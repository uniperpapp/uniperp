"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { parseEther, formatEther } from "viem";

import { useContracts } from "@/lib/contracts";
import { useSymbols } from "@/lib/hooks";
import { PERP_ADDRESS, WETH_ADDRESS } from "@/lib/config";
import { fmtEth } from "@/lib/format";
import { useTx } from "@/lib/useTx";

// Minimal canonical-WETH9 surface for the wrap/unwrap panel.
const WETH_ABI = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

/// "Get base token" helper shown below the trade panel on a launch page.
/// Routes by base asset:
///   PERP  → link to the in-house $PERP page (buy PERP there)
///   WETH  → inline ETH↔WETH wrap/unwrap
///   other → external Uniswap swap deep-link for that base token
export function GetBaseToken() {
  const { baseAddr } = useContracts();
  const { baseSym } = useSymbols();
  const base = baseAddr.toLowerCase();

  if (base === ZERO) return null; // native-ETH base (v2) — nothing to acquire

  if (base === PERP_ADDRESS.toLowerCase()) {
    return (
      <Card title={`Need ${baseSym}?`}>
        <Link
          href="/perp"
          className="block text-center py-2 rounded border border-accent/60 bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors"
        >
          Get {baseSym} on Uniperp →
        </Link>
      </Card>
    );
  }

  if (base === WETH_ADDRESS.toLowerCase()) {
    return <WrapPanel baseSym={baseSym} />;
  }

  return (
    <Card title={`Need ${baseSym}?`}>
      <a
        href={`https://app.uniswap.org/swap?outputCurrency=${baseAddr}&chain=mainnet`}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-center py-2 rounded border border-accent/60 bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors"
      >
        Get {baseSym} on Uniswap ↗
      </a>
    </Card>
  );
}

function WrapPanel({ baseSym }: { baseSym: string }) {
  const { address: wallet, isConnected } = useAccount();
  const [mode, setMode] = useState<"wrap" | "unwrap">("wrap");
  const [amountStr, setAmountStr] = useState("");

  const { data: ethBal } = useBalance({ address: wallet, query: { enabled: !!wallet } });
  const { data: wethBalRaw, refetch } = useReadContract({
    address: WETH_ADDRESS, abi: WETH_ABI, functionName: "balanceOf",
    args: wallet ? [wallet] : undefined,
    query: { enabled: !!wallet, refetchInterval: 8_000 },
  });
  const wethBal = (wethBalRaw as bigint | undefined) ?? 0n;
  const inBal = mode === "wrap" ? (ethBal?.value ?? 0n) : wethBal;
  const inSym = mode === "wrap" ? "ETH" : baseSym;

  const amount = useMemo(() => {
    if (!amountStr || Number(amountStr) <= 0) return 0n;
    try { return parseEther(amountStr); } catch { return 0n; }
  }, [amountStr]);

  const { writeContract, isBusy } = useTx(mode === "wrap" ? `wrap ETH → ${baseSym}` : `unwrap ${baseSym} → ETH`);

  const onMax = () => {
    if (mode === "wrap") {
      const reserve = parseEther("0.002"); // leave gas
      setAmountStr(formatEther(inBal > reserve ? inBal - reserve : 0n));
    } else {
      setAmountStr(formatEther(inBal));
    }
  };

  const onSubmit = () => {
    if (amount === 0n) return;
    if (mode === "wrap") {
      writeContract({ address: WETH_ADDRESS, abi: WETH_ABI, functionName: "deposit", value: amount });
    } else {
      writeContract({ address: WETH_ADDRESS, abi: WETH_ABI, functionName: "withdraw", args: [amount] });
    }
    setAmountStr("");
    setTimeout(() => refetch(), 4000);
  };

  const feasible = amount > 0n && amount <= inBal;
  const label = !isConnected ? "connect wallet"
    : amount === 0n ? "enter amount"
    : amount > inBal ? `insufficient ${inSym}`
    : isBusy ? "submitting…"
    : mode === "wrap" ? `wrap to ${baseSym}` : `unwrap to ETH`;

  return (
    <Card title={`Get ${baseSym}`}>
      <div className="flex flex-col gap-2 text-xs">
        <div className="flex gap-1">
          {(["wrap", "unwrap"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setAmountStr(""); }}
              className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
                mode === m
                  ? "bg-accent/20 border-accent text-accent"
                  : "bg-bg border-border text-muted hover:border-muted"
              }`}
            >
              {m === "wrap" ? "ETH → WETH" : "WETH → ETH"}
            </button>
          ))}
        </div>

        <div>
          <div className="flex justify-between mb-1">
            <span className="text-muted">pay ({inSym})</span>
            {wallet && (
              <button onClick={onMax} className="text-accent hover:underline">
                max: {fmtEth(inBal, 4)}
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

        {isConnected && (
          <button
            onClick={onSubmit}
            disabled={!feasible || isBusy}
            className={`py-2 rounded font-medium text-xs transition-colors ${
              feasible && !isBusy
                ? "bg-accent text-bg hover:bg-accent/90"
                : "bg-border text-muted cursor-not-allowed"
            }`}
          >
            {label}
          </button>
        )}
        <div className="text-center text-[10px] text-muted">1 ETH = 1 {baseSym} · no fee</div>
      </div>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-border rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">{title}</div>
      {children}
    </div>
  );
}
