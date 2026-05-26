"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount, useBalance, usePublicClient, useReadContract,
  useSimulateContract, useWriteContract,
} from "wagmi";
import { parseUnits, formatUnits, maxUint256, type Address } from "viem";

import { useContracts } from "@/lib/contracts";
import { UNIVERSAL_ROUTER, V4_QUOTER, PERMIT2 } from "@/lib/config";
import { universalRouterAbi, v4QuoterAbi, permit2Abi } from "@/lib/abi-spot";
import { buildPerpPoolKey, buildV4ExactInCall } from "@/lib/v4Swap";
import { fmtAmount } from "@/lib/format";
import { useTx } from "@/lib/useTx";
import { toast } from "@/lib/toast";
import { SlippageControl } from "./SlippageControl";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DEFAULT_SLIPPAGE_PCT = 1;
const UINT160_MAX = (1n << 160n) - 1n;

const ERC20_MIN_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view",
    inputs: [], outputs: [{ type: "string" }] },
] as const;

type Side = "buy" | "sell";

/// Spot buy/sell via the Uniswap v4 Universal Router (V4_SWAP command).
/// Buy  = base → token (currency0 → currency1, zeroForOne = true)
/// Sell = token → base (zeroForOne = false)
/// Permit2 is needed whenever the INPUT currency is an ERC-20 — i.e. every
/// launch swap (ERC-20 base) and every sell; only the v2 $PERP native-ETH buy
/// skips it (sends msg.value instead).
export function SpotPanel() {
  const { hookAddr, tokenAddr, baseAddr, version, baseDecimals } = useContracts();
  const baseIsNative = baseAddr.toLowerCase() === ZERO; // v2 $PERP
  const { address: wallet, isConnected } = useAccount();
  const publicClient = usePublicClient();

  const [side, setSide] = useState<Side>("buy");
  const [amountStr, setAmountStr] = useState("");
  const [slippagePct, setSlippagePct] = useState(DEFAULT_SLIPPAGE_PCT);
  const [stage, setStage] = useState<"idle" | "approve-token" | "approve-permit2">("idle");

  // ── symbols ────────────────────────────────────────────────────────────
  const { data: baseSymRaw } = useReadContract({
    address: baseAddr, abi: ERC20_MIN_ABI, functionName: "symbol",
    query: { enabled: !baseIsNative, staleTime: 5 * 60_000 },
  });
  const { data: tokenSymRaw } = useReadContract({
    address: tokenAddr, abi: ERC20_MIN_ABI, functionName: "symbol",
    query: { enabled: !!tokenAddr, staleTime: 5 * 60_000 },
  });
  const baseSym  = baseIsNative ? "ETH" : ((baseSymRaw as string | undefined) ?? "BASE");
  const tokenSym = version === "v2" ? "PERP" : ((tokenSymRaw as string | undefined) ?? "token");

  const inSym  = side === "buy" ? baseSym  : tokenSym;
  const outSym = side === "buy" ? tokenSym : baseSym;
  // Input currency: buy spends base, sell spends token.
  const currencyIn: Address = side === "buy" ? baseAddr : tokenAddr;
  const inputIsNative = side === "buy" && baseIsNative;
  // Decimals of the in/out currencies. The launched TOKEN is fixed 18-dec; the
  // BASE varies (USDC=6, WBTC=8, …). buy: in=base, out=token. sell: in=token,
  // out=base.
  const inDec  = side === "buy" ? baseDecimals : 18;
  const outDec = side === "buy" ? 18 : baseDecimals;

  const poolKey = useMemo(
    () => buildPerpPoolKey({ base: baseAddr, token: tokenAddr, hook: hookAddr }),
    [baseAddr, tokenAddr, hookAddr],
  );
  const zeroForOne = side === "buy"; // base(currency0) → token(currency1)

  // ── amount ──────────────────────────────────────────────────────────────
  // Decimals-generic: parse against the INPUT currency's decimals (`inDec`).
  const amountIn = useMemo(() => {
    if (!amountStr || Number(amountStr) <= 0) return 0n;
    try { return parseUnits(amountStr, inDec); } catch { return 0n; }
  }, [amountStr, inDec]);

  // ── balances ──────────────────────────────────────────────────────────────
  const { data: nativeBal } = useBalance({
    address: wallet, query: { enabled: !!wallet && inputIsNative },
  });
  const { data: erc20BalRaw, refetch: refetchInBal } = useReadContract({
    address: currencyIn, abi: ERC20_MIN_ABI, functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet && !inputIsNative, refetchInterval: 8_000 },
  });
  const inBal: bigint = inputIsNative
    ? (nativeBal?.value ?? 0n)
    : ((erc20BalRaw as bigint | undefined) ?? 0n);

  // ── quote (V4Quoter, non-view → simulate) ──────────────────────────────────
  const { data: quoteRes } = useSimulateContract({
    address: V4_QUOTER, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
    args: amountIn > 0n
      ? [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }] as any
      : undefined,
    query: { enabled: amountIn > 0n },
  });
  const quotedOut = (quoteRes?.result?.[0] as bigint | undefined) ?? 0n;
  const slipBps = BigInt(Math.round(slippagePct * 100));
  const minOut = quotedOut > 0n ? (quotedOut * (10_000n - slipBps)) / 10_000n : 0n;

  // ── approvals (only when input is ERC-20) ──────────────────────────────────
  const { data: erc20AllowRaw, refetch: refetchErc20Allow } = useReadContract({
    address: currencyIn, abi: ERC20_MIN_ABI, functionName: "allowance",
    args: wallet ? [wallet, PERMIT2] : undefined,
    query: { enabled: !!wallet && !inputIsNative },
  });
  const erc20Allow: bigint = (erc20AllowRaw as bigint | undefined) ?? 0n;

  const { data: permit2Allow, refetch: refetchPermit2 } = useReadContract({
    address: PERMIT2, abi: permit2Abi, functionName: "allowance",
    args: wallet ? [wallet, currencyIn, UNIVERSAL_ROUTER] : undefined,
    query: { enabled: !!wallet && !inputIsNative },
  });

  const { writeContractAsync } = useWriteContract();
  const { writeContract, isBusy } = useTx(`${side} ${tokenSym}`);

  const onMax = () => {
    if (inputIsNative) {
      const reserve = 2_000_000_000_000_000n; // 0.002 ETH gas buffer (native only)
      const v = inBal > reserve ? inBal - reserve : 0n;
      setAmountStr(formatUnits(v, inDec));
    } else {
      setAmountStr(formatUnits(inBal, inDec));
    }
  };

  async function onSwap() {
    if (!isConnected || !wallet || !publicClient || amountIn === 0n) return;
    try {
      // ERC-20 input → ensure Permit2 path (skip entirely for native ETH buy).
      if (!inputIsNative) {
        if (erc20Allow < amountIn) {
          setStage("approve-token");
          const h = await writeContractAsync({
            address: currencyIn, abi: ERC20_MIN_ABI, functionName: "approve",
            args: [PERMIT2, maxUint256],
          });
          await publicClient.waitForTransactionReceipt({ hash: h });
          await refetchErc20Allow();
        }
        const now = Math.floor(Date.now() / 1000);
        const p2 = permit2Allow as unknown as [bigint, number, number] | undefined;
        const p2Amt = p2?.[0] ?? 0n;
        const p2Exp = p2?.[1] ?? 0;
        if (p2Amt < amountIn || p2Exp < now + 600) {
          setStage("approve-permit2");
          const expiry = now + 60 * 60 * 24 * 30; // 30 days
          const h = await writeContractAsync({
            address: PERMIT2, abi: permit2Abi, functionName: "approve",
            args: [currencyIn, UNIVERSAL_ROUTER, UINT160_MAX, expiry],
          });
          await publicClient.waitForTransactionReceipt({ hash: h });
          await refetchPermit2();
        }
      }
      setStage("idle");

      const { commands, inputs } = buildV4ExactInCall(poolKey, zeroForOne, amountIn, minOut);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      writeContract({
        address: UNIVERSAL_ROUTER, abi: universalRouterAbi, functionName: "execute",
        args: [commands, inputs, deadline],
        value: inputIsNative ? amountIn : 0n,
      });
      setAmountStr("");
      refetchInBal();
    } catch (err) {
      setStage("idle");
      toast({ kind: "error", title: `${side} failed`, message: extractRevertReason(err), ttlMs: 8000 });
    }
  }

  const feasible = amountIn > 0n && amountIn <= inBal;
  const busy = isBusy || stage !== "idle";
  const label = stage === "approve-token"
    ? `approve ${inSym}…`
    : stage === "approve-permit2"
      ? "approve Permit2…"
      : isBusy
        ? "submitting…"
        : !isConnected
          ? "connect wallet"
          : amountIn === 0n
            ? "enter amount"
            : amountIn > inBal
              ? `insufficient ${inSym}`
              : `${side} ${tokenSym}`;

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* Buy / Sell toggle */}
      <div className="flex gap-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setSide(s); setAmountStr(""); }}
            className={`flex-1 py-2 rounded border text-xs font-medium transition-colors ${
              side === s
                ? s === "sell"
                  ? "bg-danger/20 border-danger text-danger"
                  : "bg-long/20 border-long text-long"
                : "bg-bg border-border text-muted hover:border-muted"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Amount in */}
      <div>
        <div className="flex justify-between mb-1">
          <span className="text-muted">{side === "buy" ? "pay" : "sell"} ({inSym})</span>
          {wallet && (
            <button onClick={onMax} className="text-accent hover:underline">
              max: {fmtAmount(inBal, inDec, 4)}
            </button>
          )}
        </div>
        <input
          type="number"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          step="0.0001" min="0" placeholder="0.0"
          className="w-full bg-bg border border-border rounded px-2 py-2 text-sm focus:border-accent"
        />
      </div>

      {/* Receive (min) */}
      <div className="bg-bg border border-border rounded p-2 space-y-1">
        <Row label="receive (min)">
          <span className="text-text">
            {quotedOut > 0n ? `${fmtAmount(minOut, outDec, 4)} ${outSym}` : "—"}
          </span>
        </Row>
        <Row label="est. out">
          <span className="text-muted">
            {quotedOut > 0n ? `${fmtAmount(quotedOut, outDec, 4)} ${outSym}` : "—"}
          </span>
        </Row>
        <Row label="LP fee">
          <span className="text-danger">1%</span>
        </Row>
      </div>

      <SlippageControl value={slippagePct} onChange={setSlippagePct} defaultValue={DEFAULT_SLIPPAGE_PCT} />

      {!isConnected ? (
        <div className="text-center py-2 text-muted text-xs">connect wallet to trade</div>
      ) : (
        <button
          onClick={onSwap}
          disabled={!feasible || busy}
          className={`py-3 rounded font-medium text-sm transition-colors ${
            feasible && !busy
              ? side === "sell"
                ? "bg-danger text-bg hover:bg-danger/90"
                : "bg-long text-bg hover:bg-long/90"
              : "bg-border text-muted cursor-not-allowed"
          }`}
        >
          {label}
        </button>
      )}

      <div className="text-center text-[10px] text-muted">
        spot swap · Uniswap v4 · 1% LP fees
      </div>
    </div>
  );
}

function extractRevertReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/reason:\s*([^\n]+)/i) || msg.match(/reverted with reason string '([^']+)'/i);
  if (m) return m[1];
  const c = msg.match(/Error:\s*([A-Z][A-Za-z]+)\(/);
  if (c) return c[1];
  return msg.split("\n")[0].slice(0, 140);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}
