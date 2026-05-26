// Minimal Perpfactory ABI for the indexer — only the events + views Ponder
// needs. Mirrors perpfactory/src/Perpfactory.sol.
export const PerpfactoryAbi = [
  {
    type: "event", name: "Launched", anonymous: false,
    inputs: [
      { indexed: true,  name: "hook",      type: "address" },
      { indexed: true,  name: "token",     type: "address" },
      { indexed: true,  name: "creator",   type: "address" },
      { indexed: false, name: "lens",      type: "address" },
      { indexed: false, name: "base",      type: "address" },
      { indexed: false, name: "v",         type: "uint256" },
      { indexed: false, name: "tickWidth", type: "uint256" },
      { indexed: false, name: "name",      type: "string"  },
      { indexed: false, name: "symbol",    type: "string"  },
      { indexed: false, name: "tokenUri",  type: "string"  },
    ],
  },
  {
    type: "event", name: "BaseSet", anonymous: false,
    inputs: [
      { indexed: true,  name: "base",    type: "address" },
      { indexed: false, name: "allowed", type: "bool"    },
    ],
  },
  // views (Ponder context.client can call these by ABI fragment)
  {
    type: "function", name: "launchCount", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;
