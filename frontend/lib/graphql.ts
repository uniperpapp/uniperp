// Minimal GraphQL client for the perpfactory-indexer Ponder endpoint.
// Set NEXT_PUBLIC_INDEXER_GRAPHQL_URL to the deployed Ponder /graphql URL.
// During dev, defaults to localhost:42069/graphql (Ponder dev default).

const INDEXER_GRAPHQL_URL =
  process.env.NEXT_PUBLIC_INDEXER_GRAPHQL_URL ?? "";

/// True only when an indexer URL is configured. The launchpad UI gates
/// every GraphQL call on this so a public Vercel preview without the env
/// var does NOT cross-origin fetch to localhost — Chrome's Private Network
/// Access prompt would otherwise fire ("site wants to access other apps
/// and services on this device").
export const INDEXER_CONFIGURED = INDEXER_GRAPHQL_URL !== "";

export interface LaunchRow {
  id: `0x${string}`;
  hook: `0x${string}`;
  token: `0x${string}`;
  lens: `0x${string}`;
  base: `0x${string}`;
  creator: `0x${string}`;
  name: string;
  symbol: string;
  tokenUri: string;
  imageURI: string;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  baseDecimals: number;
  baseSymbol: string;
  v: string;                     // bigint as string
  tickWidth: string;
  createdAt: string;
  launchBlock: string;
  curveEth: string;
  reserveETH: string;
  reserveTOKEN: string;
  insuranceETH: string;
  insuranceTOKEN: string;
  totalDebtETH: string;
  totalDebtTOKEN: string;
  totalHoldingTOKEN: string;
  totalHeldETH: string;
  totalBadDebtETH: string;
  totalBadDebtTOKEN: string;
  numOpenPositions: number;
  tradingEnabled: boolean;
  paused: boolean;
  tradeCount: number;
  lastTradeAt: string | null;
  lastSqrtPriceX96: string | null;
}

export interface TradeRow {
  id: string;
  launch: `0x${string}`;
  kind: "open_long" | "open_short" | "close" | "liquidation" | "claim";
  who: `0x${string}`;
  positionId: string | null;
  sizeBase: string | null;
  sizeToken: string | null;
  sqrtPriceX96: string | null;
  ts: string;
  blockNumber: string;
  txHash: `0x${string}`;
}

/// Ponder's auto-generated GraphQL pluralizes table names by appending "s"
/// — `launch` table → `launchs` plural collection. Adjust if your Ponder
/// version differs.
export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  if (!INDEXER_CONFIGURED) return null;
  try {
    const r = await fetch(INDEXER_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: T; errors?: unknown };
    if (j.errors) return null;
    return j.data ?? null;
  } catch {
    return null;
  }
}

// ─── prebuilt queries ───────────────────────────────────────────────────────

// `orderBy` choices the directory's filter pills map onto:
//   New          → createdAt DESC
//   Last trade   → lastTradeAt DESC NULLS LAST
//   Active       → numOpenPositions DESC, lastTradeAt DESC
//   Oldest       → createdAt ASC
export const LAUNCH_FIELDS = `
  id hook token lens base creator
  name symbol tokenUri imageURI description twitter telegram website
  baseDecimals baseSymbol
  v tickWidth
  createdAt launchBlock
  curveEth reserveETH reserveTOKEN insuranceETH insuranceTOKEN
  totalDebtETH totalDebtTOKEN totalHoldingTOKEN totalHeldETH
  totalBadDebtETH totalBadDebtTOKEN
  numOpenPositions tradingEnabled paused
  tradeCount lastTradeAt lastSqrtPriceX96
`;

export const LAUNCHES_QUERY = (orderBy: string, orderDirection: "asc" | "desc", limit = 60) => `
  query L {
    launchs(orderBy: "${orderBy}", orderDirection: "${orderDirection}", limit: ${limit}) {
      items { ${LAUNCH_FIELDS} }
    }
  }
`;

/// Resolve a launch by its TOKEN address (for token-address page URLs opened
/// from the indexer-backed directory tiles). Returns the full row so the
/// per-launch page can build its instance without extra on-chain lookups.
export const LAUNCH_BY_TOKEN_QUERY = (token: string) => `
  query LByToken {
    launchs(where: { token: "${token.toLowerCase()}" }, limit: 1) {
      items { ${LAUNCH_FIELDS} }
    }
  }
`;

export const RECENT_TRADES_QUERY = (limit = 50) => `
  query T {
    trades(orderBy: "ts", orderDirection: "desc", limit: ${limit}) {
      items {
        id launch kind who positionId sizeBase sizeToken
        sqrtPriceX96 ts blockNumber txHash
      }
    }
  }
`;
