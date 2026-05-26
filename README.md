# Uniperp — A Perp DEX Encoded Entirely Inside a Uniswap v4 Hook

### 🚀 Try it live → **[x.uniperp.app](https://x.uniperp.app)**

**Network:** [X Layer](https://www.oklink.com/xlayer) mainnet (chain id 196) · **Status:** live, trading real OKB

> Spot trades, 3× longs, and 3× shorts all settle through **one Uniswap v4 pool**, through **one swap**, with no orderbook, no oracle, and no separate AMM contract. The hook is the entire exchange.

Built for the **OKX X Layer × Uniswap × Flap "Hook the Future" hackathon** (May 2026).

---

## What is Uniperp

A **permissionless perpetuals DEX**. Anyone can launch a token in 30 seconds and trade it both spot and leveraged from the same UI, against the same liquidity, in the same Uniswap v4 pool.

- **Permissionless launches** — connect a wallet, pick a base asset, upload an image, click Launch. The factory deploys the token + hook + lens, initialises a v4 pool, and seeds 300 concentrated LP bands of liquidity in one atomic transaction. No allowlist, no approval, no gatekeeping.
- **Built-in leverage** — every launched market supports 3× longs and 3× shorts out of the box. There's no separate perp contract to set up, no orderbook to bootstrap, no funding-rate machinery to tune. The hook handles it.
- **Whitelisted base assets** — launches are quoted against admin-curated bases. On X Layer that's **WOKB** and **USDC**; on Ethereum mainnet it extends to ETH, USDC, WBTC, LINK, UNI, PEPE, and more. Add a new base = one admin tx.
- **One pool, one hook, one liquidity book** — leverage longs draw tokens *out* of the LP bands a spot trader fills against; shorts put tokens *back* in. The leverage book IS the spot book. No bridge between markets, no funding-rate drift, no separate venues to keep in sync.

Think of it as **pump.fun's permissionless launches + Hyperliquid's leverage**, collapsed into a single Uniswap v4 hook contract — atomic, oracle-free, and composable with any v4-compatible aggregator.

---

## Why it's novel

1. **Single hook = whole exchange.** A 14-bit flag (`0x2ACC`) baked into the hook's CREATE2 address registers it for 7 v4 callbacks. Spot AMM, leverage engine, fee router — one contract.
2. **Leverage shares spot liquidity.** A 3× long REMOVES tokens from v4 LP bands; a 3× short ADDS them back. Same bands a spot trader fills against. No funding-rate drift between markets — the leverage book IS the spot book.
3. **Zero oracle dependency.** PnL marks against the pool's own `sqrtPriceX96`. Liquidations trigger off pool price, not Chainlink. Manipulation is self-penalising via the bonding curve.
4. **Atomic launches.** Any token launches → mints supply to hook → initialises v4 pool → seeds 300 concentrated LP bands → opens for spot + leverage trading. One factory call.

---

## Live deployment (X Layer · chain 196)

| Contract | Address |
|---|---|
| **Perpfactory** | [`0xf9424db38dab21434dfe7701626dbed186b4d584`](https://www.oklink.com/xlayer/address/0xf9424db38dab21434dfe7701626dbed186b4d584) |
| **HookDeployer** | [`0x1E1B31c2c92b17a0BDbDD32E34AB7000763f224f`](https://www.oklink.com/xlayer/address/0x1E1B31c2c92b17a0BDbDD32E34AB7000763f224f) |
| **Uniswap v4 PoolManager** | [`0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`](https://www.oklink.com/xlayer/address/0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32) |
| **WOKB (whitelisted base)** | [`0xe538905cf8410324e03A5A23C1c177a474D59b2b`](https://www.oklink.com/xlayer/address/0xe538905cf8410324e03A5A23C1c177a474D59b2b) |
| **USDC (whitelisted base)** | [`0x74b7F16337b8972027F6196A17a631aC6dE26d22`](https://www.oklink.com/xlayer/address/0x74b7F16337b8972027F6196A17a631aC6dE26d22) |

### Sample launch — $XPERP

| | |
|---|---|
| Token | [`0xf567b3f36055199b2a8a63ed982fe322e48f89eb`](https://www.oklink.com/xlayer/address/0xf567b3f36055199b2a8a63ed982fe322e48f89eb) |
| Hook | [`0xa32e7149c9da1ffb32026cb7cb3771c1d4e3aacc`](https://www.oklink.com/xlayer/address/0xa32e7149c9da1ffb32026cb7cb3771c1d4e3aacc) (note the `…2ACC` flag-bit tail) |
| First buy tx | [`0xfbde05c4…1e06f087`](https://www.oklink.com/xlayer/tx/0xfbde05c4177460d9bbe4b2e0114b473dfcc748c0ce5b79bdac12622e1e06f087) |

---

## Repo layout

```
uniperp-xlayer/
├── contracts/      Solidity (Foundry) — factory, hook, lens, curve library
├── indexer/        Ponder TypeScript indexer (X Layer chain 196 via dRPC)
├── dex-sync/       Hono service — GeckoTerminal prices + per-pool trades feed
├── frontend/       Next.js app (X Layer build of x.uniperp.app)
└── docs/           Architecture deep-dive + screenshots
```

Each folder has its own README with run instructions.

---

## How it works (the 30-second version)

```
launch tx
   ┌────────────────────────────────────────────────────────────────────┐
   │ Perpfactory.create(name, symbol, base, V, W, uri, seedBuy)         │
   │   1. CREATE2 PerpToken                       (mints 1M to factory) │
   │   2. CREATE2 PerpHook via HookDeployer       (low 14 bits = 0x2ACC)│
   │   3. CREATE2 PerpLens                        (read-only view)      │
   │   4. token.transfer(hook, 1_000_000)         (hook holds supply)   │
   │   5. hook.initializePool(poolKey)            (Uniswap v4 init)     │
   │   6. hook.seedBands(0, 25) + seedBands(25, 50)                     │
   │      → 300 concentrated LP bands w-wide each                       │
   └────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
spot swap                    leverage open/close
   ┌─────────────────────────────────────┐    ┌──────────────────────────┐
   │ UniversalRouter.execute(SWAP_V4)    │    │ PerpHook.openPosition(   │
   │   → PoolManager.swap                │    │   side, leverage, base)  │
   │   → PerpHook.beforeSwap (1% fee)    │    │   → modify LP bands      │
   │   → PerpHook.afterSwap (returnΔ)    │    │   → mark in pool price   │
   └─────────────────────────────────────┘    └──────────────────────────┘
```

Math:

```
K = TOTAL_SUPPLY · V / 1e18
sqrtPriceX96(e) = sqrt(K · 1e18) · 2^96 / (V + e)
e(sqrtP)        = sqrt(K · 1e18) · 2^96 / sqrtP − V
```

Full architecture writeup: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Run locally

### Contracts

```bash
cd contracts
forge install
forge build
forge test
# Deploy to X Layer:
PRIVATE_KEY=0x... XLAYER_RPC_URL=https://rpc.xlayer.tech \
  forge script script/DeployXLayer.s.sol --rpc-url xlayer --broadcast
```

### Indexer

```bash
cd indexer
cp .env.example .env   # fill in DATABASE_URL + XLAYER_RPC_URL
npm install
npm run dev
```

### Dex-sync

```bash
cd dex-sync
cp .env.example .env   # fill in DATABASE_URL + PONDER_GRAPHQL_URL
npm install
npm start
```

### Frontend

```bash
cd frontend
cp .env.example .env.local   # fill in factory + dex-sync URL
npm install
npm run dev
# → http://localhost:3000
```

---

## License

[MIT](LICENSE)

## Credits

Built for the **"Hook the Future"** hackathon by [@flapdotsh](https://x.com/flapdotsh) × [@Uniswap](https://x.com/Uniswap) × [@XLayerOfficial](https://x.com/XLayerOfficial).
