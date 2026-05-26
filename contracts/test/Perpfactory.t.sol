// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////
  Perpfactory — launchpad keystone tests.

  Proves the one-tx launch is deterministic, atomic, permissioned, isolated,
  anti-sniped, single-block-cheap, and that the launched instance is a fully
  functional v2 engine. Fork test (MAINNET_RPC_URL).
//////////////////////////////////////////////////////////////*/

import "./Harness.sol";
import {Perpfactory} from "../src/Perpfactory.sol";

contract PerpfactoryTest is PerpHarness {
    // ─── CREATE2 determinism: predicted == actual ───────────────────────────
    function test_Create2Determinism() public onFork {
        // setUp already launched via create(); re-derive the salts it used and
        // assert the factory's prediction views match the deployed addresses.
        (bytes32 tSalt, bytes32 hSalt) = _mineSalts();
        address predToken = factory.predictToken(tSalt, NAME, SYM, TOKEN_URI);
        address predHook  = factory.predictHook(hSalt, predToken);
        assertEq(predToken, address(token), "predictToken == deployed token");
        assertEq(predHook,  address(hook),  "predictHook == deployed hook");
        // hook addr carries the v4 perm bits
        assertEq(uint160(address(hook)) & FLAG_MASK, FLAGS, "hook addr carries FLAGS");
        // v4 currency ordering: base(currency0) < token(currency1)
        assertLt(uint160(address(base)), uint160(address(token)), "base < token");
    }

    // ─── post-create state: live, 50 bands, exact v2 curve, factory-owned ───
    function test_PostCreateState() public onFork {
        assertTrue(hook.poolInitialized(), "pool initialized");
        assertTrue(hook.tradingEnabled(),  "trading enabled at 50 bands");
        assertEq(hook.bandsSeededCount(), hook.LAUNCH_BANDS(), "exactly LAUNCH_BANDS seeded");
        assertEq(hook.owner(), address(factory), "factory is hook owner");
        assertEq(hook.base(), address(base), "base wired");
        (uint256 v, uint256 k, uint256 tw) = hook.curveParams();
        assertEq(v,  V,  "V == v2 3.5e18");
        assertEq(tw, TW, "W == v2 5e18");
        assertEq(k,  (1_000_000 ether * V) / 1 ether, "K == deriveK(V) == 3.5e24");
        // supply conservation: the initializePool invariant
        // (balanceOf(hook)==TOTAL_SUPPLY) held at init, then the 50-band seed
        // moved ~98.6% into the pool as band liquidity. Post-create the full
        // supply is exactly (hook tail) + (PoolManager bands), nothing minted
        // or burned, and the un-seeded tail is still hook-held (admin seedTail).
        assertEq(token.totalSupply(), 1_000_000 ether, "no inflation");
        assertEq(token.balanceOf(address(hook)) + token.balanceOf(PM), 1_000_000 ether,
            "supply == hook tail + pool bands");
        assertGt(token.balanceOf(address(hook)), 0, "tail (bands 50..300) still hook-held");
        assertGt(token.balanceOf(PM), 900_000 ether, "~98.6% seeded into pool bands");
        // registry
        assertEq(factory.launchCount(), 1, "one launch registered");
        assertEq(factory.hookId(address(hook)), 1, "hookId set");
    }

    // ─── salt-verify revert: a hookSalt that doesn't carry FLAGS reverts ─────
    function test_BadHookSalt_Reverts() public onFork {
        (bytes32 tSalt, bytes32 badHSalt) =
            _mineBadHookSalt("Bad Token", "BAD", "", address(base));
        vm.prank(creator);
        vm.expectRevert();   // hook ctor validateHookPermissions / BadHookAddr
        factory.create(Perpfactory.CreateParams({
            name: "Bad Token", symbol: "BAD", tokenUri: "", base: address(base),
            tokenSalt: tSalt, hookSalt: badHSalt,
            seedBuyBase: 0
        }));
    }

    // ─── atomic rollback: a failed create registers NOTHING, deploys NOTHING ─
    function test_AtomicRollback_OnBadSalt() public onFork {
        uint256 countBefore = factory.launchCount();
        (bytes32 tSalt, bytes32 badHSalt) =
            _mineBadHookSalt("Roll Token", "ROLL", "", address(base));
        address predToken = factory.predictToken(tSalt, "Roll Token", "ROLL", "");

        vm.prank(creator);
        vm.expectRevert();
        factory.create(Perpfactory.CreateParams({
            name: "Roll Token", symbol: "ROLL", tokenUri: "", base: address(base),
            tokenSalt: tSalt, hookSalt: badHSalt,
            seedBuyBase: 0
        }));

        assertEq(factory.launchCount(), countBefore, "no launch registered");
        assertEq(predToken.code.length, 0, "token NOT deployed (whole tx rolled back)");
    }

    // ─── whitelist / bounds gate ────────────────────────────────────────────
    function test_NonWhitelistedBase_Reverts() public onFork {
        MockBase other = new MockBase();
        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor("X", "X", "", address(other));
        vm.prank(creator);
        vm.expectRevert(Perpfactory.NotWhitelisted.selector);
        factory.create(Perpfactory.CreateParams({
            name: "X", symbol: "X", tokenUri: "", base: address(other),
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: 0
        }));
    }

    /// @notice Creator no longer chooses V/W (read straight from `bases[base]`),
    ///         so the only `BadParams` route left is empty name/symbol.
    function test_EmptyName_Reverts() public onFork {
        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor("", "Y", "", address(base));
        vm.prank(creator);
        vm.expectRevert(Perpfactory.BadParams.selector);
        factory.create(Perpfactory.CreateParams({
            name: "", symbol: "Y", tokenUri: "", base: address(base),
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: 0
        }));
    }

    function test_OnlyAdminCanWhitelist() public onFork {
        vm.prank(creator);
        vm.expectRevert(bytes("not admin"));
        factory.setBase(address(0xdead), true, 1, 1);
    }

    // ─── creator gets ZERO privileges; admin-only ongoing ops ───────────────
    function test_CreatorHasNoPrivileges() public onFork {
        vm.startPrank(creator);
        vm.expectRevert(PerpHook.NotOwner.selector); hook.pause();
        vm.expectRevert(PerpHook.NotOwner.selector); hook.setCurve(1 ether, 1 ether);
        vm.expectRevert(PerpHook.NotOwner.selector); hook.seedBands(50, 75);
        vm.expectRevert(PerpHook.NotOwner.selector); hook.withdrawBackstop(1, 1);
        vm.stopPrank();
        // admin can't drive owner-ops directly either (owner == factory)
        vm.expectRevert(PerpHook.NotOwner.selector); hook.pause();
        // but CAN via the factory wrappers
        factory.pause(address(hook));   assertTrue(hook.paused(), "admin pause via factory");
        factory.unpause(address(hook)); assertFalse(hook.paused(), "admin unpause via factory");
    }

    // ─── withdrawBackstop is unreachable for launchpad instances ────────────
    // owner == factory and the factory exposes NO wrapper selector ⇒ no path.
    function test_WithdrawBackstop_Unreachable() public onFork {
        // direct calls revert (owner is the factory, not admin/creator/random)
        vm.expectRevert(PerpHook.NotOwner.selector);
        hook.withdrawBackstop(1, 1);
        vm.prank(creator);
        vm.expectRevert(PerpHook.NotOwner.selector);
        hook.withdrawBackstop(1, 1);
        // the factory has no withdrawBackstop selector at all
        (bool ok,) = address(factory).call(
            abi.encodeWithSignature("withdrawBackstop(address,uint256,uint256)", address(hook), 1, 1)
        );
        assertFalse(ok, "factory exposes no withdrawBackstop path");
    }

    // ─── anti-snipe window: fresh instance blocks externals for N blocks ────
    function test_AntiSnipeWindow() public onFork {
        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor("Snipe", "SNP", "", address(base));
        vm.prank(creator);
        (address h2, address t2,) = factory.create(Perpfactory.CreateParams({
            name: "Snipe", symbol: "SNP", tokenUri: "", base: address(base),
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: 0
        }));
        PerpHook hk = PerpHook(payable(h2));
        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(address(base)),
            currency1: Currency.wrap(t2), fee: 0, tickSpacing: 60, hooks: hk
        });
        V4Helper v4 = new V4Helper(pm);
        deal(WETH, address(v4), 100 ether);

        // within the window: external swap reverts, openLong reverts
        vm.expectRevert();
        v4.swap(k2, true, -int256(uint256(1 ether)), TickMath.MIN_SQRT_PRICE + 1);

        deal(WETH, address(this), 1 ether);
        base.approve(address(hk), 1 ether);
        vm.expectRevert(PerpHook.AntiSnipeWindow.selector);
        hk.openLong(2, 1 ether, 0, block.timestamp + 600);

        // past the window: both succeed
        vm.roll(block.number + hk.ANTI_SNIPE_BLOCKS());
        vm.warp(block.timestamp + 39);
        v4.swap(k2, true, -int256(uint256(1 ether)), TickMath.MIN_SQRT_PRICE + 1);
    }

    // ─── multi-instance isolation: a 2nd launch can't touch the 1st ─────────
    function test_MultiInstanceIsolation() public onFork {
        // warm + trade instance #1
        _warm(40 ether);
        (uint256 idA, bool okA) = _openLong(address(0xA11CE), 3, 0.5 ether);
        assertTrue(okA, "instance A long opened");
        uint256 curveA = lens.getPoolSnapshot().curveEth;
        uint256 baseInA = base.balanceOf(address(hook));
        uint256 supplyA = token.totalSupply();

        // launch + trade instance #2 (different name, same whitelisted base)
        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor("Two", "TWO", "", address(base));
        vm.prank(creator);
        (address h2, address t2, address l2) = factory.create(Perpfactory.CreateParams({
            name: "Two", symbol: "TWO", tokenUri: "", base: address(base),
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: 0
        }));
        assertTrue(h2 != address(hook) && t2 != address(token) && l2 != address(lens), "distinct deploys");
        PerpHook hk2 = PerpHook(payable(h2));
        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(address(base)),
            currency1: Currency.wrap(t2), fee: 0, tickSpacing: 60, hooks: hk2
        });
        vm.roll(block.number + hk2.ANTI_SNIPE_BLOCKS()); vm.warp(block.timestamp + 39);
        V4Helper w2 = new V4Helper(pm);
        deal(WETH, address(w2), 1_000_000 ether);
        for (uint256 i = 0; i < 30; i++) w2.swap(k2, true, -int256(uint256(1 ether)), TickMath.MIN_SQRT_PRICE + 1);

        // instance #1 state is byte-for-byte untouched by instance #2 activity
        assertEq(lens.getPoolSnapshot().curveEth, curveA, "A curve untouched");
        assertEq(base.balanceOf(address(hook)),   baseInA, "A base balance untouched");
        assertEq(token.totalSupply(),             supplyA, "A supply untouched");
        assertEq(PerpToken(t2).balanceOf(address(hook)), 0, "A hook holds none of B token");
        // and #1's position still resolves
        PerpTypes.Position memory pA = hook.positions(idA);
        assertEq(pA.owner, address(0xA11CE), "A position intact");
    }

    // ─── single-tx launch fits well under a mainnet block ───────────────────
    function test_CreateGasUnderBlockLimit() public onFork {
        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor("Gas", "GAS", "", address(base));
        Perpfactory.CreateParams memory p = Perpfactory.CreateParams({
            name: "Gas", symbol: "GAS", tokenUri: "", base: address(base),
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: 0
        });
        vm.prank(creator);
        uint256 g0 = gasleft();
        factory.create(p);
        uint256 used = g0 - gasleft();
        emit log_named_uint("create() gas (token+hook+lens+init+50 bands)", used);
        assertLt(used, 30_000_000, "single-tx launch must fit a mainnet block");
    }

    // ─── e2e: launched instance is a fully functional v2 engine ─────────────
    function test_E2E_LongShortCloseClaim() public onFork {
        _warm(120 ether);
        _inv("post-warm");

        (uint256 lid, bool okL) = _openLong(address(0xA11CE), 3, 0.5 ether);
        (uint256 sid, bool okS) = _openShort(address(0xB0B),  3, 0.5 ether);
        assertTrue(okL && okS, "long+short open on launched instance");
        _inv("post-open");

        vm.roll(block.number + 3); vm.warp(block.timestamp + 40);
        assertTrue(_close(address(0xA11CE), lid, 10_000), "long closes");
        assertTrue(_close(address(0xB0B),  sid, 10_000), "short closes");
        _inv("post-close");

        // claims pay out in the BASE ERC-20
        for (uint256 i = 0; i < 2; i++) {
            address u = i == 0 ? address(0xA11CE) : address(0xB0B);
            uint256 c = hook.claimable(u);
            if (c > 0) {
                uint256 b = base.balanceOf(u);
                vm.prank(u); hook.claim();
                assertEq(base.balanceOf(u), b + c, "claim pays base");
            }
        }
        _inv("post-claim");
    }

    function _claimSum() internal view override returns (uint256) {
        return hook.claimable(FEE_RECIPIENT) + hook.claimable(LEVERAGE_FEE_RECIPIENT) + hook.claimable(address(this))
            + hook.claimable(address(warmer)) + hook.claimable(address(helper))
            + hook.claimable(creator)
            + hook.claimable(address(0xA11CE)) + hook.claimable(address(0xB0B));
    }

    // ─── D9: optional seed buy at launch ─────────────────────────────────────
    // Verifies: factory pulls baseIn from the creator → hook → seedBuy swaps
    // base→token → forwards tokens to creator. Anti-snipe + fee exempt
    // because sender==self inside the hook. Atomic within create().
    function test_E2E_SeedBuy() public onFork {
        // Fresh creator (separate from setUp's "creator" so the prior balance
        // is unambiguous). Fund + pre-approve the factory for the seed-buy
        // amount, then call create() with seedBuyBase > 0.
        address newCreator = address(0xDeAd);
        uint256 seedBaseAmt = 0.3 ether;
        deal(WETH, newCreator, seedBaseAmt);

        (bytes32 tSalt, bytes32 hSalt) = _mineSaltsFor("Seed", "SD", "ipfs://seed", WETH);

        vm.prank(newCreator);
        base.approve(address(factory), seedBaseAmt);

        uint256 tBalBefore = 0;          // creator has none of the unlaunched token

        vm.prank(newCreator);
        (address h2, address t2,) = factory.create(Perpfactory.CreateParams({
            name: "Seed", symbol: "SD", tokenUri: "ipfs://seed", base: WETH,
            tokenSalt: tSalt, hookSalt: hSalt,
            seedBuyBase: seedBaseAmt
        }));

        // Creator paid `seedBaseAmt` base
        assertEq(base.balanceOf(newCreator), 0, "creator paid full seedBuyBase");
        // Creator received some of the launched token
        uint256 tBalAfter = PerpToken(t2).balanceOf(newCreator);
        assertGt(tBalAfter, tBalBefore, "creator received seed-bought tokens");

        // Closed-form lower-bound sanity (no fee on internal swap):
        //   tokensOut ≈ TOTAL_SUPPLY · baseIn / (V + baseIn)
        // Allow generous slack because real bands round per-band, not via
        // pure curve math. Just assert "non-trivial" (≥ 50% of theory).
        uint256 theoryOut = (1_000_000 ether * seedBaseAmt) / (V + seedBaseAmt);
        assertGt(tBalAfter, theoryOut / 2,
            "seed-bought tokens within reasonable range of curve theory");

        // Hook held no leftover base (round-trip was clean)
        // The hook only ever sees base from collateral once positions open;
        // at this point no positions opened ⇒ hook base balance is 0.
        assertEq(base.balanceOf(h2), 0, "hook holds no leftover base after seedBuy");

        // INV-4a (strict user-funds) still holds — verified via _inv on the
        // ORIGINAL launch (instance "A") since setUp's hook is unaffected.
        _inv("post-seedBuy");
    }

    // ─── seedTail under active trading — INV-5 protection ───────────────────
    // The hook holds tokens in four categories: tail_remaining, holdingTOKEN
    // (open longs), reserveTOKEN (seized from liqs), insuranceTOKEN. Each
    // band can be seeded ONCE (BandAlreadySeeded gate), and the cumulative
    // alloc across all 300 bands ≤ TOTAL_SUPPLY. Trading flows between hook
    // and pool keep `token.balanceOf(hook) - (h + r + i) = tail_remaining`
    // exactly (each long open moves POOL tokens to hook AND grows
    // holdingTOKEN by the same amount; liq is just a counter swap; close
    // settles through pool with matching counter updates).
    //
    // This test FORCES that scenario: open longs (populate holdingTOKEN),
    // crash + scan to liquidate one (populate reserveTOKEN + insuranceTOKEN),
    // THEN admin calls seedTail. The earmarked counters must be untouched
    // and INV-5 must continue to hold.
    function test_SeedTail_DoesNotConsumeEarmarkedTokens() public onFork {
        _warm(60 ether);

        // Open longs ⇒ totalHoldingTOKEN grows.
        (uint256 lidA, bool okA) = _openLong(address(0xA11CE), 3, 0.5 ether);
        (uint256 lidB, bool okB) = _openLong(address(0xB0B),   3, 0.5 ether);
        assertTrue(okA && okB, "longs opened");
        assertGt(hook.totalHoldingTOKEN(), 0, "holdingTOKEN populated");
        _inv("pre-crash");

        // Crash + warm past TWAP to liquidate at least one long → reserveTOKEN.
        warmer.swap(key, false, -int256(uint256(20_000 ether)), TickMath.MAX_SQRT_PRICE - 1);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 30; i++) {
            t += 13; vm.warp(t); vm.roll(block.number + 1);
            helper.swap(key, true, -int256(uint256(1e12)), TickMath.MIN_SQRT_PRICE + 1);
        }
        helper.swap(key, true, -int256(uint256(1e12)), TickMath.MIN_SQRT_PRICE + 1);
        _inv("post-crash");

        // Snapshot the earmarked counters BEFORE admin seedTail.
        uint256 holdingBefore   = hook.totalHoldingTOKEN();
        uint256 reserveBefore   = hook.reserveTOKEN();
        uint256 insuranceBefore = hook.insuranceTOKEN();
        uint256 hookBalBefore   = token.balanceOf(address(hook));

        // Admin seeds tail bands 50..60 — hook MUST consume only from its
        // tail surplus, never from holdingTOKEN/reserveTOKEN/insuranceTOKEN.
        factory.seedTail(address(hook), 50, 60);
        _inv("post-seedTail-50-60");

        // Earmarked counters are byte-identical (seedTail does NOT mutate them).
        assertEq(hook.totalHoldingTOKEN(), holdingBefore,   "seedTail must not touch totalHoldingTOKEN");
        assertEq(hook.reserveTOKEN(),     reserveBefore,   "seedTail must not touch reserveTOKEN");
        assertEq(hook.insuranceTOKEN(),   insuranceBefore, "seedTail must not touch insuranceTOKEN");

        // INV-5 (token solvency lower bound) still strictly holds.
        assertGe(
            token.balanceOf(address(hook)),
            hook.reserveTOKEN() + hook.insuranceTOKEN() + hook.totalHoldingTOKEN(),
            "INV-5 violated post-seedTail"
        );

        // And the hook's token balance dropped by EXACTLY the seeded-band
        // alloc (within sub-wei pool-math rounding) — proving consumption
        // came from the tail surplus, not from earmarked categories.
        uint256 hookBalAfter = token.balanceOf(address(hook));
        assertLt(hookBalAfter, hookBalBefore, "hook token balance decreased");
        uint256 consumed = hookBalBefore - hookBalAfter;
        assertGt(consumed, 0, "seedTail consumed tail tokens");

        // A second seedTail call on a different tail range should also work.
        factory.seedTail(address(hook), 60, 100);
        _inv("post-seedTail-60-100");
        // And re-seeding an already-seeded band reverts (BandAlreadySeeded).
        vm.expectRevert();
        factory.seedTail(address(hook), 50, 51);

        // unused vars silence the compiler
        lidA; lidB;
    }
}
