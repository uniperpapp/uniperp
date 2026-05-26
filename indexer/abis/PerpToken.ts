// PerpToken — ERC-20 surface the indexer touches. Holder tracking via
// Transfer; the immutable on-chain `tokenUri()` is read once at index time
// for IPFS metadata resolution (it's set in the constructor and never changes).
export const PerpTokenAbi = [
  {
    type: "event", name: "Transfer", anonymous: false,
    inputs: [
      { indexed: true,  name: "from",  type: "address" },
      { indexed: true,  name: "to",    type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
  {
    type: "function", name: "tokenUri", stateMutability: "view", inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
