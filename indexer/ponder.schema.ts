import { onchainTable, index } from "@ponder/core";

/*
 * perpfactory schema
 * ──────────────────
 * Spine = one `Launch` row per launched token, all live aggregates updated
 * from event snapshots (no off-chain accumulators that can drift).
 *
 *   Launch ── Position (open + closed history)
 *           └ Trade    (activity feed across launches: open/close/liq/claim)
 *           └ Holder   (per-launch token balance map, via ERC-20 Transfer)
 */

/// One row per launched token. `id` = the launch's PerpHook address (unique
/// per launch and the natural primary key the frontend already routes on).
export const Launch = onchainTable(
  "launch",
  (t) => ({
    id: t.hex().primaryKey(),          // hook address
    hook: t.hex().notNull(),
    token: t.hex().notNull(),
    lens: t.hex().notNull(),
    base: t.hex().notNull(),
    creator: t.hex().notNull(),

    // identity (from Launched event args + IPFS resolution at index time)
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    tokenUri: t.text().notNull(),
    imageURI: t.text().notNull().default(""),
    description: t.text(),
    twitter: t.text(),
    telegram: t.text(),
    website: t.text(),

    // curve params (immutable per launch)
    v: t.bigint().notNull(),
    tickWidth: t.bigint().notNull(),

    // base-asset metadata — the engine is decimal-agnostic (V/W/curveEth/debt
    // are all in base-RAW units), so the UI needs the base's decimals + symbol
    // to render directory/feed amounts correctly for non-18-dec bases (USDC=6).
    baseDecimals: t.integer().notNull().default(18),
    baseSymbol: t.text().notNull().default(""),

    // chain meta
    createdAt: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    createdTx: t.hex().notNull(),
    launchBlock: t.bigint().notNull(),

    // ── live state, updated from event snapshots ─────────────────────────
    // (we read these off the hook's view fns via context.client at event time
    //  rather than reproducing engine math off-chain — eliminates drift risk;
    //  the cost is one staticcall per state-changing event, batched by Ponder)
    curveEth: t.bigint().notNull().default(0n),
    reserveETH: t.bigint().notNull().default(0n),
    reserveTOKEN: t.bigint().notNull().default(0n),
    insuranceETH: t.bigint().notNull().default(0n),
    insuranceTOKEN: t.bigint().notNull().default(0n),
    totalDebtETH: t.bigint().notNull().default(0n),
    totalDebtTOKEN: t.bigint().notNull().default(0n),
    totalHoldingTOKEN: t.bigint().notNull().default(0n),
    totalHeldETH: t.bigint().notNull().default(0n),
    totalBadDebtETH: t.bigint().notNull().default(0n),
    totalBadDebtTOKEN: t.bigint().notNull().default(0n),
    numOpenPositions: t.integer().notNull().default(0),
    tradingEnabled: t.boolean().notNull().default(false),
    paused: t.boolean().notNull().default(false),

    // activity rollups
    tradeCount: t.integer().notNull().default(0),
    lastTradeAt: t.bigint(),
    lastSqrtPriceX96: t.bigint(),
  }),
  (table) => ({
    newestIdx: index().on(table.createdAt),
    tradeIdx: index().on(table.lastTradeAt),
    creatorIdx: index().on(table.creator),
    baseIdx: index().on(table.base),
  }),
);

/// One row per perp position (long or short) on any launched hook. Status
/// transitions: 'open' → 'closed' | 'liquidated'.
export const Position = onchainTable(
  "position",
  (t) => ({
    id: t.text().primaryKey(),         // `${hook}-${positionId}`
    launch: t.hex().notNull(),         // fk → Launch.id
    positionId: t.bigint().notNull(),
    owner: t.hex().notNull(),
    side: t.text().notNull(),          // 'long' | 'short'

    collateralETH: t.bigint().notNull(),
    debtETH: t.bigint().notNull().default(0n),
    debtTOKEN: t.bigint().notNull().default(0n),
    holdingTOKEN: t.bigint().notNull().default(0n),
    heldETH: t.bigint().notNull().default(0n),
    openSqrtPriceX96: t.bigint().notNull(),
    leverage: t.integer().notNull(),

    openedAt: t.bigint().notNull(),
    openedAtBlock: t.bigint().notNull(),
    openedTx: t.hex().notNull(),

    status: t.text().notNull().default("open"),  // 'open' | 'closed' | 'liquidated'
    closedAt: t.bigint(),
    closedAtBlock: t.bigint(),
    closedTx: t.hex(),
    closedReturned: t.bigint(),
  }),
  (table) => ({
    launchIdx: index().on(table.launch),
    ownerIdx: index().on(table.owner),
    statusIdx: index().on(table.status),
    openedAtIdx: index().on(table.openedAt),
  }),
);

/// Cross-launch activity feed. One row per state-changing event the
/// launchpad UI surfaces: open / close / liquidation / claim.
export const Trade = onchainTable(
  "trade",
  (t) => ({
    id: t.text().primaryKey(),         // `${tx}-${logIndex}`
    launch: t.hex().notNull(),         // fk → Launch.id (hook addr)
    kind: t.text().notNull(),          // 'open_long'|'open_short'|'close'|'liquidation'|'claim'
    who: t.hex().notNull(),
    positionId: t.bigint(),

    // economic fields (filled per kind; nulls allowed where not applicable)
    sizeBase: t.bigint(),              // base in (opens) / base out (close/claim)
    sizeToken: t.bigint(),             // token holding (open long) / held (close short)
    sqrtPriceX96: t.bigint(),

    ts: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    launchTimeIdx: index().on(table.launch, table.ts),
    timeIdx: index().on(table.ts),
    whoIdx: index().on(table.who),
    kindIdx: index().on(table.kind),
  }),
);

/// Per-launch ERC-20 balance map (from PerpToken Transfer events).
export const Holder = onchainTable(
  "holder",
  (t) => ({
    id: t.text().primaryKey(),         // `${launch}-${address}`
    launch: t.hex().notNull(),         // fk
    address: t.hex().notNull(),
    balance: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    launchIdx: index().on(table.launch),
    addressIdx: index().on(table.address),
  }),
);
