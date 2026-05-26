// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PerpCore} from "./PerpCore.sol";
import {PerpCurve} from "./PerpCurve.sol";
import {PerpTypes} from "../PerpTypes.sol";

/// @title  PerpShort — open/close handler for SHORT positions (external lib).
/// @notice Mirror of PerpLong. Borrow TOKEN reserve-first → ahead bands
///         (symmetric TWAP-gate `min(live,twap)`, 25% cap), sell → ETH held.
///         Close buys back TOKEN, refills bands then deepens; never reserve.
library PerpShort {
    using PerpCore for PerpTypes.PerpState;

    error TwapNotWarm();
    error SpikeBlocked();
    error BorrowCapPerBlockExceeded();
    error InsufficientBorrowCapacity();
    error PartialFill();
    error NothingSold();
    error InvalidSellBps();

    function openHandler(
        PerpTypes.PerpState storage s, IPoolManager pm, address token,
        bytes memory payload, PerpTypes.Cfg memory cfg, address staking
    ) external returns (bytes memory) {
        (uint256 borrowValEth, uint256 effectiveCol, uint256 borrowFee,,) =
            abi.decode(payload, (uint256, uint256, uint256, address, uint256));

        s.autoHeal(pm, token, cfg.numBands);

        int24 ct = PerpCore.currentTick(s, pm);
        (int24 tt, bool ok) = PerpCore.twapTick(s, cfg.twapSeconds);
        if (!ok) revert TwapNotWarm();
        // §6.1-deep (mirror): block opens into a same-block dump. Live spot vs
        // the immutable prior-block price; >~50% ⇒ this block was crashed by an
        // atomic attacker. Organic moves are gradual ⇒ legit shorts pass.
        if (PerpCore.isBlockSpike(s, ct)) revert SpikeBlocked();
        // §6.1 short: borrowable iff ahead under BOTH ticks ⇒ refTick = min.
        int24 refTick = ct < tt ? ct : tt;
        uint160 twapSqrtP = TickMath.getSqrtPriceAtTick(tt);

        // TOKEN amount whose value == borrowValEth, priced at the TWAP.
        uint256 borrowTok = PerpCurve.ethValueToToken(borrowValEth, twapSqrtP);

        PerpCore.resetBorrowBlock(s);

        uint256 reserveDrawn = PerpCore.drawReserveTOKEN(s, borrowTok);
        uint256 remaining    = borrowTok > reserveDrawn ? borrowTok - reserveDrawn : 0;
        uint256 bandsFreed   = remaining > 0 ? PerpCore.borrowShortBands(s, pm, token, refTick, remaining, cfg) : 0;
        uint256 totalFreed   = reserveDrawn + bandsFreed;

        if (totalFreed + PerpCore.DUST_TOL < borrowTok) revert InsufficientBorrowCapacity();

        // Sell the borrowed TOKEN → ETH (hook-internal, fee-exempt).
        (uint256 ethProceeds, uint256 tokSold) =
            PerpCore.swapTokenForEth(s, pm, token, totalFreed, TickMath.MAX_SQRT_PRICE - 1);
        if (tokSold + PerpCore.DUST_TOL < totalFreed) revert PartialFill();

        // Per-block cap charged on the REAL spot proceeds (not a TWAP
        // valuation), so a stale-low TWAP cannot understate the borrow.
        uint256 newBlockTotal = uint256(s.borrowedThisBlock) + ethProceeds;
        if (newBlockTotal > cfg.maxBorrowPerBlock) revert BorrowCapPerBlockExceeded();
        s.borrowedThisBlock = uint128(newBlockTotal);

        uint256 heldETH = effectiveCol + ethProceeds;
        PerpCore.routeFee(s, borrowFee, cfg, staking);
        return abi.encode(totalFreed, heldETH);
    }

    function closeHandler(
        PerpTypes.PerpState storage s, IPoolManager pm, address token,
        bytes memory payload, PerpTypes.Cfg memory cfg, address staking
    ) external returns (bytes memory) {
        (uint256 positionId, uint256 sellBps, uint256 minOut) =
            abi.decode(payload, (uint256, uint256, uint256));

        PerpTypes.Position storage p = s.positions[positionId];
        uint256 debtTok = p.debtTOKEN;
        uint256 held    = p.heldETH;
        address pOwner  = p.owner;
        uint8   lev     = p.leverage;
        uint256 col     = p.collateralETH;
        uint128 prevOut = p.realizedOut;

        uint256 tokToRepay  = sellBps == 10_000 ? debtTok : (debtTok * sellBps) / 10_000;
        uint256 heldPortion = sellBps == 10_000 ? held    : (held    * sellBps) / 10_000;
        if (tokToRepay == 0) revert InvalidSellBps();

        // Buy back the TOKEN debt with held ETH (exact-output, capped at budget).
        (uint256 gotTok, uint256 ethSpent) =
            PerpCore.swapEthForExactToken(s, pm, tokToRepay, heldPortion);
        if (gotTok == 0) revert NothingSold();

        // Return bought TOKEN → bands first, then deepen bands with leftover.
        uint256 toBands = gotTok;
        uint256 spent = PerpCore.refillShortBands(s, pm, token, toBands, false, cfg.numBands);
        if (toBands > spent) PerpCore.deepenBandsTOKEN(s, pm, token, toBands - spent, cfg.numBands);

        // Couldn't buy back full debt (underwater) → provisional TOKEN bad debt.
        uint256 shortfall = tokToRepay > gotTok ? tokToRepay - gotTok : 0;
        if (shortfall > 0) {
            uint256 flagged = PerpCore.attributeBadDebtShort(s, shortfall, cfg.numBands);
            s.totalBadDebtTOKEN += flagged;
        }

        // ETH left after buyback → user (minus 1% close fee on it).
        uint256 toUser = heldPortion > ethSpent ? heldPortion - ethSpent : 0;
        if (toUser > 0) {
            uint256 fee = (toUser * cfg.closeFeeBps) / 10_000;
            if (fee > 0) { PerpCore.routeFee(s, fee, cfg, staking); toUser -= fee; }
        }
        // minOut checked UNCONDITIONALLY (even when toUser == 0): an MEV'd close
        // returning 0 must still honour the caller's slippage floor, not silently
        // consume the position with no payout.
        if (toUser < minOut) revert PartialFill();
        if (toUser > 0) s.claimable[pOwner] += toUser;

        s.totalDebtTOKEN -= tokToRepay;
        s.totalHeldETH   -= heldPortion;

        uint256 newDebtTok = debtTok - tokToRepay;
        uint256 newHeld    = held - heldPortion;
        bool fullClose = sellBps == 10_000 || newDebtTok == 0;

        if (fullClose) {
            PerpCore.recordHistory(s, pOwner, positionId, lev, PerpTypes.Side.SHORT,
                col, ethSpent, uint256(prevOut) + toUser, PerpTypes.HistoryKind.FullClose);
            PerpCore.removePosition(s, positionId);
        } else {
            p.debtTOKEN   = newDebtTok;
            p.heldETH     = newHeld;
            p.realizedOut = prevOut + uint128(toUser);
        }

        s.autoHeal(pm, token, cfg.numBands);
        return abi.encode(toUser, ethSpent);
    }
}
