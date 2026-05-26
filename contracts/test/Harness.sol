// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////
  perpfactory — shared test harness.

  The v4-core lib vendored here ships ONLY interfaces/libraries/types (no
  PoolManager implementation), so — exactly like the proven v2 suite — the
  tests fork mainnet for the canonical PoolManager at
  0x000000000004444c5dc75cB358380D2e3dE08A90.

  Faithfulness proof: every launched instance is created through the REAL
  `Perpfactory.create()` path with the EXACT v2 curve params (V=3.5e18,
  W=5e18, K=deriveK(V)=3.5e24). The only generalization vs v2 is the base:
  native ETH (currency0 == address(0)) → an ERC-20 base.

  WHY REAL WETH (not a fresh mock): the engine's `beforeSwap` charges the 1%
  spot fee with `poolManager.take(currency0=base, hook, fee)` — IDENTICAL to
  v2 (which used native ETH). That `take` transiently pulls `fee` from the
  PoolManager (netted when the swapper settles the full input the same
  unlock), so the PM must already hold the base. v2's fork worked because the
  forked mainnet PM holds huge native ETH. The faithful ERC-20 analog is REAL
  mainnet WETH (the forked canonical PM holds large WETH balances from real
  v4 pools). A brand-new mock token the forked PM has never seen has zero PM
  balance ⇒ the very first buy's fee-`take` reverts — which is ALSO the real
  operational constraint on the admin base-whitelist (bases must be assets
  with existing v4 PM balances; see PLAN/audit-prep).

  In-EVM salt mining mirrors the off-chain miner: factory's own
  `tokenInitCodeHash`/`hookInitCodeHash` + CREATE2(deployer=factory), and
  additionally enforces token > base (v4 currency0(base) < currency1(token);
  WETH is a high address ⇒ ~25% of token salts qualify).
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

/// @dev The base-asset surface the engine (IERC20Base) + the v4 PoolManager
///      (IERC20Minimal) touch. Real mainnet WETH implements all of it.
interface IBase {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function deposit() external payable;
}

/// @dev Only used by the non-whitelisted-base factory test, which needs a
///      concrete address that is NOT in the whitelist and never swaps.
contract MockBase {
    string public constant name = "Mock Base";
    string public constant symbol = "mBASE";
    uint8  public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function transfer(address, uint256) external pure returns (bool) { return true; }
}

/// @notice Generic v4 swap proxy. Pays the owed side from its OWN base/token
///         balance via the ERC-20 settle path.
contract V4Helper {
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
        _s(k.currency0, del.amount0());
        _s(k.currency1, del.amount1());
        return abi.encode(del);
    }
    function _s(Currency c, int128 x) internal {
        if (x == 0) return;
        if (x < 0) {
            uint256 o = uint256(uint128(-x));
            if (Currency.unwrap(c) == address(0)) pm.settle{value: o}();
            else { pm.sync(c); IBase(Currency.unwrap(c)).transfer(address(pm), o); pm.settle(); }
        } else {
            pm.take(c, address(this), uint256(uint128(x)));
        }
    }
}

/// @notice Self-contained attacker. EVERY base cost is drawn from THIS
///         contract's own base balance and EVERY inflow returns here, so
///         base.balanceOf(atk) before-vs-after is an unambiguous net P&L.
contract Attacker {
    IPoolManager public immutable pm;
    PerpHook public immutable hook;
    address public immutable base;
    PoolKey key;

    constructor(IPoolManager pm_, PerpHook hook_, address base_) { pm = pm_; hook = hook_; base = base_; }
    receive() external payable {}
    function setKey(PoolKey calldata k) external { key = k; }

    function _swap(bool zfo, int256 amt, uint160 lim) internal { pm.unlock(abi.encode(zfo, amt, lim)); }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (bool zfo, int256 amt, uint160 lim) = abi.decode(data, (bool, int256, uint160));
        BalanceDelta d = pm.swap(key, SwapParams({zeroForOne: zfo, amountSpecified: amt, sqrtPriceLimitX96: lim}), "");
        _s(key.currency0, d.amount0());
        _s(key.currency1, d.amount1());
        return abi.encode(d);
    }
    function _s(Currency c, int128 a) internal {
        if (a == 0) return;
        if (a < 0) {
            uint256 owed = uint256(uint128(-a));
            if (Currency.unwrap(c) == address(0)) pm.settle{value: owed}();
            else { pm.sync(c); IBase(Currency.unwrap(c)).transfer(address(pm), owed); pm.settle(); }
        } else {
            pm.take(c, address(this), uint256(uint128(a)));
        }
    }

    function buyBag(uint256 baseAmt) external { _swap(true, -int256(baseAmt), TickMath.MIN_SQRT_PRICE + 1); }
    function sellAll() external {
        uint256 bag = IBase(Currency.unwrap(key.currency1)).balanceOf(address(this));
        if (bag > 0) _swap(false, -int256(bag), TickMath.MAX_SQRT_PRICE - 1);
    }
    function openMaxLong(uint256 col) external returns (uint256 id, bool ok) {
        IBase(base).approve(address(hook), col);
        try hook.openLong(3, col, 0, block.timestamp + 600) returns (uint256 _id, uint256) {
            id = _id; ok = true;
        } catch { ok = false; }
    }
    function closeAll(uint256 id) external {
        try hook.close(id, 10_000, 0, block.timestamp + 600) {} catch {}
        if (hook.claimable(address(this)) > 0) hook.claim();
    }
}

/// @notice Abstract base for every ported suite. Forks mainnet, deploys the
///         factory, whitelists real WETH as the base, launches ONE instance
///         via the real `create()` path with the exact v2 curve params, and
///         exposes the v2 invariant battery (ETH side → hook WETH balance).
abstract contract PerpHarness is Test {
    address constant PM   = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // Spot fee wallet (PerpHook.feeRecipient — beforeSwap/afterSwap fees).
    address constant FEE_RECIPIENT           = 0x98Fb2387eb8B5db1811D6789DE8c1e12546d994D;
    // Leverage fee wallet (PerpCore.LEVERAGE_FEE_RECIPIENT — borrow/close fees).
    address constant LEVERAGE_FEE_RECIPIENT  = 0x3F38Dd1e04a14f9E6615DEb5fFC62b5eE71A9cAF;

    // exact v2 curve params (V=3.5e18 ⇒ K=3.5e24, W=5e18) — the faithfulness anchor
    uint256 constant V  = 3.5 ether;
    uint256 constant TW = 5 ether;

    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG |
        Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG |
        Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG |
        Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
    uint160 constant FLAG_MASK = uint160(0x3fff);

    string constant NAME      = "Launch Token";
    string constant SYM       = "LAUNCH";
    // Test value for the per-token metadata URI (immutable on PerpToken).
    // The content doesn't matter for engine/factory invariants — only that
    // the same value is used in mining + create + prediction so init-code
    // hashes line up.
    string constant TOKEN_URI = "ipfs://bafyTESTmetadata";

    IPoolManager pm;
    Perpfactory  factory;
    IBase        base;     // == WETH
    PerpToken    token;
    PerpHook     hook;
    PerpLens     lens;
    V4Helper     warmer;   // pumps/warms the curve; holds the post-pump bag
    V4Helper     helper;   // attacker swap proxy; starts with ZERO token bag
    PoolKey      key;

    address admin   = address(this);          // factory admin (curates bases, owner-ops)
    address creator = address(0xC0FFEE);      // launches; must get ZERO privileges
    bool    forked;

    receive() external payable {}
    modifier onFork() { if (!forked) { console2.log("SKIP: no MAINNET_RPC_URL"); return; } _; }

    function setUp() public virtual {
        try vm.envString("MAINNET_RPC_URL") returns (string memory rpc) {
            vm.createSelectFork(rpc); forked = true;
        } catch { forked = false; return; }

        pm = IPoolManager(PM);
        base = IBase(WETH);
        HookDeployer hd = new HookDeployer(admin);
        factory = new Perpfactory(pm, admin, hd);
        hd.setFactory(address(factory));

        // whitelist WETH with the exact v2 params (locked V=3.5 WETH, W=5 WETH)
        factory.setBase(WETH, true, uint128(V), uint128(TW));

        (bytes32 tokenSalt, bytes32 hookSalt) = _mineSalts();

        vm.prank(creator);
        (address h, address t, address l) = factory.create(Perpfactory.CreateParams({
            name: NAME, symbol: SYM, tokenUri: TOKEN_URI, base: WETH,
            tokenSalt: tokenSalt, hookSalt: hookSalt,
            seedBuyBase: 0
        }));
        hook  = PerpHook(payable(h));
        token = PerpToken(t);
        lens  = PerpLens(l);

        key = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(address(token)),
            fee: 0, tickSpacing: 60, hooks: hook
        });

        warmer = new V4Helper(pm);
        helper = new V4Helper(pm);
        deal(WETH, address(warmer), 5_000_000 ether);
        deal(WETH, address(helper), 5_000_000 ether);
        deal(WETH, address(this),  10_000_000 ether);

        // anti-snipe: no external swap/open until launchBlock + ANTI_SNIPE_BLOCKS
        vm.roll(block.number + hook.ANTI_SNIPE_BLOCKS());
        vm.warp(block.timestamp + 39);
    }

    // ─── in-EVM salt miner (mirrors the off-chain miner exactly) ────────────
    function _c2(address deployer, bytes32 salt, bytes32 initHash) internal pure returns (address) {
        return address(uint160(uint256(
            keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash))
        )));
    }

    /// @return tokenSalt s.t. predictToken > base (v4 currency ordering)
    /// @return hookSalt  s.t. predictHook carries the v4 perm FLAGS
    function _mineSalts() internal view returns (bytes32 tokenSalt, bytes32 hookSalt) {
        return _mineSaltsFor(NAME, SYM, TOKEN_URI, WETH);
    }

    function _mineSaltsFor(string memory nm, string memory sym, string memory uri, address baseAddr)
        internal view returns (bytes32 tokenSalt, bytes32 hookSalt)
    {
        bytes32 tHash = factory.tokenInitCodeHash(nm, sym, uri);
        address tok;
        bool gotT;
        for (uint256 ts = 0; ts < 1_000_000; ts++) {
            tok = _c2(address(factory), bytes32(ts), tHash);
            if (uint160(tok) > uint160(baseAddr)) { tokenSalt = bytes32(ts); gotT = true; break; }
        }
        require(gotT, "no token salt");

        bytes32 hHash = factory.hookInitCodeHash(tok);
        address hookDep = address(factory.hookDeployer());
        for (uint256 hs = 0; hs < 2_000_000; hs++) {
            address h = _c2(hookDep, bytes32(hs), hHash);
            if (uint160(h) & FLAG_MASK == FLAGS) { hookSalt = bytes32(hs); return (tokenSalt, hookSalt); }
        }
        revert("no hook salt");
    }

    // Returns (tokenSalt, badHookSalt) where badHookSalt's predicted hook
    // address does NOT carry FLAGS — for the salt-verify-revert /
    // atomic-rollback tests.
    function _mineBadHookSalt(string memory nm, string memory sym, string memory uri, address baseAddr)
        internal view returns (bytes32 tokenSalt, bytes32 badHookSalt)
    {
        bytes32 tHash = factory.tokenInitCodeHash(nm, sym, uri);
        address tok;
        bool gotT;
        for (uint256 ts = 0; ts < 1_000_000; ts++) {
            tok = _c2(address(factory), bytes32(ts), tHash);
            if (uint160(tok) > uint160(baseAddr)) { tokenSalt = bytes32(ts); gotT = true; break; }
        }
        require(gotT, "no token salt");
        bytes32 hHash = factory.hookInitCodeHash(tok);
        address hookDep = address(factory.hookDeployer());
        for (uint256 hs = 0; hs < 1_000_000; hs++) {
            address h = _c2(hookDep, bytes32(hs), hHash);
            if (uint160(h) & FLAG_MASK != FLAGS) return (tokenSalt, bytes32(hs));
        }
        revert("no bad hook salt");
    }

    // ─── actor entry helpers ────────────────────────────────────────────────
    // `_open*` deal fresh collateral then open (convenience for sims/invariants
    // where actor funding is irrelevant). `_open*From` does NOT fund — the
    // caller must already hold base, so balance deltas stay an honest P&L
    // proxy (used by the exploit round-trip / self-sandwich gates).
    function _openLong(address who, uint256 lev, uint256 col) internal returns (uint256 id, bool ok) {
        deal(WETH, who, col);
        return _openLongFrom(who, lev, col);
    }
    function _openShort(address who, uint256 lev, uint256 col) internal returns (uint256 id, bool ok) {
        deal(WETH, who, col);
        return _openShortFrom(who, lev, col);
    }
    function _openLongFrom(address who, uint256 lev, uint256 col) internal returns (uint256 id, bool ok) {
        vm.startPrank(who);
        base.approve(address(hook), col);
        try hook.openLong(lev, col, 0, block.timestamp + 600) returns (uint256 _id, uint256) { id = _id; ok = true; }
        catch { ok = false; }
        vm.stopPrank();
    }
    function _openShortFrom(address who, uint256 lev, uint256 col) internal returns (uint256 id, bool ok) {
        vm.startPrank(who);
        base.approve(address(hook), col);
        try hook.openShort(lev, col, 0, block.timestamp + 600) returns (uint256 _id, uint256) { id = _id; ok = true; }
        catch { ok = false; }
        vm.stopPrank();
    }
    function _close(address who, uint256 id, uint256 bps) internal returns (bool ok) {
        vm.prank(who);
        try hook.close(id, bps, 0, block.timestamp + 600) { ok = true; } catch { ok = false; }
    }

    // ─── warm: pump curveEth to target with base→token buys, then dwell so
    //          the TWAP/prior-block tick catch up to spot (v2 method) ────────
    function _warm(uint256 target) internal {
        for (uint256 i = 0; i < 80; i++) {
            if (lens.getPoolSnapshot().curveEth >= target) break;
            warmer.swap(key, true, -int256(uint256(1 ether)), TickMath.MIN_SQRT_PRICE + 1);
        }
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 30; i++) {
            t += 13; vm.warp(t); vm.roll(block.number + 1);
            warmer.swap(key, true, -int256(uint256(1e12)), TickMath.MIN_SQRT_PRICE + 1);
        }
    }

    // ─── the two-sided conservation invariants ──────────────────────────────
    //     INV-4 ETH-solvency is now WETH-solvency. We assert it in TWO parts:
    //
    //     INV-4a (STRICT, zero tolerance, ALWAYS): the hook's WETH balance
    //       covers every USER's claimable. This is the funds-safety guarantee
    //       — a user must always be payable. It excludes the hardcoded
    //       protocol fee wallet (FEE_RECIPIENT), which is a protocol-owned,
    //       best-effort obligation (in v2 the ex-staker slice was a
    //       best-effort external `staking.call`; here it accrues to
    //       FEE_RECIPIENT — economically the same: protocol revenue, NOT a
    //       user deposit).
    //
    //     INV-4b (FULL, tolerance `_invSlackTol()`): balance also covers
    //       reserve + insurance + ALL claimable (incl. FEE_RECIPIENT). Default
    //       tolerance is ZERO (exact, identical to v2 — Exploit/Invariants keep
    //       it exact and pass). The stochastic ~700-op Sim overrides it with a
    //       SMALL DOCUMENTED bound: hundreds of cascade liquidations accumulate
    //       sub-1% mulDiv truncation on the *protocol backstop* counters
    //       (reserve/insurance), a path/fork-block-dependent residual that is
    //       NOT a user leak (INV-4a still strict) and is squarely within v2's
    //       already-documented "accepted bounded residual" philosophy on the
    //       seize/heal path (see PERP_DESIGN; v2's own sim never tested this
    //       undrained end-state — it drained the backstop first).
    function _inv(string memory tag) internal view {
        uint256 sBE; uint256 sSE; uint256 sBT; uint256 sST;
        for (uint256 i = 0; i < 300; i++) {
            PerpTypes.Band memory b = hook.bands(i);
            sBE += b.borrowedETH;  sSE += b.realizedShortfallETH;
            sBT += b.borrowedTOKEN; sST += b.realizedShortfallTOKEN;
        }
        uint256 sClaim     = _claimSum();
        // Strict USER-only claim = total claim sum minus BOTH protocol fee
        // recipients (spot wallet + leverage wallet). Funds-safety check
        // (INV-4a) only owes against actual user-owned claimables.
        uint256 sUserClaim = sClaim
            - hook.claimable(FEE_RECIPIENT)
            - hook.claimable(LEVERAGE_FEE_RECIPIENT);
        uint256 bal        = base.balanceOf(address(hook));

        assertEq(token.totalSupply(), 1_000_000 ether, string.concat(tag, ":INV1 supply"));
        assertApproxEqAbs(sSE, hook.totalBadDebtETH(),   1e7,  string.concat(tag, ":INV2 shortfallE==badDebtE"));
        assertApproxEqAbs(sST, hook.totalBadDebtTOKEN(), 1e10, string.concat(tag, ":INV3 shortfallT==badDebtT"));
        // INV-4a: STRICT user-funds solvency (zero tolerance, every scenario).
        assertGe(bal, sUserClaim, string.concat(tag, ":INV4a USER solvency (strict)"));
        // INV-4b: full backstop-inclusive solvency, bounded tolerance.
        assertGe(bal + _invSlackTol(), hook.reserveETH() + hook.insuranceETH() + sClaim,
            string.concat(tag, ":INV4b WETH solvency"));
        assertGe(token.balanceOf(address(hook)),
            hook.reserveTOKEN() + hook.insuranceTOKEN() + hook.totalHoldingTOKEN(),
            string.concat(tag, ":INV5 TOKEN solvency"));
        assertGe(sBE, sSE, string.concat(tag, ":INV6 borrowedE>=shortfallE"));
        assertGe(sBT, sST, string.concat(tag, ":INV7 borrowedT>=shortfallT"));
    }

    /// @dev Allowed slack on the FULL (backstop-inclusive) INV-4b only.
    ///      ZERO by default ⇒ Exploit/Invariants stay byte-exact to v2.
    ///      Only the stochastic Sim overrides this (documented above).
    function _invSlackTol() internal view virtual returns (uint256) { return 0; }

    /// @dev Override in suites with their own actor set; default covers the
    ///      common participants + the hardcoded fee recipient.
    function _claimSum() internal view virtual returns (uint256) {
        return hook.claimable(FEE_RECIPIENT) + hook.claimable(LEVERAGE_FEE_RECIPIENT)
            + hook.claimable(address(this))
            + hook.claimable(address(warmer))
            + hook.claimable(address(helper))
            + hook.claimable(creator);
    }
}
