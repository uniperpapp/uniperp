"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLaunches, type Sort } from "@/lib/use-launches";
import { useDexData } from "@/lib/use-dex-data";
import { maybePerpLaunches } from "@/lib/perp-pseudo";
import { TokenRow, ROW_GRID } from "./TokenRow";
import { PriceTicker } from "./PriceTicker";
import { MarketsSidebar } from "./MarketsSidebar";
import { LaunchHero } from "./LaunchHero";
import { ActivityFeed } from "./ActivityFeed";
import { BaseFilter } from "./BaseFilter";

const TABS: { key: Sort; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "new",      label: "New" },
  { key: "mcap",     label: "Market Cap" },
];

export function LaunchpadDirectory() {
  const [sort, setSort]   = useState<Sort>("trending");
  const [query, setQuery] = useState("");
  const [baseFilter, setBaseFilter] = useState<string>("all");
  // Fetch newest-first; we re-sort client-side below so $PERP (which has no
  // indexer metrics) can rank by its real dex USD values alongside launches.
  const { data: indexed = [], isLoading } = useLaunches("new", 120);

  // Inject the $PERP pseudo-launch (deployed outside the factory).
  const launches = useMemo(() => [...maybePerpLaunches(), ...indexed], [indexed]);

  // dex_data merge — keyed by token address (lowercased)
  const tokens = useMemo(() => launches.map((L) => L.token.toLowerCase() as `0x${string}`), [launches]);
  const { data: dexMap = {} } = useDexData(tokens);

  const mcapOf = (L: { token: string }): number => {
    const d = dexMap[L.token.toLowerCase()];
    return d ? (d.marketCapUsd ?? d.fdvUsd ?? 0) : 0;
  };
  const volOf = (L: { token: string }): number =>
    dexMap[L.token.toLowerCase()]?.volumeH24Usd ?? 0;

  // Top 3 by 24h volume → the "TRENDING" badge.
  const trendingSet = useMemo(() => {
    const ranked = launches
      .map((L) => ({ t: L.token.toLowerCase(), v: volOf(L) }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map((x) => x.t);
    return new Set(ranked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launches, dexMap]);

  // Client-side sort by REAL dex metrics so $PERP ranks with everything else.
  const sorted = useMemo(() => {
    const arr = [...launches];
    if (sort === "new") arr.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    else if (sort === "trending") arr.sort((a, b) => volOf(b) - volOf(a));
    else arr.sort((a, b) => mcapOf(b) - mcapOf(a));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launches, sort, dexMap]);

  const visible = useMemo(() => {
    const q = query.toLowerCase();
    return sorted.filter((L) => {
      if (baseFilter !== "all" && (L.baseSymbol || "").toLowerCase() !== baseFilter) return false;
      if (!q) return true;
      return (
        L.symbol.toLowerCase().includes(q) ||
        L.name.toLowerCase().includes(q) ||
        L.hook.toLowerCase().includes(q) ||
        L.token.toLowerCase().includes(q)
      );
    });
  }, [sorted, query, baseFilter]);

  // Infinite scroll — render a window of rows, grow as a sentinel scrolls in.
  const PAGE = 30;
  const [shown, setShown] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setShown(PAGE); }, [sort, query, baseFilter]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setShown((s) => s + PAGE); },
      { rootMargin: "600px" }, // vs viewport — works for page scroll (mobile) + inner scroll (desktop)
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length]);
  const shownRows = visible.slice(0, shown);

  return (
    <div className="flex flex-col lg:h-full lg:min-h-0">
      <PriceTicker />

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr_340px] lg:flex-1 lg:min-h-0">
        {/* LEFT — markets + create (desktop only) */}
        <aside className="hidden lg:flex flex-col border-r border-border min-h-0">
          <MarketsSidebar />
        </aside>

        {/* CENTER — hero + controls + token table */}
        <div ref={scrollRef} className="lg:min-h-0 lg:overflow-y-auto">
          <div className="p-3 space-y-3">
            <LaunchHero />

            {/* search */}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for tokens by name, symbol, or address…"
              className="w-full bg-panel border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
            />

            {/* tabs + filters */}
            <div className="flex items-center gap-3 sm:gap-4 border-b border-border">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setSort(t.key)}
                  className={`relative py-2 text-sm font-medium transition-colors ${
                    sort === t.key ? "text-accent" : "text-muted hover:text-text"
                  }`}
                >
                  {t.label}
                  {sort === t.key && (
                    <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-accent rounded-full" />
                  )}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2 py-1.5">
                <BaseFilter value={baseFilter} onChange={setBaseFilter} />
              </div>
            </div>

            {/* table */}
            <div className="rounded-lg border border-border overflow-hidden">
              <div className={`${ROW_GRID} px-3 py-2 bg-panel/60 border-b border-border text-[10px] uppercase tracking-wider text-muted`}>
                <span>Token</span>
                <span className="hidden sm:block">Base</span>
                <span className="text-right">24h</span>
                <span className="text-right">Mcap</span>
              </div>

              {isLoading && visible.length === 0 ? (
                <SkeletonRows />
              ) : visible.length === 0 ? (
                <EmptyState />
              ) : (
                <>
                  {shownRows.map((L) => (
                    <TokenRow
                      key={L.id}
                      launch={L}
                      dex={dexMap[L.token.toLowerCase()]}
                      trending={trendingSet.has(L.token.toLowerCase())}
                    />
                  ))}
                  {shown < visible.length && (
                    <div ref={sentinelRef} className="py-3 text-center text-[11px] text-muted">
                      loading more…
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — recent trades */}
        <aside className="border-t lg:border-t-0 lg:border-l border-border flex flex-col lg:min-h-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[11px] uppercase tracking-wider text-muted">Recent trades</span>
            <span className="flex items-center gap-1 text-[10px] text-accent">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" /> live
            </span>
          </div>
          <div className="max-h-[60vh] lg:max-h-none lg:flex-1 overflow-y-auto">
            <ActivityFeed />
          </div>
        </aside>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`${ROW_GRID} px-3 py-2.5 border-b border-border/60 animate-pulse`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-panel" />
            <div className="flex-1 space-y-1.5">
              <div className="h-2.5 bg-panel rounded w-1/3" />
              <div className="h-2 bg-panel rounded w-1/2" />
            </div>
          </div>
          <div className="hidden sm:block h-2.5 bg-panel rounded" />
          <div className="h-2.5 bg-panel rounded" />
          <div className="h-2.5 bg-panel rounded" />
        </div>
      ))}
    </>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16 text-muted">
      <p>No tokens match.</p>
      <Link href="/launch" className="inline-block mt-3 text-accent hover:underline">
        Launch the first one →
      </Link>
    </div>
  );
}
