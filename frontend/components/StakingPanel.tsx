"use client";

import { useState, useMemo } from "react";
import { useAccount } from "wagmi";
import { parseEther } from "viem";
import {
  useStakedBalance,
  useStakingPending,
  useTotalStaked,
  useTokenBalance,
  useTokenAllowance,
} from "@/lib/hooks";
import { useContracts } from "@/lib/contracts";
import { fmtEth, fmtTokens } from "@/lib/format";
import { useTx } from "@/lib/useTx";

export function StakingPanel() {
  const [amountStr, setAmountStr] = useState("");
  const [mode, setMode] = useState<"stake" | "unstake">("stake");

  const { stakingAddr, stakingAbi, tokenAddr, tokenAbi } = useContracts();
  const { address, isConnected } = useAccount();
  const { data: stakedBal } = useStakedBalance();
  const { data: pending } = useStakingPending();
  const { data: totalStaked } = useTotalStaked();
  const { data: tokenBal } = useTokenBalance(address);
  const { data: allowance } = useTokenAllowance(stakingAddr);
  const { writeContract: writeApprove, isBusy: approveBusy } = useTx("approve PERP");
  const { writeContract: writeStake, isBusy: stakeBusy } = useTx(mode === "stake" ? "stake PERP" : "unstake PERP");
  const { writeContract: writeClaim, isBusy: claimBusy } = useTx("claim staking rewards");
  const isPending = approveBusy || stakeBusy || claimBusy;

  const amountWei = useMemo(() => {
    try { return parseEther(amountStr || "0"); } catch { return 0n; }
  }, [amountStr]);

  const needsApproval = mode === "stake"
    && amountWei > 0n
    && (allowance ?? 0n) < amountWei;

  const onMax = () => {
    if (mode === "stake" && tokenBal) {
      setAmountStr((Number(tokenBal) / 1e18).toFixed(4));
    } else if (mode === "unstake" && stakedBal) {
      setAmountStr((Number(stakedBal) / 1e18).toFixed(4));
    }
  };

  const onApprove = () => {
    writeApprove({
      address: tokenAddr,
      abi: tokenAbi,
      functionName: "approve",
      args: [stakingAddr, 2n ** 256n - 1n],
    });
  };

  const onSubmit = () => {
    if (amountWei === 0n) return;
    writeStake({
      address: stakingAddr,
      abi: stakingAbi,
      functionName: mode,
      args: [amountWei],
    });
    setAmountStr("");
  };

  const onClaim = () => {
    writeClaim({
      address: stakingAddr,
      abi: stakingAbi,
      functionName: "claim",
      args: [],
    });
  };

  const showClaim = pending && pending > 0n;

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="text-accent text-sm font-medium">Stake PERP</div>

      {/* Stats row */}
      <div className="bg-bg border border-border rounded p-2 space-y-1">
        <Row label="your stake">
          <span className="text-text">
            {stakedBal ? fmtTokens(stakedBal) : "0"} PERP
          </span>
        </Row>
        <Row label="pending rewards">
          <span className="text-accent">
            {pending ? fmtEth(pending, 5) : "0"} ETH
          </span>
        </Row>
        <Row label="total staked">
          <span className="text-muted">
            {totalStaked ? fmtTokens(totalStaked) : "0"} PERP
          </span>
        </Row>
      </div>

      {/* Claim */}
      {showClaim ? (
        <button
          onClick={onClaim}
          disabled={isPending}
          className="py-2 rounded font-medium text-xs bg-accent/20 border border-accent text-accent hover:bg-accent/30 transition-colors"
        >
          claim {fmtEth(pending!, 5)} ETH
        </button>
      ) : null}

      {/* Mode toggle */}
      <div className="flex gap-1">
        {(["stake", "unstake"] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setAmountStr(""); }}
            className={`flex-1 py-1.5 rounded border text-xs font-medium transition-colors ${
              mode === m
                ? "bg-accent/20 border-accent text-accent"
                : "bg-bg border-border text-muted hover:border-muted"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Amount input */}
      <div>
        <div className="flex justify-between mb-1">
          <span className="text-muted">amount (PERP)</span>
          <button onClick={onMax} className="text-accent hover:underline">
            max:{" "}
            {mode === "stake"
              ? tokenBal ? fmtTokens(tokenBal, 2) : "0"
              : stakedBal ? fmtTokens(stakedBal, 2) : "0"}
          </button>
        </div>
        <input
          type="number"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          step="any"
          min="0"
          placeholder="0.0"
          className="w-full bg-bg border border-border rounded px-2 py-2 text-sm focus:border-accent"
        />
      </div>

      {/* Submit */}
      {!isConnected ? (
        <div className="text-center py-2 text-muted text-xs">connect wallet to stake</div>
      ) : needsApproval ? (
        <button
          onClick={onApprove}
          disabled={isPending}
          className="py-3 rounded font-medium text-sm bg-accent text-bg hover:bg-accent/90 disabled:bg-border disabled:text-muted"
        >
          {isPending ? "approving…" : "approve PERP"}
        </button>
      ) : (
        <button
          onClick={onSubmit}
          disabled={isPending || amountWei === 0n}
          className={`py-3 rounded font-medium text-sm transition-colors ${
            !isPending && amountWei > 0n
              ? "bg-accent text-bg hover:bg-accent/90"
              : "bg-border text-muted cursor-not-allowed"
          }`}
        >
          {isPending ? "confirming…" : mode}
        </button>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}
