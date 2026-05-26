# Contracts — Uniperp v4 Hook

Solidity (Foundry) source for the Perpfactory, PerpHook, PerpLens, and the curve library. Deploys to **X Layer mainnet** (chain id 196).

## Layout

```
src/
├── Perpfactory.sol         Launch entrypoint, CREATE2 mining, base whitelist
├── HookDeployer.sol        Sidecar that holds the 22 KB PerpHook initcode
├── PerpTypes.sol           Storage structs + custom errors
├── hook/
│   ├── PerpHook.sol        The hook — every v4 callback, spot + leverage
│   └── PerpLens.sol        Read-only view contract for off-chain consumers
├── library/
│   └── PerpCurve.sol       Pure math: K, sqrtPrice ↔ e, band geometry
├── token/
│   └── PerpToken.sol       Minimal ERC20, 1M supply minted to factory
└── interfaces/             External contract interfaces

test/                        Foundry tests (unit, invariants, exploit, sim)
script/
├── DeployXLayer.s.sol      X Layer mainnet deploy
├── Launch.s.sol            Launch a single token via the deployed factory
├── MineSalt.s.sol          Helper: mine CREATE2 salt for `…2ACC` hook addr
└── WhitelistBases.s.sol    Admin: add/remove base tokens
```

## Setup

```bash
forge install foundry-rs/forge-std --no-commit
forge install Uniswap/v4-core --no-commit
forge install Uniswap/v4-periphery --no-commit
forge install OpenZeppelin/uniswap-hooks --no-commit
forge install Vectorized/solady --no-commit
```

If branch/tag issues, pin compatible commits — Solidity is `^0.8.26`, EVM is `cancun`.

## Build + test

```bash
forge build
forge test
forge test --match-contract Exploit  # adversarial suite
forge test --match-contract Invariants
```

## Deploy

```bash
cp .env.example .env       # then fill in PRIVATE_KEY + (optional) XLAYER_RPC_URL
forge script script/DeployXLayer.s.sol \
    --rpc-url xlayer \
    --broadcast \
    --slow
```

The deploy script:

1. Deploys `HookDeployer(ADMIN)`
2. Deploys `Perpfactory(POOL_MANAGER, ADMIN, hookDeployer)`
3. Binds the HookDeployer to the factory (one-shot via `setFactory`)
4. Whitelists WOKB + USDC as bases with calibrated V/W

## Live X Layer addresses (chain 196)

| Contract | Address |
|---|---|
| Perpfactory | [`0xf9424db38dab21434dfe7701626dbed186b4d584`](https://www.oklink.com/xlayer/address/0xf9424db38dab21434dfe7701626dbed186b4d584) |
| HookDeployer | [`0x1E1B31c2c92b17a0BDbDD32E34AB7000763f224f`](https://www.oklink.com/xlayer/address/0x1E1B31c2c92b17a0BDbDD32E34AB7000763f224f) |
| Uniswap v4 PoolManager (X Layer) | [`0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32`](https://www.oklink.com/xlayer/address/0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32) |
| WOKB | [`0xe538905cf8410324e03A5A23C1c177a474D59b2b`](https://www.oklink.com/xlayer/address/0xe538905cf8410324e03A5A23C1c177a474D59b2b) |
| USDC | [`0x74b7F16337b8972027F6196A17a631aC6dE26d22`](https://www.oklink.com/xlayer/address/0x74b7F16337b8972027F6196A17a631aC6dE26d22) |

## Verification (X Layer)

X Layer uses Sourcify (not Etherscan) for contract verification:

```bash
forge verify-contract <address> <ContractName> \
    --verifier sourcify \
    --rpc-url xlayer \
    --chain 196
```

## Architecture deep-dive

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
