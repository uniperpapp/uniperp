// Uniperp — chain-aware config. This X Layer build (chain 196) sets
// NEXT_PUBLIC_CHAIN_ID=196 in .env.example; the same codebase can target
// other EVM chains by changing that one env var + the matching indexer /
// dex-sync / factory URLs.
import { createConfig, http } from "wagmi";
import { mainnet } from "wagmi/chains";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";

// ── active chain selection ─────────────────────────────────────────────────
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 1);
export const IS_X_LAYER = CHAIN_ID === 196;
export const IS_MAINNET = CHAIN_ID === 1;

// X Layer (OKX L2). Native gas = OKB.
const xLayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/xlayer" } },
});

export const TARGET_CHAIN = IS_X_LAYER ? xLayer : mainnet;

// Client-side RPC URL. Defaults to our same-origin `/api/rpc` proxy (mainnet)
// or X Layer's public RPC directly (X Layer has no key to hide).
export const RPC_MAINNET =
  process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL !== ""
    ? process.env.NEXT_PUBLIC_RPC_URL
    : (IS_X_LAYER ? "https://rpc.xlayer.tech" : "/api/rpc");

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const norm = (v: string | undefined) =>
  v && v !== "" ? (v as `0x${string}`) : ZERO;

// ── per-chain v4 + base addresses ──────────────────────────────────────────
// Mainnet values are the canonical Uniswap v4 deployment + the in-house v1/v2
// PERP set. X Layer values come from docs.uniswap.org/contracts/v4/deployments
// (chain 196 mainnet); v1/v2/migration are mainnet-only and stay as their
// Ethereum addresses (unused on X Layer; the /perp + /migration nav links are
// hidden when IS_X_LAYER).
const MAINNET_CONF = {
  poolManager:     "0x000000000004444c5dc75cB358380D2e3dE08A90",
  universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
  v4Quoter:        "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
  weth:            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
} as const;

const XLAYER_CONF = {
  poolManager:     "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
  universalRouter: "0xDa00aE15d3A71466517129255255db7c0c0956d3",
  v4Quoter:        "0x8928074CA1b241D8Ec02815881c1Af11E8bC5219",
  weth:            "0xe538905cf8410324e03A5A23C1c177a474D59b2b", // WOKB serves the "wrapped native" role on X Layer
} as const;

const CONF = IS_X_LAYER ? XLAYER_CONF : MAINNET_CONF;

export const POOL_MANAGER     = CONF.poolManager as `0x${string}`;
export const UNIVERSAL_ROUTER = CONF.universalRouter as `0x${string}`;
export const V4_QUOTER        = CONF.v4Quoter as `0x${string}`;
// Permit2 is canonical (same address every EVM chain).
export const PERMIT2          = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as `0x${string}`;
// "Wrapped native" base — WETH on mainnet, WOKB on X Layer.
export const WETH_ADDRESS     = CONF.weth as `0x${string}`;

// ── v1 / v2 PERP + migration (Ethereum mainnet only) ──────────────────────
// These addresses exist only on Ethereum; on X Layer the nav links to /perp
// and /migration are hidden (see Header.tsx). The pages would render broken if
// reached directly on a non-mainnet build, but they're unreachable via UI.
export const HOOK_ADDRESS    = "0x3db1ebb71c735980d12422f153987d89f4d7eacc" as `0x${string}`;
export const TOKEN_ADDRESS   = "0x6c6be583c45075a5a3da03f81c2874607ac111f8" as `0x${string}`;
export const STAKING_ADDRESS = "0x4ae2458e6d087aaa3625d81242f22f0b513bca07" as `0x${string}`;
export const V2_HOOK_ADDRESS    = "0x8e2a65dd95661b20ddaf6390707567b54ac7aacc" as `0x${string}`;
export const V2_LENS_ADDRESS    = "0x7c65fb61aa906d0d3dac49599cbe64ebe9a42355" as `0x${string}`;
export const V2_HOOK_TOKEN_ADDRESS   = "0xb645f59da20ff373f4d2f6001faca64454a31a3a" as `0x${string}`;
export const V2_STAKING_ADDRESS = "0x997b450b3b5ca05ede90e67d3ab0888fdadcd639" as `0x${string}`;

// Per-version contract sets the contracts-context picks from (mainnet-only).
export const CONTRACT_SETS = {
  v1: { hook: HOOK_ADDRESS,    read: HOOK_ADDRESS,     token: TOKEN_ADDRESS,         staking: STAKING_ADDRESS },
  v2: { hook: V2_HOOK_ADDRESS, read: V2_LENS_ADDRESS,  token: V2_HOOK_TOKEN_ADDRESS, staking: V2_STAKING_ADDRESS },
} as const;

// v1→v2 migration (Ethereum-only).
export const V1_TOKEN_ADDRESS = TOKEN_ADDRESS;
export const MIGRATION_ADDRESS = norm(process.env.NEXT_PUBLIC_MIGRATION_ADDRESS);
export const V2_TOKEN_ADDRESS  = norm(process.env.NEXT_PUBLIC_V2_TOKEN_ADDRESS);
// Only meaningful on Ethereum mainnet.
export const MIGRATION_LIVE = IS_MAINNET && MIGRATION_ADDRESS !== ZERO;

// Flagship base on mainnet only.
export const PERP_ADDRESS = V2_HOOK_TOKEN_ADDRESS;

// ── launchpad (perpfactory) ────────────────────────────────────────────────
export const FACTORY_ADDRESS = norm(process.env.NEXT_PUBLIC_FACTORY_ADDRESS);
export const FACTORY_LIVE    = FACTORY_ADDRESS !== ZERO;

// ── candidate bases ────────────────────────────────────────────────────────
export interface BaseMeta {
  address: `0x${string}`;
  symbol:  string;
  name:    string;
  decimals: number;            // engine is decimal-agnostic; UI uses this to render
  logo?:    string;            // logo URL; falls back to dexscreener CDN → monogram
}

// X Layer launch bases (whitelisted on-chain via DeployXLayer.s.sol).
// Display order is admin-curated. First entry = default selection. Each shown
// only when the on-chain `factory.bases(addr).allowed` check passes.
const XLAYER_BASES: BaseMeta[] = [
  { address: XLAYER_CONF.weth, symbol: "WOKB", name: "Wrapped OKB", decimals: 18, logo: "https://coin-images.coingecko.com/coins/images/4463/large/WeChat_Image_20220118095654.png?1696505053" },
  { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", symbol: "USDC", name: "USD Coin", decimals: 6, logo: "https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602" },
];

export const CANDIDATE_BASES: BaseMeta[] = XLAYER_BASES;

// Hook permission FLAGS — used by the in-browser salt miner. Same on every
// EVM chain (Uniswap v4 hook permission bits are protocol-wide).
export const HOOK_FLAGS     = 0x2ACC;
export const HOOK_FLAG_MASK = 0x3FFF;

// Injected connector only (MetaMask / Rabby / browser wallets). Both chains are
// registered so wagmi's types are happy; ChainGuard restricts the user to
// TARGET_CHAIN at runtime and the active deployment only ever uses one.
export const wagmiConfig = createConfig({
  chains: [mainnet, xLayer],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(IS_MAINNET ? RPC_MAINNET : "https://eth.llamarpc.com"),
    [xLayer.id]:  http(IS_X_LAYER ? RPC_MAINNET : "https://rpc.xlayer.tech"),
  },
  ssr: true,
});
