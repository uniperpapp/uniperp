# Architecture — Uniperp v4-Hook Perp DEX

A walkthrough of how spot AMM, leverage engine, and fee router collapse into a single Uniswap v4 hook contract.

---

## 1. The hook address IS the permission set

Uniswap v4's hook system reads a hook's 14 lowest address bits as a bitfield specifying which callbacks the hook implements:

| Bit | Callback | Used by Uniperp |
|----:|---|---|
| 13  | `beforeInitialize`    | ✅ |
| 12  | `afterInitialize`     | ✅ |
| 11  | `beforeAddLiquidity`  | ✅ |
| 10  | `afterAddLiquidity`   | — |
|  9  | `beforeRemoveLiquidity` | — |
|  8  | `afterRemoveLiquidity`  | — |
|  7  | `beforeSwap`          | ✅ |
|  6  | `afterSwap`           | ✅ |
|  5  | `beforeDonate`        | ✅ |
|  4  | `afterDonate`         | ✅ |
|  3  | `beforeSwapReturnDelta` | ✅ |
|  2  | `afterSwapReturnDelta`  | — |
|  1  | `afterAddLiquidityReturnDelta` | — |
|  0  | `afterRemoveLiquidityReturnDelta` | — |

Our hook uses **7 callbacks**, encoded as `0x2ACC` in the low 14 bits.

To get an address with those exact bits, the factory **mines a CREATE2 salt** until the deployed-address tail matches. Every Uniperp hook on-chain ends in `…2ACC` (see [`0xa32e7149c9da1ffb32026cb7cb3771c1d4e3aacc`](https://www.oklink.com/xlayer/address/0xa32e7149c9da1ffb32026cb7cb3771c1d4e3aacc)).

This is "address-as-capability" — v4's gas-cheap way of avoiding per-call permission lookups. We use it as designed.

---

## 2. Why a sidecar HookDeployer?

The PerpHook bytecode is ~22 KB. Embedding its initcode in the factory blows EIP-170's 24 KB contract-size limit. So we split:

```
Perpfactory  (≈3.5 KB runtime, holds business logic + factory state)
   │
   └──→ HookDeployer  (≈22 KB runtime, holds PerpHook initcode literally as bytecode)
            │
            └──→ deploys PerpHook via CREATE2 with mined salt
```

The HookDeployer is **one-shot bound** to the factory at construction (via `setFactory`, callable once by admin). Only the factory can request hook deploys. This is a pure size workaround — no extra trust surface.

---

## 3. Launch flow (one transaction)

```solidity
Perpfactory.create(name, symbol, base, V, W, uri, seedBuy)
  │
  ├─ 1. CREATE2  PerpToken                       // mints 1_000_000 to factory
  ├─ 2. CREATE2  PerpHook  via HookDeployer      // low 14 bits = 0x2ACC
  ├─ 3. CREATE2  PerpLens                        // read-only view contract
  ├─ 4. token.transfer(hook, 1_000_000)          // invariant: hook holds 100% supply
  ├─ 5. hook.setBase(base, V, W)                 // calibrates curve geometry
  ├─ 6. hook.setCurve(V, W)                      // computes K, ticks, bands
  ├─ 7. hook.initializePool(poolKey)             // Uniswap v4 PoolManager.initialize
  ├─ 8. hook.seedBands(0, 25)                    // first 25 LP bands
  └─ 9. hook.seedBands(25, 50)                   // remaining 275 LP bands (split for gas)
```

By the end of that one external call, the token has a v4 pool, 300 concentrated LP bands of liquidity, and is trade-ready for spot + leverage.

---

## 4. Spot trading (the easy part)

A standard Uniswap v4 swap path:

```
UniversalRouter.execute(SWAP_V4)
   → PoolManager.swap(poolKey, swapParams)
       → PerpHook.beforeSwap()
            • snapshot pool sqrtPrice for PnL marking
            • return 1% fee delta (collected at hook)
       → core swap executes against the 300 LP bands
       → PerpHook.afterSwap()
            • update last-trade timestamp
            • emit Swap event
```

User pays base token, receives launch token. 1% spot fee goes to the hook's insurance reserve.

---

## 5. Leverage (the interesting part)

A 3× long opens by **removing** tokens from the LP bands using the trader's collateral. A 3× short opens by **adding** tokens back from collateral. The position's PnL marks against the pool's own sqrtPrice — the leverage book IS the spot book.

```
hook.openPosition(side, base, collateralIn, leverage)
   │
   ├─ pull collateral from trader
   ├─ compute notional = collateral · leverage
   ├─ side=LONG  → withdraw `notional` worth of tokens from LP bands
   │              → record entry sqrtPrice + debt
   ├─ side=SHORT → withdraw `notional` worth of base from LP bands
   │              → record entry sqrtPrice + debt
   └─ emit OpenPosition
```

Closing:

```
hook.closePosition(positionId)
   │
   ├─ compute exit sqrtPrice (= current pool sqrtPrice)
   ├─ compute PnL = f(entrySqrtPrice, exitSqrtPrice, notional)
   ├─ side=LONG  → put tokens back into LP bands
   ├─ side=SHORT → put base back into LP bands
   ├─ pay (collateral + PnL) to trader, or seize collateral if liquidated
   └─ emit ClosePosition
```

**No funding rate.** Because the leverage trader IS the LP counterparty by construction (they literally borrowed from the same bands a spot trader fills against), there's no inter-market drift to correct.

**No oracle.** Pool sqrtPrice is the mark price. Manipulating it costs you on the spot leg — you'd have to move the pool back to extract value, and the 1% spot fee + bands geometry make this a money pit.

---

## 6. Bonding curve geometry

```
K = TOTAL_SUPPLY · V / 1e18         // curve constant
sqrtPriceX96(e) = sqrt(K · 1e18) · 2^96 / (V + e)
e(sqrtP)        = sqrt(K · 1e18) · 2^96 / sqrtP − V
```

`V` and `W` are per-base calibration constants such that target launch FDV ≈ 3.5 × ETH-USD. For X Layer (OKB-denominated bases):

| Base | V | W | Implied launch FDV |
|---|---|---|---|
| WOKB | 67.02 WOKB | 95.75 WOKB | ≈ $7,487 |
| USDC | 7,487 USDC | 10,696 USDC | ≈ $7,487 |

The 300 LP bands are each `W`-wide in token amount, concentrated around the curve so the implied spot price moves smoothly as the buyer walks the bands.

---

## 7. Indexing + data flow

```
                                 ┌──────────────────────┐
   X Layer (chain 196)           │ Postgres (Railway)   │
   ┌──────────────────┐          │                      │
   │ Perpfactory      │          │   schema_xlayer      │
   │ PerpHook(s)      │── logs ──▶ launches             │
   │ Uniswap v4 PM    │          │   positions          │
   └──────────────────┘          │   trades             │
            │                    │   dex_data           │
            │ eth_getLogs        │   dex_trade          │
            ▼                    └──────┬─────┬─────────┘
   ┌──────────────────┐                 │     │
   │ Ponder indexer   │─────────────────┘     │
   │ (dRPC backend)   │                       │
   └──────────────────┘                       │
                                              │
   ┌──────────────────┐                       │
   │ dex-sync (Hono)  │── reads launches ─────┘
   │ BACKEND=gecko    │
   │   GT prices+vol  │── writes dex_data + dex_trade
   │   GT pool trades │
   └──────────────────┘
            │
            ▼
   ┌──────────────────┐
   │ frontend         │── reads Ponder GraphQL + dex-sync HTTP
   │ (Next.js)        │── writes go to wallet via wagmi/viem
   │ x.uniperp.app    │
   └──────────────────┘
```

Why dex-sync instead of just Ponder? Spot trades go through the v4 PoolManager and are emitted as `Swap` events on the PM (not the hook), so per-pool trade attribution + USD pricing comes via GeckoTerminal's `/pools/{poolId}/trades` endpoint. Ponder owns *factory* events (launches, positions, liquidations). The frontend merges both streams into one Recent-trades feed.

---

## 8. Why this matters (for the hackathon)

Most "perp DEXes built on v4" treat the hook as a *router* — they keep an off-chain matching engine or a separate AMM and just use the hook for fee collection or settlement. Uniperp inverts that: **the hook is the matching engine, the AMM, the leverage book, and the liquidation engine**. v4 isn't a building block; it's the entire substrate.

This makes the system:

- **Composable** — any v4-compatible aggregator can route to it without special integration
- **Atomic** — leverage open → spot move → liquidation all in one block under one PoolManager lock
- **Auditable** — one contract per market, no off-chain dependencies, ~1.2 K lines of Solidity total
- **MEV-resistant** — there's no off-chain orderbook to front-run, and same-block leverage manipulation has to round-trip the spot pool

---

## 9. Code map

| File | Role |
|---|---|
| `contracts/src/Perpfactory.sol` | Launch entrypoint, CREATE2 mining, base whitelist |
| `contracts/src/HookDeployer.sol` | Sidecar that holds the 22 KB PerpHook initcode |
| `contracts/src/hook/PerpHook.sol` | The hook itself — every callback, spot + leverage |
| `contracts/src/hook/PerpLens.sol` | Read-only view contract for indexer + frontend |
| `contracts/src/library/PerpCurve.sol` | Pure math — K, sqrtPrice ↔ e, band geometry |
| `contracts/src/token/PerpToken.sol` | Minimal ERC20 minted to the factory at launch |
| `contracts/src/PerpTypes.sol` | Storage structs (Curve, Position, etc.) + custom errors |
| `contracts/script/DeployXLayer.s.sol` | X Layer mainnet deploy |

All read by the [indexer](../indexer) (event sourcing) and [dex-sync](../dex-sync) (off-chain price + trades enrichment), surfaced by the [frontend](../frontend).
