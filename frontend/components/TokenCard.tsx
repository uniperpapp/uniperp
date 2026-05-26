"use client";

import Link from "next/link";
import type { LaunchRow } from "@/lib/graphql";
import type { DexDatum } from "@/lib/use-dex-data";
import { shortAddr, fmtUsd, fmtPct, timeAgo, ipfsToHttp } from "@/lib/fmt";
import { fmtAmount } from "@/lib/format";

/// One card in the launchpad directory grid. Pure presentation — data comes
/// from the merged (Launch ⨝ dex_data) row.
export function TokenCard({ launch, dex }: { launch: LaunchRow; dex?: DexDatum }) {
  const img = ipfsToHttp(launch.imageURI || "");
  const chgPct = dex?.priceChangeH24Pct ?? null;
  const chgColor =
    chgPct == null ? "text-text/60"
      : chgPct >= 0 ? "text-emerald-400"
      :               "text-rose-400";

  return (
    <Link
      href={`/t/${launch.token}`}
      className="group bg-panel border border-border rounded-lg p-3 flex gap-3 hover:border-accent transition-colors"
    >
      {/* logo */}
      <div className="shrink-0 w-14 h-14 rounded-md bg-bg border border-border flex items-center justify-center overflow-hidden">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={launch.symbol} className="w-full h-full object-cover" />
        ) : (
          <span className="text-lg font-semibold opacity-70">
            {launch.symbol.slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>

      {/* main */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold truncate">
              ${launch.symbol}{" "}
              <span className="font-normal text-text/60 text-sm">· {launch.name}</span>
            </div>
            <div className="text-xs text-text/60 truncate">
              by {shortAddr(launch.creator)} · {timeAgo(launch.createdAt)}
            </div>
          </div>
          <div className={`text-sm font-medium ${chgColor}`}>{fmtPct(chgPct)}</div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <Stat label="price"      value={dex ? fmtUsd(dex.priceUsd) : "—"} />
          <Stat label="mcap"       value={dex ? fmtUsd(dex.marketCapUsd ?? dex.fdvUsd) : "—"} />
          <Stat label="24h vol"    value={dex ? fmtUsd(dex.volumeH24Usd) : "—"} />
          <Stat label="liquidity"  value={dex ? fmtUsd(dex.liquidityUsd) : "—"} />
          <Stat label="open pos"   value={launch.numOpenPositions.toString()} />
          <Stat label="curve base" value={`${fmtAmount(launch.curveEth, launch.baseDecimals ?? 18, 3)} ${launch.baseSymbol || "base"}`} />
        </div>

        {launch.paused && (
          <div className="mt-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">
            paused
          </div>
        )}
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 min-w-0">
      <span className="text-text/50 truncate">{label}</span>
      <span className="text-text/90 font-medium truncate text-right">{value}</span>
    </div>
  );
}
