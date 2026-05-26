"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReadContract } from "wagmi";
import { useContracts } from "@/lib/contracts";
import { useSymbols, usePoolSnapshot } from "@/lib/hooks";
import { useDexData } from "@/lib/use-dex-data";
import { launchHookExtraAbi } from "@/lib/abi-launch-hook-extra";
import { ipfsToHttp, fmtUsd, fmtPrice, fmtPct } from "@/lib/fmt";
import { fmtAmount } from "@/lib/format";
import { TokenLogo } from "./TokenLogo";

const META_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "tokenUri", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

// Min-collateral divisor — matches PerpHook.MIN_COLLATERAL_DIVISOR (W / 500).
const MIN_COLLATERAL_DIVISOR = 500n;

interface TokenMeta {
  name?: string; image?: string; description?: string;
  twitter?: string; telegram?: string; website?: string;
}

/// Token identity header for the per-launch page: logo, name + ticker, contract
/// address, base token, socials, description. Rich metadata (logo/socials/desc)
/// comes from the indexer (resolved IPFS); name/ticker fall back to on-chain so
/// the header still renders if the indexer is unavailable.
export function TokenHeader() {
  const { tokenAddr, baseAddr, hookAddr, baseDecimals } = useContracts();
  const { baseSym, tokenSym } = useSymbols();
  const { data: snap } = usePoolSnapshot();

  // Live USD market data (same dex-sync source the directory tiles use).
  const { data: dexMap } = useDexData([tokenAddr]);
  const dex = dexMap?.[tokenAddr.toLowerCase()];
  const chgPct = dex?.priceChangeH24Pct ?? null;
  const chgClass = chgPct == null ? "text-muted" : chgPct >= 0 ? "text-long" : "text-danger";

  // Identity comes straight off the token contract: `name` + `tokenUri`
  // (the IPFS metadata JSON pinned at launch). We fetch + resolve that JSON
  // ourselves rather than depending on the indexer — Unicurve resolves
  // ipfs:// via the filebase gateway, which works; the indexer's imageURI
  // is unreliable (stored empty when its dead-gateway fetch failed).
  const { data: nameRaw } = useReadContract({
    address: tokenAddr, abi: META_ABI, functionName: "name",
    query: { staleTime: 5 * 60_000 },
  });
  const { data: tokenUriRaw } = useReadContract({
    address: tokenAddr, abi: META_ABI, functionName: "tokenUri",
    query: { staleTime: 5 * 60_000 },
  });

  const metaUrl = ipfsToHttp(tokenUriRaw as string | undefined);
  const { data: row } = useQuery<TokenMeta | null>({
    queryKey: ["tokenMeta", metaUrl],
    enabled: !!metaUrl,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(metaUrl);
      if (!res.ok) return null;
      return (await res.json()) as TokenMeta;
    },
  });

  // Borrow params derive from W (tickWidth): minBorrow = W/500, per-block
  // borrow limit = W, and long-leverage unlocks once the pool's base passes
  // the first band (curveEth ≥ W). Read curveParams on-chain (authoritative).
  const { data: cpRaw } = useReadContract({
    address: hookAddr, abi: launchHookExtraAbi, functionName: "curveParams",
    query: { staleTime: 5 * 60_000 },
  });
  const cp: any = cpRaw;
  const W: bigint | undefined = cp ? ((Array.isArray(cp) ? cp[2] : cp.tickWidth) as bigint) : undefined;
  const minBorrow = W ? W / MIN_COLLATERAL_DIVISOR : undefined;
  const curveEth = snap?.cumulativeEthInPool ?? 0n;
  const leverageLive = W !== undefined && curveEth >= W;

  const name = (row?.name && row.name.trim()) || (nameRaw as string | undefined) || tokenSym;
  const img = row?.image ? ipfsToHttp(row.image) : "";
  const description = row?.description?.trim() || null;
  const twitter = row?.twitter || null;
  const telegram = row?.telegram || null;
  const website = row?.website || null;

  return (
    <div className="bg-panel border border-border rounded-lg p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      {/* Logo */}
      <div className="shrink-0 w-14 h-14 sm:w-16 sm:h-16 rounded-lg bg-bg border border-border overflow-hidden flex items-center justify-center">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={tokenSym} className="w-full h-full object-cover" />
        ) : (
          <span className="text-lg font-semibold text-muted">{tokenSym.slice(0, 3).toUpperCase()}</span>
        )}
      </div>

      {/* Identity + meta */}
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-lg font-semibold text-text leading-none">${tokenSym}</span>
          <span className="text-sm text-muted truncate">{name}</span>
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted/80 border border-border rounded px-1.5 py-0.5">
            <TokenLogo address={baseAddr} symbol={baseSym} size={12} /> base: {baseSym}
          </span>
        </div>

        {/* Live USD price + 24h change */}
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold tabular-nums text-text leading-none">
            {dex ? fmtPrice(dex.priceUsd) : "—"}
          </span>
          <span className={`text-xs tabular-nums ${chgClass}`}>
            {chgPct != null ? `${fmtPct(chgPct)} 24h` : ""}
          </span>
        </div>

        {description && (
          <p className="text-xs text-text/70 line-clamp-2 max-w-2xl">{description}</p>
        )}

        <div className="flex items-center gap-3 flex-wrap text-[11px]">
          <CopyAddr addr={tokenAddr} label="CA" />
          {twitter  && <Social href={twitter}  label="Twitter" />}
          {telegram && <Social href={telegram} label="Telegram" />}
          {website  && <Social href={website}  label="Website" />}
        </div>
      </div>

      {/* Market data (USD, from dex-sync) */}
      <div className="shrink-0 grid grid-cols-3 sm:grid-cols-1 gap-x-4 gap-y-1.5 sm:gap-y-1 sm:text-right sm:border-l sm:border-border sm:pl-4">
        <Stat label="market cap" value={dex ? fmtUsd(dex.marketCapUsd ?? dex.fdvUsd) : "—"} />
        <Stat label="24h vol"    value={dex ? fmtUsd(dex.volumeH24Usd) : "—"} />
        <Stat label="liquidity"  value={dex ? fmtUsd(dex.liquidityUsd) : "—"} />
      </div>

      {/* Borrow / leverage params (derived from W) */}
      <div className="shrink-0 grid grid-cols-2 sm:flex sm:flex-col gap-x-4 gap-y-1.5 sm:gap-y-1 sm:text-right sm:border-l sm:border-border sm:pl-4">
        <Stat label="min borrow" value={minBorrow !== undefined ? `${fmtAmount(minBorrow, baseDecimals, 2)} ${baseSym}` : "—"} />
        <Stat label="per-block borrow cap" value={W !== undefined ? `${fmtAmount(W, baseDecimals, 0)} ${baseSym}` : "—"} />
        <Stat
          label="leverage unlocks at"
          value={W !== undefined ? `pool > ${fmtAmount(W, baseDecimals, 0)} ${baseSym}` : "—"}
        />
        <Stat
          label="leverage status"
          value={leverageLive ? "● live" : "pending (band 1)"}
          valueClass={leverageLive ? "text-long" : "text-warn"}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass = "text-text" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`text-[11px] tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function Social({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline"
    >
      {label} ↗
    </a>
  );
}

function CopyAddr({ addr, label }: { addr: `0x${string}`; label: string }) {
  const [copied, setCopied] = useState(false);
  const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(addr); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      onClick={onCopy}
      title={`Copy ${label} — ${addr}`}
      className="inline-flex items-center gap-1 tabular-nums bg-bg border border-border rounded px-1.5 py-0.5 text-muted hover:text-accent hover:border-accent transition-colors"
    >
      <span className="text-muted/70">{label}:</span>
      <span>{copied ? "copied!" : short}</span>
    </button>
  );
}
