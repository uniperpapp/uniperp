// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PerpCurve} from "./PerpCurve.sol";
import {PerpTypes} from "../PerpTypes.sol";

interface IERC20Like {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
interface IStakingNotify { function notifyReward() external payable; }

/// @title  PerpCore — shared internal primitives (inlined into the handler libs).
/// @notice v4-touching helpers + accounting. `internal` so each external
///         handler-lib (PerpLong/Short/Reserve/Lib) inlines its own copy,
///         keeping the *hook* tiny. All functions run in the hook's context
///         (delegatecall) so address(this)==hook, balances/storage are the
///         hook's. See PERP_DESIGN.md §6 for the tick-gating derivation.
library PerpCore {
    using StateLibrary for IPoolManager;

    error ImpureBorrow();
    error TokenTransferFailed();

    uint256 internal constant DUST_TOL = 1 gwei;
    uint256 internal constant MIN_BAND_TAKE = 1e4;

    // ─── pool id ────────────────────────────────────────────────────────────
    function poolId(PerpTypes.PerpState storage s) internal view returns (PoolId) {
        return PoolIdLibrary.toId(s.poolKey);
    }

    function currentTick(PerpTypes.PerpState storage s, IPoolManager pm) internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(poolId(s));
    }

    function currentSqrtP(PerpTypes.PerpState storage s, IPoolManager pm) internal view returns (uint160 sp) {
        (sp,,,) = pm.getSlot0(poolId(s));
    }

    /// @dev Pay `amt` of the base (currency0, an ERC-20) to the pool using
    ///      the standard v4 sync→transfer→settle idiom.
    function _payBase(PerpTypes.PerpState storage s, IPoolManager pm, uint256 amt) internal {
        pm.sync(s.poolKey.currency0);
        if (!IERC20Like(Currency.unwrap(s.poolKey.currency0)).transfer(address(pm), amt)) revert TokenTransferFailed();
        pm.settle();
    }

    // ─── TWAP ring read (shared; inlined into PerpLib/Long/Short) ───────────
    function twapTick(PerpTypes.PerpState storage s, uint32 secondsAgo)
        internal view returns (int24 avgTick, bool ok)
    {
        PerpTypes.Observation memory cur = s.obs[s.obsIndex];
        if (!cur.initialized) return (0, false);
        uint32 endTime = cur.timestamp;
        if (endTime < secondsAgo) return (0, false);
        uint32 target = endTime - secondsAgo;
        PerpTypes.Observation memory past;
        bool found;
        for (uint256 i = 1; i < PerpTypes.OBS_BUFFER_SIZE; ++i) {
            uint256 idx = (uint256(s.obsIndex) + PerpTypes.OBS_BUFFER_SIZE - i) % PerpTypes.OBS_BUFFER_SIZE;
            PerpTypes.Observation memory o = s.obs[idx];
            if (!o.initialized) break;
            if (o.timestamp <= target) { past = o; found = true; break; }
        }
        if (!found) return (0, false);
        uint32 elapsed = endTime - past.timestamp;
        if (elapsed == 0) return (cur.tick, true);
        avgTick = int24((cur.tickCumulative - past.tickCumulative) / int56(uint56(elapsed)));
        ok = true;
    }

    // ─── hook-internal swaps (fee-exempt: sender==hook) ─────────────────────
    /// @notice §6.1-deep: prior-block spike guard. An open reverts if live spot
    ///         deviates more than ~50% (≈4055 ticks) from the most recent
    ///         observation from a STRICTLY PRIOR block. A flash attack is atomic
    ///         (1 block) and can only move the *current* block's price; the
    ///         prior block's recorded price is immutable. So a pumped/crashed
    ///         spot ≠ prior-block price → open blocked. Organic moves are
    ///         gradual block-to-block ⇒ legit opens pass even in wild markets;
    ///         the open's *own* price impact is unaffected (checked at entry,
    ///         before the leveraged swap). No TWAP-lag penalty, 3× preserved.
    int24 internal constant SPIKE_TOL_TICKS = 4055; // ~50% price

    /// @return tick of the most recent observation from a block strictly before
    ///         the current one (current-block obs excluded — that's where an
    ///         atomic attacker's pump lands). ok=false only if the ring has no
    ///         prior-block entry (never, post-init: seed obs have past stamps).
    function priorBlockTick(PerpTypes.PerpState storage s) internal view returns (int24 tick, bool ok) {
        uint32 nowTs = uint32(block.timestamp);
        for (uint256 i = 0; i < PerpTypes.OBS_BUFFER_SIZE; ++i) {
            uint256 idx = (uint256(s.obsIndex) + PerpTypes.OBS_BUFFER_SIZE - i) % PerpTypes.OBS_BUFFER_SIZE;
            PerpTypes.Observation memory o = s.obs[idx];
            if (!o.initialized) break;
            if (o.timestamp < nowTs) return (o.tick, true);
        }
        return (0, false);
    }

    /// @return true if `liveTick` deviates > SPIKE_TOL_TICKS from the prior
    ///         block's price (a same-block pump/crash). Reverts-worthy in opens.
    function isBlockSpike(PerpTypes.PerpState storage s, int24 liveTick) internal view returns (bool) {
        (int24 pt, bool ok) = priorBlockTick(s);
        if (!ok) return false; // no prior reference (pre-trade) → don't block
        int24 d = liveTick > pt ? liveTick - pt : pt - liveTick;
        return d > SPIKE_TOL_TICKS;
    }

    function swapEthForToken(PerpTypes.PerpState storage s, IPoolManager pm, uint256 ethIn, uint160 sqrtLimit)
        internal returns (uint256 tokensOut, uint256 ethSpent)
    {
        if (ethIn == 0) return (0, 0);
        BalanceDelta d = pm.swap(
            s.poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: sqrtLimit }),
            ""
        );
        int128 e = d.amount0();
        int128 t = d.amount1();
        if (e < 0) { ethSpent = uint256(uint128(-e)); _payBase(s, pm, ethSpent); }
        if (t > 0) { tokensOut = uint256(uint128(t)); pm.take(s.poolKey.currency1, address(this), tokensOut); }
    }

    /// @dev Exact-output ETH→TOKEN (buy exactly `tokenOut`). Used by short
    ///      close to repay an exact TOKEN debt. Hook-internal ⇒ fee-exempt.
    function swapEthForExactToken(PerpTypes.PerpState storage s, IPoolManager pm, uint256 tokenOut, uint256 ethBudget)
        internal returns (uint256 gotToken, uint256 ethSpent)
    {
        if (tokenOut == 0 || ethBudget == 0) return (0, 0);
        // Budget-bounded buy: the price after spending exactly `ethBudget` is
        // the swap limit, so v4 either fills `tokenOut` fully (cost ≤ budget,
        // change returned) or partial-fills at the limit (cost > budget: the
        // unbought remainder flows to the bad-debt path). Settle the EXACT
        // amount debited so there is never an unsettled delta.
        PerpCurve.CurveParams memory cp = PerpCurve.CurveParams(s.curveV, s.curveK, s.curveTickWidth);
        uint256 curEth = PerpCurve.ethAtSqrtPrice(currentSqrtP(s, pm), cp);
        uint160 lim = PerpCurve.sqrtPriceX96AtEth(curEth + ethBudget, cp);
        if (lim < TickMath.MIN_SQRT_PRICE + 1) lim = TickMath.MIN_SQRT_PRICE + 1;
        BalanceDelta d = pm.swap(
            s.poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: int256(tokenOut), sqrtPriceLimitX96: lim }),
            ""
        );
        int128 e = d.amount0();
        int128 t = d.amount1();
        if (e < 0) {
            ethSpent = uint256(uint128(-e));
            _payBase(s, pm, ethSpent);
        }
        if (t > 0) { gotToken = uint256(uint128(t)); pm.take(s.poolKey.currency1, address(this), gotToken); }
    }

    function swapTokenForEth(PerpTypes.PerpState storage s, IPoolManager pm, address token, uint256 tokenIn, uint160 limit)
        internal returns (uint256 ethOut, uint256 tokenSold)
    {
        if (tokenIn == 0) return (0, 0);
        BalanceDelta d = pm.swap(
            s.poolKey,
            SwapParams({ zeroForOne: false, amountSpecified: -int256(tokenIn), sqrtPriceLimitX96: limit }),
            ""
        );
        int128 t = d.amount1();
        int128 e = d.amount0();
        if (t < 0) {
            tokenSold = uint256(uint128(-t));
            pm.sync(s.poolKey.currency1);
            if (!IERC20Like(token).transfer(address(pm), tokenSold)) revert TokenTransferFailed();
            pm.settle();
        }
        if (e > 0) { ethOut = uint256(uint128(e)); pm.take(s.poolKey.currency0, address(this), ethOut); }
    }

    // ─── per-block borrow throttle (ETH-equiv, both sides incl. reserve) ────
    function resetBorrowBlock(PerpTypes.PerpState storage s) internal {
        if (uint64(block.number) != s.lastBorrowBlock) {
            s.lastBorrowBlock = uint64(block.number);
            s.borrowedThisBlock = 0;
        }
    }

    // ─── reserve-first draw ─────────────────────────────────────────────────
    function drawReserveETH(PerpTypes.PerpState storage s, uint256 need) internal returns (uint256 drawn) {
        drawn = s.reserveETH < need ? s.reserveETH : need;
        if (drawn > 0) s.reserveETH -= drawn;
    }

    function drawReserveTOKEN(PerpTypes.PerpState storage s, uint256 need) internal returns (uint256 drawn) {
        drawn = s.reserveTOKEN < need ? s.reserveTOKEN : need;
        if (drawn > 0) s.reserveTOKEN -= drawn;
    }

    // ─── LONG borrow walk: ETH-only removal from passed bands, TWAP-gated ───
    /// @param refTick = max(currentTick, twapTick) — pump-proof eligibility
    function borrowLongBands(
        PerpTypes.PerpState storage s, IPoolManager pm,
        int24 refTick, uint256 want, PerpTypes.Cfg memory cfg
    ) internal returns (uint256 totalFreed) {
        uint256 capPerBand = (s.curveTickWidth * cfg.longCapBps) / 10_000;
        uint256 remaining = want;
        uint256 slots;
        for (uint256 b = 0; b < cfg.numBands && remaining > DUST_TOL; b++) {
            if (slots >= cfg.maxBorrowBands) break;
            PerpTypes.Band storage band = s.bands[b];
            if (band.liquidity == 0) continue;
            if (band.v4TickLower <= refTick) continue;            // not passed under BOTH ticks
            uint256 liveOwed = band.borrowedETH > band.realizedShortfallETH
                ? band.borrowedETH - band.realizedShortfallETH : 0;
            if (liveOwed >= capPerBand) continue;
            uint256 avail = capPerBand - liveOwed;
            uint256 take  = remaining < avail ? remaining : avail;
            if (take < MIN_BAND_TAKE) continue;
            uint256 freed = _pullBandETH(s, pm, band, take); // isolated frame
            if (freed == 0) continue;
            totalFreed += freed;
            remaining = remaining > freed ? remaining - freed : 0;
            slots++;
        }
    }

    function _pullBandETH(PerpTypes.PerpState storage s, IPoolManager pm, PerpTypes.Band storage band, uint256 take)
        private returns (uint256 freed)
    {
        uint128 lRem = PerpCurve.liquidityForEthOnly(band.v4TickLower, band.v4TickUpper, take);
        if (lRem == 0 || lRem > band.liquidity) return 0;
        (BalanceDelta dd,) = pm.modifyLiquidity(
            s.poolKey,
            ModifyLiquidityParams({ tickLower: band.v4TickLower, tickUpper: band.v4TickUpper,
                liquidityDelta: -int256(uint256(lRem)), salt: bytes32(0) }), "");
        if (dd.amount0() <= 0 || dd.amount1() != 0) revert ImpureBorrow();
        freed = uint256(uint128(dd.amount0()));
        pm.take(s.poolKey.currency0, address(this), freed);
        band.liquidity   -= lRem;
        band.borrowedETH += freed;
    }

    // ─── SHORT borrow walk: TOKEN-only removal from ahead bands, TWAP-gated ─
    /// @param refTick = min(currentTick, twapTick) — dump-proof eligibility
    function borrowShortBands(
        PerpTypes.PerpState storage s, IPoolManager pm, address /*token*/,
        int24 refTick, uint256 wantTok, PerpTypes.Cfg memory cfg
    ) internal returns (uint256 totalFreedTok) {
        uint256 remaining = wantTok;
        uint256 slots;
        PerpCurve.CurveParams memory cp = PerpCurve.CurveParams(s.curveV, s.curveK, s.curveTickWidth);
        for (uint256 b = 0; b < cfg.numBands && remaining > 0; b++) {
            if (slots >= cfg.maxBorrowBands) break;
            PerpTypes.Band storage band = s.bands[b];
            if (band.liquidity == 0) continue;
            if (band.v4TickUpper >= refTick) continue;            // not ahead under BOTH ticks
            uint256 capTok = (PerpCurve.loopAllocForBand(b, cp) * cfg.shortCapBps) / 10_000;
            uint256 liveOwed = band.borrowedTOKEN > band.realizedShortfallTOKEN
                ? band.borrowedTOKEN - band.realizedShortfallTOKEN : 0;
            if (liveOwed >= capTok) continue;
            uint256 avail = capTok - liveOwed;
            uint256 take  = remaining < avail ? remaining : avail;
            if (take < MIN_BAND_TAKE) continue;
            uint256 freed = _pullBandTOKEN(s, pm, band, take); // isolated frame
            if (freed == 0) continue;
            totalFreedTok += freed;
            remaining = remaining > freed ? remaining - freed : 0;
            slots++;
        }
    }

    function _pullBandTOKEN(PerpTypes.PerpState storage s, IPoolManager pm, PerpTypes.Band storage band, uint256 take)
        private returns (uint256 freed)
    {
        uint128 lRem = PerpCurve.liquidityForLoopOnly(band.v4TickLower, band.v4TickUpper, take);
        if (lRem == 0 || lRem > band.liquidity) return 0;
        (BalanceDelta dd,) = pm.modifyLiquidity(
            s.poolKey,
            ModifyLiquidityParams({ tickLower: band.v4TickLower, tickUpper: band.v4TickUpper,
                liquidityDelta: -int256(uint256(lRem)), salt: bytes32(0) }), "");
        if (dd.amount1() <= 0 || dd.amount0() != 0) revert ImpureBorrow(); // TOKEN-only
        freed = uint256(uint128(dd.amount1()));
        pm.take(s.poolKey.currency1, address(this), freed);
        band.liquidity     -= lRem;
        band.borrowedTOKEN += freed;
    }

    // ─── refill (close/liquidation = isHeal:false; donation/insurance = true)
    function refillLongBands(
        PerpTypes.PerpState storage s, IPoolManager pm, uint256 budget, bool isHeal, uint256 numBands
    ) internal returns (uint256 spent) {
        if (budget == 0) return 0;
        int24 ct = currentTick(s, pm);
        uint256 remaining = budget;
        for (uint256 i = numBands; i > 0 && remaining > 0; i--) {
            PerpTypes.Band storage band = s.bands[i - 1];
            // isHeal (insurance/rebalance): target ONLY bad debt — repay
            // realizedShortfall, never a healthy position's live band debt.
            // !isHeal (close/liquidation): repay LIVE owed only (= borrowed −
            // realizedShortfall). The shortfall slice is a hole only insurance
            // fills; letting a closer plug it breaks INV6 and double-pays heal.
            uint256 target = isHeal
                ? band.realizedShortfallETH
                : (band.borrowedETH > band.realizedShortfallETH ? band.borrowedETH - band.realizedShortfallETH : 0);
            if (target == 0) continue;
            if (band.v4TickLower <= ct) continue;                 // only passed bands
            uint256 put  = remaining < target ? remaining : target;
            uint128 lAdd = PerpCurve.liquidityForEthOnly(band.v4TickLower, band.v4TickUpper, put);
            if (lAdd == 0) continue;
            (BalanceDelta dd,) = pm.modifyLiquidity(
                s.poolKey,
                ModifyLiquidityParams({ tickLower: band.v4TickLower, tickUpper: band.v4TickUpper,
                    liquidityDelta: int256(uint256(lAdd)), salt: bytes32(0) }), "");
            int128 o0 = dd.amount0();
            if (o0 < 0) {
                uint256 sp = uint256(uint128(-o0));
                _payBase(s, pm, sp);
                band.liquidity += lAdd;
                band.borrowedETH = band.borrowedETH >= sp ? band.borrowedETH - sp : 0;
                if (isHeal) {
                    // sp ≤ realizedShortfall by construction (target capped it)
                    band.realizedShortfallETH = band.realizedShortfallETH >= sp ? band.realizedShortfallETH - sp : 0;
                }
                remaining = remaining >= sp ? remaining - sp : 0;
                spent += sp; // == shortfall-cleared in the heal path → invariant exact
            }
        }
    }

    function refillShortBands(
        PerpTypes.PerpState storage s, IPoolManager pm, address token, uint256 budgetTok, bool isHeal, uint256 numBands
    ) internal returns (uint256 spentTok) {
        if (budgetTok == 0) return 0;
        int24 ct = currentTick(s, pm);
        uint256 remaining = budgetTok;
        for (uint256 b = 0; b < numBands && remaining > 0; b++) {
            PerpTypes.Band storage band = s.bands[b];
            // isHeal (insurance/rebalance): target ONLY bad debt — repay
            // realizedShortfallTOKEN, never a healthy position's live band debt.
            // !isHeal (close/liquidation): repay LIVE owed only (= borrowed −
            // realizedShortfall). The shortfall slice is a hole only insurance
            // fills; letting a closer plug it breaks INV7 and double-pays heal.
            uint256 target = isHeal
                ? band.realizedShortfallTOKEN
                : (band.borrowedTOKEN > band.realizedShortfallTOKEN ? band.borrowedTOKEN - band.realizedShortfallTOKEN : 0);
            if (target == 0) continue;
            if (band.v4TickUpper >= ct) continue;                 // only ahead bands
            uint256 put  = remaining < target ? remaining : target;
            uint128 lAdd = PerpCurve.liquidityForLoopOnly(band.v4TickLower, band.v4TickUpper, put);
            if (lAdd == 0) continue;
            (BalanceDelta dd,) = pm.modifyLiquidity(
                s.poolKey,
                ModifyLiquidityParams({ tickLower: band.v4TickLower, tickUpper: band.v4TickUpper,
                    liquidityDelta: int256(uint256(lAdd)), salt: bytes32(0) }), "");
            int128 o1 = dd.amount1();
            if (o1 < 0) {
                uint256 sp = uint256(uint128(-o1));
                pm.sync(s.poolKey.currency1);
                if (!IERC20Like(token).transfer(address(pm), sp)) revert TokenTransferFailed();
                pm.settle();
                band.liquidity += lAdd;
                band.borrowedTOKEN = band.borrowedTOKEN >= sp ? band.borrowedTOKEN - sp : 0;
                if (isHeal) {
                    // sp ≤ realizedShortfallTOKEN by construction (target capped it)
                    band.realizedShortfallTOKEN = band.realizedShortfallTOKEN >= sp ? band.realizedShortfallTOKEN - sp : 0;
                }
                remaining = remaining >= sp ? remaining - sp : 0;
                spentTok += sp; // == shortfall-cleared in the heal path → invariant exact
            }
        }
    }

    // ─── phase-2 deepen: leftover close funds → band depth (never reserve) ──
    /// @notice Deposit `amount` ETH as single-sided L into the nearest passed
    ///         band (deepens the curve where price is). Returns deposited.
    function deepenBandsETH(PerpTypes.PerpState storage s, IPoolManager pm, uint256 amount, uint256 numBands)
        internal returns (uint256 deposited)
    {
        if (amount == 0) return 0;
        int24 ct = currentTick(s, pm);
        // nearest-active passed band first (highest-index passed band)
        for (uint256 i = numBands; i > 0 && amount > 0; i--) {
            PerpTypes.Band storage band = s.bands[i - 1];
            if (band.liquidity == 0) continue;
            if (band.v4TickLower <= ct) continue;             // must be passed (ETH-only valid)
            uint128 lAdd = PerpCurve.liquidityForEthOnly(band.v4TickLower, band.v4TickUpper, amount);
            if (lAdd == 0) continue;
            (BalanceDelta dd,) = pm.modifyLiquidity(
                s.poolKey,
                ModifyLiquidityParams({ tickLower: band.v4TickLower, tickUpper: band.v4TickUpper,
                    liquidityDelta: int256(uint256(lAdd)), salt: bytes32(0) }), "");
            int128 o0 = dd.amount0();
            if (o0 < 0) {
                uint256 sp = uint256(uint128(-o0));
                _payBase(s, pm, sp);
                band.liquidity += lAdd;
                deposited += sp;
                amount = amount > sp ? amount - sp : 0;
            }
            break; // single nearest band absorbs the leftover (concentrate depth at price)
        }
    }

    function deepenBandsTOKEN(PerpTypes.PerpState storage s, IPoolManager pm, address token, uint256 amount, uint256 numBands)
        internal returns (uint256 deposited)
    {
        if (amount == 0) return 0;
        int24 ct = currentTick(s, pm);
        for (uint256 b = 0; b < numBands && amount > 0; b++) {
            PerpTypes.Band storage band = s.bands[b];
            if (band.liquidity == 0) continue;
            if (band.v4TickUpper >= ct) continue;             // must be ahead (TOKEN-only valid)
            uint128 lAdd = PerpCurve.liquidityForLoopOnly(band.v4TickLower, band.v4TickUpper, amount);
            if (lAdd == 0) continue;
            (BalanceDelta dd,) = pm.modifyLiquidity(
                s.poolKey,
                ModifyLiquidityParams({ tickLower: band.v4TickLower, tickUpper: band.v4TickUpper,
                    liquidityDelta: int256(uint256(lAdd)), salt: bytes32(0) }), "");
            int128 o1 = dd.amount1();
            if (o1 < 0) {
                uint256 sp = uint256(uint128(-o1));
                pm.sync(s.poolKey.currency1);
                if (!IERC20Like(token).transfer(address(pm), sp)) revert TokenTransferFailed();
                pm.settle();
                band.liquidity += lAdd;
                deposited += sp;
                amount = amount > sp ? amount - sp : 0;
            }
            break;
        }
    }

    // ─── bad-debt attribution (bottom-up, mirrors borrow walk) ──────────────
    /// @return flagged ETH actually attributed to band live-owed (≤ badDebt).
    ///         The unflagged remainder was reserve-drawn (not band debt) and
    ///         nets out via reserveETH↓/reserveTOKEN↑ — keeps the invariant
    ///         `totalBadDebtETH == Σ band.realizedShortfallETH` exact.
    function attributeBadDebtLong(PerpTypes.PerpState storage s, uint256 badDebt, uint256 numBands)
        internal returns (uint256 flagged)
    {
        uint256 remaining = badDebt;
        for (uint256 b = 0; b < numBands && remaining > 0; b++) {
            PerpTypes.Band storage band = s.bands[b];
            uint256 liveOwed = band.borrowedETH > band.realizedShortfallETH
                ? band.borrowedETH - band.realizedShortfallETH : 0;
            if (liveOwed == 0) continue;
            uint256 take = remaining < liveOwed ? remaining : liveOwed;
            band.realizedShortfallETH += take;
            remaining -= take;
            flagged += take;
        }
    }

    function attributeBadDebtShort(PerpTypes.PerpState storage s, uint256 badDebtTok, uint256 numBands)
        internal returns (uint256 flagged)
    {
        uint256 remaining = badDebtTok;
        for (uint256 b = 0; b < numBands && remaining > 0; b++) {
            PerpTypes.Band storage band = s.bands[b];
            uint256 liveOwed = band.borrowedTOKEN > band.realizedShortfallTOKEN
                ? band.borrowedTOKEN - band.realizedShortfallTOKEN : 0;
            if (liveOwed == 0) continue;
            uint256 take = remaining < liveOwed ? remaining : liveOwed;
            band.realizedShortfallTOKEN += take;
            remaining -= take;
            flagged += take;
        }
    }

    /// @dev Leverage fee recipient — receives the ex-staker slice of every
    ///      borrow/close fee. Separate from the SPOT fee wallet (PerpHook's
    ///      `feeRecipient`, hardcoded for v2 parity). Hardcoded, no setter.
    address internal constant LEVERAGE_FEE_RECIPIENT = 0x3F38Dd1e04a14f9E6615DEb5fFC62b5eE71A9cAF;

    // ─── adaptive fee split (base-token; spot fee handled in hook) ──────────
    // Insurance slice stays per-instance (bad-debt backstop); the ex-staker
    // slice accrues to `claimable[LEVERAGE_FEE_RECIPIENT]` in the base token.
    // `staking` arg is unused (kept to avoid caller churn) — there is no
    // staking contract per launch.
    function routeFee(
        PerpTypes.PerpState storage s, uint256 amount, PerpTypes.Cfg memory cfg, address /*staking*/
    ) internal {
        if (amount == 0) return;
        uint256 insBps = s.totalBadDebtETH > cfg.badDebtThreshold ? cfg.insuranceBpsHigh : cfg.insuranceBpsLow;
        uint256 toIns = (amount * insBps) / 10_000;
        uint256 toStk = amount - toIns;
        if (toIns > 0) s.insuranceETH += toIns;
        if (toStk > 0) s.claimable[LEVERAGE_FEE_RECIPIENT] += toStk;
    }

    // ─── auto-heal: deploy insurance toward bad debt (both sides) ───────────
    function autoHeal(PerpTypes.PerpState storage s, IPoolManager pm, address token, uint256 numBands) internal {
        if (s.insuranceETH > 0 && s.totalBadDebtETH > 0) {
            uint256 t = s.insuranceETH < s.totalBadDebtETH ? s.insuranceETH : s.totalBadDebtETH;
            uint256 d = refillLongBands(s, pm, t, true, numBands);
            if (d > 0) {
                s.insuranceETH -= d;
                s.totalBadDebtETH = s.totalBadDebtETH > d ? s.totalBadDebtETH - d : 0;
            }
        }
        if (s.insuranceTOKEN > 0 && s.totalBadDebtTOKEN > 0) {
            uint256 t = s.insuranceTOKEN < s.totalBadDebtTOKEN ? s.insuranceTOKEN : s.totalBadDebtTOKEN;
            uint256 d = refillShortBands(s, pm, token, t, true, numBands);
            if (d > 0) {
                s.insuranceTOKEN -= d;
                s.totalBadDebtTOKEN = s.totalBadDebtTOKEN > d ? s.totalBadDebtTOKEN - d : 0;
            }
        }
    }

    // ─── position list management ───────────────────────────────────────────
    function removePosition(PerpTypes.PerpState storage s, uint256 id) internal {
        address pOwner = s.positions[id].owner;
        uint256 idx = s.openIdIndex[id];
        uint256 last = s.openIds.length - 1;
        if (idx != last) {
            uint256 lid = s.openIds[last];
            s.openIds[idx] = lid;
            s.openIdIndex[lid] = idx;
        }
        s.openIds.pop();
        delete s.openIdIndex[id];

        uint256[] storage up = s.userPositions[pOwner];
        uint256 ui = s.userPosIndex[id];
        uint256 ul = up.length - 1;
        if (ui != ul) {
            uint256 luid = up[ul];
            up[ui] = luid;
            s.userPosIndex[luid] = ui;
        }
        up.pop();
        delete s.userPosIndex[id];
        delete s.positions[id];
    }

    function recordHistory(
        PerpTypes.PerpState storage s, address user, uint256 id, uint8 lev,
        PerpTypes.Side side, uint256 collateral, uint256 amtIn, uint256 amtOut, PerpTypes.HistoryKind kind
    ) internal {
        s.userHistory[user].push(PerpTypes.ClosedPositionRecord({
            timestamp: uint64(block.timestamp), positionId: uint64(id), leverage: lev,
            side: side, kind: kind, collateralETH: uint128(collateral),
            amountIn: uint128(amtIn), amountOut: uint128(amtOut)
        }));
    }
}
