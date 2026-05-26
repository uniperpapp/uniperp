import pg from "pg";

const { Pool } = pg;

declare global {
  // eslint-disable-next-line no-var
  var __dexPool: pg.Pool | undefined;
  // eslint-disable-next-line no-var
  var __dexInitDone: boolean | undefined;
}

export function getPool(): pg.Pool {
  if (!global.__dexPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL not set");
    global.__dexPool = new Pool({
      connectionString,
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    });
  }
  return global.__dexPool;
}

/// Idempotent — safe to run on every boot. Sibling tables to the Ponder
/// indexer's tables; same Postgres, no FK constraints across services so
/// either can be reset independently.
export async function ensureSchema(): Promise<void> {
  if (global.__dexInitDone) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dex_data (
      token_address         text PRIMARY KEY,
      pool_id               text NOT NULL,
      price_usd             numeric(40, 18),
      price_native          numeric(40, 18),
      market_cap_usd        numeric(40, 4),
      fdv_usd               numeric(40, 4),
      liquidity_usd         numeric(40, 4),
      volume_h1_usd         numeric(40, 4),
      volume_h24_usd        numeric(40, 4),
      txns_h1_count         integer,
      price_change_h1_pct   numeric(12, 4),
      price_change_h24_pct  numeric(12, 4),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      source                text NOT NULL DEFAULT 'dexscreener'
    );

    CREATE INDEX IF NOT EXISTS dex_volume_h24_idx ON dex_data (volume_h24_usd DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS dex_marketcap_idx  ON dex_data (market_cap_usd  DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS dex_updated_idx    ON dex_data (updated_at DESC);

    CREATE TABLE IF NOT EXISTS dex_trade (
      id              text PRIMARY KEY,           -- {token_address}-{tx_hash}-{log_index}
      token_address   text NOT NULL,
      pool_id         text NOT NULL,
      side            text NOT NULL,              -- 'buy' | 'sell'
      base_amount     numeric(78, 0),             -- raw token amount (wei-like)
      quote_amount    numeric(78, 0),
      amount_usd      numeric(40, 4),
      price_usd       numeric(40, 18),
      ts              timestamptz NOT NULL,
      tx_hash         text NOT NULL,
      who             text,
      source          text NOT NULL DEFAULT 'dexscreener'
    );

    CREATE INDEX IF NOT EXISTS dex_trade_token_ts_idx ON dex_trade (token_address, ts DESC);
    CREATE INDEX IF NOT EXISTS dex_trade_ts_idx       ON dex_trade (ts DESC);
  `);
  global.__dexInitDone = true;
}

export interface DexRowDb {
  tokenAddress: string;
  poolId: string;
  priceUsd: number | null;
  priceNative: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  txnsH1Count: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH24Pct: number | null;
}

export async function upsertDexData(d: DexRowDb) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dex_data
      (token_address, pool_id, price_usd, price_native, market_cap_usd, fdv_usd,
       liquidity_usd, volume_h1_usd, volume_h24_usd, txns_h1_count,
       price_change_h1_pct, price_change_h24_pct, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (token_address) DO UPDATE SET
       pool_id              = EXCLUDED.pool_id,
       price_usd            = EXCLUDED.price_usd,
       price_native         = EXCLUDED.price_native,
       market_cap_usd       = EXCLUDED.market_cap_usd,
       fdv_usd              = EXCLUDED.fdv_usd,
       liquidity_usd        = EXCLUDED.liquidity_usd,
       volume_h1_usd        = EXCLUDED.volume_h1_usd,
       volume_h24_usd       = EXCLUDED.volume_h24_usd,
       txns_h1_count        = EXCLUDED.txns_h1_count,
       price_change_h1_pct  = EXCLUDED.price_change_h1_pct,
       price_change_h24_pct = EXCLUDED.price_change_h24_pct,
       updated_at           = now();`,
    [
      d.tokenAddress.toLowerCase(), d.poolId,
      d.priceUsd, d.priceNative, d.marketCapUsd, d.fdvUsd,
      d.liquidityUsd, d.volumeH1Usd, d.volumeH24Usd, d.txnsH1Count,
      d.priceChangeH1Pct, d.priceChangeH24Pct,
    ],
  );
}

export async function insertDexTrades(rows: {
  id: string;
  tokenAddress: string;
  poolId: string;
  side: "buy" | "sell";
  baseAmount: string | null;
  quoteAmount: string | null;
  amountUsd: number | null;
  priceUsd: number | null;
  ts: Date;
  txHash: string;
  who: string | null;
}[]) {
  if (rows.length === 0) return;
  const pool = getPool();
  // simple loop; row counts are tiny per poll
  for (const r of rows) {
    await pool.query(
      `INSERT INTO dex_trade
         (id, token_address, pool_id, side, base_amount, quote_amount,
          amount_usd, price_usd, ts, tx_hash, who)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING;`,
      [
        r.id, r.tokenAddress.toLowerCase(), r.poolId, r.side,
        r.baseAmount, r.quoteAmount, r.amountUsd, r.priceUsd,
        r.ts.toISOString(), r.txHash, r.who,
      ],
    );
  }
}

/// Batch upsert one poll's worth of rows (≤30). Sequential — counts are tiny.
export async function upsertDexRows(rows: DexRowDb[]) {
  for (const r of rows) await upsertDexData(r);
}

/// Upsert a base asset's USD price/mcap/volume (from GeckoTerminal). Updates
/// ONLY price fields — never touches pool_id — so a token that also has a real
/// pool (e.g. PERP, set by the dexscreener path) keeps it and stays in the
/// trades poll. New base rows get pool_id='' ⇒ excluded from getPools().
export async function upsertBasePrice(r: {
  token: string; priceUsd: number | null; marketCapUsd: number | null;
  volumeH24Usd: number | null; priceChangeH24Pct: number | null;
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dex_data
       (token_address, pool_id, price_usd, market_cap_usd, volume_h24_usd, price_change_h24_pct, updated_at, source)
     VALUES ($1, '', $2, $3, $4, $5, now(), 'geckoterminal')
     ON CONFLICT (token_address) DO UPDATE SET
       price_usd            = EXCLUDED.price_usd,
       market_cap_usd       = EXCLUDED.market_cap_usd,
       volume_h24_usd       = EXCLUDED.volume_h24_usd,
       price_change_h24_pct = EXCLUDED.price_change_h24_pct,
       updated_at           = now();`,
    [r.token.toLowerCase(), r.priceUsd, r.marketCapUsd, r.volumeH24Usd, r.priceChangeH24Pct],
  );
}

/// Gecko-mode upsert for LAUNCH tokens: sets pool_id (so the trades loop can
/// hit GT /pools/{poolId}/trades), price, mcap (synthesized from FDV / price ×
/// supply by the caller — GT leaves market_cap_usd null for new tokens), vol,
/// 24h change. pool_id is preserved on update via COALESCE so a once-resolved
/// pool stays put even if a later cycle can't fetch it.
export async function upsertLaunchGecko(r: {
  token: string; poolId: string;
  priceUsd: number | null; marketCapUsd: number | null;
  volumeH24Usd: number | null; priceChangeH24Pct: number | null;
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dex_data
       (token_address, pool_id, price_usd, market_cap_usd, volume_h24_usd, price_change_h24_pct, updated_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, now(), 'geckoterminal')
     ON CONFLICT (token_address) DO UPDATE SET
       pool_id              = COALESCE(NULLIF(EXCLUDED.pool_id, ''), dex_data.pool_id),
       price_usd            = EXCLUDED.price_usd,
       market_cap_usd       = EXCLUDED.market_cap_usd,
       volume_h24_usd       = EXCLUDED.volume_h24_usd,
       price_change_h24_pct = EXCLUDED.price_change_h24_pct,
       updated_at           = now();`,
    [r.token.toLowerCase(), r.poolId, r.priceUsd, r.marketCapUsd, r.volumeH24Usd, r.priceChangeH24Pct],
  );
}

/// Pools to poll for trades: every token we have a dex_data row + pool_id for.
/// (pool_id == the v4 pool address GeckoTerminal indexes by.)
export async function getPools(): Promise<{ token: string; poolId: string }[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT token_address, pool_id FROM dex_data WHERE pool_id IS NOT NULL AND pool_id <> ''`,
  );
  return rows.map((r) => ({ token: r.token_address as string, poolId: r.pool_id as string }));
}

/// Recent spot trades for the activity feed. Optional `token` filter; newest
/// first. `ts` returned as unix seconds (matches the frontend's timeAgo()).
export async function getRecentTrades(limit: number, token?: string): Promise<{
  id: string; token: string; side: string;
  amountUsd: number | null; priceUsd: number | null;
  ts: number; txHash: string; who: string | null;
}[]> {
  const pool = getPool();
  const lim = Math.max(1, Math.min(100, limit));
  const { rows } = token
    ? await pool.query(
        `SELECT id, token_address, side, amount_usd, price_usd,
                extract(epoch from ts)::bigint AS ts, tx_hash, who
           FROM dex_trade WHERE token_address = $1
          ORDER BY ts DESC LIMIT $2`,
        [token.toLowerCase(), lim],
      )
    : await pool.query(
        `SELECT id, token_address, side, amount_usd, price_usd,
                extract(epoch from ts)::bigint AS ts, tx_hash, who
           FROM dex_trade ORDER BY ts DESC LIMIT $1`,
        [lim],
      );
  const n = (v: any) => (v == null ? null : Number(v));
  return rows.map((r) => ({
    id: r.id, token: r.token_address, side: r.side,
    amountUsd: n(r.amount_usd), priceUsd: n(r.price_usd),
    ts: Number(r.ts), txHash: r.tx_hash, who: r.who ?? null,
  }));
}

/// Serve the frontend's `useDexData` hook: token→datum map (camelCase shape
/// matching frontend/lib/use-dex-data.ts DexDatum).
export async function getDexByTokens(ids: string[]): Promise<Record<string, {
  priceUsd: number | null; priceNative: number | null;
  marketCapUsd: number | null; fdvUsd: number | null; liquidityUsd: number | null;
  volumeH1Usd: number | null; volumeH24Usd: number | null;
  priceChangeH1Pct: number | null; priceChangeH24Pct: number | null;
  updatedAt: string | null;
}>> {
  if (ids.length === 0) return {};
  const pool = getPool();
  const lower = ids.map((s) => s.toLowerCase());
  const { rows } = await pool.query(
    `SELECT token_address, price_usd, price_native, market_cap_usd, fdv_usd,
            liquidity_usd, volume_h1_usd, volume_h24_usd,
            price_change_h1_pct, price_change_h24_pct, updated_at
       FROM dex_data
      WHERE token_address = ANY($1::text[])`,
    [lower],
  );
  const n = (v: any) => (v == null ? null : Number(v));
  const out: Record<string, any> = {};
  for (const r of rows) {
    out[r.token_address] = {
      priceUsd:          n(r.price_usd),
      priceNative:       n(r.price_native),
      marketCapUsd:      n(r.market_cap_usd),
      fdvUsd:            n(r.fdv_usd),
      liquidityUsd:      n(r.liquidity_usd),
      volumeH1Usd:       n(r.volume_h1_usd),
      volumeH24Usd:      n(r.volume_h24_usd),
      priceChangeH1Pct:  n(r.price_change_h1_pct),
      priceChangeH24Pct: n(r.price_change_h24_pct),
      updatedAt:         r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
  }
  return out;
}
