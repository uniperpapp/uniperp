/// dex-sync — Dexscreener/GeckoTerminal batched price refresh + live spot-trade feed.
///
/// Three concurrent duties in one long-running Railway process:
///   1. Price loop — round-robins every launched token through Dexscreener in
///      30-token batches at 4 req/s (240/min, under the 300/min limit). Besides
///      price/volume/mcap, it reads each pool's rolling txn count and, when that
///      count INCREASES (a new trade happened), marks the pool "dirty".
///   2. Trades loop — drains the dirty set through GeckoTerminal's per-pool
///      /trades endpoint at ≤1 call/2.2s (~27/min, under GT's ~30/min limit),
///      upserting individual spot trades. Idle pools cost ZERO GT calls, so this
///      scales to any number of launches: we only ever spend GT budget on pools
///      that actually traded (the only ones with trades to show). Dexscreener is
///      the cheap, batched "who just traded" signal; GeckoTerminal supplies the
///      trade detail. New pools get a one-time backfill on first sight.
///   3. HTTP server (Hono) — serves `dex_data` at GET /dex and recent spot
///      trades at GET /trades to the frontend.
///
/// On-chain LEVERAGE activity (opens/closes/liquidations) still comes from the
/// Ponder indexer; the frontend merges both into one Recent-trades feed.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

import { ensureSchema, upsertDexRows, getDexByTokens, getRecentTrades, insertDexTrades, upsertBasePrice, upsertLaunchGecko, getPools } from "./db.ts";
import { fetchTokens } from "./dexscreener.ts";
import { fetchPoolTrades, fetchTokenPrices, fetchTokenInfo } from "./geckoterminal.ts";
import { fetchLaunches } from "./ponder.ts";

// ── polling loop ────────────────────────────────────────────────────────────

/// 4 req/s = 240/min (20% buffer under Dexscreener's 300/min rolling limit).
const TARGET_INTERVAL_MS = 250;
/// Dexscreener hard cap per /tokens call.
const BATCH_SIZE = 30;
/// Re-pull the launch list from the indexer this often so new launches join.
const LAUNCHES_RELOAD_MS = 60_000;

// Extra non-factory tokens to track (e.g. the v2 $PERP token, deployed
// directly). Format: "token:base,token:base" (base = quote token; use the zero
// address for native-ETH pools so the dexscreener pair pick matches).
const EXTRA_TOKENS: { token: `0x${string}`; base: `0x${string}` }[] = (process.env.EXTRA_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((pair) => {
    const [token, base] = pair.split(":");
    return { token: token!.toLowerCase() as `0x${string}`, base: (base ?? "").toLowerCase() as `0x${string}` };
  })
  .filter((e) => /^0x[0-9a-f]{40}$/.test(e.token));

// Base assets to price for the Markets rail (USDC/WBTC/… are usually the QUOTE
// side, so the dexscreener path misses them). Priced via GeckoTerminal batch,
// stored price-only (no pool_id) ⇒ kept OUT of the trades poll. Comma-separated.
const BASE_TOKENS: string[] = (process.env.BASE_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => /^0x[0-9a-f]{40}$/.test(s));

/// Data backend: "dexscreener" (default, Ethereum mainnet — dexscreener prices
/// for launches + GT for bases/trades) or "gecko" (X Layer and anywhere
/// dexscreener doesn't index — GT for EVERYTHING via the simple/token_price
/// batch endpoint; no per-pool trades for v1 to keep within GT rate limits).
const BACKEND = (process.env.BACKEND ?? "dexscreener").toLowerCase();

let launches: { token: `0x${string}`; base: `0x${string}` }[] = [];
let lastReload = 0;
let cursor = 0;

/// Last-seen rolling txn count per token (from dexscreener). An increase ⇒ a
/// new trade ⇒ that pool goes "dirty" for the GeckoTerminal trades fetch.
const txnSeen = new Map<string, number>();
/// Pools awaiting a trades fetch — `token → poolId`, FIFO (Map keeps insertion
/// order), bounded by the launch count.
const dirty = new Map<string, string>();

async function loopOnce(): Promise<void> {
  const started = Date.now();
  try {
    if (started - lastReload > LAUNCHES_RELOAD_MS || launches.length === 0) {
      const fresh = await fetchLaunches();
      if (fresh.length > 0) {
        const factory = fresh.map((l) => ({ token: l.token, base: l.base }));
        // Prepend extras (e.g. $PERP), de-duped against factory launches.
        const seen = new Set(factory.map((l) => l.token.toLowerCase()));
        launches = [...EXTRA_TOKENS.filter((e) => !seen.has(e.token)), ...factory];
      } else if (launches.length === 0) {
        launches = [...EXTRA_TOKENS];
      }
      lastReload = started;
    }

    if (launches.length > 0) {
      const take = Math.min(BATCH_SIZE, launches.length);
      const batch: { token: string; base: string }[] = [];
      for (let i = 0; i < take; i++) batch.push(launches[(cursor + i) % launches.length]!);
      cursor = (cursor + take) % launches.length;

      const rows = await fetchTokens(batch);
      if (rows.length > 0) {
        await upsertDexRows(rows);
        // Activity detection: first sight ⇒ backfill; count increase ⇒ new trade.
        for (const r of rows) {
          const tok = r.tokenAddress.toLowerCase();
          const c = r.txnsH1Count ?? 0;
          const prev = txnSeen.get(tok);
          if (prev === undefined || c > prev) dirty.set(tok, r.poolId);
          txnSeen.set(tok, c);
        }
      }
    }
  } catch (err) {
    // Transient (429 / 5xx / network): log + brief extra wait, self-recover.
    console.error("[dex-sync] batch failed:", (err as Error).message);
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // Self-schedule: next tick TARGET_INTERVAL_MS after this one started; if the
  // call ran long, fire immediately.
  const wait = Math.max(0, TARGET_INTERVAL_MS - (Date.now() - started));
  setTimeout(loopOnce, wait);
}

// ── trades loop (GeckoTerminal, rate-limited) ─────────────────────────────────

/// ~1 call / 2.2s ≈ 27/min, under GeckoTerminal's ~30/min free limit.
const GT_INTERVAL_MS = 2_200;

async function tradesLoopOnce(): Promise<void> {
  const started = Date.now();
  let extra = 0;
  try {
    const next = dirty.entries().next(); // oldest dirty pool (FIFO fairness)
    if (!next.done) {
      const [token, poolId] = next.value;
      dirty.delete(token);
      const trades = await fetchPoolTrades(poolId, token);
      if (trades.length > 0) {
        await insertDexTrades(
          trades.map((t) => ({
            id: t.id, tokenAddress: token, poolId, side: t.side,
            baseAmount: null, quoteAmount: null,
            amountUsd: t.amountUsd, priceUsd: t.priceUsd,
            ts: t.ts, txHash: t.txHash, who: t.who,
          })),
        );
      }
    }
  } catch (err) {
    // 429/5xx: back off an extra beat; the pool stays out of `dirty` (already
    // popped) but the next dexscreener delta will re-enqueue it.
    console.error("[dex-sync] trades batch failed:", (err as Error).message);
    extra = 2_000;
  }
  const wait = Math.max(0, GT_INTERVAL_MS - (Date.now() - started)) + extra;
  setTimeout(tradesLoopOnce, wait);
}

// ── gecko-only loop (X Layer mode — dexscreener doesn't index X Layer) ─────

/// Batched GT price refresh covering BOTH base assets AND launch tokens (one
/// /simple/token_price call ≤30 addresses every interval). For LAUNCH tokens
/// we also (a) lazily resolve their v4 poolId via a one-time /tokens/{addr}
/// fetch — the Ponder indexer doesn't store it — so the trades loop can hit
/// /pools/{poolId}/trades, and (b) synthesize market cap from priceUsd × the
/// known 1M total supply, since GT leaves market_cap_usd null until it has a
/// circulating-supply data point (new tokens don't).
const GECKO_INTERVAL_MS = 30_000;

/// Total supply of every Perpfactory launch (1_000_000 ether, per
/// PerpToken.TOTAL_SUPPLY). Used to derive mcap from priceUsd when GT can't.
const LAUNCH_SUPPLY = 1_000_000;

/// Cache: launchToken → v4 poolId (resolved once via GT /tokens). Persisted in
/// dex_data.pool_id, but kept in memory too so we don't re-fetch on every cycle.
const launchPoolIds = new Map<string, string>();

async function geckoPriceLoopOnce(): Promise<void> {
  const started = Date.now();
  let extra = 0;
  try {
    if (started - lastReload > LAUNCHES_RELOAD_MS || launches.length === 0) {
      const fresh = await fetchLaunches();
      if (fresh.length > 0) launches = fresh.map((l) => ({ token: l.token, base: l.base }));
      lastReload = started;
    }
    // Hydrate launchPoolIds from DB once on cold start, so the trades loop can
    // start immediately without waiting for a per-token resolve.
    if (launchPoolIds.size === 0) {
      const pools = await getPools();
      for (const p of pools) launchPoolIds.set(p.token.toLowerCase(), p.poolId);
    }

    // Resolve any unknown poolIds — one /tokens call per new launch, only once.
    // Trivially under the ~30/min GT budget at expected launch cadence.
    for (const l of launches) {
      const tok = l.token.toLowerCase();
      if (launchPoolIds.has(tok)) continue;
      try {
        const info = await fetchTokenInfo(tok);
        if (info.topPoolAddress) {
          launchPoolIds.set(tok, info.topPoolAddress);
          console.log(`[dex-sync] resolved pool ${tok} → ${info.topPoolAddress}`);
        }
      } catch (e) {
        console.error(`[dex-sync] tokenInfo ${tok} failed:`, (e as Error).message);
      }
    }

    // Union of bases (env) + launch tokens. GT simple endpoint caps at 30.
    const launchSet = new Set(launches.map((l) => l.token.toLowerCase()));
    const set = new Set<string>(BASE_TOKENS);
    for (const t of launchSet) set.add(t);
    const list = Array.from(set).slice(0, 30);
    if (list.length > 0) {
      const prices = await fetchTokenPrices(list);
      for (const p of prices) {
        if (!p.token) continue;
        if (launchSet.has(p.token)) {
          // Launch token: synthesize mcap if GT gave us null, persist poolId.
          const poolId = launchPoolIds.get(p.token) ?? "";
          const mcap = p.marketCapUsd ?? (p.priceUsd != null ? p.priceUsd * LAUNCH_SUPPLY : null);
          await upsertLaunchGecko({
            token: p.token, poolId,
            priceUsd: p.priceUsd, marketCapUsd: mcap,
            volumeH24Usd: p.volumeH24Usd, priceChangeH24Pct: p.priceChangeH24Pct,
          });
        } else {
          // Base asset (USDC/WOKB): price-only, no pool.
          await upsertBasePrice(p);
        }
      }
    }
  } catch (err) {
    console.error("[dex-sync] gecko loop failed:", (err as Error).message);
    extra = 5_000;
  }
  const wait = Math.max(0, GECKO_INTERVAL_MS - (Date.now() - started)) + extra;
  setTimeout(geckoPriceLoopOnce, wait);
}

// ── gecko-mode trades loop ──────────────────────────────────────────────────

/// In gecko mode there's no dexscreener "did this pool just trade?" signal, so
/// we round-robin through every launch with a known poolId and poll its trades
/// directly. Kept gentle (~6s/call ≈ 10/min) because GT's ~30/min free limit
/// is shared with the mainnet dex-sync (same Railway egress IP) AND with the
/// price/info calls in this same process; 429s here are silently dropped and
/// re-tried next rotation. With one launch this still polls the same pool
/// every 6s — plenty live for the demo.
const GECKO_TRADES_INTERVAL_MS = 6_000;
let geckoTradesCursor = 0;

async function geckoTradesLoopOnce(): Promise<void> {
  const started = Date.now();
  let extra = 0;
  try {
    const entries = Array.from(launchPoolIds.entries());
    if (entries.length > 0) {
      const [token, poolId] = entries[geckoTradesCursor % entries.length]!;
      geckoTradesCursor = (geckoTradesCursor + 1) % entries.length;
      const trades = await fetchPoolTrades(poolId, token);
      if (trades.length > 0) {
        await insertDexTrades(
          trades.map((t) => ({
            id: t.id, tokenAddress: token, poolId, side: t.side,
            baseAmount: null, quoteAmount: null,
            amountUsd: t.amountUsd, priceUsd: t.priceUsd,
            ts: t.ts, txHash: t.txHash, who: t.who,
          })),
        );
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    // 429: back off harder; the same pool will get retried next rotation.
    if (msg.includes("429")) extra = 15_000;
    else { console.error("[dex-sync] gecko trades failed:", msg); extra = 4_000; }
  }
  const wait = Math.max(0, GECKO_TRADES_INTERVAL_MS - (Date.now() - started)) + extra;
  setTimeout(geckoTradesLoopOnce, wait);
}

// ── base-price loop (GeckoTerminal batch) ────────────────────────────────────

/// Refresh base-asset USD prices for the Markets rail. One batched GT call
/// (≤30 tokens) every interval — trivial against the ~30/min limit.
const BASES_INTERVAL_MS = 45_000;

async function basesLoopOnce(): Promise<void> {
  const started = Date.now();
  let extra = 0;
  try {
    if (BASE_TOKENS.length > 0) {
      const prices = await fetchTokenPrices(BASE_TOKENS.slice(0, 30));
      for (const p of prices) if (p.token) await upsertBasePrice(p);
    }
  } catch (err) {
    console.error("[dex-sync] bases batch failed:", (err as Error).message);
    extra = 5_000;
  }
  const wait = Math.max(0, BASES_INTERVAL_MS - (Date.now() - started)) + extra;
  setTimeout(basesLoopOnce, wait);
}

// ── HTTP API ────────────────────────────────────────────────────────────────

const app = new Hono();
app.use("/*", cors());

app.get("/health", (c) => c.json({ ok: true, watching: launches.length, cursor, dirty: dirty.size }));

/// Recent spot trades for the activity feed. GET /trades?limit=50[&token=0x..].
app.get("/trades", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const token = c.req.query("token") ?? "";
  const tok = /^0x[0-9a-fA-F]{40}$/.test(token) ? token : undefined;
  return c.json(await getRecentTrades(Number.isFinite(limit) ? limit : 50, tok));
});

/// Frontend useDexData: GET /dex?tokens=0xabc,0xdef → { "0xabc": {...}, ... }.
/// Caps at 100 addresses to bound PG load.
const DEX_IDS_MAX = 100;
app.get("/dex", async (c) => {
  const raw = c.req.query("tokens") ?? "";
  if (raw.length > 8192) return c.json({ error: "tokens too long" }, 400);
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s))
    .slice(0, DEX_IDS_MAX);
  if (ids.length === 0) return c.json({});
  return c.json(await getDexByTokens(ids));
});

// ── boot ────────────────────────────────────────────────────────────────────

async function main() {
  await ensureSchema();
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[dex-sync] http listening on :${info.port}`);
  });
  if (BACKEND === "gecko") {
    console.log(`[dex-sync] backend=gecko (GT-only mode; no dexscreener)`);
    console.log(`[dex-sync] gecko price loop: ${GECKO_INTERVAL_MS}ms (network=${process.env.GT_NETWORK ?? "eth"}, ${BASE_TOKENS.length} bases + dynamic launches)`);
    console.log(`[dex-sync] gecko trades loop: ${GECKO_TRADES_INTERVAL_MS}ms per pool`);
    geckoPriceLoopOnce();
    geckoTradesLoopOnce();
  } else {
    console.log(`[dex-sync] backend=dexscreener`);
    console.log(`[dex-sync] price loop: ${TARGET_INTERVAL_MS}ms interval, batch ${BATCH_SIZE}`);
    console.log(`[dex-sync] trades loop: ${GT_INTERVAL_MS}ms interval (GeckoTerminal)`);
    console.log(`[dex-sync] bases loop: ${BASES_INTERVAL_MS}ms interval, ${BASE_TOKENS.length} bases`);
    loopOnce();
    tradesLoopOnce();
    basesLoopOnce();
  }
}

main().catch((err) => {
  console.error("[dex-sync] fatal:", err);
  process.exit(1);
});
