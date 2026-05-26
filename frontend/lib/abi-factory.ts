// Minimal Perpfactory ABI — only the surface the launchpad UI touches.
// (Full source: perpfactory/src/Perpfactory.sol)
export const perpfactoryAbi = [
  // ── views ─────────────────────────────────────────────────────────────────
  {
    type: "function", name: "admin", stateMutability: "view", inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "launchCount", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "launches", stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "hook",      type: "address" },
      { name: "token",     type: "address" },
      { name: "lens",      type: "address" },
      { name: "base",      type: "address" },
      { name: "creator",   type: "address" },
      { name: "createdAt", type: "uint64"  },
    ],
  },
  {
    type: "function", name: "hookId", stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "hookDeployer", stateMutability: "view", inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "bases", stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "allowed",   type: "bool"    },
      { name: "v",         type: "uint128" },
      { name: "tickWidth", type: "uint128" },
    ],
  },
  {
    type: "function", name: "tokenInitCodeHash", stateMutability: "pure",
    inputs: [
      { name: "name",     type: "string" },
      { name: "symbol",   type: "string" },
      { name: "tokenUri", type: "string" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "hookInitCodeHash", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "predictToken", stateMutability: "view",
    inputs: [
      { name: "tokenSalt", type: "bytes32" },
      { name: "name",      type: "string"  },
      { name: "symbol",    type: "string"  },
      { name: "tokenUri",  type: "string"  },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "predictHook", stateMutability: "view",
    inputs: [
      { name: "hookSalt", type: "bytes32" },
      { name: "token",    type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
  // ── launch ────────────────────────────────────────────────────────────────
  // V/W are admin-locked per base in `bases[base]` — creator no longer supplies them.
  {
    type: "function", name: "create", stateMutability: "nonpayable",
    inputs: [{
      name: "p", type: "tuple",
      components: [
        { name: "name",        type: "string"  },
        { name: "symbol",      type: "string"  },
        { name: "tokenUri",    type: "string"  },
        { name: "base",        type: "address" },
        { name: "tokenSalt",   type: "bytes32" },
        { name: "hookSalt",    type: "bytes32" },
        { name: "seedBuyBase", type: "uint256" }, // D9: optional initial creator buy
      ],
    }],
    outputs: [
      { name: "hook",  type: "address" },
      { name: "token", type: "address" },
      { name: "lens",  type: "address" },
    ],
  },
  // ── events ────────────────────────────────────────────────────────────────
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
  // ── errors (decode-friendly for UI) ───────────────────────────────────────
  { type: "error", name: "NotWhitelisted",  inputs: [] },
  { type: "error", name: "BadParams",       inputs: [] },
  { type: "error", name: "BadHookAddr",     inputs: [] },
  { type: "error", name: "TransferFailed",  inputs: [] },
] as const;
