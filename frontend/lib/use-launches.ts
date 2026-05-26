"use client";

import { useQuery } from "@tanstack/react-query";
import { gql, LAUNCHES_QUERY, RECENT_TRADES_QUERY, INDEXER_CONFIGURED, type LaunchRow, type TradeRow } from "./graphql";

export type Sort = "new" | "trending" | "mcap";

const SORT_MAP: Record<Sort, { orderBy: string; orderDirection: "asc" | "desc" }> = {
  // Most recent launches.
  new:      { orderBy: "createdAt",  orderDirection: "desc" },
  // Trending = highest activity. Ideal metric: 24h SPOT volume USD from
  // dex-sync (dex_data.volume_h24_usd). Until dex-sync is wired, the best
  // on-chain proxy in our indexer is cumulative `tradeCount` (total
  // leverage opens + closes + liquidations + claims). Post-MVP swap:
  // change orderBy to a JOIN-backed view of dex_data via the Hono custom
  // resolver (see perpfactory-indexer TODO).
  trending: { orderBy: "tradeCount", orderDirection: "desc" },
  // Market Cap. Ideal: dex_data.market_cap_usd. Until wired, the closest
  // on-chain proxy is `curveEth` (total base on the bonding curve — scales
  // monotonically with FDV at fixed V).
  mcap:     { orderBy: "curveEth",   orderDirection: "desc" },
};

export function useLaunches(sort: Sort = "new", limit = 60) {
  const { orderBy, orderDirection } = SORT_MAP[sort];
  return useQuery({
    queryKey: ["launches", sort, limit],
    enabled: INDEXER_CONFIGURED,
    queryFn: async () => {
      const data = await gql<{ launchs: { items: LaunchRow[] } }>(
        LAUNCHES_QUERY(orderBy, orderDirection, limit),
      );
      return data?.launchs?.items ?? [];
    },
    refetchInterval: 15_000,
    staleTime: 8_000,
  });
}

export function useRecentTrades(limit = 50) {
  return useQuery({
    queryKey: ["recentTrades", limit],
    enabled: INDEXER_CONFIGURED,
    queryFn: async () => {
      const data = await gql<{ trades: { items: TradeRow[] } }>(
        RECENT_TRADES_QUERY(limit),
      );
      return data?.trades?.items ?? [];
    },
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}
