"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { usePoolSnapshot, useTotalStaked } from "@/lib/hooks";
import { fmtTokens, tokenPriceInEth, fmtPriceCompact } from "@/lib/format";
import { IS_MAINNET, IS_X_LAYER } from "@/lib/config";

export function Header() {
  const { data: snap } = usePoolSnapshot();
  const { data: totalStaked } = useTotalStaked();
  const pathname = usePathname();

  const priceEth = snap ? tokenPriceInEth(snap.sqrtPriceX96) : 0;

  // A nav link is highlighted on its own page (and, optionally, its sub-routes
  // — pass extra path prefixes in activePrefixes).
  const navCls = (href: string, activePrefixes: string[] = []) => {
    const active = pathname === href || activePrefixes.some((p) => pathname?.startsWith(p));
    return `text-xs ml-2 sm:ml-3 transition-colors border-b border-dotted shrink-0 ${
      active
        ? "text-accent border-accent/60"
        : "text-muted border-muted/40 hover:text-accent hover:border-accent"
    }`;
  };

  return (
    <header className="h-14 px-3 sm:px-5 flex items-center justify-between border-b border-border bg-panel">
      <div className="flex items-center gap-2 min-w-0">
        <Link href="/" className="flex items-center gap-2 min-w-0 shrink-0">
          <Image src="/logo.png" alt="uniperp" width={28} height={28} priority />
          <span className="text-accent text-lg font-bold tracking-tight">uniperp</span>
        </Link>
        {IS_MAINNET && (
          <Link href="/perp" className={navCls("/perp")}>
            $PERP
          </Link>
        )}
        {IS_X_LAYER && (
          <span className="ml-2 sm:ml-3 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-accent/40 text-accent">
            X Layer
          </span>
        )}
        <Link href="/whitepaper" className={navCls("/whitepaper")}>
          whitepaper
        </Link>
      </div>

      {/* Per-token nav stats ONLY on the v2 $PERP page. Launch pages (/t/[hook])
          show price + identity in the dedicated TokenHeader, so these would be
          redundant (and the "ETH" unit is wrong for an ERC-20-base launch). */}
      {snap && pathname === "/perp" && (
        <div className="hidden md:flex items-center gap-6 text-xs">
          <Stat label="price" value={priceEth > 0 ? `${fmtPriceCompact(priceEth)} ETH` : "—"} accent />
          <Stat label="open" value={Number(snap.numOpenPositions).toString()} />
          <Stat label="staked" value={totalStaked ? `${fmtTokens(totalStaked)} PERP` : "0"} />
        </div>
      )}

      <ConnectButton />
    </header>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`tabular-nums ${accent ? "text-accent" : "text-text"}`}>{value}</span>
    </div>
  );
}
