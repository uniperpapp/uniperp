// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PerpCore} from "./PerpCore.sol";
import {PerpTypes} from "../PerpTypes.sol";

/// @title  PerpReserve — owner-only reserve cleanup (external lib).
/// @notice `rebalanceReserve()` converts excess one-sided reserve *through the
///         pool* (no owner capital), refills the matching bands, clears the
///         provisional bad debt, and deepens bands with any leftover. The
///         manual, owner-timed successor to v1's forced drip-seller. Reserve
///         is otherwise only fed by liquidation seizes. See PERP_DESIGN §5.
library PerpReserve {
    using PerpCore for PerpTypes.PerpState;

    error NothingToRebalance();
    error SlippageExceeded();

    function rebalanceHandler(
        PerpTypes.PerpState storage s, IPoolManager pm, address token,
        bool sellTok, uint256 amt, uint256 minOut, uint256 numBands
    ) external returns (bytes memory) {
        if (sellTok) {
            // reserveTOKEN → ETH → heal long (ETH) bands.
            if (amt > s.reserveTOKEN) amt = s.reserveTOKEN;
            if (amt == 0) revert NothingToRebalance();
            s.reserveTOKEN -= amt;
            (uint256 ethGot, uint256 tokSold) =
                PerpCore.swapTokenForEth(s, pm, token, amt, TickMath.MAX_SQRT_PRICE - 1);
            if (ethGot < minOut) revert SlippageExceeded();   // owner's anti-sandwich floor
            if (tokSold < amt) s.reserveTOKEN += (amt - tokSold); // refund unsold

            uint256 spent = PerpCore.refillLongBands(s, pm, ethGot, true, numBands);
            s.totalBadDebtETH = s.totalBadDebtETH > spent ? s.totalBadDebtETH - spent : 0;
            if (ethGot > spent) PerpCore.deepenBandsETH(s, pm, ethGot - spent, numBands);
            return abi.encode(tokSold, ethGot);
        } else {
            // reserveETH → TOKEN → heal short (TOKEN) bands.
            if (amt > s.reserveETH) amt = s.reserveETH;
            if (amt == 0) revert NothingToRebalance();
            s.reserveETH -= amt;
            // Owner-controlled rebalance — permissive limit (no manipulation vector).
            (uint256 tokGot, uint256 ethSpent) = PerpCore.swapEthForToken(s, pm, amt, TickMath.MIN_SQRT_PRICE + 1);
            if (tokGot < minOut) revert SlippageExceeded();   // owner's anti-sandwich floor
            if (ethSpent < amt) s.reserveETH += (amt - ethSpent); // refund unspent

            uint256 spent = PerpCore.refillShortBands(s, pm, token, tokGot, true, numBands);
            s.totalBadDebtTOKEN = s.totalBadDebtTOKEN > spent ? s.totalBadDebtTOKEN - spent : 0;
            if (tokGot > spent) PerpCore.deepenBandsTOKEN(s, pm, token, tokGot - spent, numBands);
            return abi.encode(ethSpent, tokGot);
        }
    }
}
