// Minimal PerpHook ABI for the indexer — events Ponder subscribes to and
// the public view fns we staticcall to refresh Launch snapshot rows.
// Mirrors perpfactory/src/hook/PerpHook.sol.
export const PerpHookAbi = [
  // ── events we index ──────────────────────────────────────────────────────
  // (Side enum is uint8: 0 = LONG, 1 = SHORT)
  {
    type: "event", name: "PositionOpened", anonymous: false,
    inputs: [
      { indexed: true,  name: "id",         type: "uint256" },
      { indexed: true,  name: "owner",      type: "address" },
      { indexed: false, name: "side",       type: "uint8"   },
      { indexed: false, name: "collateral", type: "uint256" },
      { indexed: false, name: "debt",       type: "uint256" },
      { indexed: false, name: "holding",    type: "uint256" },
    ],
  },
  {
    type: "event", name: "PositionClosed", anonymous: false,
    inputs: [
      { indexed: true,  name: "id",       type: "uint256" },
      { indexed: true,  name: "owner",    type: "address" },
      { indexed: false, name: "returned", type: "uint256" },
    ],
  },
  {
    type: "event", name: "PositionLiquidated", anonymous: false,
    inputs: [
      { indexed: true,  name: "id",    type: "uint256" },
      { indexed: true,  name: "owner", type: "address" },
      { indexed: false, name: "side",  type: "uint8"   },
    ],
  },
  {
    type: "event", name: "Claimed", anonymous: false,
    inputs: [
      { indexed: true,  name: "user",   type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
  {
    type: "event", name: "PausedSet", anonymous: false,
    inputs: [{ indexed: false, name: "paused", type: "bool" }],
  },

  // ── views (called via context.client.readContract for snapshot refresh) ──
  { type: "function", name: "tradingEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused",         stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "launchBlock",    stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "openIdsLength",  stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // position(id) — used to enrich Position rows on close/liquidation if needed
  {
    type: "function", name: "positions", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{
      name: "p", type: "tuple",
      components: [
        { name: "owner",            type: "address" },
        { name: "side",             type: "uint8"   },
        { name: "collateralETH",    type: "uint256" },
        { name: "debtETH",          type: "uint256" },
        { name: "debtTOKEN",        type: "uint256" },
        { name: "holdingTOKEN",     type: "uint256" },
        { name: "heldETH",          type: "uint256" },
        { name: "openSqrtPriceX96", type: "uint160" },
        { name: "leverage",         type: "uint8"   },
        { name: "openedAtBlock",    type: "uint64"  },
        { name: "realizedOut",      type: "uint256" },
      ],
    }],
  },
] as const;
