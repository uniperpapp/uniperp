// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @title PerpTypes — shared structs/enums for the Hype perp.
/// @notice All mutable hook state lives in one `PerpState` struct stored once
///         in the hook; external delegate-libraries take `PerpState storage`
///         so their signatures stay clean. See PERP_DESIGN.md.
library PerpTypes {
    enum Side { LONG, SHORT }

    enum Action { SEED_BANDS, OPEN_LONG, OPEN_SHORT, CLOSE, REBALANCE, SEED_BUY }

    enum HistoryKind { FullClose, Liquidated }

    /// @notice Immutable fee/cap config the hook passes into handler libs
    ///         (avoids long arg lists; libs can't read hook constants).
    struct Cfg {
        uint256 longCapBps;
        uint256 shortCapBps;
        uint256 maxBorrowBands;
        uint256 numBands;
        uint32  twapSeconds;
        uint256 maxBorrowPerBlock;
        uint256 borrowFeeBps;
        uint256 closeFeeBps;
        uint256 badDebtThreshold;
        uint256 insuranceBpsHigh;
        uint256 insuranceBpsLow;
        uint256 liqHealthBps;
        uint16  maxLeverage;
    }

    /// @notice One v4 band. A band is either "passed" (curve above it → ~100%
    ///         ETH, lends to LONGS) or "ahead" (~100% TOKEN, lends to SHORTS);
    ///         it transitions as curveEth moves, so it carries both sides'
    ///         accounting. `*Shortfall` = bad-debt portion of the matching
    ///         `borrowed*` (cap check uses borrowed − shortfall = live owed).
    struct Band {
        int24   v4TickLower;
        int24   v4TickUpper;
        uint128 liquidity;
        uint256 borrowedETH;            // long side: ETH lent out
        uint256 realizedShortfallETH;   // long side: realized bad debt
        uint256 borrowedTOKEN;          // short side: TOKEN lent out
        uint256 realizedShortfallTOKEN; // short side: realized bad debt
    }

    /// @notice A leveraged position. Side-specific fields:
    ///   LONG  → debtETH owed to bands, holdingTOKEN held by hook
    ///   SHORT → debtTOKEN owed to bands, heldETH held by hook
    struct Position {
        address owner;
        Side    side;
        uint256 collateralETH;       // ETH posted (minus borrow fee), both sides
        uint256 debtETH;             // LONG: ETH owed to bands
        uint256 debtTOKEN;           // SHORT: TOKEN owed to bands
        uint256 holdingTOKEN;        // LONG: TOKEN held
        uint256 heldETH;             // SHORT: ETH held (collateral + sale proceeds)
        uint160 openSqrtPriceX96;
        uint8   leverage;            // 2..3
        uint64  openedAtBlock;
        uint128 realizedOut;         // lifetime payout pulled via prior partial closes
    }

    struct ClosedPositionRecord {
        uint64  timestamp;
        uint64  positionId;
        uint8   leverage;
        Side    side;
        HistoryKind kind;
        uint128 collateralETH;
        uint128 amountIn;   // tokens (long) / eth (short) consumed
        uint128 amountOut;  // lifetime payout returned
    }

    /// @notice TWAP ring observation. Liquidation health AND borrow eligibility
    ///         both read the TWAP tick — a single-block flash move can't shift
    ///         it, which is the core anti-manipulation primitive.
    struct Observation {
        uint32 timestamp;
        int56  tickCumulative;
        int24  tick;
        bool   initialized;
    }

    uint16 internal constant OBS_BUFFER_SIZE = 64;

    /// @notice The entire mutable state of the hook, stored once.
    struct PerpState {
        // ── pool lifecycle ──
        PoolKey poolKey;
        bool    poolInitialized;
        bool    tradingEnabled;
        bool    paused;            // owner emergency stop — blocks NEW opens only
        uint256 bandsSeededCount;
        uint64  launchBlock;

        // ── per-launch curve immutables (set once at init; FACTORY) ──
        // `curveK` MUST equal PerpCurve.deriveK(curveV) — enforced by the hook.
        uint256 curveV;          // virtual reserve V, in base-token units
        uint256 curveK;          // = TOTAL_SUPPLY · curveV / 1e18
        uint256 curveTickWidth;  // cumulative-base width per band W

        // ── bands & positions ──
        mapping(uint256 => Band) bands;
        mapping(uint256 => Position) positions;
        mapping(address => uint256[]) userPositions;
        mapping(uint256 => uint256) userPosIndex;
        uint256[] openIds;
        mapping(uint256 => uint256) openIdIndex;
        mapping(address => ClosedPositionRecord[]) userHistory;
        uint256 iterCursor;
        uint256 nextPositionId;

        // ── aggregates ──
        uint256 totalDebtETH;      // Σ long debt
        uint256 totalDebtTOKEN;    // Σ short debt
        uint256 totalHoldingTOKEN; // Σ long holdings
        uint256 totalHeldETH;      // Σ short held ETH
        uint256 totalBadDebtETH;   // long-side realized bad debt
        uint256 totalBadDebtTOKEN; // short-side realized bad debt

        // ── reserve & insurance (per-instance, real assets) ──
        uint256 reserveETH;        // seized from liquidated shorts → funds new longs
        uint256 reserveTOKEN;      // seized from liquidated longs  → funds new shorts
        uint256 insuranceETH;
        uint256 insuranceTOKEN;

        // ── pull payouts ──
        mapping(address => uint256) claimable;

        // ── TWAP ring ──
        Observation[OBS_BUFFER_SIZE] obs;
        uint16 obsIndex;

        // ── throttles ──
        uint64  lastLiqBlock;
        uint16  liqsThisBlock;
        uint64  lastBorrowBlock;
        uint128 borrowedThisBlock;  // ETH-equiv, both sides, incl. reserve draws
        bool    inLiquidation;
    }
}
