// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////
  perpfactory — pure-math curve sweep (v2 port, hardened for the factory).

  The factory lets each launch pick V within per-base whitelist bounds. This
  sweeps V across the realistic launchpad range and asserts, for every V:
    • the inline curve math == PerpCurve.{deriveK,sqrtPriceX96AtEth} EXACTLY
      (proves the parameterized library is the same formula as v2's), and
    • genesis sqrtP (e=0, the highest price / nearest a v4 bound) stays
      strictly below MAX_SQRT_PRICE and its tick is inside MAX_TICK with
      room — i.e. any whitelist that stays in this band is launch-safe.
  No fork, instant.
//////////////////////////////////////////////////////////////*/

import "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PerpCurve} from "../src/library/PerpCurve.sol";

contract CurveSweepTest is Test {
    uint256 constant TS  = 1_000_000 ether;     // 1e24 (fixed, all launches)
    uint256 constant Q96 = 1 << 96;

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2; y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }
    function _sqrtP(uint256 V, uint256 eth) internal pure returns (uint256) {
        uint256 K = (TS * V) / 1e18;                 // == PerpCurve.deriveK(V)
        return FullMath.mulDiv(_sqrt(K * 1e18), Q96, V + eth);
    }
    function _tickOf(uint256 sp) internal pure returns (int256) {
        if (sp <= TickMath.MIN_SQRT_PRICE) return type(int256).min;
        if (sp >= TickMath.MAX_SQRT_PRICE) return type(int256).max;
        return int256(TickMath.getTickAtSqrtPrice(uint160(sp)));
    }

    function test_SweepV() public pure {
        int256 MAXT = int256(TickMath.MAX_TICK);
        uint256[7] memory Vs =
            [uint256(3.5 ether), 4 ether, 5 ether, 6 ether, 7 ether, 8 ether, 10 ether];
        for (uint256 i = 0; i < Vs.length; i++) {
            uint256 V = Vs[i];

            // 1. the parameterized library MUST equal the inline v2 formula.
            PerpCurve.CurveParams memory cp =
                PerpCurve.CurveParams(V, PerpCurve.deriveK(V), 5 ether);
            assertEq(PerpCurve.deriveK(V), (TS * V) / 1e18, "deriveK == TS*V/1e18");
            assertEq(uint256(PerpCurve.sqrtPriceX96AtEth(0, cp)), _sqrtP(V, 0),
                "lib sqrtP(e=0) == inline");
            assertEq(uint256(PerpCurve.sqrtPriceX96AtEth(14 ether, cp)), _sqrtP(V, 14 ether),
                "lib sqrtP(e=14) == inline");

            // 2. genesis price is launch-safe (strictly inside v4 bounds).
            uint256 sp0 = _sqrtP(V, 0);
            assertLt(sp0, TickMath.MAX_SQRT_PRICE, "genesis sqrtP < MAX_SQRT_PRICE");
            int256 t0 = _tickOf(sp0);
            assertTrue(t0 != type(int256).max, "genesis tick inside MAX_TICK");
            assertGt(MAXT - t0, int256(60), "genesis tick has >= 1 tickSpacing of room");

            console2.log("V/1e16 =", V / 1e16);
            console2.log("  sqrtP(e=0) =", sp0);
            console2.logInt(t0);
            console2.logInt(_tickOf(_sqrtP(V, 1500 ether)));
        }
    }
}
