// HypeMigration + minimal ERC20 (for the v1 OLD token approve/allowance).
export const migrationAbi = [
  { type: "function", name: "migrate", stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "snapshotAmount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ], outputs: [] },
  { type: "function", name: "migrated", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "merkleRoot", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "OLD", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "NEW", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "event", name: "Migrated", anonymous: false,
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ] },
  { type: "error", name: "BadProof", inputs: [] },
  { type: "error", name: "ExceedsSnapshot", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "RootNotSet", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "", type: "address" }, { name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;
