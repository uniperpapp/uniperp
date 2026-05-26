"use client";

import Link from "next/link";

/// Hero banner above the token table. Our own copy (not alt.fun's): every
/// launch is a real Uniswap-v4 market with a built-in perp engine.
export function LaunchHero() {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-panel">
      {/* Decorative gradient backdrop (our take on alt.fun's wave graphic). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(120% 120% at 80% -10%, rgba(110,231,183,0.18), transparent 55%), radial-gradient(90% 90% at 100% 120%, rgba(16,185,129,0.12), transparent 60%)",
        }}
      />
      <div className="relative px-5 py-7 sm:px-8 sm:py-9">
        <div className="text-[11px] sm:text-xs font-semibold uppercase tracking-[0.2em] text-accent/80 mb-1.5">
          Perp Dex powered by Hooks
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-text">
          Launch a token <span className="text-muted">/</span>{" "}
          <span className="text-accent">trade it with leverage</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-text/70">
          Every launch is a live Uniswap&nbsp;v4 market with a built-in perp engine.
          Buy and sell spot, or go up to 3× long or short.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Link
            href="/launch"
            className="px-4 py-2 rounded-md bg-accent text-bg text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            + Create a token
          </Link>
          <Link
            href="/whitepaper"
            className="px-4 py-2 rounded-md border border-border text-sm text-text/80 hover:text-text hover:border-muted transition-colors"
          >
            How it works
          </Link>
        </div>
      </div>
    </div>
  );
}
