"use client";

import Link from "next/link";
import { useMemo } from "react";
import { CANDIDATE_BASES } from "@/lib/config";
import { useDexData } from "@/lib/use-dex-data";
import { fmtPrice, fmtPct } from "@/lib/fmt";
import { TokenLogo } from "./TokenLogo";

/// Left rail: the assets our tokens are paired against ("markets"), each with a
/// live USD price + 24h move. This grows as more bases are whitelisted. The
/// "+ create" CTA is pinned to the bottom (alt.fun-style).
export function MarketsSidebar() {
  const addrs = useMemo(
    () => CANDIDATE_BASES.map((b) => b.address.toLowerCase() as `0x${string}`),
    [],
  );
  const { data: dexMap = {} } = useDexData(addrs);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted border-b border-border">
        Markets
      </div>

      <div className="flex-1 overflow-y-auto">
        {CANDIDATE_BASES.map((b) => {
          const d = dexMap[b.address.toLowerCase()];
          const chg = d?.priceChangeH24Pct ?? null;
          return (
            <div
              key={b.address}
              className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border/60"
            >
              <TokenLogo src={b.logo} address={b.address} symbol={b.symbol} size={32} />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="text-xs font-semibold text-text truncate">{b.symbol}</div>
                {chg != null && (
                  <div className={`text-[10px] tabular-nums ${chg >= 0 ? "text-long" : "text-danger"}`}>
                    {fmtPct(chg)}
                  </div>
                )}
              </div>
              <div className="text-xs tabular-nums text-text/90 shrink-0">
                {d?.priceUsd != null ? fmtPrice(d.priceUsd) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-2 border-t border-border">
        <Link
          href="/launch"
          className="block text-center py-2.5 rounded-md bg-accent text-bg text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          + Create a token
        </Link>
      </div>
    </div>
  );
}

