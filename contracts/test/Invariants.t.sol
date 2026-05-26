// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////
  perpfactory — two-sided conservation invariant battery (v2 port).

  Identical battery to the v2 Invariants suite, run on an instance launched
  through Perpfactory.create() with the exact v2 curve params. The ONLY
  adaptation: INV-4 ETH-solvency is measured as the hook's BASE-ERC-20
  balance (the engine's ETH side is now an ERC-20 base). If any invariant
  drifts, the ERC-20 refactor was NOT faithful to v2 → DOES NOT SHIP.

    INV-1 supply == 1_000_000e18
    INV-2 Σ realizedShortfallETH   == totalBadDebtETH
    INV-3 Σ realizedShortfallTOKEN == totalBadDebtTOKEN
    INV-4 base.balanceOf(hook) >= reserveETH + insuranceETH + Σ claimable
    INV-5 token.balanceOf(hook) >= reserveTOKEN + insuranceTOKEN + Σ holding
    INV-6 Σ borrowedETH   >= Σ realizedShortfallETH
    INV-7 Σ borrowedTOKEN >= Σ realizedShortfallTOKEN
//////////////////////////////////////////////////////////////*/

import "./Harness.sol";

contract InvariantsTest is PerpHarness {
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    function _claimSum() internal view override returns (uint256) {
        return hook.claimable(FEE_RECIPIENT) + hook.claimable(LEVERAGE_FEE_RECIPIENT) + hook.claimable(address(this))
            + hook.claimable(address(warmer)) + hook.claimable(address(helper))
            + hook.claimable(creator) + hook.claimable(alice) + hook.claimable(bob);
    }

    function test_Invariants_LongLifecycle() public onFork {
        _warm(120 ether);
        _inv("post-warm");

        (uint256 id, bool ok) = _openLong(alice, 3, 0.5 ether);
        assertTrue(ok, "long opened");
        _inv("post-openLong");

        vm.roll(block.number + 3); vm.warp(block.timestamp + 40);
        _close(alice, id, 10_000);
        _inv("post-closeLong");
    }

    function test_Invariants_ShortLifecycle() public onFork {
        _warm(120 ether);
        _inv("post-warm");

        (uint256 id, bool ok) = _openShort(bob, 3, 0.5 ether);
        assertTrue(ok, "short opened");
        _inv("post-openShort");

        vm.roll(block.number + 3); vm.warp(block.timestamp + 40);
        _close(bob, id, 10_000);
        _inv("post-closeShort");
    }

    function test_Invariants_MixedThenCrash() public onFork {
        _warm(120 ether);
        _openLong(alice, 3, 0.5 ether);
        _openShort(bob,  3, 0.5 ether);
        _inv("post-mixed-open");

        // crash → long should become liquidatable; warm past TWAP; trigger scan
        warmer.swap(key, false, -int256(uint256(30_000 ether)), TickMath.MAX_SQRT_PRICE - 1);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 30; i++) {
            t += 13; vm.warp(t); vm.roll(block.number + 1);
            warmer.swap(key, true, -int256(uint256(1e12)), TickMath.MIN_SQRT_PRICE + 1);
        }
        warmer.swap(key, true, -int256(uint256(1e12)), TickMath.MIN_SQRT_PRICE + 1);
        _inv("post-crash-and-scan");
    }
}
