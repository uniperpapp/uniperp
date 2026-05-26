// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PerpCore} from "./PerpCore.sol";
import {PerpTypes} from "../PerpTypes.sol";

/// @title  PerpLong — open/close handler for LONG positions (external lib).
/// @notice Delegate-called by the hook. Borrow ETH reserve-first → passed
///         bands (TWAP-gated, per-block-capped). Close repays bands-first then
///         deepens bands; never returns to reserve. See PERP_DESIGN §2/§5/§6.
library PerpLong {
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
        (uint256 borrowEth, uint256 effectiveCol, uint256 borrowFee,,) =
            abi.decode(payload, (uint256, uint256, uint256, address, uint256));

        // Heal first so the cap check sees fresh post-heal band state.
        s.autoHeal(pm, token, cfg.numBands);

        int24 ct = PerpCore.currentTick(s, pm);
        (int24 tt, bool ok) = PerpCore.twapTick(s, cfg.twapSeconds);
        if (!ok) revert TwapNotWarm();
        // §6.1-deep: block opens into a same-block pump. Live spot vs the prior
        // block's (immutable, attack-proof) price; >~50% ⇒ this block was
        // manipulated. Organic moves are gradual block-to-block ⇒ legit opens
        // pass even in wild markets; the open's own impact is unaffected.
        if (PerpCore.isBlockSpike(s, ct)) revert SpikeBlocked();
        // §6.1 long: borrowable iff passed under BOTH ticks ⇒ refTick = max.
        int24 refTick = ct > tt ? ct : tt;

        PerpCore.resetBorrowBlock(s);

        uint256 reserveDrawn = PerpCore.drawReserveETH(s, borrowEth);
        uint256 remaining    = borrowEth > reserveDrawn ? borrowEth - reserveDrawn : 0;
        uint256 bandsFreed   = remaining > 0 ? PerpCore.borrowLongBands(s, pm, refTick, remaining, cfg) : 0;
        uint256 totalFreed   = reserveDrawn + bandsFreed;

        // §6.2 per-block cap covers reserve draws too (attack-safe).
        uint256 newBlockTotal = uint256(s.borrowedThisBlock) + totalFreed;
        if (newBlockTotal > cfg.maxBorrowPerBlock) revert BorrowCapPerBlockExceeded();
        s.borrowedThisBlock = uint128(newBlockTotal);

        if (totalFreed + PerpCore.DUST_TOL < borrowEth) revert InsufficientBorrowCapacity();

        // Leveraged buy executes freely (no price cap) — opens move the curve,
        // the product is intact. The spike guard above already blocked any
        // same-block pump, so this buy is at an honest price.
        uint256 swapInput = effectiveCol + totalFreed;
        (uint256 tokensOut, uint256 ethSpent) =
            PerpCore.swapEthForToken(s, pm, swapInput, TickMath.MIN_SQRT_PRICE + 1);
        if (ethSpent + PerpCore.DUST_TOL < swapInput) revert PartialFill();

        PerpCore.routeFee(s, borrowFee, cfg, staking);
        return abi.encode(totalFreed, tokensOut);
    }

    function closeHandler(
        PerpTypes.PerpState storage s, IPoolManager pm, address token,
        bytes memory payload, PerpTypes.Cfg memory cfg, address staking
    ) external returns (bytes memory) {
        (uint256 positionId, uint256 sellBps, uint256 minOut) =
            abi.decode(payload, (uint256, uint256, uint256));

        PerpTypes.Position storage p = s.positions[positionId];
        uint256 holding = p.holdingTOKEN;
        uint256 debt    = p.debtETH;
        address pOwner  = p.owner;
        uint8   lev     = p.leverage;
        uint256 col     = p.collateralETH;
        uint128 prevOut = p.realizedOut;

        uint256 tokensToSell = sellBps == 10_000 ? holding : (holding * sellBps) / 10_000;
        if (tokensToSell == 0) revert InvalidSellBps();

        (uint256 ethFromSell, uint256 tokenSold) =
            PerpCore.swapTokenForEth(s, pm, token, tokensToSell, TickMath.MAX_SQRT_PRICE - 1);
        if (tokenSold == 0) revert NothingSold();
        if (tokenSold < tokensToSell) revert PartialFill();

        // Pro-rata debt for partial close.
        uint256 debtPortion = sellBps == 10_000 ? debt : (debt * sellBps) / 10_000;

        // Repay → bands first, then deepen bands with leftover (never reserve).
        uint256 toBands = debtPortion < ethFromSell ? debtPortion : ethFromSell;
        uint256 spent = PerpCore.refillLongBands(s, pm, toBands, false, cfg.numBands);
        if (toBands > spent) PerpCore.deepenBandsETH(s, pm, toBands - spent, cfg.numBands);

        // Shortfall → provisional bad debt (flagged on bands; healed via reserve recycle).
        uint256 badDebt = debtPortion > ethFromSell ? debtPortion - ethFromSell : 0;
        if (badDebt > 0) {
            uint256 flagged = PerpCore.attributeBadDebtLong(s, badDebt, cfg.numBands);
            s.totalBadDebtETH += flagged;
        }

        // Surplus → user (minus 1% close fee on profit).
        uint256 toUser = ethFromSell > debtPortion ? ethFromSell - debtPortion : 0;
        if (toUser > 0) {
            uint256 fee = (toUser * cfg.closeFeeBps) / 10_000;
            if (fee > 0) { PerpCore.routeFee(s, fee, cfg, staking); toUser -= fee; }
        }
        // minOut checked UNCONDITIONALLY (even when toUser == 0): an MEV'd close
        // returning 0 must still honour the caller's slippage floor, not silently
        // consume the position with no payout.
        if (toUser < minOut) revert PartialFill();
        if (toUser > 0) s.claimable[pOwner] += toUser;

        s.totalDebtETH      -= debtPortion;
        s.totalHoldingTOKEN -= tokenSold;

        uint256 newHolding = holding - tokenSold;
        uint256 newDebt    = debt - debtPortion;
        bool fullClose = sellBps == 10_000 || newHolding == 0;

        if (fullClose) {
            PerpCore.recordHistory(s, pOwner, positionId, lev, PerpTypes.Side.LONG,
                col, tokenSold, uint256(prevOut) + toUser, PerpTypes.HistoryKind.FullClose);
            PerpCore.removePosition(s, positionId);
        } else {
            p.holdingTOKEN = newHolding;
            p.debtETH      = newDebt;
            p.realizedOut  = prevOut + uint128(toUser);
        }

        s.autoHeal(pm, token, cfg.numBands);
        return abi.encode(toUser, tokenSold);
    }
}
