"use client";

import Link from "next/link";
import type { LaunchRow } from "@/lib/graphql";
import type { DexDatum } from "@/lib/use-dex-data";
import { fmtUsd, fmtPct, ipfsToHttp, timeAgo } from "@/lib/fmt";
import { launchHref } from "@/lib/perp-pseudo";
import { TokenLogo } from "./TokenLogo";

/// Shared grid template — header and rows use the same tracks so columns align.
/// mobile: TOKEN · 24H · MCAP   ·   sm+: TOKEN · BASE · 24H · MCAP
export const ROW_GRID =
  "grid items-center gap-3 grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] sm:grid-cols-[minmax(0,1fr)_9rem_5rem_6rem]";

const DAY = 24 * 60 * 60;

/// One row in the launchpad token table (alt.fun-style list, not a card).
export function TokenRow({
  launch,
  dex,
  trending,
}: {
  launch: LaunchRow;
  dex?: DexDatum;
  trending?: boolean;
}) {
  const img = ipfsToHttp(launch.imageURI || "");
  const chg = dex?.priceChangeH24Pct ?? null;
  const isNew = Date.now() / 1000 - Number(launch.createdAt) < DAY;
  const mcap = dex ? (dex.marketCapUsd ?? dex.fdvUsd) : null;

  return (
    <Link
      href={launchHref(launch)}
      className={`${ROW_GRID} px-3 py-2.5 border-b border-border/60 hover:bg-bg/60 transition-colors`}
    >
      {/* TOKEN */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="shrink-0 w-9 h-9 rounded-full bg-bg border border-border overflow-hidden flex items-center justify-center">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img} alt={launch.symbol} className="w-full h-full object-cover" />
          ) : (
            <span className="text-[11px] font-semibold text-muted">
              {launch.symbol.slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 leading-tight">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-semibold text-text truncate">${launch.symbol}</span>
            {isNew && <Badge tone="new">NEW</Badge>}
            {trending && <Badge tone="trending">TRENDING</Badge>}
          </div>
          <div className="text-[11px] text-muted truncate">
            {launch.name} · {timeAgo(launch.createdAt)}
          </div>
        </div>
      </div>

      {/* BASE (underlying pair) — hidden on mobile */}
      <div className="hidden sm:flex items-center gap-1.5 min-w-0">
        <TokenLogo address={launch.base} symbol={launch.baseSymbol} size={18} />
        <span className="text-xs text-text/80 truncate">{launch.baseSymbol || "base"}</span>
      </div>

      {/* 24H CHANGE */}
      <div
        className={`text-right text-xs tabular-nums ${
          chg == null ? "text-muted" : chg >= 0 ? "text-long" : "text-danger"
        }`}
      >
        {chg != null ? fmtPct(chg) : "—"}
      </div>

      {/* MCAP */}
      <div className="text-right text-xs tabular-nums text-text/90">
        {fmtUsd(mcap)}
      </div>
    </Link>
  );
}

function Badge({ tone, children }: { tone: "new" | "trending"; children: React.ReactNode }) {
  const cls =
    tone === "new"
      ? "bg-accent/15 text-accent border-accent/30"
      : "bg-warn/15 text-warn border-warn/30";
  return (
    <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wider px-1 py-px rounded border ${cls}`}>
      {children}
    </span>
  );
}
