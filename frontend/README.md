# Frontend — Uniperp (Next.js)

The web UI for **x.uniperp.app**. Next.js 14 + Tailwind + wagmi/viem + TanStack Query, built for **X Layer mainnet** (chain id 196).

## Routes

| Path | What it is |
|---|---|
| `/` | Launchpad directory — every launch with live price, mcap, 24h vol, holders |
| `/launch` | Launch form — name/symbol/image → CREATE2-mine hook salt → atomic on-chain launch |
| `/t/[hook]` | Per-launch trade page — curve chart, spot swap, leverage open/close, positions, holders |
| `/whitepaper` | The hackathon-tuned whitepaper (live addresses + hook arch deep-dive) |

## Architecture (frontend perspective)

```
       ┌─────────────────────────────────────────────────────────┐
       │  Next.js App Router (server components for static SEO)  │
       └────────────┬────────────────────────┬───────────────────┘
                    │                        │
       ┌────────────▼─────────────┐  ┌───────▼────────────┐
       │  GraphQL                 │  │  HTTP              │
       │  → indexer (Ponder)      │  │  → dex-sync        │
       │   - launch directory     │  │   - dex_data       │
       │   - per-launch state     │  │   - dex_trade      │
       │   - positions / holders  │  │   - merge into     │
       │   - leverage trade feed  │  │     activity feed  │
       └──────────────────────────┘  └────────────────────┘
                    │
       ┌────────────▼──────────────┐
       │  wagmi/viem               │
       │  → X Layer PoolManager    │  (read: pool sqrtPrice, liquidity)
       │  → Perpfactory            │  (write: create, setBase)
       │  → PerpHook + PerpLens    │  (read: snapshot, position; write: open/close)
       │  → UniversalRouter        │  (write: spot swap via SWAP_V4 command)
       └───────────────────────────┘
```

## Chain-aware (single codebase)

The codebase is chain-aware: every chain-specific value (PoolManager, UniversalRouter, V4Quoter, base assets) is selected from a per-chain config keyed by `NEXT_PUBLIC_CHAIN_ID`. This X Layer build sets `196`; the same code targets other EVM chains by changing that one env var plus the indexer/dex-sync/factory URLs. See [`lib/config.ts`](lib/config.ts).

## Run locally

```bash
cp .env.example .env.local
# Edit .env.local — at minimum set NEXT_PUBLIC_FACTORY_ADDRESS,
# NEXT_PUBLIC_INDEXER_GRAPHQL_URL, NEXT_PUBLIC_DEX_DATA_URL.
npm install
npm run dev
# → http://localhost:3000
```

You'll need an injected wallet (MetaMask / Rabby) with the X Layer network added:

| | |
|---|---|
| RPC | `https://rpc.xlayer.tech` |
| Chain ID | `196` |
| Symbol | `OKB` |
| Explorer | `https://www.oklink.com/xlayer` |

Bridge a small amount of OKB for gas (the [official X Layer bridge](https://www.okx.com/xlayer/bridge) is the easiest path).

## Build + deploy (Vercel)

```bash
npm run build
```

Set the same env vars in the Vercel project. The live deployment at [x.uniperp.app](https://x.uniperp.app) is a Vercel project that's just this folder.
