// Number formatting helpers — all take wei-style bigints
import { formatEther, formatUnits } from "viem";

export function fmtEth(wei: bigint, decimals = 4): string {
  const e = Number(formatEther(wei));
  if (e === 0) return "0";
  if (e < 0.0001) return "<0.0001";
  if (e >= 1000) return e.toFixed(0);
  return e.toFixed(decimals);
}

export function fmtTokens(wei: bigint, decimals = 0): string {
  const t = Number(formatUnits(wei, 18));
  if (t === 0) return "0";
  if (t >= 1_000_000) return (t / 1_000_000).toFixed(2) + "M";
  if (t >= 1_000) return (t / 1_000).toFixed(2) + "K";
  return t.toFixed(decimals);
}

/// Decimals-aware amount formatter (like fmtEth but for any base token).
/// The launchpad base may be 18-dec (WETH/PERP), 6-dec (USDC), 8-dec (WBTC) …
/// — pass the base's `decimals()` so amounts render at the right magnitude.
export function fmtAmount(wei: bigint | string | null | undefined, tokenDecimals: number, dp = 4): string {
  if (wei == null) return "—";
  const b = typeof wei === "string" ? BigInt(wei) : wei;
  const e = Number(formatUnits(b, tokenDecimals));
  if (e === 0) return "0";
  if (e < 0.0001) return "<0.0001";
  if (e >= 1000) return e.toFixed(0);
  return e.toFixed(dp);
}

/// Convert a raw token-amount bigint to a human float at `tokenDecimals`.
export function toNumber(wei: bigint, tokenDecimals: number): number {
  return Number(formatUnits(wei, tokenDecimals));
}

/// Price of 1 TOKEN expressed in BASE units, decimals-aware.
/// sqrtPriceX96 encodes the RAW reserve ratio (token_raw / base_raw); the human
/// price = (base_raw/10^baseDec) / (token_raw/10^18) = rawRatio × 10^(18−baseDec).
/// For an 18-dec base this is identical to `tokenPriceInEth`.
export function tokenPriceInBase(sqrtPriceX96: bigint, baseDecimals = 18): number {
  return tokenPriceInEth(sqrtPriceX96) * Math.pow(10, 18 - baseDecimals);
}

export function fmtPct(bps: bigint | number, decimals = 2): string {
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  return (n / 100).toFixed(decimals) + "%";
}

export function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// Compute TOKEN price (ETH per TOKEN) from sqrtPriceX96
// In our pool: currency0 = ETH (low), currency1 = TOKEN (high)
// P = currency1 / currency0 = TOKEN/ETH (sqrtPriceX96^2 / 2^192)
// price of 1 TOKEN in ETH = 1/P = 2^192 / sqrtPriceX96^2
export function tokenPriceInEth(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 === 0n) return 0;
  // Use floats for display purposes (precision sufficient for UI)
  const sqrtP = Number(sqrtPriceX96);
  const Q96 = 2 ** 96;
  const sqrtFloat = sqrtP / Q96;
  const priceP = sqrtFloat * sqrtFloat; // TOKEN per ETH
  return priceP === 0 ? 0 : 1 / priceP;  // ETH per TOKEN
}

export function ethPriceInToken(sqrtPriceX96: bigint): number {
  const tokPerEth = 1 / tokenPriceInEth(sqrtPriceX96);
  return tokPerEth;
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
function subscript(n: number): string {
  return n.toString().split("").map((d) => SUB[+d]).join("");
}

/**
 * Render a price/number cleanly without scientific notation.
 *   1.234     → "1.234"
 *   0.0521    → "0.05210"
 *   0.000123  → "0.000123"
 *   2.06e-5   → "0.0₄206"    (zero point, four zeros, then 206 — GeckoTerminal style)
 *   1.2e-9    → "0.0₈12"
 * Significand cap controls how many post-zeros digits to show.
 */
export function fmtPriceCompact(p: number, sig = 4): string {
  if (!isFinite(p) || p === 0) return "0";
  if (p < 0) return "-" + fmtPriceCompact(-p, sig);
  if (p >= 1000) return p.toFixed(0);
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.001) return p.toPrecision(sig);
  // p < 0.001: use subscript notation. Determine zero count after "0.".
  // log10(0.0001) = -4 → 3 leading zeros after the decimal point.
  const exp = Math.floor(Math.log10(p));      // negative
  const zeros = -exp - 1;                      // count of consecutive zeros after "0."
  // Get the leading significant digits (sig of them) without the leading zeros
  const scaled = p / Math.pow(10, exp);        // ~1.xx..
  const digits = scaled.toFixed(sig - 1).replace(".", ""); // e.g., "2065" for sig=4
  if (zeros < 4) {
    // few enough zeros that plain decimal is still readable
    const totalDecimals = zeros + sig;
    return p.toFixed(totalDecimals);
  }
  return `0.0${subscript(zeros)}${digits}`;
}
