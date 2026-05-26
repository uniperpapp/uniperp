// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title  PerpCurve — bonding-curve ↔ Uniswap v4 tick mapping.
/// @notice The bonding curve `realTokens × (V + base) = K` is realized as N
///         v4 LP positions ("bands"). Band i covers cumulative pool base
///         [W·i, W·(i+1)] (W = cp.tickWidth), seeded with the token slice the
///         curve sells across that range.
///
///         FACTORY CHANGE: `V`, `K`, `tickWidth` are no longer compile-time
///         constants — they are per-launch immutables carried in `CurveParams`
///         and threaded into every fn. `TOTAL_SUPPLY` and `TICK_SPACING` stay
///         protocol-wide constants. The curve is self-similar in V; opening
///         FDV ∝ V. K is always derived from V (`deriveK`) so the
///         `realTokens(0) = TOTAL_SUPPLY` identity holds for every launch.
///         Pure-math library (no bytecode footprint — inlined).
library PerpCurve {
    uint256 internal constant TOTAL_SUPPLY = 1_000_000 ether; // 1M supply (fixed, all launches)
    int24   internal constant TICK_SPACING = 60;              // fixed, all launches

    /// @notice Per-launch curve immutables. Set once by the factory, stored on
    ///         the hook, passed into every curve call. `k` MUST equal
    ///         `deriveK(v)` (the hook/factory enforces this at construction).
    struct CurveParams {
        uint256 v;          // virtual reserve V, in base-token units
        uint256 k;          // = TOTAL_SUPPLY · v / 1e18
        uint256 tickWidth;  // cumulative-base width per band W
    }

    error InvalidBand();

    /// @notice K such that realTokens(base=0) == TOTAL_SUPPLY for this V.
    function deriveK(uint256 v) internal pure returns (uint256) {
        return (TOTAL_SUPPLY * v) / 1 ether;
    }

    /// @notice [lo, hi) cumulative-pool-base range covered by band `bandId`.
    function bandEthRange(uint256 bandId, CurveParams memory cp)
        internal pure returns (uint256 lo, uint256 hi)
    {
        lo = cp.tickWidth * bandId;
        hi = cp.tickWidth * (bandId + 1);
    }

    /// @notice Token allocation for band `bandId`:
    ///         alloc = K·1e18/(V+lo) − K·1e18/(V+hi). Σ over bands → TOTAL_SUPPLY.
    function loopAllocForBand(uint256 bandId, CurveParams memory cp)
        internal pure returns (uint256 alloc)
    {
        uint256 lo = cp.tickWidth * bandId;
        uint256 hi = cp.tickWidth * (bandId + 1);
        uint256 remainingLo = FullMath.mulDiv(cp.k, 1e18, cp.v + lo);
        uint256 remainingHi = FullMath.mulDiv(cp.k, 1e18, cp.v + hi);
        alloc = remainingLo - remainingHi;
    }

    /// @notice v4 sqrtPriceX96 at cumulative pool base `e`.
    ///         v4Price = K·1e18/(V+e)² ⟹ sqrtPriceX96 = sqrt(K·1e18)·2^96/(V+e).
    function sqrtPriceX96AtEth(uint256 e, CurveParams memory cp)
        internal pure returns (uint160 sqrtPriceX96)
    {
        uint256 result = FullMath.mulDiv(sqrt(cp.k * 1e18), 1 << 96, cp.v + e);
        require(result <= type(uint160).max, "sqrtPriceOverflow");
        sqrtPriceX96 = uint160(result);
    }

    /// @notice v4 tick range for band `bandId`. Higher pool base → lower v4
    ///         price → lower tick, so tickLower = tick(hi), tickUpper = tick(lo).
    function bandToV4Ticks(uint256 bandId, CurveParams memory cp)
        internal pure returns (int24 tickLower, int24 tickUpper)
    {
        (uint256 lo, uint256 hi) = bandEthRange(bandId, cp);
        int24 tickHi = TickMath.getTickAtSqrtPrice(sqrtPriceX96AtEth(lo, cp));
        int24 tickLo = TickMath.getTickAtSqrtPrice(sqrtPriceX96AtEth(hi, cp));
        tickLower = _alignDown(tickLo, TICK_SPACING);
        tickUpper = _alignUp(tickHi, TICK_SPACING);
        if (tickLower >= tickUpper) revert InvalidBand();
    }

    /// @notice L to deposit `tokenAmount` token1 single-sided (current ≤ tickLower).
    function liquidityForLoopOnly(int24 tickLower, int24 tickUpper, uint256 tokenAmount)
        internal pure returns (uint128 liquidity)
    {
        return LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            tokenAmount
        );
    }

    /// @notice L to deposit `ethAmount` token0 single-sided (current ≤ tickLower).
    function liquidityForEthOnly(int24 tickLower, int24 tickUpper, uint256 ethAmount)
        internal pure returns (uint128 liquidity)
    {
        return LiquidityAmounts.getLiquidityForAmount0(
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            ethAmount
        );
    }

    /// @notice Inverse of sqrtPriceX96AtEth: cumulative pool base implied by a price.
    function ethAtSqrtPrice(uint160 sqrtPriceX96, CurveParams memory cp)
        internal pure returns (uint256 e)
    {
        uint256 vPlusE = FullMath.mulDiv(sqrt(cp.k * 1e18), 1 << 96, sqrtPriceX96);
        e = vPlusE > cp.v ? vPlusE - cp.v : 0;
    }

    /// @notice TOKEN value in base at a given sqrtPriceX96, overflow-safe.
    ///         value = tokenAmount × (2^96/sqrtP)².  (V/K-free — pure ratio.)
    function tokenValueInEth(uint256 tokenAmount, uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 step1 = FullMath.mulDiv(tokenAmount, 1 << 96, uint256(sqrtPriceX96));
        return FullMath.mulDiv(step1, 1 << 96, uint256(sqrtPriceX96));
    }

    /// @notice Inverse: TOKEN amount whose value is `ethValue` at sqrtPriceX96.
    ///         token = ethValue × (sqrtP/2^96)².  (V/K-free — pure ratio.)
    function ethValueToToken(uint256 ethValue, uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 step1 = FullMath.mulDiv(ethValue, uint256(sqrtPriceX96), 1 << 96);
        return FullMath.mulDiv(step1, uint256(sqrtPriceX96), 1 << 96);
    }

    /// @dev Babylonian integer sqrt.
    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }

    function _alignDown(int24 t, int24 spacing) private pure returns (int24) {
        int24 r = t % spacing;
        if (r < 0) r += spacing;
        return t - r;
    }

    function _alignUp(int24 t, int24 spacing) private pure returns (int24) {
        int24 down = _alignDown(t, spacing);
        return down == t ? t : down + spacing;
    }
}
