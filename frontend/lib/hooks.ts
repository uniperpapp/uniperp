"use client";

import { useReadContract, useReadContracts, useAccount } from "wagmi";
import { useContracts } from "./contracts";

const refetchOpts = { query: { refetchInterval: 12_000 } as const };

// Normalized pool snapshot — exposes the field set every existing consumer
// reads, regardless of v1 (hook.getPoolSnapshot) or v2 (lens.getPoolSnapshot).
// v2's `curveEth` is mapped onto `cumulativeEthInPool`.
export type PoolSnapshot = {
  sqrtPriceX96: bigint;
  totalSupply: bigint;
  totalDebtETH: bigint;
  totalBadDebtETH: bigint;
  numOpenPositions: bigint;
  cumulativeEthInPool: bigint;
  poolInitialized: boolean;
  tradingEnabled: boolean;
};

const SYMBOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/// Base + token symbols for the active instance. Launch instances trade against
/// an ERC-20 base (PERP/WETH) and have their own token symbol; v1/v2 are native
/// ETH base + the PERP token. Use everywhere instead of hardcoding "ETH"/"PERP".
export function useSymbols(): { baseSym: string; tokenSym: string } {
  const { baseAddr, tokenAddr, version } = useContracts();
  const isLaunch = version === "launch";
  const { data: baseSymRaw } = useReadContract({
    address: baseAddr, abi: SYMBOL_ABI, functionName: "symbol",
    query: { enabled: isLaunch && baseAddr.toLowerCase() !== ZERO_ADDR, staleTime: 5 * 60_000 },
  });
  const { data: tokenSymRaw } = useReadContract({
    address: tokenAddr, abi: SYMBOL_ABI, functionName: "symbol",
    query: { enabled: isLaunch, staleTime: 5 * 60_000 },
  });
  return {
    baseSym:  isLaunch ? ((baseSymRaw  as string | undefined) ?? "base")  : "ETH",
    tokenSym: isLaunch ? ((tokenSymRaw as string | undefined) ?? "token") : "PERP",
  };
}

export function usePoolSnapshot() {
  const { readAddr, readAbi, version } = useContracts();
  const q = useReadContract({
    address: readAddr,
    abi: readAbi,
    functionName: "getPoolSnapshot",
    ...refetchOpts,
  });

  const raw = q.data as any;
  let data: PoolSnapshot | undefined;
  if (raw) {
    data = {
      sqrtPriceX96: raw.sqrtPriceX96 as bigint,
      totalSupply: raw.totalSupply as bigint,
      totalDebtETH: raw.totalDebtETH as bigint,
      totalBadDebtETH: raw.totalBadDebtETH as bigint,
      numOpenPositions: raw.numOpenPositions as bigint,
      // v2 AND launch use the same lens (getPoolSnapshot → `curveEth`); only
      // v1's hook getter exposes `cumulativeEthInPool`.
      cumulativeEthInPool: (version === "v1"
        ? raw.cumulativeEthInPool
        : raw.curveEth) as bigint,
      poolInitialized: raw.poolInitialized as boolean,
      tradingEnabled: raw.tradingEnabled as boolean,
    };
  }

  return { data, isLoading: q.isLoading };
}

/// Active positions for the connected user.
///
/// We enumerate the user's open-position ID array via `userPositions(addr, idx)`
/// (the contract swap-pops closed positions, so this stays small), then
/// multicall the raw `positions(id)` struct (not the lens view) so the frontend
/// can decode per-version and compute health + liq price itself. Out-of-range
/// indices revert; wagmi reports `result === undefined`, which we filter.
const MAX_POSITION_SCAN = 64;
const MAX_LIQ_HEALTH_BPS = 10_500n;

export type PositionData = {
  id: bigint;
  owner: `0x${string}`;
  side: "long" | "short";
  collateralETH: bigint;
  debtETH: bigint;
  debtTOKEN: bigint;
  holdingTOKEN: bigint;
  heldETH: bigint;
  openedAtBlock: bigint;
  currentValueEth: bigint;
  healthBps: bigint;
  liquidatable: boolean;
  liquidationEth: bigint;
  openSqrtPriceX96: bigint;
  leverage: number;
  realizedETHOut: bigint;
};

export function useUserPositions() {
  const { hookAddr, hookAbi, version } = useContracts();
  const { address } = useAccount();
  const { data: snap } = usePoolSnapshot();

  const scanCalls = address
    ? Array.from({ length: MAX_POSITION_SCAN }, (_, i) => ({
        address: hookAddr,
        abi: hookAbi,
        functionName: "userPositions" as const,
        args: [address, BigInt(i)] as const,
      }))
    : [];
  const { data: idResults } = useReadContracts({
    contracts: scanCalls,
    query: { enabled: !!address, refetchInterval: 12_000 },
  });

  const ids: bigint[] = (idResults ?? [])
    .map((r) => (r.status === "success" ? (r.result as bigint) : undefined))
    .filter((x): x is bigint => x != null);

  const posCalls = ids.map((id) => ({
    address: hookAddr,
    abi: hookAbi,
    functionName: "positions" as const,
    args: [id] as const,
  }));
  const { data: posResults, isLoading: posLoading } = useReadContracts({
    contracts: posCalls,
    query: { enabled: ids.length > 0, refetchInterval: 12_000 },
  });

  const sqrtP = snap?.sqrtPriceX96 ?? 0n;

  // v1 raw Position (named object): no side, single debtETH, holdingTOKEN.
  type RawPosV1 = {
    owner: `0x${string}`;
    collateralETH: bigint;
    debtETH: bigint;
    holdingTOKEN: bigint;
    openSqrtPriceX96: bigint;
    leverage: number;
    openedAtBlock: bigint;
    realizedETHOut: bigint;
  };
  // v2 raw Position (named object): side + debtTOKEN + heldETH + realizedOut.
  type RawPosV2 = {
    owner: `0x${string}`;
    side: number;
    collateralETH: bigint;
    debtETH: bigint;
    debtTOKEN: bigint;
    holdingTOKEN: bigint;
    heldETH: bigint;
    openSqrtPriceX96: bigint;
    leverage: number;
    openedAtBlock: bigint;
    realizedOut: bigint;
  };

  const data: PositionData[] = ids
    .map((id, i) => {
      const r = posResults?.[i];
      if (!r || r.status !== "success") return null;

      if (version === "v1") {
        const p = r.result as RawPosV1;
        if (p.debtETH === 0n && p.holdingTOKEN === 0n) return null; // closed
        const currentValueEth =
          sqrtP > 0n ? tokenValueInEth(p.holdingTOKEN, sqrtP) : 0n;
        const healthBps =
          p.debtETH > 0n
            ? (currentValueEth * 10_000n) / p.debtETH
            : 1n << 255n;
        const liquidatable = p.debtETH > 0n && healthBps < MAX_LIQ_HEALTH_BPS;
        return {
          id,
          owner: p.owner,
          side: "long" as const,
          collateralETH: p.collateralETH,
          debtETH: p.debtETH,
          debtTOKEN: 0n,
          holdingTOKEN: p.holdingTOKEN,
          heldETH: 0n,
          openedAtBlock: p.openedAtBlock,
          currentValueEth,
          healthBps,
          liquidatable,
          liquidationEth: 0n,
          openSqrtPriceX96: p.openSqrtPriceX96,
          leverage: p.leverage,
          realizedETHOut: p.realizedETHOut,
        };
      }

      const p = r.result as RawPosV2;
      const isShort = p.side === 1;
      if (isShort) {
        if (p.debtTOKEN === 0n && p.heldETH === 0n) return null; // closed
        const currentValueEth = p.heldETH;
        const debtValue =
          sqrtP > 0n ? tokenValueInEth(p.debtTOKEN, sqrtP) : 0n;
        const healthBps =
          debtValue > 0n ? (p.heldETH * 10_000n) / debtValue : 1n << 255n;
        const liquidatable =
          p.debtTOKEN > 0n && healthBps < MAX_LIQ_HEALTH_BPS;
        return {
          id,
          owner: p.owner,
          side: "short" as const,
          collateralETH: p.collateralETH,
          debtETH: p.debtETH,
          debtTOKEN: p.debtTOKEN,
          holdingTOKEN: p.holdingTOKEN,
          heldETH: p.heldETH,
          openedAtBlock: p.openedAtBlock,
          currentValueEth,
          healthBps,
          liquidatable,
          liquidationEth: 0n,
          openSqrtPriceX96: p.openSqrtPriceX96,
          leverage: p.leverage,
          realizedETHOut: p.realizedOut,
        };
      }

      if (p.debtETH === 0n && p.holdingTOKEN === 0n) return null; // closed
      const currentValueEth =
        sqrtP > 0n ? tokenValueInEth(p.holdingTOKEN, sqrtP) : 0n;
      const healthBps =
        p.debtETH > 0n ? (currentValueEth * 10_000n) / p.debtETH : 1n << 255n;
      const liquidatable = p.debtETH > 0n && healthBps < MAX_LIQ_HEALTH_BPS;
      return {
        id,
        owner: p.owner,
        side: "long" as const,
        collateralETH: p.collateralETH,
        debtETH: p.debtETH,
        debtTOKEN: 0n,
        holdingTOKEN: p.holdingTOKEN,
        heldETH: 0n,
        openedAtBlock: p.openedAtBlock,
        currentValueEth,
        healthBps,
        liquidatable,
        liquidationEth: 0n,
        openSqrtPriceX96: p.openSqrtPriceX96,
        leverage: p.leverage,
        realizedETHOut: p.realizedOut,
      };
    })
    .filter((x): x is PositionData => x != null);

  return { data, isLoading: posLoading };
}

// tokenValueInEth: ETH value (wei) of `tokens` (wei) at given sqrtPriceX96.
// Mirrors the on-chain `_tokenValueInEth` helper:
//   ethValue = tokens × (2^96 / sqrtP) × (2^96 / sqrtP)
function tokenValueInEth(tokens: bigint, sqrtP: bigint): bigint {
  if (sqrtP === 0n) return 0n;
  const Q96 = 1n << 96n;
  const step1 = (tokens * Q96) / sqrtP;
  return (step1 * Q96) / sqrtP;
}

/// Lightweight pre-submit quote, computed client-side. The detailed
/// "can the borrow walk satisfy this" check is left to the simulate-then-submit
/// path (publicClient.simulateContract before openLong), which reverts with
/// `InsufficientBorrowCapacity` if it can't — surfaced as a toast.
const BORROW_FEE_BPS = 100n;
export function useOpenQuote(collateralWei: bigint | undefined, leverage: number) {
  const { data: snap } = usePoolSnapshot();
  if (!collateralWei || collateralWei === 0n || leverage < 2 || leverage > 5) {
    return { borrowEth: 0n, borrowFee: 0n, effectiveCollateral: 0n, ready: false };
  }
  const borrowEth = collateralWei * BigInt(leverage - 1);
  const borrowFee = (borrowEth * BORROW_FEE_BPS) / 10_000n;
  const effectiveCollateral = collateralWei - borrowFee;
  const ready = !!snap?.poolInitialized;
  return { borrowEth, borrowFee, effectiveCollateral, ready };
}

export function useTokenBalance(addr?: `0x${string}`) {
  const { tokenAddr, tokenAbi } = useContracts();
  const q = useReadContract({
    address: tokenAddr,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: addr ? [addr] : undefined,
    query: { enabled: !!addr, refetchInterval: 12_000 },
  });
  return { ...q, data: q.data as bigint | undefined };
}

export function useClaimable() {
  const { hookAddr, hookAbi } = useContracts();
  const { address } = useAccount();
  const q = useReadContract({
    address: hookAddr,
    abi: hookAbi,
    functionName: "claimable",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 12_000 },
  });
  return { ...q, data: q.data as bigint | undefined };
}

export function useEthBalance() {
  return null;
}

// ─── Staking ────────────────────────────────────────────────────────────────

export function useStakedBalance() {
  const { stakingAddr, stakingAbi } = useContracts();
  const { address } = useAccount();
  const q = useReadContract({
    address: stakingAddr,
    abi: stakingAbi,
    functionName: "stakedBalance",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 12_000 },
  });
  return { ...q, data: q.data as bigint | undefined };
}

export function useStakingPending() {
  const { stakingAddr, stakingAbi } = useContracts();
  const { address } = useAccount();
  const q = useReadContract({
    address: stakingAddr,
    abi: stakingAbi,
    functionName: "pendingRewards",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 12_000 },
  });
  return { ...q, data: q.data as bigint | undefined };
}

export function useTotalStaked() {
  const { stakingAddr, stakingAbi } = useContracts();
  const q = useReadContract({
    address: stakingAddr,
    abi: stakingAbi,
    functionName: "totalStaked",
    ...refetchOpts,
  });
  return { ...q, data: q.data as bigint | undefined };
}

export function useTokenAllowance(spender: `0x${string}`) {
  const { tokenAddr, tokenAbi } = useContracts();
  const { address } = useAccount();
  const q = useReadContract({
    address: tokenAddr,
    abi: tokenAbi,
    functionName: "allowance",
    args: address ? [address, spender] : undefined,
    query: { enabled: !!address, refetchInterval: 12_000 },
  });
  return { ...q, data: q.data as bigint | undefined };
}

// ─── User trade history (closed + liquidated only; reads from on-chain view) ─

export type HistoryItem = {
  type: "close" | "liquidated";
  side: "long" | "short";
  positionId: bigint;
  timestamp: bigint;
  leverage: number;
  collateralETH: bigint;
  amountIn: bigint;
  amountOut: bigint;
  pnlETH: bigint;
};

export function useUserHistory() {
  const { hookAddr, hookAbi, version } = useContracts();
  const { address } = useAccount();

  const { data: count } = useReadContract({
    address: hookAddr,
    abi: hookAbi,
    functionName: "userHistoryLength",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  const total = count ? Number(count) : 0;
  const indices = Array.from({ length: total }, (_, i) => BigInt(total - 1 - i));
  const calls = indices.map((idx) => ({
    address: hookAddr,
    abi: hookAbi,
    functionName: "userHistory" as const,
    args: [address!, idx] as const,
  }));

  const { data: rows, isLoading } = useReadContracts({
    contracts: calls,
    query: {
      enabled: !!address && total > 0,
      refetchInterval: 15_000,
    },
  });

  // v1: the auto-getter for `mapping(addr => ClosedPositionRecord[])` unrolls
  // the struct into 7 positional return values — wagmi decodes that as a
  // POSITIONAL TUPLE (array), accessed by index, no `side`.
  // v2: `userHistory` returns a single struct output → wagmi decodes it as a
  // NAMED OBJECT including `side` and `kind`.
  type RowV1 = readonly [
    bigint, // 0 timestamp
    bigint, // 1 positionId
    number, // 2 leverage
    number, // 3 kind
    bigint, // 4 collateralETH
    bigint, // 5 amountIn
    bigint, // 6 amountOut
  ];
  type RowV2 = {
    timestamp: bigint;
    positionId: bigint;
    leverage: number;
    side: number;
    kind: number;
    collateralETH: bigint;
    amountIn: bigint;
    amountOut: bigint;
  };

  const items: HistoryItem[] = (rows ?? [])
    .map((r) => r.result)
    .filter((r): r is RowV1 | RowV2 => r != null)
    .map((r) => {
      if (version === "v1") {
        const v = r as RowV1;
        return {
          type: v[3] === 1 ? "liquidated" : "close",
          side: "long" as const,
          positionId: v[1],
          timestamp: v[0],
          leverage: v[2],
          collateralETH: v[4],
          amountIn: v[5],
          amountOut: v[6],
          pnlETH: v[6] - v[4],
        };
      }
      const v = r as RowV2;
      return {
        type: v.kind === 1 ? "liquidated" : "close",
        side: v.side === 1 ? "short" : "long",
        positionId: v.positionId,
        timestamp: v.timestamp,
        leverage: v.leverage,
        collateralETH: v.collateralETH,
        amountIn: v.amountIn,
        amountOut: v.amountOut,
        pnlETH: v.amountOut - v.collateralETH,
      };
    });

  return { data: items, isLoading };
}
