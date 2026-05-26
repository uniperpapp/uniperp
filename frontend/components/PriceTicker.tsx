"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useLaunches } from "@/lib/use-launches";
import { useDexData } from "@/lib/use-dex-data";
import { maybePerpLaunches, launchHref } from "@/lib/perp-pseudo";
import { fmtPrice, fmtPct } from "@/lib/fmt";

/// Top scrolling ticker of our launched tokens: $TICKER · price · 24h %.
/// The track renders the item list twice and CSS translates it −50% so the
/// loop is seamless (see `.ticker-track` in globals.css). Pauses on hover.
export function PriceTicker() {
  const { data: indexed = [] } = useLaunches("trending", 40);
  const launches = useMemo(() => [...maybePerpLaunches(), ...indexed], [indexed]);
  const tokens = useMemo(
    () => launches.map((L) => L.token.toLowerCase() as `0x${string}`),
    [launches],
  );
  const { data: dexMap = {} } = useDexData(tokens);

  const items = useMemo(
    () =>
      launches.map((L) => {
        const d = dexMap[L.token.toLowerCase()];
        return {
          href: launchHref(L),
          symbol: L.symbol,
          priceUsd: d?.priceUsd ?? null,
          chg: d?.priceChangeH24Pct ?? null,
        };
      }),
    [launches, dexMap],
  );

  if (items.length === 0) return null;

  // Duplicate the list so the −50% translate wraps with no visible seam.
  const loop = [...items, ...items];

  return (
    <div className="border-b border-border bg-panel/60 overflow-hidden">
      <div className="ticker-track py-1.5">
        {loop.map((it, i) => (
          <Link
            key={`${it.symbol}-${i}`}
            href={it.href}
            className="inline-flex items-center gap-1.5 px-4 text-xs hover:text-accent transition-colors"
          >
            <span className="font-semibold text-text">${it.symbol}</span>
            <span className="tabular-nums text-muted">
              {it.priceUsd != null ? fmtPrice(it.priceUsd) : "—"}
            </span>
            {it.chg != null && (
              <span className={`tabular-nums ${it.chg >= 0 ? "text-long" : "text-danger"}`}>
                {fmtPct(it.chg)}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
