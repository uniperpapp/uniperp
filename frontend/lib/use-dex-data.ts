"use client";

import { useQuery } from "@tanstack/react-query";

/// Per-token live market data sourced from dex-sync (dexscreener mirror).
/// Returned as a map keyed by token address (lowercased) for cheap merge in
/// the directory cards.
export interface DexDatum {
  priceUsd: number | null;
  priceNative: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH24Pct: number | null;
  updatedAt: string | null;
}

const DEX_DATA_URL =
  process.env.NEXT_PUBLIC_DEX_DATA_URL ??
  // Reasonable default: a Hono route added to the indexer's `src/api.ts`
  // that does `SELECT … FROM dex_data` and returns a token→datum map.
  // Until that route exists the hook returns an empty map and the UI
  // gracefully shows "—" for USD fields.
  "";

/// One spot trade from dex-sync's GeckoTerminal-sourced feed.
export interface SpotTrade {
  id: string;
  token: string;
  side: "buy" | "sell";
  amountUsd: number | null;
  priceUsd: number | null;
  ts: number;            // unix seconds
  txHash: string;
  who: string | null;
}

// dex-sync serves trades at the sibling /trades route of the /dex base URL.
const DEX_TRADES_URL = DEX_DATA_URL ? DEX_DATA_URL.replace(/\/dex\/?$/, "/trades") : "";

/// Recent spot trades across all launches (newest first). Polls every 5s for a
/// near-live feed; the server caps how often it actually hits GeckoTerminal.
export function useDexTrades(limit = 50) {
  return useQuery({
    queryKey: ["dexTrades", limit],
    enabled: DEX_TRADES_URL !== "",
    queryFn: async (): Promise<SpotTrade[]> => {
      try {
        const url = new URL(DEX_TRADES_URL);
        url.searchParams.set("limit", String(limit));
        const r = await fetch(url.toString());
        if (!r.ok) return [];
        return (await r.json()) as SpotTrade[];
      } catch {
        return [];
      }
    },
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

/// Fetch dex_data for the given token addresses. Empty input ⇒ empty map.
export function useDexData(tokens: `0x${string}`[] | undefined) {
  return useQuery({
    queryKey: ["dexData", (tokens ?? []).map((t) => t.toLowerCase()).sort().join(",")],
    enabled: !!tokens && tokens.length > 0 && DEX_DATA_URL !== "",
    queryFn: async (): Promise<Record<string, DexDatum>> => {
      if (!tokens || tokens.length === 0 || DEX_DATA_URL === "") return {};
      try {
        const url = new URL(DEX_DATA_URL);
        url.searchParams.set("tokens", tokens.map((t) => t.toLowerCase()).join(","));
        const r = await fetch(url.toString());
        if (!r.ok) return {};
        const j = (await r.json()) as Record<string, DexDatum>;
        return j;
      } catch {
        return {};
      }
    },
    refetchInterval: 15_000,
    staleTime: 8_000,
  });
}
