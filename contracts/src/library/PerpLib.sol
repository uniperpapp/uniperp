// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PerpCurve} from "./PerpCurve.sol";
import {PerpCore} from "./PerpCore.sol";
import {PerpTypes} from "../PerpTypes.sol";

interface IERC20Seed {
    function transfer(address, uint256) external returns (bool);
}

/// @title  PerpLib — external, hook-facing: seeding, TWAP ring, liquidation scan.
/// @notice Delegate-called by the hook (keeps the hook under EIP-170). Uses
///         PerpCore internals (inlined here). Liquidation SEIZES the whole
///         position into the reserve (no fire-sale) — the cascade fix.
library PerpLib {
    using StateLibrary for IPoolManager;
    using PerpCore for PerpTypes.PerpState;

    error TokenTransferFailed();

    event PositionLiquidated(uint256 indexed id, address indexed owner, PerpTypes.Side side);

    // ─── band seeding (TOKEN-only LP at the band's range) ───────────────────
    function seedSingleBand(PerpTypes.PerpState storage s, IPoolManager pm, address token, uint256 bandId)
        external returns (int24 tickLower, int24 tickUpper, uint128 liquidity)
    {
        require(s.bands[bandId].liquidity == 0, "seeded");
        PerpCurve.CurveParams memory cp = PerpCurve.CurveParams(s.curveV, s.curveK, s.curveTickWidth);
        (tickLower, tickUpper) = PerpCurve.bandToV4Ticks(bandId, cp);
        uint256 alloc = PerpCurve.loopAllocForBand(bandId, cp);
        liquidity = PerpCurve.liquidityForLoopOnly(tickLower, tickUpper, alloc);

        (BalanceDelta delta,) = pm.modifyLiquidity(
            s.poolKey,
            ModifyLiquidityParams({ tickLower: tickLower, tickUpper: tickUpper,
                liquidityDelta: int128(liquidity), salt: bytes32(0) }), "");
        int128 a1 = delta.amount1();
        if (a1 < 0) {
            uint256 owed = uint256(uint128(-a1));
            pm.sync(s.poolKey.currency1);
            if (!IERC20Seed(token).transfer(address(pm), owed)) revert TokenTransferFailed();
            pm.settle();
        }
        s.bands[bandId] = PerpTypes.Band({
            v4TickLower: tickLower, v4TickUpper: tickUpper, liquidity: liquidity,
            borrowedETH: 0, realizedShortfallETH: 0, borrowedTOKEN: 0, realizedShortfallTOKEN: 0
        });
    }

    // ─── TWAP ring ──────────────────────────────────────────────────────────
    function seedTwap(PerpTypes.PerpState storage s, int24 tick, uint32 span) external {
        uint32 nowTs = uint32(block.timestamp);
        s.obs[0] = PerpTypes.Observation({
            timestamp: nowTs > span ? nowTs - span : 0, tickCumulative: 0, tick: tick, initialized: true });
        s.obs[1] = PerpTypes.Observation({
            timestamp: nowTs, tickCumulative: int56(tick) * int56(uint56(span)), tick: tick, initialized: true });
        s.obsIndex = 1;
    }

    function writeObservation(PerpTypes.PerpState storage s, IPoolManager pm, PoolId pid) external {
        uint32 nowTs = uint32(block.timestamp);
        PerpTypes.Observation memory last = s.obs[s.obsIndex];
        if (last.initialized && last.timestamp == nowTs) return;
        (, int24 curTick,,) = pm.getSlot0(pid);
        int56 newCum = last.initialized
            ? last.tickCumulative + int56(last.tick) * int56(uint56(nowTs - last.timestamp))
            : int56(0);
        uint16 nextIdx = uint16((uint256(s.obsIndex) + 1) % PerpTypes.OBS_BUFFER_SIZE);
        s.obs[nextIdx] = PerpTypes.Observation({ timestamp: nowTs, tickCumulative: newCum, tick: curTick, initialized: true });
        s.obsIndex = nextIdx;
    }

    /// @notice External TWAP view (hook delegate-calls this for getTwapTick).
    function twapTick(PerpTypes.PerpState storage s, uint32 secondsAgo) external view returns (int24, bool) {
        return PerpCore.twapTick(s, secondsAgo);
    }

    // ─── liquidation scan: TWAP-health gated, seize whole position → reserve ─
    function scanAndLiquidate(
        PerpTypes.PerpState storage s, IPoolManager pm, address token,
        uint256 liqHealthBps, uint32 twapSeconds,
        uint16 maxScan, uint16 maxLiqSwap, uint16 maxLiqBlock, uint256 numBands
    ) external {
        uint256 n = s.openIds.length;
        if (n == 0) return;
        (int24 tt, bool tok) = PerpCore.twapTick(s, twapSeconds);
        if (!tok) return;
        uint160 healthSqrtP = TickMath.getSqrtPriceAtTick(tt);

        if (uint64(block.number) != s.lastLiqBlock) { s.lastLiqBlock = uint64(block.number); s.liqsThisBlock = 0; }
        if (s.liqsThisBlock >= maxLiqBlock) return;
        uint256 blockRemaining = maxLiqBlock - s.liqsThisBlock;

        uint256 scanBudget = n < maxScan ? n : maxScan;
        uint256 maxLiq = scanBudget < maxLiqSwap ? scanBudget : maxLiqSwap;
        if (maxLiq > blockRemaining) maxLiq = blockRemaining;

        uint256[] memory toLiq = new uint256[](maxLiq);
        uint256 count;
        uint256 cursor = s.iterCursor % n;
        uint256 scanned;
        for (uint256 i = 0; i < scanBudget && count < maxLiq; i++) {
            uint256 pid = s.openIds[(cursor + i) % n];
            if (_unhealthy(s.positions[pid], healthSqrtP, liqHealthBps)) toLiq[count++] = pid;
            scanned = i + 1;
        }
        s.iterCursor = (cursor + scanned) % (n > 0 ? n : 1);
        if (count == 0) return;

        s.inLiquidation = true;
        for (uint256 i = 0; i < count; i++) _seize(s, toLiq[i], numBands);
        s.inLiquidation = false;
        s.liqsThisBlock += uint16(count);

        // Opportunistic insurance auto-heal after seizing.
        s.autoHeal(pm, token, numBands);
    }

    function _unhealthy(PerpTypes.Position storage p, uint160 sqrtP, uint256 liqBps) private view returns (bool) {
        if (p.owner == address(0)) return false;
        if (p.side == PerpTypes.Side.LONG) {
            if (p.debtETH == 0) return false;
            uint256 hv = PerpCurve.tokenValueInEth(p.holdingTOKEN, sqrtP);
            return (hv * 10_000) / p.debtETH < liqBps;
        } else {
            if (p.debtTOKEN == 0) return false;
            uint256 dv = PerpCurve.tokenValueInEth(p.debtTOKEN, sqrtP);
            if (dv == 0) return false;
            return (p.heldETH * 10_000) / dv < liqBps;
        }
    }

    /// @notice Seize the WHOLE position into the reserve. No fire-sale, no
    ///         penalty. The owed band side stays outstanding, now backed by
    ///         the seized asset in the reserve (converted later via internal
    ///         clearing / insurance auto-heal / owner rebalance).
    function _seize(PerpTypes.PerpState storage s, uint256 id, uint256 numBands) private {
        PerpTypes.Position storage p = s.positions[id];
        address pOwner = p.owner;
        PerpTypes.Side side = p.side;
        uint8 lev = p.leverage;
        uint256 col = p.collateralETH;

        if (side == PerpTypes.Side.LONG) {
            uint256 holding = p.holdingTOKEN;
            s.totalDebtETH      -= p.debtETH;
            s.totalHoldingTOKEN -= holding;
            s.reserveTOKEN      += holding;       // seized collateral → reserve
            // Bands still owed ETH; flag it (keeps band borrowable — §6.4) and
            // book provisional bad debt, healed when reserveTOKEN recycles.
            uint256 flagged = PerpCore.attributeBadDebtLong(s, p.debtETH, numBands);
            s.totalBadDebtETH += flagged;
            PerpCore.recordHistory(s, pOwner, id, lev, side, col, holding, 0, PerpTypes.HistoryKind.Liquidated);
        } else {
            uint256 held = p.heldETH;
            s.totalDebtTOKEN -= p.debtTOKEN;
            s.totalHeldETH   -= held;
            s.reserveETH     += held;             // seized collateral → reserve
            uint256 flaggedT = PerpCore.attributeBadDebtShort(s, p.debtTOKEN, numBands);
            s.totalBadDebtTOKEN += flaggedT;
            PerpCore.recordHistory(s, pOwner, id, lev, side, col, held, 0, PerpTypes.HistoryKind.Liquidated);
        }
        PerpCore.removePosition(s, id);
        emit PositionLiquidated(id, pOwner, side);
    }
}
