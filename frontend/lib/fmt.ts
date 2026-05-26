// Tiny formatting helpers for the launchpad UI. (The existing lib/format.ts
// is full of v1/v2-specific helpers; these are launchpad-only and standalone
// so they don't touch the existing surface.)

export function shortAddr(a: string | undefined): string {
  if (!a) return "—";
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// Compact USD — for market caps / volumes (B/M/K). Small values use the
// CoinGecko subscript-zero style instead of e-notation.
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(2)}K`;
  if (n <= 0)             return "$0";
  return `$${compactSmall(n)}`;
}

// Token price — CoinGecko style: full value with commas ≥ $1, subscript-zero
// notation for tiny prices (e.g. PEPE → $0.0₅3811). Never e-notation.
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1)    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${compactSmall(n)}`;
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const toSub = (k: number) => String(k).split("").map((d) => SUBSCRIPT[+d]).join("");

// 0 < n < 1 → CoinGecko-style: ≥0.001 plain (4 sig figs), else 0.0<sub-zeros><digits>.
function compactSmall(n: number): string {
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "");
  const exp = Math.floor(Math.log10(n));   // e.g. -6 for 3.8e-6
  const zeros = -exp - 1;                   // consecutive zeros after "0."
  const digits = Math.round(n / Math.pow(10, exp) * 1000).toString().padStart(4, "0").slice(0, 4);
  return `0.0${toSub(zeros)}${digits}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtEthBig(wei: string | bigint | null | undefined, decimals = 3): string {
  if (wei == null) return "—";
  const b = typeof wei === "string" ? BigInt(wei) : wei;
  // 1 ether = 1e18 wei; format with `decimals` precision via integer math
  const whole = b / 10n ** 18n;
  const frac  = b % 10n ** 18n;
  const fracStr = (frac + 10n ** 18n).toString().slice(1, 1 + decimals);
  return `${whole.toString()}.${fracStr}`;
}

export function timeAgo(ts: number | string | null | undefined): string {
  if (ts == null) return "—";
  const sec = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(sec)) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (diff < 5)     return "just now";
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Preferred IPFS gateway for client-side rendering. Filebase's gateway
// resolves CIDs we pin fastest; override via NEXT_PUBLIC_PINATA_GATEWAY.
const IPFS_GATEWAY =
  (process.env.NEXT_PUBLIC_PINATA_GATEWAY && process.env.NEXT_PUBLIC_PINATA_GATEWAY !== ""
    ? process.env.NEXT_PUBLIC_PINATA_GATEWAY
    : "https://ipfs.filebase.io"
  ).replace(/\/+$/, "");

export function ipfsToHttp(uri: string | null | undefined): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    return `${IPFS_GATEWAY}/ipfs/` + uri.slice("ipfs://".length);
  }
  // Rewrite ANY `/ipfs/<cid>` gateway URL to our gateway. The indexer resolves
  // metadata `image` through the now-DEAD cloudflare-ipfs.com gateway; rebuild
  // it (and any other gateway host) onto the working one so logos load.
  const m = uri.match(/\/ipfs\/([^?#]+)/);
  if (m) return `${IPFS_GATEWAY}/ipfs/${m[1]}`;
  return uri;
}
