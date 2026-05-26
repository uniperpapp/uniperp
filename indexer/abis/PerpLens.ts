// PerpLens — read-only snapshot aggregator. ONE staticcall returns every
// Launch-row aggregate we want refreshed on every event. Saves N hook
// getter calls per event.
export const PerpLensAbi = [
  {
    type: "function", name: "getPoolSnapshot", stateMutability: "view", inputs: [],
    outputs: [{
      name: "s", type: "tuple",
      components: [
        { name: "sqrtPriceX96",      type: "uint160" },
        { name: "currentTick",       type: "int24"   },
        { name: "curveEth",          type: "uint256" },
        { name: "totalDebtETH",      type: "uint256" },
        { name: "totalDebtTOKEN",    type: "uint256" },
        { name: "totalBadDebtETH",   type: "uint256" },
        { name: "totalBadDebtTOKEN", type: "uint256" },
        { name: "totalHoldingTOKEN", type: "uint256" },
        { name: "totalHeldETH",      type: "uint256" },
        { name: "reserveETH",        type: "uint256" },
        { name: "reserveTOKEN",      type: "uint256" },
        { name: "insuranceETH",      type: "uint256" },
        { name: "insuranceTOKEN",    type: "uint256" },
        { name: "numOpenPositions",  type: "uint256" },
        { name: "totalSupply",       type: "uint256" },
        { name: "poolInitialized",   type: "bool"    },
        { name: "tradingEnabled",    type: "bool"    },
        { name: "paused",            type: "bool"    },
        { name: "launchBlock",       type: "uint64"  },
      ],
    }],
  },
] as const;
