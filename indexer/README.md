# Indexer — Uniperp (Ponder)

[Ponder](https://ponder.sh)-based indexer for the Perpfactory launchpad on **X Layer mainnet** (chain id 196). Tracks the launch directory, leverage activity, and token holders. Spot price + volume comes from the sibling [`dex-sync/`](../dex-sync) service.

## What's indexed

- **`Perpfactory:Launched`** — singleton, drives discovery. One `Launch` row per launched token; metadata resolved once at index time from the immutable on-chain `tokenUri` (IPFS) and cached on the row.
- **Per-launched `PerpHook`** (auto-discovered via Ponder's `factory()` source pattern — no EventBus contract needed): `PositionOpened`, `PositionClosed`, `PositionLiquidated`, `Claimed`, `PausedSet`, `BandSeeded`, `ReserveRebalanced`. After every event the `Launch` row's snapshot fields (`curveEth`, reserves, insurance, debt, etc.) are refreshed via one `lens.getPoolSnapshot()` staticcall — single source of truth, zero drift risk.
- **Per-launched `PerpToken`** (auto-discovered): `Transfer` → `Holder` table for per-launch balance maps.

Spot swap volume is **not** indexed here — those events fire on the v4 PoolManager. The [`dex-sync/`](../dex-sync) service polls GeckoTerminal per-pool and writes `dex_data` + `dex_trade` to the same Postgres. The frontend reads merged `Launch ⨝ dex_data` + activity feed = `(Trade ∪ dex_trade) ORDER BY ts DESC`.

## Run locally

```bash
cp .env.example .env
# Edit .env — fill DATABASE_URL, PONDER_RPC_URL_1, FACTORY_ADDRESS, START_BLOCK
npm install
npm run dev            # ponder dev (hot-reloads schema + handlers)
```

GraphQL playground: `http://localhost:42069/graphql`.

## Why dRPC instead of the public X Layer RPC

The public `rpc.xlayer.tech` endpoint **fails on archive `eth_getLogs`** queries spanning more than a few thousand blocks — which Ponder's historical sync needs. Use `https://xlayer.drpc.org` instead (works out of the box, no API key for low volume).

## Deploy (Railway)

The repo includes a `railway.toml`. Provision a Postgres plugin in the same project and set env vars from `.env.example`. Push the `indexer/` subtree as its own Railway service.

## Schema

See [`ponder.schema.ts`](ponder.schema.ts). Ponder auto-generates a GraphQL schema; add custom Hono routes in [`src/index.ts`](src/index.ts) for any non-GraphQL endpoints (e.g. `/top` for the frontend's directory query).
