// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PerpCurve} from "../library/PerpCurve.sol";
import {PerpTypes} from "../PerpTypes.sol";
import {PerpHook} from "./PerpHook.sol";

/// @title  PerpLens — read-only two-sided aggregator for the frontend.
/// @notice Stateless, deploy-once. Reads through the hook's public getters and
///         reconstructs snapshot / position views with health + liq price.
contract PerpLens {
    using StateLibrary for IPoolManager;

    PerpHook     public immutable hook;
    IPoolManager public immutable poolManager;
    uint256 public constant LIQ_HEALTH_BPS = 10_500;

    struct PoolSnapshot {
        uint160 sqrtPriceX96;
        int24   currentTick;
        uint256 curveEth;
        uint256 totalDebtETH;
        uint256 totalDebtTOKEN;
        uint256 totalBadDebtETH;
        uint256 totalBadDebtTOKEN;
        uint256 totalHoldingTOKEN;
        uint256 totalHeldETH;
        uint256 reserveETH;
        uint256 reserveTOKEN;
        uint256 insuranceETH;
        uint256 insuranceTOKEN;
        uint256 numOpenPositions;
        uint256 totalSupply;
        bool    poolInitialized;
        bool    tradingEnabled;
        bool    paused;
        uint64  launchBlock;
    }

    struct PositionView {
        uint256 id;
        address owner;
        PerpTypes.Side side;
        uint256 collateralETH;
        uint256 debtETH;
        uint256 debtTOKEN;
        uint256 holdingTOKEN;
        uint256 heldETH;
        uint64  openedAtBlock;
        uint256 currentValueEth;  // long: holding value; short: heldETH
        uint256 healthBps;
        bool    liquidatable;
        uint256 liquidationEth;   // curveEth level at which this liquidates
    }

    constructor(PerpHook hook_) {
        hook = hook_;
        poolManager = hook_.poolManager();
    }

    function _poolId() internal view returns (PoolId) {
        return PoolIdLibrary.toId(hook.poolKey());
    }

    function _slot0() internal view returns (uint160 sp, int24 t) {
        (sp, t,,) = poolManager.getSlot0(_poolId());
    }

    function getPoolSnapshot() external view returns (PoolSnapshot memory s) {
        if (hook.poolInitialized()) {
            (s.sqrtPriceX96, s.currentTick) = _slot0();
            (uint256 cv, uint256 ck, uint256 ctw) = hook.curveParams();
            s.curveEth = PerpCurve.ethAtSqrtPrice(s.sqrtPriceX96, PerpCurve.CurveParams(cv, ck, ctw));
        }
        s.totalDebtETH      = hook.totalDebtETH();
        s.totalDebtTOKEN    = hook.totalDebtTOKEN();
        s.totalBadDebtETH   = hook.totalBadDebtETH();
        s.totalBadDebtTOKEN = hook.totalBadDebtTOKEN();
        s.totalHoldingTOKEN = hook.totalHoldingTOKEN();
        s.totalHeldETH      = hook.totalHeldETH();
        s.reserveETH        = hook.reserveETH();
        s.reserveTOKEN      = hook.reserveTOKEN();
        s.insuranceETH      = hook.insuranceETH();
        s.insuranceTOKEN    = hook.insuranceTOKEN();
        s.numOpenPositions  = hook.openIdsLength();
        s.totalSupply       = PerpCurve.TOTAL_SUPPLY;
        s.poolInitialized   = hook.poolInitialized();
        s.tradingEnabled    = hook.tradingEnabled();
        s.paused            = hook.paused();
        s.launchBlock       = hook.launchBlock();
    }

    function getPosition(uint256 id) public view returns (PositionView memory v) {
        PerpTypes.Position memory p = hook.positions(id);
        if (p.owner == address(0)) return v;

        v.id = id; v.owner = p.owner; v.side = p.side;
        v.collateralETH = p.collateralETH;
        v.debtETH = p.debtETH; v.debtTOKEN = p.debtTOKEN;
        v.holdingTOKEN = p.holdingTOKEN; v.heldETH = p.heldETH;
        v.openedAtBlock = p.openedAtBlock;

        (uint160 sqrtP,) = _slot0();
        (uint256 curveV, uint256 curveK,) = hook.curveParams();
        if (p.side == PerpTypes.Side.LONG) {
            if (p.debtETH == 0 && p.holdingTOKEN == 0) return v;
            v.currentValueEth = PerpCurve.tokenValueInEth(p.holdingTOKEN, sqrtP);
            v.healthBps = p.debtETH == 0 ? type(uint256).max : (v.currentValueEth * 10_000) / p.debtETH;
            v.liquidatable = p.debtETH > 0 && v.healthBps < LIQ_HEALTH_BPS;
            // liq when tokenValue(holding, eth) = LIQ_BPS·debt/BPS
            if (p.debtETH > 0 && p.holdingTOKEN > 0) {
                uint256 vPlusEthSq = curveK * 1e18 * LIQ_HEALTH_BPS * p.debtETH
                    / (10_000 * p.holdingTOKEN);
                uint256 vPlusEth = PerpCurve.sqrt(vPlusEthSq);
                v.liquidationEth = vPlusEth > curveV ? vPlusEth - curveV : 0;
            }
        } else {
            if (p.debtTOKEN == 0 && p.heldETH == 0) return v;
            v.currentValueEth = p.heldETH;
            uint256 dv = PerpCurve.tokenValueInEth(p.debtTOKEN, sqrtP);
            v.healthBps = dv == 0 ? type(uint256).max : (p.heldETH * 10_000) / dv;
            v.liquidatable = p.debtTOKEN > 0 && v.healthBps < LIQ_HEALTH_BPS;
            // short liquidates as price RISES: liq when heldETH·BPS = LIQ_BPS·tokenValue(debt)
            // tokenValue(debt, eth) = debt·(V+eth)²/(K·1e18) ⟹
            // (V+eth)² = heldETH·BPS·K·1e18 / (LIQ_BPS·debt)
            if (p.debtTOKEN > 0 && p.heldETH > 0) {
                uint256 vPlusEthSq = p.heldETH * 10_000 * curveK * 1e18
                    / (LIQ_HEALTH_BPS * p.debtTOKEN);
                uint256 vPlusEth = PerpCurve.sqrt(vPlusEthSq);
                v.liquidationEth = vPlusEth > curveV ? vPlusEth - curveV : 0;
            }
        }
    }

    function getUserPositions(address user) external view returns (PositionView[] memory views) {
        uint256 n = _userLen(user);
        uint256 openCount;
        for (uint256 i = 0; i < n; i++) {
            PerpTypes.Position memory p = hook.positions(hook.userPositions(user, i));
            if (p.owner != address(0)) openCount++;
        }
        views = new PositionView[](openCount);
        uint256 j;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = hook.userPositions(user, i);
            if (hook.positions(id).owner != address(0)) views[j++] = getPosition(id);
        }
    }

    function _userLen(address user) internal view returns (uint256 len) {
        while (true) {
            try hook.userPositions(user, len) returns (uint256) { unchecked { ++len; } }
            catch { break; }
        }
    }
}
