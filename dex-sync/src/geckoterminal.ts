/// GeckoTerminal API client — per-pool spot trades.
/// Docs: https://api.geckoterminal.com/docs/index.html
///
/// Endpoint: GET /networks/{network}/pools/{pool}/trades
///   - returns up to ~300 trades from the last 24h for one pool
///   - free, no API key; rolling rate limit ~30 calls/min
///   - for Uniswap v4 the pool address == the v4 poolId, which is exactly the
///     `pairAddress` dexscreener gives us (verified) → we reuse our stored
///     pool_id, no extra resolution call.
///
/// We DON'T poll every pool — the caller only asks for pools that just traded
/// (detected cheaply via the batched dexscreener txn count), so this low rate
/// limit scales to any number of launches.

const GT = "https://api.geckoterminal.com/api/v2";
const NETWORK = process.env.GT_NETWORK ?? "eth";

export interface GtTrade {
  id: string;
  side: "buy" | "sell";
  amountUsd: number | null;
  priceUsd: number | null;
  ts: Date;
  txHash: string;
  who: string | null;
}

interface GtTradeRaw {
  id: string;
  attributes: {
    block_timestamp: string;
    tx_hash: string;
    tx_from_address?: string;
    from_token_address: string;
    to_token_address: string;
    price_from_in_usd?: string;
    price_to_in_usd?: string;
    volume_in_usd?: string;
    kind?: string;
  };
}

function num(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const n = typeof s === "number" ? s : parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export interface GtTokenPrice {
  token: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volumeH24Usd: number | null;
  priceChangeH24Pct: number | null;
}

/// Batch USD price/mcap/24h-vol/24h-change for up to 30 tokens in ONE call.
/// Used to price the base assets (USDC/WBTC/…) for the Markets rail — most are
/// the QUOTE side of their pools, so the dexscreener-by-baseToken path misses
/// them. The /simple endpoint returns parallel maps keyed by lowercased addr.
/// @throws on non-200 so the caller can back off.
export async function fetchTokenPrices(addresses: string[]): Promise<GtTokenPrice[]> {
  if (addresses.length === 0) return [];
  const url =
    `${GT}/simple/networks/${NETWORK}/token_price/${addresses.join(",")}` +
    `?include_market_cap=true&include_24hr_vol=true&include_24hr_price_change=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
  const a = ((await res.json()) as { data?: { attributes?: any } }).data?.attributes ?? {};
  const px = a.token_prices ?? {};
  const mc = a.market_cap_usd ?? {};
  const vol = a.h24_volume_usd ?? {};
  const chg = a.h24_price_change_percentage ?? {};
  return Object.keys(px).map((t) => ({
    token: t.toLowerCase(),
    priceUsd: num(px[t]),
    marketCapUsd: num(mc[t]),
    volumeH24Usd: num(vol[t]),
    priceChangeH24Pct: num(chg[t]),
  }));
}

/// Per-token info: the v4 poolId GT indexes the token under (its top pool) +
/// FDV. Used in gecko-only mode (X Layer) to (a) discover the poolId we need
/// to fetch trades by, since the Ponder indexer doesn't store it, and (b) get
/// a real USD-denominated cap (GT leaves market_cap_usd null until it has a
/// circulating-supply data point; FDV is always populated).
/// @throws on non-200 so the caller can back off.
export interface GtTokenInfo {
  topPoolAddress: string | null;  // bare 0x-hex, no chain prefix
  fdvUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
}
export async function fetchTokenInfo(address: string): Promise<GtTokenInfo> {
  const url = `${GT}/networks/${NETWORK}/tokens/${address}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
  const j = (await res.json()) as any;
  const a = j?.data?.attributes ?? {};
  const r = j?.data?.relationships ?? {};
  // top_pools[0].id looks like "x-layer_0x44fba..." — strip the chain prefix.
  const topId: string | undefined = r?.top_pools?.data?.[0]?.id;
  const top = topId?.includes("_") ? topId.split("_").slice(1).join("_") : topId ?? null;
  return {
    topPoolAddress: top && /^0x[0-9a-fA-F]+$/.test(top) ? top.toLowerCase() : null,
    fdvUsd: num(a.fdv_usd),
    marketCapUsd: num(a.market_cap_usd),
    priceUsd: num(a.price_usd),
  };
}

/// Fetch recent trades for one pool, oriented to `token` (our launched token):
/// a trade that DELIVERS `token` to the trader is a "buy"; one that spends it
/// is a "sell" — robust regardless of GeckoTerminal's base/quote ordering.
/// @throws on non-200 (429/5xx) so the caller can back off.
export async function fetchPoolTrades(pool: string, token: string): Promise<GtTrade[]> {
  const url = `${GT}/networks/${NETWORK}/pools/${pool}/trades`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`); // 429 ⇒ caller backs off

  const body = (await res.json()) as { data?: GtTradeRaw[] | null };
  const data = body.data ?? [];
  const tok = token.toLowerCase();

  return data.map((d) => {
    const a = d.attributes;
    const isBuy = a.to_token_address?.toLowerCase() === tok; // trader received our token
    return {
      id: d.id,
      side: isBuy ? "buy" : "sell",
      amountUsd: num(a.volume_in_usd),
      priceUsd: isBuy ? num(a.price_to_in_usd) : num(a.price_from_in_usd),
      ts: new Date(a.block_timestamp),
      txHash: a.tx_hash,
      who: a.tx_from_address ?? null,
    };
  });
}
