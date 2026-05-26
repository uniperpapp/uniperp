// ABI fragments for perpfactory (launch) hooks that DIFFER from the v2 mainnet
// hook ABI (`lib/abi-hype-hook.ts`, generated from the deployed native-ETH v2).
//
// CRITICAL: openLong/openShort changed signature in the ERC-20-base refactor:
//   v2 (native):    openLong(leverage, minOut, deadline)               PAYABLE     (3-arg)
//   launch (ERC20): openLong(leverage, collateral, minOut, deadline)   non-payable (4-arg)
// so the v2 ABI's open functions MUST be swapped out for these when talking to a
// launch hook (contracts.tsx builds the launch hookAbi = v2 minus openLong/
// openShort, plus these). close / claim / positions / … are unchanged.
export const launchHookExtraAbi = [
  {
    type: "function", name: "openLong", stateMutability: "nonpayable",
    inputs: [
      { name: "leverage",      type: "uint256" },
      { name: "collateral",    type: "uint256" },
      { name: "minHoldingOut", type: "uint256" },
      { name: "deadline",      type: "uint256" },
    ],
    outputs: [
      { name: "positionId", type: "uint256" },
      { name: "holdingOut", type: "uint256" },
    ],
  },
  {
    type: "function", name: "openShort", stateMutability: "nonpayable",
    inputs: [
      { name: "leverage",   type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "minEthOut",  type: "uint256" },
      { name: "deadline",   type: "uint256" },
    ],
    outputs: [
      { name: "positionId", type: "uint256" },
      { name: "heldEthOut", type: "uint256" },
    ],
  },
  {
    type: "function", name: "curveParams", stateMutability: "view", inputs: [],
    outputs: [
      { name: "v",         type: "uint256" },
      { name: "k",         type: "uint256" },
      { name: "tickWidth", type: "uint256" },
    ],
  },
  {
    type: "function", name: "base", stateMutability: "view", inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
