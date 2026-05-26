/// Dexscreener API client — batched 30-token pull.
/// Docs: https://docs.dexscreener.com/api/reference
///
/// Endpoint: GET /latest/dex/tokens/{addresses}
///   - up to 30 comma-separated addresses per call (their hard cap)
///   - returns every pair matching any queried token
///   - rate limit: 300 requests/minute (free tier)
///
/// One call covers 30 launches, vs the old 1-call-per-token loop. The poller
/// (index.ts) round-robins batches at 4 req/s to stay under the limit while
/// refreshing ~120 tokens/second.

const BASE = "https://api.dexscreener.com";

export interface DexRow {
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

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number };
  priceChange?: { h24?: number; h1?: number };
  txns?: { h1?: { buys: number; sells: number } };
}

function num(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const n = typeof s === "number" ? s : parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/// Fetch dex data for up to 30 launches in ONE call.
/// @param batch  [{ token, base }] — `base` (WETH/PERP) disambiguates which
///               pair to pick when a token shows up in multiple pools.
/// @returns one DexRow per launch dexscreener has indexed (others skipped —
///          a freshly-launched token may not be indexed for a minute or two).
/// @throws  on non-200 (429 / 5xx) so the caller can back off.
export async function fetchTokens(
  batch: { token: string; base: string }[],
): Promise<DexRow[]> {
  if (batch.length === 0) return [];
  if (batch.length > 30) throw new Error(`dexscreener batch limit is 30, got ${batch.length}`);

  const addresses = batch.map((b) => b.token).join(",");
  const url = `${BASE}/latest/dex/tokens/${addresses}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`); // 429 ⇒ caller backs off

  const body = (await res.json()) as { pairs?: DexPair[] | null };
  const pairs = body.pairs ?? [];

  // Index ethereum pairs by baseToken address (the launched token side).
  const byBase = new Map<string, DexPair[]>();
  for (const p of pairs) {
    if (p.chainId !== "ethereum") continue;
    const k = p.baseToken.address.toLowerCase();
    const arr = byBase.get(k) ?? [];
    arr.push(p);
    byBase.set(k, arr);
  }

  const out: DexRow[] = [];
  for (const { token, base } of batch) {
    const candidates = byBase.get(token.toLowerCase());
    if (!candidates || candidates.length === 0) continue;

    // Prefer the pair quoted in our launch base (WETH/PERP) so priceUsd /
    // marketCap orient to the launched token. Fall back to highest liquidity.
    const baseLc = base.toLowerCase();
    let pick =
      candidates.find((p) => p.quoteToken.address.toLowerCase() === baseLc) ??
      candidates.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!pick) continue;

    out.push({
      tokenAddress:      token.toLowerCase(),
      poolId:            pick.pairAddress,
      priceUsd:          num(pick.priceUsd),
      priceNative:       num(pick.priceNative),
      marketCapUsd:      num(pick.marketCap),
      fdvUsd:            num(pick.fdv),
      liquidityUsd:      num(pick.liquidity?.usd),
      volumeH1Usd:       num(pick.volume?.h1),
      volumeH24Usd:      num(pick.volume?.h24),
      txnsH1Count:       pick.txns?.h1 ? pick.txns.h1.buys + pick.txns.h1.sells : null,
      priceChangeH1Pct:  num(pick.priceChange?.h1),
      priceChangeH24Pct: num(pick.priceChange?.h24),
    });
  }
  return out;
}
