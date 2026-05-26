"use client";

import Link from "next/link";
import { useReadContract, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { perpfactoryAbi } from "@/lib/abi-factory";
import { launchHookExtraAbi } from "@/lib/abi-launch-hook-extra";
import { FACTORY_ADDRESS, FACTORY_LIVE } from "@/lib/config";
import { gql, LAUNCH_BY_TOKEN_QUERY, INDEXER_CONFIGURED, type LaunchRow } from "@/lib/graphql";
import {
  ContractsProvider,
  type LaunchInstance,
} from "@/lib/contracts";

const ERC20_DECIMALS_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

import { Header } from "@/components/Header";
import { ChainGuard } from "@/components/ChainGuard";
import { TokenHeader } from "@/components/TokenHeader";
import { TradeStakeTabs } from "@/components/TradeStakeTabs";
import { GetBaseToken } from "@/components/GetBaseToken";
import { PositionsList } from "@/components/PositionsList";
import { CurveChart } from "@/components/CurveChart";

/// Per-launch trade page. PURE-CLIENT + RPC + multicall — exactly the
/// architecture of the v2 page (proven). No indexer dependency: a launched
/// token's live state is read straight from its hook + lens via wagmi.
///
/// Two reads in one multicall to populate the LaunchInstance:
///   1. factory.hookId(hook)        — confirms it's a valid launch, gets index
///   2. hook.curveParams()          — per-launch (V, K, tickWidth)
///
/// Then one follow-up read of factory.launches(hookId-1) gives token/lens/base.
///
/// Everything below the ContractsProvider is the SAME components the v2 page
/// uses (TradePanel/PositionsList/CurveChart) — they read from useContracts()
/// and stay byte-unchanged.
/// `addr` is the URL param — it may be a HOOK address (launch-time redirect,
/// activity links) OR a TOKEN address (directory tiles, shareable links).
/// Resolution: try `hookId(addr)` on-chain first (hook path, indexer-free); if
/// that's 0, resolve token→hook via the indexer (tiles are already indexer-
/// backed). Everything downstream is keyed on the resolved hook.
export function PerLaunchPage({ addr }: { addr: `0x${string}` }) {
  // Step 0 — is `addr` itself a hook?
  const hookIdOfParam = useReadContract({
    address: FACTORY_ADDRESS,
    abi: perpfactoryAbi,
    functionName: "hookId",
    args: [addr],
    query: { enabled: FACTORY_LIVE },
  });
  const paramHookId = hookIdOfParam.data as bigint | undefined;
  const paramIsHook = !!paramHookId && paramHookId > 0n;

  // Step 0b — not a hook ⇒ treat `addr` as a token and resolve its hook via
  // the indexer (the tiles that link with a token address are indexer-backed).
  const tokenResolve = useQuery({
    queryKey: ["resolveHookByToken", addr.toLowerCase()],
    enabled: FACTORY_LIVE && paramHookId !== undefined && !paramIsHook && INDEXER_CONFIGURED,
    staleTime: 60_000,
    queryFn: async () => {
      const d = await gql<{ launchs: { items: LaunchRow[] } }>(LAUNCH_BY_TOKEN_QUERY(addr));
      return (d?.launchs?.items?.[0]?.hook as `0x${string}` | undefined) ?? null;
    },
  });

  const hookAddr: `0x${string}` | undefined =
    paramIsHook ? addr : (tokenResolve.data ?? undefined);

  // Step 1 — on-chain reads keyed on the RESOLVED hook: hookId + curveParams.
  const head = useReadContracts({
    contracts: hookAddr
      ? [
          { address: FACTORY_ADDRESS, abi: perpfactoryAbi, functionName: "hookId", args: [hookAddr] },
          { address: hookAddr, abi: launchHookExtraAbi, functionName: "curveParams" },
        ]
      : [],
    query: { enabled: !!hookAddr, refetchInterval: 30_000 },
  });

  const hookId = head.data?.[0]?.result as bigint | undefined;
  // viem decoded shape can be a positional tuple OR named object — coerce.
  const cpRaw: any = head.data?.[1]?.result;
  const curveV: bigint | undefined = cpRaw
    ? ((Array.isArray(cpRaw) ? cpRaw[0] : cpRaw.v) as bigint)
    : undefined;

  // Step 2 — once hookId resolves, read the Launch struct for token/lens/base.
  const launchRead = useReadContracts({
    contracts:
      hookId && hookId > 0n
        ? [
            {
              address: FACTORY_ADDRESS,
              abi: perpfactoryAbi,
              functionName: "launches",
              args: [hookId - 1n],
            },
          ]
        : [],
    query: { enabled: !!hookId && hookId > 0n, refetchInterval: 60_000 },
  });
  const launchRaw: any = launchRead.data?.[0]?.result;

  if (!FACTORY_LIVE) return <NotDeployed />;
  // Still resolving the param (hook check, or token→hook via indexer).
  if (hookIdOfParam.isLoading || (!paramIsHook && tokenResolve.isLoading)) {
    return <LoadingPage hookAddr={addr} />;
  }
  // Param is neither a known hook nor a known token.
  if (!hookAddr) {
    return <NotFound hookAddr={addr} />;
  }
  if (head.isLoading || (hookId && hookId > 0n && launchRead.isLoading)) {
    return <LoadingPage hookAddr={hookAddr} />;
  }
  if (head.isError || !hookId || hookId === 0n) {
    return <NotFound hookAddr={hookAddr} />;
  }
  if (!launchRaw || !curveV) {
    return <LoadingPage hookAddr={hookAddr} />;
  }

  const isArr = Array.isArray(launchRaw);
  const tokenAddr = (isArr ? launchRaw[1] : launchRaw.token) as `0x${string}`;
  const lensAddr  = (isArr ? launchRaw[2] : launchRaw.lens)  as `0x${string}`;
  const baseAddr  = (isArr ? launchRaw[3] : launchRaw.base)  as `0x${string}`;

  return <ResolvedLaunch hookAddr={hookAddr} tokenAddr={tokenAddr} lensAddr={lensAddr} baseAddr={baseAddr} curveV={curveV} />;
}

/// Reads the base asset's `decimals()` (the engine is decimal-agnostic, so the
/// UI needs it to parse/format base amounts), then mounts the trading UI. Split
/// into its own component so the decimals read is a clean top-level hook.
function ResolvedLaunch({
  hookAddr, tokenAddr, lensAddr, baseAddr, curveV,
}: {
  hookAddr: `0x${string}`; tokenAddr: `0x${string}`; lensAddr: `0x${string}`;
  baseAddr: `0x${string}`; curveV: bigint;
}) {
  const { data: baseDecRaw } = useReadContract({
    address: baseAddr, abi: ERC20_DECIMALS_ABI, functionName: "decimals",
    query: { staleTime: Infinity },
  });
  const baseDecimals = baseDecRaw != null ? Number(baseDecRaw) : 18;

  const instance: LaunchInstance = {
    hookAddr, tokenAddr, lensAddr, baseAddr, curveV, baseDecimals,
  };

  return (
    <ContractsProvider instance={instance}>
      <div className="min-h-screen md:h-screen flex flex-col bg-bg text-text">
        <ChainGuard />
        <Header />

        {/* Token identity header (full width) above the trading grid. */}
        <main className="flex-1 min-h-0 flex flex-col gap-2 sm:gap-3 p-2 sm:p-3 overflow-y-auto md:overflow-hidden">
          <TokenHeader />

          {/* 12-col trading-terminal grid — minus the Stake tab (per-launch
              tokens have no staking). */}
          <div className="flex-1 min-h-0 flex flex-col gap-2 sm:gap-3 md:overflow-hidden md:grid md:grid-cols-12">
            <aside className="md:col-span-4 lg:col-span-3 md:min-h-0 md:overflow-auto flex flex-col gap-2 sm:gap-3">
              <div className="bg-panel border border-border rounded-lg p-3">
                <TradeStakeTabs />
              </div>
              <GetBaseToken />
            </aside>
            <section className="flex flex-col gap-2 sm:gap-3 md:col-span-8 lg:col-span-9 md:min-h-0">
              <div className="bg-panel border border-border rounded-lg h-[280px] sm:h-[340px] md:h-auto md:min-h-0 md:flex-[3_1_0]">
                <CurveChart />
              </div>
              <div className="bg-panel border border-border rounded-lg flex flex-col min-h-[260px] md:min-h-0 md:flex-[2_1_0]">
                <PositionsList />
              </div>
            </section>
          </div>
        </main>
      </div>
    </ContractsProvider>
  );
}

// ─── small inline states ────────────────────────────────────────────────────

function NotDeployed() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg text-text p-6">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-xl font-semibold">Launchpad not deployed yet</h1>
        <p className="text-sm opacity-70">
          Set <code className="opacity-90">NEXT_PUBLIC_FACTORY_ADDRESS</code> once
          the perpfactory contracts are deployed on mainnet.
        </p>
        <Link href="/" className="text-accent underline">← back to v2</Link>
      </div>
    </div>
  );
}

function NotFound({ hookAddr }: { hookAddr: `0x${string}` }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg text-text p-6">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-xl font-semibold">Launch not found</h1>
        <p className="text-sm opacity-70 break-all">
          No launchpad token matches hook{" "}
          <code className="opacity-90">{hookAddr}</code>.
        </p>
        <Link href="/" className="text-accent underline">
          ← browse launches
        </Link>
      </div>
    </div>
  );
}

function LoadingPage({ hookAddr }: { hookAddr: `0x${string}` }) {
  return (
    <div className="min-h-screen flex flex-col bg-bg text-text">
      <Header />
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm opacity-60">
          Loading launch{" "}
          <code className="opacity-90 break-all">{hookAddr.slice(0, 10)}…</code>
        </div>
      </div>
    </div>
  );
}
