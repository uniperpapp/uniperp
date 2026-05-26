"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRecentTrades, useLaunches } from "@/lib/use-launches";
import { useDexTrades } from "@/lib/use-dex-data";
import type { LaunchRow } from "@/lib/graphql";
import { maybePerpLaunches, launchHref } from "@/lib/perp-pseudo";
import { shortAddr, timeAgo, fmtUsd } from "@/lib/fmt";
import { fmtAmount } from "@/lib/format";

/// Unified feed item — both spot (GeckoTerminal via dex-sync) and leverage
/// (Ponder indexer) trades collapse to this shape, then sort by time.
interface FeedItem {
  id: string;
  ts: number;            // unix seconds
  href?: string;         // row link target (/t/<token> or /perp)
  symbol?: string;
  who: string;
  label: string;
  detail: string;
  color: string;
}

/// Cross-launch recent-activity feed. Merges spot buys/sells (from dex-sync's
/// GeckoTerminal feed, keyed by token) with leverage opens/closes/liqs/claims
/// (from the indexer, keyed by hook) into one time-ordered stream.
export function ActivityFeed() {
  const lev      = useRecentTrades(50).data ?? [];
  const spot     = useDexTrades(60).data ?? [];
  const indexed  = useLaunches("new", 200).data ?? [];
  const launches = useMemo(() => [...maybePerpLaunches(), ...indexed], [indexed]);

  const byHook  = useMemo(() => {
    const m = new Map<string, LaunchRow>();
    for (const L of launches) m.set(L.hook.toLowerCase(), L);
    return m;
  }, [launches]);
  const byToken = useMemo(() => {
    const m = new Map<string, LaunchRow>();
    for (const L of launches) m.set(L.token.toLowerCase(), L);
    return m;
  }, [launches]);

  const items = useMemo(() => {
    const out: FeedItem[] = [];

    for (const t of spot) {
      const L = byToken.get(t.token.toLowerCase());
      out.push({
        id: `s-${t.id}`,
        ts: t.ts,
        href: launchHref({ token: L?.token ?? t.token }),
        symbol: L?.symbol,
        who: t.who ?? "",
        label: t.side === "buy" ? "bought" : "sold",
        detail: t.amountUsd != null ? fmtUsd(t.amountUsd) : "",
        color: t.side === "buy" ? "text-long" : "text-danger",
      });
    }

    for (const t of lev) {
      const L = byHook.get(t.launch.toLowerCase());
      const label =
        t.kind === "open_long"    ? "opened long"
        : t.kind === "open_short" ? "opened short"
        : t.kind === "close"      ? "closed"
        : t.kind === "liquidation" ? "liquidated"
        : t.kind === "claim"       ? "claimed"
        : t.kind;
      const color =
        t.kind === "open_long"    ? "text-long"
        : t.kind === "open_short" ? "text-danger"
        : t.kind === "liquidation" ? "text-warn"
        : t.kind === "claim"       ? "text-accent"
        :                            "text-text/70";
      const detail = t.sizeBase
        ? `${fmtAmount(t.sizeBase, L?.baseDecimals ?? 18, 3)}${L?.baseSymbol ? ` ${L.baseSymbol}` : ""}`
        : "";
      out.push({
        id: `l-${t.id}`,
        ts: Number(t.ts),
        href: L ? launchHref({ token: L.token }) : undefined,
        symbol: L?.symbol,
        who: t.who,
        label, detail, color,
      });
    }

    return out.sort((a, b) => b.ts - a.ts).slice(0, 60);
  }, [spot, lev, byHook, byToken]);

  if (items.length === 0) {
    return <div className="text-xs text-muted p-3">No activity yet.</div>;
  }

  return (
    <ul>
      {items.map((it) => (
        <Row key={it.id} it={it} />
      ))}
    </ul>
  );
}

function Row({ it }: { it: FeedItem }) {
  return (
    <li className="px-3 py-2 border-b border-border/50 hover:bg-bg/40">
      <div className="flex items-center justify-between gap-2">
        {it.symbol && it.href ? (
          <Link href={it.href} className="font-semibold text-text hover:text-accent truncate">
            ${it.symbol}
          </Link>
        ) : (
          <span className="font-semibold text-text/60 truncate">${(it.symbol ?? "").slice(0, 8) || "—"}</span>
        )}
        <span className="shrink-0 text-[10px] text-muted">{timeAgo(it.ts)}</span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-0.5">
        <span className={`text-[11px] ${it.color}`}>
          {it.label}{it.detail ? ` · ${it.detail}` : ""}
        </span>
        {it.who && <span className="shrink-0 text-[10px] text-muted tabular-nums">{shortAddr(it.who)}</span>}
      </div>
    </li>
  );
}
