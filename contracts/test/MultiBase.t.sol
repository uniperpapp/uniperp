// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////
  perpfactory — multi-base end-to-end lifecycle.

  Validates audit F6 RESOLUTION (per-base econ params derived from W):
  for SIX base configs spanning 6/8/18 decimals × $0.53 → $94K USD price,
  every launch:
    • opens at the SAME USD FDV target ($7,470, matching v2 PERP audited),
    • exposes the SAME USD-equivalent dust floor (~$21) + anti-FL cap (~$10K),
    • runs a full lifecycle without reverts (buy/sell/long/short/close/claim).

  Why mock bases (not real mainnet tokens): isolates F6 (econ-param scaling
  across decimals/USD) from F1 (PM-liquid base whitelist). For each mock we
  inject a large PM balance via `deal()` so beforeSwap's `take(currency0,...)`
  works as if the canonical v4 PM held real reserves — operational F1 is
  still admin's responsibility at whitelist time.

  Why $7,470 USD FDV: matches v2 PERP's audited opening (V=3.5 WETH @
  $2,134/ETH). Calibrated 2026-05-21.
//////////////////////////////////////////////////////////////*/

import "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {Perpfactory}  from "../src/Perpfactory.sol";
import {PerpToken}    from "../src/token/PerpToken.sol";
import {PerpHook}     from "../src/hook/PerpHook.sol";
import {PerpLens}     from "../src/hook/PerpLens.sol";
import {PerpTypes}    from "../src/PerpTypes.sol";
import {HookDeployer} from "../src/HookDeployer.sol";

import {MockBaseN} from "./mocks/MockBaseN.sol";

/// @dev Inline swap proxy — settles ERC-20 currency0 via sync→transfer→settle
///      (same pattern as Harness's V4Helper).
contract V4HelperMB {
    IPoolManager public immutable pm;
    constructor(IPoolManager pm_) { pm = pm_; }
    receive() external payable {}
    function swap(PoolKey calldata k, bool zfo, int256 a, uint160 l) external returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(k, zfo, a, l)), (BalanceDelta));
    }
    function unlockCallback(bytes calldata d) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory k, bool zfo, int256 a, uint160 l) = abi.decode(d, (PoolKey, bool, int256, uint160));
        BalanceDelta del = pm.swap(k, SwapParams({zeroForOne: zfo, amountSpecified: a, sqrtPriceLimitX96: l}), "");
        _settle(k.currency0, del.amount0());
        _settle(k.currency1, del.amount1());
        return abi.encode(del);
    }
    function _settle(Currency c, int128 x) internal {
        if (x == 0) return;
        address tok = Currency.unwrap(c);
        if (x < 0) {
            uint256 o = uint256(uint128(-x));
            pm.sync(c);
            (bool ok,) = tok.call(abi.encodeWithSignature("transfer(address,uint256)", address(pm), o));
            require(ok, "settle xfer");
            pm.settle();
        } else {
            pm.take(c, address(this), uint256(uint128(x)));
        }
    }
}

contract MultiBaseTest is Test {
    // ── constants ───────────────────────────────────────────────────────────
    address constant PM = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant FEE_RECIPIENT          = 0x98Fb2387eb8B5db1811D6789DE8c1e12546d994D;
    address constant LEVERAGE_FEE_RECIPIENT = 0x3F38Dd1e04a14f9E6615DEb5fFC62b5eE71A9cAF;

    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG |
        Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG |
        Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG |
        Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint160 constant FLAG_MASK = uint160(0x3fff);

    string constant TOKEN_NAME = "Launch";
    string constant TOKEN_SYM  = "LNCH";
    string constant TOKEN_URI  = "ipfs://bafyTESTmulti";

    // ── per-base spec ───────────────────────────────────────────────────────
    /// @dev USD price expressed e18-scaled so 6-dec PEPE etc. can be encoded
    ///      without losing the fractional part.
    struct BaseSpec {
        string  label;
        uint8   decimals;
        uint256 priceUsdE18; // (USD per 1 base token) * 1e18
    }

    /// @dev Launched instance — one per base.
    struct Launch {
        BaseSpec  spec;
        MockBaseN base;
        PerpHook  hook;
        PerpToken token;
        PerpLens  lens;
        PoolKey   key;
        uint256   V; // calibrated V in base raw units
        uint256   W; // calibrated W in base raw units
    }

    // target opening FDV in USD (v2 PERP audited @ WETH=$2,134, V=3.5)
    uint256 constant TARGET_USD_FDV = 7_470;

    // ── infra ───────────────────────────────────────────────────────────────
    IPoolManager pm;
    Perpfactory  factory;
    V4HelperMB   warmer;
    V4HelperMB   helper;

    address admin   = address(this);
    address creator = address(0xC0FFEE);
    address alice   = address(0xA11CE);
    address bob     = address(0xB0B);
    bool    forked;

    modifier onFork() { if (!forked) { console2.log("SKIP: no MAINNET_RPC_URL"); return; } _; }
    receive() external payable {}

    function setUp() public {
        try vm.envString("MAINNET_RPC_URL") returns (string memory rpc) {
            vm.createSelectFork(rpc); forked = true;
        } catch { forked = false; return; }

        pm = IPoolManager(PM);
        HookDeployer hd = new HookDeployer(admin);  // admin == address(this)
        factory = new Perpfactory(pm, admin, hd);
        hd.setFactory(address(factory));

        warmer = new V4HelperMB(pm);
        helper = new V4HelperMB(pm);
    }

    // ─── the six specs we test ──────────────────────────────────────────────
    function _specs() internal pure returns (BaseSpec[6] memory s) {
        // (label, decimals, USD price * 1e18)
        s[0] = BaseSpec("WETH-like (18d, $2134)", 18,    2134 ether);                // $2,134
        s[1] = BaseSpec("USDC-like (6d, $1)",     6,     1 ether);                   // $1
        s[2] = BaseSpec("WBTC-like (8d, $94K)",   8,     94_000 ether);              // $94,000
        s[3] = BaseSpec("DAI-like (18d, $1)",     18,    1 ether);                   // $1
        s[4] = BaseSpec("WBNB-like (18d, $600)",  18,    600 ether);                 // $600
        s[5] = BaseSpec("PERP-like (18d, $0.53)", 18,    0.5343 ether);              // $0.5343
    }

    // ─── calibrate V/W for a spec ───────────────────────────────────────────
    /// V (base raw) = TARGET_USD_FDV / price * 10^decimals
    /// W = V * 5 / 3.5  (audited W/V ratio)
    function _calibrate(BaseSpec memory s) internal pure returns (uint256 V, uint256 W) {
        // V_in_base_tokens = TARGET_USD_FDV / priceUsd
        // V_in_raw = V_in_base_tokens * 10^decimals
        //         = (TARGET_USD_FDV * 1e18 / priceUsdE18) * 10^decimals
        uint256 vTokensE18 = (TARGET_USD_FDV * 1e18 * 1e18) / s.priceUsdE18; // V tokens * 1e18 (fixed-point)
        uint256 scale      = 10 ** s.decimals;
        V = (vTokensE18 * scale) / 1e18;
        W = (V * 5) / 7 * 2;   // V * 10/7 (≈ V * 1.4286). Avoid loss: V*5/3.5 == V*10/7
        // tiny correction: (V * 10 + 3) / 7 rounded better, but V*10/7 is fine
        W = (V * 10) / 7;
    }

    // ─── CREATE2 helpers (mirror Harness exactly) ───────────────────────────
    function _c2(address dep, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(
            keccak256(abi.encodePacked(bytes1(0xff), dep, salt, initHash))
        )));
    }

    function _mineSaltsFor(address baseAddr, string memory uri)
        internal view returns (bytes32 tokenSalt, bytes32 hookSalt)
    {
        bytes32 tHash = factory.tokenInitCodeHash(TOKEN_NAME, TOKEN_SYM, uri);
        address tok; bool gotT;
        for (uint256 ts = 0; ts < 2_000_000; ts++) {
            tok = _c2(address(factory), bytes32(ts), tHash);
            if (uint160(tok) > uint160(baseAddr)) { tokenSalt = bytes32(ts); gotT = true; break; }
        }
        require(gotT, "no token salt");

        bytes32 hHash = factory.hookInitCodeHash(tok);
        address hookDep = address(factory.hookDeployer());
        for (uint256 hs = 0; hs < 4_000_000; hs++) {
            address h = _c2(hookDep, bytes32(hs), hHash);
            if (uint160(h) & FLAG_MASK == FLAGS) { hookSalt = bytes32(hs); return (tokenSalt, hookSalt); }
        }
        revert("no hook salt");
    }

    // ─── set up + launch one instance per spec ──────────────────────────────
    function _setupLaunch(BaseSpec memory s, string memory uri) internal returns (Launch memory L) {
        L.spec = s;
        L.base = new MockBaseN(s.label, s.label, s.decimals);

        // PM liquidity for take()/settle() — bump well above any per-test draw.
        L.base.mint(PM, 1e36);

        (L.V, L.W) = _calibrate(s);
        require(L.V > 0 && L.W > 0, "calibration zero");
        require(L.V <= type(uint128).max && L.W <= type(uint128).max, "calibration overflow128");

        // whitelist with single locked V/W (creator no longer chooses).
        factory.setBase(address(L.base), true, uint128(L.V), uint128(L.W));

        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor(address(L.base), uri);

        vm.prank(creator);
        (address h, address t, address l) = factory.create(Perpfactory.CreateParams({
            name: TOKEN_NAME, symbol: TOKEN_SYM, tokenUri: uri,
            base: address(L.base),
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: 0
        }));
        L.hook  = PerpHook(payable(h));
        L.token = PerpToken(t);
        L.lens  = PerpLens(l);

        L.key = PoolKey({
            currency0: Currency.wrap(address(L.base)),
            currency1: Currency.wrap(address(L.token)),
            fee: 0, tickSpacing: 60, hooks: h.code.length > 0 ? PerpHook(payable(h)) : PerpHook(payable(h)) // pass-through; v4 stores it
        });
        // tickSpacing 60 = PerpCurve.TICK_SPACING (verified in PerpHook.beforeInitialize)
        // (the cast above is awkward in struct literal; rebuild:)
        L.key = PoolKey({
            currency0: Currency.wrap(address(L.base)),
            currency1: Currency.wrap(address(L.token)),
            fee: 0, tickSpacing: 60, hooks: PerpHook(payable(h))
        });

        // fund warmer/helper with this base so subsequent swaps can settle.
        L.base.mint(address(warmer), 1e36);
        L.base.mint(address(helper), 1e36);
        L.base.mint(address(this),   1e36);
        L.base.mint(creator,         1e36);
        L.base.mint(alice,           1e36);
        L.base.mint(bob,             1e36);

        // exit the anti-snipe window.
        vm.roll(block.number + L.hook.ANTI_SNIPE_BLOCKS());
        vm.warp(block.timestamp + 39);
    }

    // ─── tiny helpers, base-aware ───────────────────────────────────────────
    function _spotBuy(Launch memory L, uint256 baseIn) internal {
        warmer.swap(L.key, true, -int256(baseIn), TickMath.MIN_SQRT_PRICE + 1);
    }
    function _spotSell(Launch memory L, uint256 tokensIn) internal {
        warmer.swap(L.key, false, -int256(tokensIn), TickMath.MAX_SQRT_PRICE - 1);
    }
    function _warm(Launch memory L, uint256 hops, uint256 baseIn) internal {
        for (uint256 i = 0; i < hops; i++) {
            _spotBuy(L, baseIn);
        }
        // dwell so TWAP / prior-block tick catch up.
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 30; i++) {
            t += 13; vm.warp(t); vm.roll(block.number + 1);
            _spotBuy(L, baseIn / 1e6 + 1);   // tiny pulse to advance the observation ring
        }
    }
    function _openLong(Launch memory L, address who, uint256 lev, uint256 col) internal returns (uint256 id, bool ok) {
        vm.startPrank(who);
        L.base.approve(address(L.hook), col);
        try L.hook.openLong(lev, col, 0, block.timestamp + 600) returns (uint256 _id, uint256) { id = _id; ok = true; }
        catch { ok = false; }
        vm.stopPrank();
    }
    function _openShort(Launch memory L, address who, uint256 lev, uint256 col) internal returns (uint256 id, bool ok) {
        vm.startPrank(who);
        L.base.approve(address(L.hook), col);
        try L.hook.openShort(lev, col, 0, block.timestamp + 600) returns (uint256 _id, uint256) { id = _id; ok = true; }
        catch { ok = false; }
        vm.stopPrank();
    }
    function _close(Launch memory L, address who, uint256 id) internal returns (bool ok) {
        vm.prank(who);
        try L.hook.close(id, 10_000, 0, block.timestamp + 600) { ok = true; } catch { ok = false; }
    }

    // ─── invariants for ONE launched instance (4a strict, 4b loose) ────────
    function _inv(Launch memory L, string memory tag) internal view {
        uint256 sBE; uint256 sSE; uint256 sBT; uint256 sST;
        for (uint256 i = 0; i < 300; i++) {
            PerpTypes.Band memory b = L.hook.bands(i);
            sBE += b.borrowedETH;  sSE += b.realizedShortfallETH;
            sBT += b.borrowedTOKEN; sST += b.realizedShortfallTOKEN;
        }
        uint256 sClaim = L.hook.claimable(FEE_RECIPIENT) + L.hook.claimable(LEVERAGE_FEE_RECIPIENT)
            + L.hook.claimable(address(this)) + L.hook.claimable(address(warmer))
            + L.hook.claimable(address(helper)) + L.hook.claimable(creator)
            + L.hook.claimable(alice) + L.hook.claimable(bob);
        uint256 sUserClaim = sClaim
            - L.hook.claimable(FEE_RECIPIENT)
            - L.hook.claimable(LEVERAGE_FEE_RECIPIENT);
        uint256 bal = L.base.balanceOf(address(L.hook));

        assertEq(L.token.totalSupply(), 1_000_000 ether, string.concat(tag, ":INV1"));
        assertGe(bal, sUserClaim,
            string.concat(tag, ":INV4a STRICT user-funds solvency"));
        assertGe(bal, L.hook.reserveETH() + L.hook.insuranceETH() + sClaim,
            string.concat(tag, ":INV4b base solvency"));
        assertGe(L.token.balanceOf(address(L.hook)),
            L.hook.reserveTOKEN() + L.hook.insuranceTOKEN() + L.hook.totalHoldingTOKEN(),
            string.concat(tag, ":INV5 TOKEN solvency"));
        assertGe(sBE, sSE, string.concat(tag, ":INV6"));
        assertGe(sBT, sST, string.concat(tag, ":INV7"));
    }

    // ─── THE TEST ───────────────────────────────────────────────────────────
    /// Per base spec: launch, verify F6 econ params are correctly scaled,
    /// run full lifecycle (spot buy/sell + long/short open+close), keep
    /// all invariants throughout.
    function test_MultiBase_AllLifecycles() public onFork {
        BaseSpec[6] memory specs = _specs();
        for (uint256 i = 0; i < specs.length; i++) {
            _runOne(specs[i], i);
        }
    }

    function _runOne(BaseSpec memory s, uint256 idx) internal {
        // unique URI per iteration → distinct init-code hash → distinct CREATE2 addrs
        string memory uri = string.concat(TOKEN_URI, "-", _u(idx));
        Launch memory L = _setupLaunch(s, uri);

        // ── F6 assertions: per-base econ params correctly USD-aligned ───────
        // The hook derives them inline: minColl=W/500, maxBorrowPerBlock=W,
        // badDebtThreshold=W. We assert via behavior + a direct math check.
        uint256 minColl = L.W / 500;
        assertGt(minColl, 0, string.concat(s.label, ":minColl>0"));

        // Confirm USD-scale: minColl in USD should be ≈ $21 (audited dust floor).
        // usd_e18 = minColl_raw * priceUsdE18 / 10^decimals
        uint256 minCollUsdE18 = (minColl * s.priceUsdE18) / (10 ** s.decimals);
        // Allow ±10% slack since W is rounded to integer base wei when calibrated.
        assertApproxEqRel(minCollUsdE18, 21 ether, 0.10e18,
            string.concat(s.label, ":minColl USD value ~$21"));

        uint256 maxBorrowUsdE18 = (L.W * s.priceUsdE18) / (10 ** s.decimals);
        assertApproxEqRel(maxBorrowUsdE18, 10_670 ether, 0.10e18,
            string.concat(s.label, ":maxBorrow USD value ~$10,670"));

        // ── spot lifecycle ──────────────────────────────────────────────────
        _inv(L, _t(s.label, "post-launch"));

        // Warm the curve. Hop size = W/10 — big enough to move the curve in
        // a handful of hops, small enough to not blow past the launch bands.
        _warm(L, 80, L.W / 10);
        _inv(L, _t(s.label, "post-warm"));

        // spot sell back a tiny fraction so afterSwap fee path executes too
        uint256 warmBag = L.token.balanceOf(address(warmer));
        if (warmBag > 0) {
            _spotSell(L, warmBag / 200);
            _inv(L, _t(s.label, "post-spotSell"));
        }

        // ── leverage long open + close ──────────────────────────────────────
        uint256 longCol = minColl * 4;   // 4× the dust floor — comfortably above
        (uint256 longId, bool ok1) = _openLong(L, alice, 3, longCol);
        assertTrue(ok1, string.concat(s.label, ":long open"));
        _inv(L, _t(s.label, "post-openLong"));

        vm.roll(block.number + 3); vm.warp(block.timestamp + 40);
        bool ok2 = _close(L, alice, longId);
        assertTrue(ok2, string.concat(s.label, ":long close"));
        _inv(L, _t(s.label, "post-closeLong"));

        // ── leverage short open + close ─────────────────────────────────────
        uint256 shortCol = minColl * 4;
        (uint256 shortId, bool ok3) = _openShort(L, bob, 3, shortCol);
        assertTrue(ok3, string.concat(s.label, ":short open"));
        _inv(L, _t(s.label, "post-openShort"));

        vm.roll(block.number + 3); vm.warp(block.timestamp + 40);
        bool ok4 = _close(L, bob, shortId);
        assertTrue(ok4, string.concat(s.label, ":short close"));
        _inv(L, _t(s.label, "post-closeShort"));

        // ── dust-floor enforcement: open below minColl reverts ──────────────
        if (minColl > 1) {
            (, bool dustOk) = _openLong(L, alice, 2, minColl - 1);
            assertFalse(dustOk, string.concat(s.label, ":sub-dust open reverts"));
        }

        // ── claim path: alice gets her base back from any accrued claimable ─
        if (L.hook.claimable(alice) > 0) {
            uint256 pre = L.base.balanceOf(alice);
            vm.prank(alice); L.hook.claim();
            assertGt(L.base.balanceOf(alice), pre, string.concat(s.label, ":alice claims base"));
        }

        // ── final invariant sweep ───────────────────────────────────────────
        _inv(L, _t(s.label, "final"));

        // Log a tidy per-base report (visible with `forge test -vv`).
        console2.log("\n--", s.label, "--");
        console2.log("  V (raw)         :", L.V);
        console2.log("  W (raw)         :", L.W);
        console2.log("  minColl (raw)   :", minColl);
        console2.log("  minColl USD e18 :", minCollUsdE18);
        console2.log("  maxBorrow USD e18:", maxBorrowUsdE18);
    }

    // ─── tiny string helpers ────────────────────────────────────────────────
    function _t(string memory a, string memory b) internal pure returns (string memory) {
        return string.concat(a, "/", b);
    }
    function _u(uint256 x) internal pure returns (string memory) {
        if (x == 0) return "0";
        bytes memory buf = new bytes(20);
        uint256 i = 20;
        while (x > 0) { i--; buf[i] = bytes1(uint8(48 + (x % 10))); x /= 10; }
        bytes memory out = new bytes(20 - i);
        for (uint256 j = 0; j < out.length; j++) out[j] = buf[i + j];
        return string(out);
    }
}
