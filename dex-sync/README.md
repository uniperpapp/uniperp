# dex-sync — Uniperp (GeckoTerminal price + trades feed)

Stateless Hono service that mirrors live market data for every launched token into Postgres, alongside the [indexer](../indexer)'s on-chain state. The frontend reads merged `Launch ⨝ dex_data` for the directory + token pages, and `(Trade ∪ dex_trade) ORDER BY ts DESC` for the activity feed.

On **X Layer mainnet** we run in `BACKEND=gecko` mode (Dexscreener doesn't index X Layer yet). The mainnet build flips to `BACKEND=dexscreener`; both share this codebase.

## What it writes

- **`dex_data`** — one row per token (upserted): price USD/native, mcap, FDV, liquidity USD, 1h/24h volume USD, 1h/24h % change.
- **`dex_trade`** — append-only spot trade rows (recent buys/sells per pool); the cross-launch "recent trades" feed merges these with the indexer's leverage `Trade` rows.

## Why split this from the indexer

- The indexer is **stateful + deterministic** — it replays chain history into Postgres. Adding GeckoTerminal API calls inside Ponder handlers would intermix non-deterministic network IO with the deterministic event stream and slow reindex builds.
- This service is **stateless + best-effort** — runs in the background, can be restarted/scaled independently, missed cycles recover next tick.

## Modes

### `BACKEND=gecko` (X Layer)

```
every 30s:
  launches      = ponder_graphql.query(Launch.items)
  unknown_pools = launches \ launchPoolIds.keys()
  for L in unknown_pools:
    info       = GeckoTerminal /networks/x-layer/tokens/{L.token}
    launchPoolIds[L.token] = info.top_pool   // cache forever; persist via dex_data.pool_id

  prices = GeckoTerminal /simple/networks/x-layer/token_price/{bases + launches}
  for p in prices:
    mcap = p.market_cap_usd ?? (p.price_usd × 1_000_000)   // synth FDV; GT returns
                                                          // null for new tokens
    upsert dex_data(token, pool_id, price, mcap, vol, %chg)

every 6s (rotating launch pool):
  trades = GeckoTerminal /networks/x-layer/pools/{poolId}/trades
  insert dex_trade rows
```

### `BACKEND=dexscreener` (default — for chains Dexscreener covers)

Per-token batched pull from Dexscreener at 4 req/s (240/min, 20% under their 300/min limit), with GeckoTerminal as the trades feed for pools that just traded (detected via Dexscreener's rolling txn count delta).

See [`src/index.ts`](src/index.ts) for both loops side by side.

## Run

```bash
cp .env.example .env
# Edit .env:
#   BACKEND=gecko
#   GT_NETWORK=x-layer
#   DATABASE_URL=<shared with indexer>
#   PONDER_GRAPHQL_URL=<your indexer URL>
#   BASE_TOKENS=0xe538905cf8410324e03a5a23c1c177a474d59b2b,0x74b7f16337b8972027f6196a17a631ac6de26d22
npm install
npm start
```

Endpoints:

- `GET /health` — sanity (`{ ok: true, watching: N, ... }`)
- `GET /dex?tokens=0xabc,0xdef` — `{ token → { priceUsd, marketCapUsd, volumeH24Usd, ... } }` map
- `GET /trades?limit=50[&token=0x..]` — recent spot trades

## Deploy (Railway)

The included [`railway.toml`](railway.toml) (nixpacks builder, `npm start`) lets you push as a Railway service. Set env vars from `.env.example`. Reference the same Postgres plugin the indexer uses.

## Rate-limit notes

GeckoTerminal's free tier is ~30 calls/min per IP. Both dex-sync services on the same Railway region share that budget, so the X Layer gecko-mode loop intentionally polls trades at 6s per pool (not 2.5s) to leave headroom for the mainnet service running on the same egress IP.
