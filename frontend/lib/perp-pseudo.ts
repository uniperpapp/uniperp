import type { LaunchRow } from "./graphql";
import {
  V2_HOOK_ADDRESS,
  V2_LENS_ADDRESS,
  V2_HOOK_TOKEN_ADDRESS,
  PERP_ADDRESS,
  IS_MAINNET,
} from "./config";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/// $PERP (the v2 flagship) was deployed directly, NOT via the factory, so it has
/// no indexer Launch row. We synthesize one so it appears in the directory
/// table, ticker, sorting and the trades feed alongside factory launches. Its
/// live USD price / mcap / volume / spot trades come from the same dex-sync
/// pipeline (PERP is added to its poll set via the EXTRA_TOKENS env).
export function makePerpLaunch(): LaunchRow {
  return {
    id: V2_HOOK_ADDRESS,
    hook: V2_HOOK_ADDRESS,
    token: V2_HOOK_TOKEN_ADDRESS,
    lens: V2_LENS_ADDRESS,
    base: ZERO,                       // v2 = native ETH
    creator: ZERO,
    name: "Uniperp",
    symbol: "PERP",
    tokenUri: "",
    imageURI: "/logo.png",           // app logo (relative URL passes through ipfsToHttp)
    description: null,
    twitter: null,
    telegram: null,
    website: null,
    baseDecimals: 18,
    baseSymbol: "ETH",
    v: "0",
    tickWidth: "0",
    createdAt: "1778975687",         // PERP v2 pool creation (2026-05-16)
    launchBlock: "0",
    curveEth: "0",
    reserveETH: "0",
    reserveTOKEN: "0",
    insuranceETH: "0",
    insuranceTOKEN: "0",
    totalDebtETH: "0",
    totalDebtTOKEN: "0",
    totalHoldingTOKEN: "0",
    totalHeldETH: "0",
    totalBadDebtETH: "0",
    totalBadDebtTOKEN: "0",
    numOpenPositions: 0,
    tradingEnabled: true,
    paused: false,
    tradeCount: 0,
    lastTradeAt: null,
    lastSqrtPriceX96: null,
  };
}

/// True for the $PERP pseudo-launch (matched on token address).
export function isPerp(tokenAddr: string): boolean {
  return tokenAddr.toLowerCase() === PERP_ADDRESS.toLowerCase();
}

/// Spreadable: returns [makePerpLaunch()] on Ethereum mainnet, [] elsewhere.
/// Use as `[...maybePerpLaunches(), ...indexed]` in directory/ticker/feed so
/// $PERP appears only where it actually exists.
export function maybePerpLaunches(): LaunchRow[] {
  return IS_MAINNET ? [makePerpLaunch()] : [];
}

/// Row link target: $PERP routes to its dedicated /perp page; factory launches
/// route to /t/<token>.
export function launchHref(L: { token: string }): string {
  return isPerp(L.token) ? "/perp" : `/t/${L.token}`;
}
