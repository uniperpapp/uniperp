import { ponder } from "@/generated";
import { Launch, Position, Trade, Holder } from "../ponder.schema";
import { PerpLensAbi } from "../abis/PerpLens";

// ─── small helpers ──────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/// Resolve an IPFS URI (or http) to a JSON metadata blob. Best-effort: on any
/// failure (no network, bad CID, malformed JSON, slow gateway) return empty
/// fields so the Launch row still gets created. The frontend can always
/// re-resolve the URI client-side later.
// Working IPFS gateway for resolving metadata JSON. cloudflare-ipfs.com was
// SHUT DOWN; default to filebase (where we pin) and allow override via env.
const IPFS_GATEWAY = (process.env.IPFS_GATEWAY || "https://ipfs.filebase.io").replace(/\/+$/, "");
const ipfsToHttp = (u: string) =>
  u.startsWith("ipfs://") ? `${IPFS_GATEWAY}/ipfs/${u.slice("ipfs://".length)}` : u;

async function fetchMetadata(uri: string): Promise<{
  image: string; description: string | null;
  twitter: string | null; telegram: string | null; website: string | null;
}> {
  const blank = { image: "", description: null, twitter: null, telegram: null, website: null };
  if (!uri) return blank;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6_000);
    const r = await fetch(ipfsToHttp(uri), { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) return blank;
    const j = (await r.json()) as Record<string, unknown>;
    const s = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : null);
    // Store image as the raw `ipfs://` URI; the frontend resolves it through
    // its own (working) gateway, so a gateway change never strands stored rows.
    const image = s("image") ?? s("imageURI") ?? "";
    return {
      image,
      description: s("description"),
      twitter: s("twitter"),
      telegram: s("telegram"),
      website: s("website"),
    };
  } catch { return blank; }
}

/// Refresh the snapshot fields on a Launch row from one `lens.getPoolSnapshot()`
/// staticcall. Single source of truth; never reproduces engine math.
async function refreshSnapshot(args: {
  launchId: `0x${string}`;
  lens: `0x${string}`;
  ts: bigint;
  sqrtPriceX96?: bigint;
  context: any;
}) {
  const { launchId, lens, ts, context } = args;
  try {
    const snap = await context.client.readContract({
      address: lens, abi: PerpLensAbi, functionName: "getPoolSnapshot",
    });
    await context.db.update(Launch, { id: launchId }).set((row: any) => ({
      curveEth:          snap.curveEth,
      reserveETH:        snap.reserveETH,
      reserveTOKEN:      snap.reserveTOKEN,
      insuranceETH:      snap.insuranceETH,
      insuranceTOKEN:    snap.insuranceTOKEN,
      totalDebtETH:      snap.totalDebtETH,
      totalDebtTOKEN:    snap.totalDebtTOKEN,
      totalHoldingTOKEN: snap.totalHoldingTOKEN,
      totalHeldETH:      snap.totalHeldETH,
      totalBadDebtETH:   snap.totalBadDebtETH,
      totalBadDebtTOKEN: snap.totalBadDebtTOKEN,
      numOpenPositions:  Number(snap.numOpenPositions),
      tradingEnabled:    snap.tradingEnabled,
      paused:            snap.paused,
      lastTradeAt:       ts,
      lastSqrtPriceX96:  args.sqrtPriceX96 ?? snap.sqrtPriceX96,
      tradeCount:        (row.tradeCount ?? 0) + 1,
    }));
  } catch {
    // staticcall failure (RPC blip / state still pre-init) — leave row as-is
    // for now; the next event will refresh.
  }
}

// Minimal ERC-20 view ABI for reading a base asset's decimals + symbol.
const ERC20_META_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol",   stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/// Best-effort base-asset metadata. The engine treats every base as raw units,
/// so the UI needs decimals/symbol to render amounts. Defaults: 18 / "".
async function fetchBaseMeta(client: any, base: `0x${string}`): Promise<{ decimals: number; symbol: string }> {
  try {
    const [dec, sym] = await Promise.all([
      client.readContract({ address: base, abi: ERC20_META_ABI, functionName: "decimals" }),
      client.readContract({ address: base, abi: ERC20_META_ABI, functionName: "symbol" }),
    ]);
    return { decimals: Number(dec), symbol: String(sym) };
  } catch {
    return { decimals: 18, symbol: "" };
  }
}

// ─── Perpfactory:Launched → create the Launch row ───────────────────────────

ponder.on("Perpfactory:Launched", async ({ event, context }) => {
  const { hook, token, creator, lens, base, v, tickWidth, name, symbol, tokenUri } = event.args;
  const meta = await fetchMetadata(tokenUri);
  const baseMeta = await fetchBaseMeta(context.client, base);

  await context.db.insert(Launch).values({
    id: hook,
    hook, token, lens, base, creator,
    name, symbol, tokenUri,
    imageURI: meta.image,
    description: meta.description,
    twitter: meta.twitter,
    telegram: meta.telegram,
    website: meta.website,
    baseDecimals: baseMeta.decimals,
    baseSymbol:   baseMeta.symbol,
    v, tickWidth,
    createdAt:    event.block.timestamp,
    createdBlock: event.block.number,
    createdTx:    event.transaction.hash,
    launchBlock:  event.block.number,
    tradingEnabled: true,        // create() seeds 50 bands ⇒ trading enabled at end of tx
    paused:         false,
  });

  // First snapshot — gives us curveEth, reserves, etc. immediately.
  await refreshSnapshot({ launchId: hook, lens, ts: event.block.timestamp, context });
});

// ─── leverage events ─────────────────────────────────────────────────────────

ponder.on("PerpHook:PositionOpened", async ({ event, context }) => {
  const launchId = event.log.address;            // the hook addr = Launch.id
  const { id, owner, side, collateral, debt, holding } = event.args;
  const sideStr = Number(side) === 0 ? "long" : "short";
  const posId   = `${launchId}-${id.toString()}`;

  // The hook's position storage has the full picture; one staticcall enriches.
  // Best-effort: if the staticcall fails (very rare), fall back to event args.
  let openSqrt = 0n; let lev = 0;
  let dETH = 0n; let dTOK = 0n; let holdT = 0n; let heldE = 0n;
  try {
    const p = await context.client.readContract({
      address: launchId, abi: (await import("../abis/PerpHook")).PerpHookAbi,
      functionName: "positions", args: [id],
    });
    openSqrt = p.openSqrtPriceX96;
    lev      = Number(p.leverage);
    dETH = p.debtETH; dTOK = p.debtTOKEN; holdT = p.holdingTOKEN; heldE = p.heldETH;
  } catch {
    if (sideStr === "long")  { dETH = debt; holdT = holding; } else { dTOK = debt; heldE = holding; }
  }

  await context.db.insert(Position).values({
    id: posId, launch: launchId, positionId: id, owner, side: sideStr,
    collateralETH: collateral, debtETH: dETH, debtTOKEN: dTOK,
    holdingTOKEN: holdT, heldETH: heldE,
    openSqrtPriceX96: openSqrt, leverage: lev,
    openedAt: event.block.timestamp, openedAtBlock: event.block.number,
    openedTx: event.transaction.hash,
    status: "open",
  });

  await context.db.insert(Trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    launch: launchId,
    kind: sideStr === "long" ? "open_long" : "open_short",
    who: owner, positionId: id,
    sizeBase: collateral,
    sizeToken: sideStr === "long" ? holding : 0n,
    sqrtPriceX96: openSqrt,
    ts: event.block.timestamp, blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  const launch = await context.db.find(Launch, { id: launchId });
  if (launch) await refreshSnapshot({ launchId, lens: launch.lens, ts: event.block.timestamp, sqrtPriceX96: openSqrt, context });
});

ponder.on("PerpHook:PositionClosed", async ({ event, context }) => {
  const launchId = event.log.address;
  const { id, owner, returned } = event.args;
  const posId = `${launchId}-${id.toString()}`;

  await context.db.update(Position, { id: posId }).set({
    status: "closed",
    closedAt: event.block.timestamp,
    closedAtBlock: event.block.number,
    closedTx: event.transaction.hash,
    closedReturned: returned,
  });

  await context.db.insert(Trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    launch: launchId, kind: "close",
    who: owner, positionId: id,
    sizeBase: returned,
    ts: event.block.timestamp, blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  const launch = await context.db.find(Launch, { id: launchId });
  if (launch) await refreshSnapshot({ launchId, lens: launch.lens, ts: event.block.timestamp, context });
});

ponder.on("PerpHook:PositionLiquidated", async ({ event, context }) => {
  const launchId = event.log.address;
  const { id, owner } = event.args;
  const posId = `${launchId}-${id.toString()}`;

  await context.db.update(Position, { id: posId }).set({
    status: "liquidated",
    closedAt: event.block.timestamp,
    closedAtBlock: event.block.number,
    closedTx: event.transaction.hash,
  });

  await context.db.insert(Trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    launch: launchId, kind: "liquidation",
    who: owner, positionId: id,
    ts: event.block.timestamp, blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  const launch = await context.db.find(Launch, { id: launchId });
  if (launch) await refreshSnapshot({ launchId, lens: launch.lens, ts: event.block.timestamp, context });
});

ponder.on("PerpHook:Claimed", async ({ event, context }) => {
  const launchId = event.log.address;
  const { user, amount } = event.args;

  await context.db.insert(Trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    launch: launchId, kind: "claim",
    who: user, sizeBase: amount,
    ts: event.block.timestamp, blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  const launch = await context.db.find(Launch, { id: launchId });
  if (launch) await refreshSnapshot({ launchId, lens: launch.lens, ts: event.block.timestamp, context });
});

ponder.on("PerpHook:PausedSet", async ({ event, context }) => {
  await context.db.update(Launch, { id: event.log.address }).set({ paused: event.args.paused });
});

// ─── ERC-20 transfers on each launched PerpToken → Holder table ─────────────

ponder.on("PerpToken:Transfer", async ({ event, context }) => {
  const tokenAddr = event.log.address;
  const { from, to, value } = event.args;
  if (value === 0n) return;

  // The Launch row's id is the HOOK address, not the token. Look up by token.
  // (Cheap because we have an index would be ideal — but Ponder's find-by-fk
  //  is a sequential scan; the token→hook map is tiny and only ever appends.
  //  At any scale where this matters we add an index. MVP-fine.)
  // For now we accept the cost; the Transfer firehose isn't on the hot path.
  const ts = event.block.timestamp;

  if (from !== ZERO) {
    const fromId = `${tokenAddr}-${from}`;
    const cur = await context.db.find(Holder, { id: fromId });
    if (cur) {
      await context.db.update(Holder, { id: fromId }).set({
        balance: cur.balance - value, updatedAt: ts,
      });
    }
  }
  if (to !== ZERO) {
    const toId = `${tokenAddr}-${to}`;
    const cur = await context.db.find(Holder, { id: toId });
    if (cur) {
      await context.db.update(Holder, { id: toId }).set({
        balance: cur.balance + value, updatedAt: ts,
      });
    } else {
      await context.db.insert(Holder).values({
        id: toId, launch: tokenAddr, address: to, balance: value, updatedAt: ts,
      });
    }
  }
});
