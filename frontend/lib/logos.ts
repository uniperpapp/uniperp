import { CANDIDATE_BASES } from "./config";

const BASE_LOGOS = new Map<string, string>(
  CANDIDATE_BASES.filter((b) => b.logo).map((b) => [b.address.toLowerCase(), b.logo!]),
);

/// Ordered logo-URL candidates for a token address: the configured base logo
/// (CoinGecko via GeckoTerminal) first, then dexscreener's per-address CDN.
/// Empty ⇒ the caller renders a monogram. Used by <TokenLogo>.
export function logoCandidates(address?: string): string[] {
  const out: string[] = [];
  const a = address?.toLowerCase();
  if (a && BASE_LOGOS.has(a)) out.push(BASE_LOGOS.get(a)!);
  if (a) out.push(`https://dd.dexscreener.com/ds-data/tokens/ethereum/${a}.png?size=lg`);
  return out;
}
