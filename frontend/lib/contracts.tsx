"use client";

import { createContext, useContext, useMemo } from "react";
import type { Abi } from "viem";
import { CONTRACT_SETS } from "./config";
import { boostHookAbi } from "./abi-hook";
import { hypeHookAbi } from "./abi-hype-hook";
import { launchHookExtraAbi } from "./abi-launch-hook-extra";
import { hypeLensAbi } from "./abi-hype-lens";

// Launch hooks use the ERC-20-base engine: openLong/openShort take an extra
// `collateral` arg and are non-payable (v2's are native + payable). Swap those
// out of the v2 ABI and add the 4-arg launch versions (+ curveParams/base).
const launchHookAbi = [
  ...hypeHookAbi.filter(
    (x: any) => !(x.type === "function" && (x.name === "openLong" || x.name === "openShort")),
  ),
  ...launchHookExtraAbi,
] as unknown as Abi;
import { boostTokenAbi } from "./abi-token";
import { hypeTokenAbi } from "./abi-hype-token";
import { boostStakingAbi } from "./abi-staking";
import { hypeStakingAbi } from "./abi-hype-staking";

export type V = "v1" | "v2";

export interface Contracts {
  version: V | "launch";        // 'launch' = a perpfactory-launched instance
  hookAddr: `0x${string}`;
  hookAbi: Abi;
  readAddr: `0x${string}`;
  readAbi: Abi;
  tokenAddr: `0x${string}`;
  tokenAbi: Abi;
  /// Zero for launchpad instances (no per-launch staking).
  stakingAddr: `0x${string}`;
  stakingAbi: Abi;
  curve: { V: number; KHuman: number };
  /// Per-launch base asset (currency0); equals WETH for the standard
  /// whitelist. Static v1/v2 sets use the native-ETH sentinel 0x0.
  baseAddr: `0x${string}`;
  /// Decimals of the base asset (currency0). The engine is decimal-agnostic
  /// (V/W/curveEth/debt are all in base-raw units), so the UI must use this to
  /// parse/format base amounts and to scale prices. Native ETH + the launched
  /// token are always 18-dec; only the whitelisted base varies (USDC=6, …).
  baseDecimals: number;
}

/// Inputs for a launchpad instance (one launched token). All addresses
/// come from `factory.launches(i)` or are read directly off-chain.
export interface LaunchInstance {
  hookAddr:  `0x${string}`;
  lensAddr:  `0x${string}`;
  tokenAddr: `0x${string}`;
  baseAddr:  `0x${string}`;
  /// Per-launch V in base-raw units (e.g. 3.5e18 for an 18-dec base). The
  /// frontend converts to the human `curve.V` field via `baseDecimals`.
  curveV:    bigint;
  /// `decimals()` of the base asset. Defaults to 18 if the read is pending.
  baseDecimals: number;
}

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

function buildContracts(version: V): Contracts {
  const set = CONTRACT_SETS[version];
  if (version === "v2") {
    return {
      version,
      hookAddr: set.hook,
      hookAbi: hypeHookAbi,
      readAddr: set.read,
      readAbi: hypeLensAbi,
      tokenAddr: set.token,
      tokenAbi: hypeTokenAbi,
      stakingAddr: set.staking,
      stakingAbi: hypeStakingAbi,
      curve: { V: 3.5, KHuman: 3.5e6 },
      baseAddr: ZERO,             // v2 = native ETH
      baseDecimals: 18,           // native ETH is 18-dec
    };
  }
  return {
    version,
    hookAddr: set.hook,
    hookAbi: boostHookAbi,
    readAddr: set.read,
    readAbi: boostHookAbi,
    tokenAddr: set.token,
    tokenAbi: boostTokenAbi,
    stakingAddr: set.staking,
    stakingAbi: boostStakingAbi,
    curve: { V: 10, KHuman: 1e7 },
    baseAddr: ZERO,               // v1 = native ETH
    baseDecimals: 18,             // native ETH is 18-dec
  };
}

/// Build a Contracts object for a perpfactory launch. Reuses the v2 ABIs
/// (the engine is byte-faithful to v2 modulo the ERC-20 base + curve
/// params; same selectors, same event sigs). Sets `stakingAddr=0` so the
/// existing staking-aware UI can short-circuit those code paths.
export function buildLaunchContracts(inst: LaunchInstance): Contracts {
  // V is stored in base-RAW units, so divide by 10^baseDecimals (not 1e18) to
  // get the human V used by the curve math/chart. Token supply is fixed 1M.
  const vHuman    = Number(inst.curveV) / 10 ** inst.baseDecimals;
  const totalSupp = 1_000_000;                       // fixed TOTAL_SUPPLY
  return {
    version: "launch",
    hookAddr: inst.hookAddr,
    hookAbi: launchHookAbi,
    readAddr: inst.lensAddr,
    readAbi: hypeLensAbi,
    tokenAddr: inst.tokenAddr,
    tokenAbi: hypeTokenAbi,
    stakingAddr: ZERO,                                // launchpad instances have NO staking
    stakingAbi: hypeStakingAbi,                       // unused, kept for type consistency
    curve: { V: vHuman, KHuman: totalSupp * vHuman }, // K = TOTAL_SUPPLY · V
    baseAddr: inst.baseAddr,
    baseDecimals: inst.baseDecimals,
  };
}

const DEFAULT_CONTRACTS = buildContracts("v2");

const ContractsContext = createContext<Contracts>(DEFAULT_CONTRACTS);

/// Provider supports either a static version ('v1'/'v2') OR an explicit
/// `instance` for per-launch routes. If both supplied, `instance` wins.
export function ContractsProvider({
  version = "v2",
  instance,
  children,
}: {
  version?: V;
  instance?: LaunchInstance;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => (instance ? buildLaunchContracts(instance) : buildContracts(version)),
    [version, instance?.hookAddr, instance?.lensAddr, instance?.tokenAddr, instance?.baseAddr, instance?.curveV, instance?.baseDecimals],
  );
  return (
    <ContractsContext.Provider value={value}>
      {children}
    </ContractsContext.Provider>
  );
}

export function useContracts(): Contracts {
  return useContext(ContractsContext);
}
