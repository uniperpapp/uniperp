"use client";

import { useState, useMemo, useEffect } from "react";
import { useAccount, useBalance, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { useOpenQuote, usePoolSnapshot } from "@/lib/hooks";
import { useContracts } from "@/lib/contracts";
import { fmtAmount, tokenPriceInBase, fmtPriceCompact, toNumber } from "@/lib/format";
import { useTx } from "@/lib/useTx";
import { toast } from "@/lib/toast";
import { SlippageControl } from "./SlippageControl";

const DEFAULT_SLIPPAGE_PCT = 1;

type Dir = "long" | "short";

// Tiny ERC-20 surface for launch-instance allowance + approve writes and the
// universal symbol() read. The launchpad treats every whitelisted base as a
// generic ERC-20, so adding new bases later requires zero frontend changes
// beyond the (admin-curated) factory whitelist.
const ERC20_MIN_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view",
    inputs: [], outputs: [{ type: "string" }] },
] as const;

export function TradePanel() {
  const { hookAddr, hookAbi, version, baseAddr, baseDecimals } = useContracts();
  const isLaunch = version === "launch";

  const { tokenAddr } = useContracts();

  // Universal base + launched-token symbols — read straight from the ERC-20
  // `symbol()` view. Any future whitelisted base (USDC, WBTC, etc.) just
  // works; no frontend hardcoding needed.
  const { data: baseSymRaw } = useReadContract({
    address: baseAddr,
    abi: ERC20_MIN_ABI,
    functionName: "symbol",
    query: { enabled: isLaunch, staleTime: 5 * 60_000 },
  });
  const { data: tokenSymRaw } = useReadContract({
    address: tokenAddr,
    abi: ERC20_MIN_ABI,
    functionName: "symbol",
    query: { enabled: isLaunch, staleTime: 5 * 60_000 },
  });
  const baseSym  = isLaunch ? (baseSymRaw  as string | undefined) ?? "BASE"  : "ETH";
  const tokenSym = isLaunch ? (tokenSymRaw as string | undefined) ?? "token" : "PERP";

  // v2 + perpfactory (launch) cap leverage at 3 (MAX_LEVERAGE=3); v1 allows 5.
  const leverageOptions = version === "v1" ? [2, 3, 4, 5] : [2, 3];
  const maxLeverage = leverageOptions[leverageOptions.length - 1];
  const [collateralStr, setCollateralStr] = useState("0.02");
  const [leverage, setLeverage] = useState(maxLeverage);
  const [slippagePct, setSlippagePct] = useState(DEFAULT_SLIPPAGE_PCT);
  const [dir, setDir] = useState<Dir>("long");

  // v1 has no shorts — force long if a stale short state survives a remount.
  useEffect(() => {
    if (version === "v1" && dir !== "long") setDir("long");
  }, [version, dir]);
  // Keep leverage within the active version's cap.
  useEffect(() => {
    if (leverage > maxLeverage) setLeverage(maxLeverage);
  }, [leverage, maxLeverage]);
  const isShort = version !== "v1" && dir === "short";

  const { address, isConnected } = useAccount();
  // For launch instances read the base ERC-20 balance; otherwise native ETH.
  const { data: ethBal } = useBalance({
    address,
    token: isLaunch ? baseAddr : undefined,
    query: { enabled: !!address },
  });
  // Launch instances need an approve(hook, collateral) before each open.
  // Read current allowance so we can short-circuit if it's already enough.
  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    address: baseAddr,
    abi: ERC20_MIN_ABI,
    functionName: "allowance",
    args: address ? [address, hookAddr] : undefined,
    query: { enabled: isLaunch && !!address },
  });
  const allowance: bigint = (allowanceRaw as bigint | undefined) ?? 0n;
  const { writeContractAsync } = useWriteContract();
  const { data: snap } = usePoolSnapshot();
  const publicClient = usePublicClient();
  const [simulating, setSimulating] = useState(false);

  const collateralWei = useMemo(() => {
    try { return parseUnits(collateralStr || "0", baseDecimals); } catch { return 0n; }
  }, [collateralStr, baseDecimals]);

  const quote = useOpenQuote(collateralWei, leverage);
  const { writeContract, isBusy } = useTx(`open ${leverage}x ${dir}`);

  const onMax = () => {
    if (!ethBal?.value) return;
    // Native-ETH base (v1/v2) must keep a gas buffer; an ERC-20 base pays gas in
    // ETH, so the full base balance is spendable.
    const reserve = isLaunch ? 0n : 5_000_000_000_000_000n; // 0.005 ETH
    const max = ethBal.value > reserve ? ethBal.value - reserve : 0n;
    setCollateralStr(formatUnits(max, baseDecimals));
  };

  // Industry-standard simulate-then-submit:
  //   1. eth_call openLong/openShort with min-out=0 to obtain the exact output
  //      the swap would produce at the *current* block.
  //   2. Apply the user's slippage tolerance to that real value.
  //   3. Submit the actual tx with the resulting min-out.
  //
  // For launch instances the openLong signature is non-payable + 4-arg
  //   `(leverage, collateral, minOut, deadline)` and the hook pulls collateral
  //   via transferFrom — so we first ensure allowance ≥ collateral (one-time
  //   max approval), then simulate + submit without `value`.
  // For v1/v2 the existing payable 3-arg path is unchanged.
  const onOpen = async () => {
    if (!collateralWei || collateralWei === 0n) return;
    if (!publicClient || !address) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min
    const fn = isShort ? "openShort" : "openLong";

    // (1) Launch instances: ensure ERC-20 allowance before simulating.
    if (isLaunch) {
      if (allowance < collateralWei) {
        setSimulating(true);
        try {
          const ah = await writeContractAsync({
            address: baseAddr,
            abi: ERC20_MIN_ABI,
            functionName: "approve",
            args: [hookAddr, (1n << 256n) - 1n], // max — one-time, future trades reuse it
          });
          await publicClient.waitForTransactionReceipt({ hash: ah });
          await refetchAllowance();
        } catch (err) {
          setSimulating(false);
          toast({
            kind: "error",
            title: `approve ${baseSym} failed`,
            message: extractRevertReason(err),
            ttlMs: 8000,
          });
          return;
        }
        setSimulating(false);
      }
    }

    setSimulating(true);
    let expectedOut: bigint;
    try {
      const sim = await publicClient.simulateContract({
        address: hookAddr,
        abi: hookAbi,
        functionName: fn,
        // launch: 4-arg non-payable `(leverage, collateral, minOut, deadline)`
        // v1/v2: 3-arg payable `(leverage, minOut, deadline)` with value
        args: isLaunch
          ? [BigInt(leverage), collateralWei, 0n, deadline]
          : [BigInt(leverage), 0n, deadline],
        value: isLaunch ? undefined : collateralWei,
        account: address,
      });
      // openLong → [positionId, holdingOut]; openShort → [positionId, heldEthOut]
      const result = sim.result as unknown as readonly [bigint, bigint];
      expectedOut = result[1];
    } catch (err) {
      setSimulating(false);
      toast({
        kind: "error",
        title: `open ${leverage}x ${dir} failed (simulation)`,
        message: extractRevertReason(err),
        ttlMs: 8000,
      });
      return;
    }
    setSimulating(false);

    const slipBps = BigInt(Math.round(slippagePct * 100));
    const minOut = (expectedOut * (10_000n - slipBps)) / 10_000n;

    writeContract({
      address: hookAddr,
      abi: hookAbi,
      functionName: fn,
      args: isLaunch
        ? [BigInt(leverage), collateralWei, minOut, deadline]
        : [BigInt(leverage), minOut, deadline],
      value: isLaunch ? undefined : collateralWei,
    });
  };

  const feasible = quote.ready && collateralWei > 0n;
  const borrowEth = toNumber(quote.borrowEth, baseDecimals);
  const fee = toNumber(quote.borrowFee, baseDecimals);

  const currentPriceEth = snap ? tokenPriceInBase(snap.sqrtPriceX96, baseDecimals) : 0;

  // LONG liq price falls: P_liq = P × 1.05 × (L-1)/L  (5x → −16%).
  // SHORT liq price rises: as price climbs the borrowed TOKEN debt outgrows
  // the held ETH. Approximate symmetric mirror P_liq ≈ P × (1 + 1.05/L);
  // the simulate is the source of truth for fills, this is just a hint.
  let liqPriceEth = 0;
  let liqMovePct = 0;
  if (isShort) {
    // SHORT liq price rises: heldETH≈L·C, debt entry value≈(L-1)·C, liquidates
    // at health 1.05 → price × L/(1.05·(L-1)). 2x → ×1.905 (+90%), mirror of
    // 2x long's −47.5%.
    const factor = leverage > 1 ? leverage / (1.05 * (leverage - 1)) : 0;
    liqPriceEth = currentPriceEth * factor;
    liqMovePct = (factor - 1) * 100;
  } else {
    const factor = leverage >= 2 ? 1.05 * (leverage - 1) / leverage : 0;
    liqPriceEth = currentPriceEth * factor;
    liqMovePct = (1 - factor) * 100;
  }

  // Estimated exposure: (collateral + borrow) / current_price tokens.
  const totalSpend = toNumber(collateralWei, baseDecimals) * leverage;
  const estPositionTokens = currentPriceEth > 0 ? totalSpend / currentPriceEth : 0;

  return (
    <div className="flex flex-col gap-3 text-xs">
      {version !== "v1" && (
        <div className="flex gap-1">
          {(["long", "short"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDir(d)}
              className={`flex-1 py-2 rounded border text-xs font-medium transition-colors ${
                dir === d
                  ? d === "short"
                    ? "bg-danger/20 border-danger text-danger"
                    : "bg-long/20 border-long text-long"
                  : "bg-bg border-border text-muted hover:border-muted"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      <div className={`text-sm font-medium ${isShort ? "text-danger" : "text-long"}`}>
        Open {isShort ? "Short" : "Long"}
      </div>

      <div>
        <div className="flex justify-between mb-1">
          <span className="text-muted">collateral ({baseSym})</span>
          {ethBal && (
            <button onClick={onMax} className="text-accent hover:underline">
              max: {fmtAmount(ethBal.value, baseDecimals, 3)}
            </button>
          )}
        </div>
        <input
          type="number"
          value={collateralStr}
          onChange={(e) => setCollateralStr(e.target.value)}
          step="0.001"
          min="0"
          placeholder="0.0"
          className="w-full bg-bg border border-border rounded px-2 py-2 text-sm focus:border-accent"
        />
      </div>

      <div>
        <div className="flex justify-between mb-1">
          <span className="text-muted">leverage</span>
          <span className="text-text">{leverage}x</span>
        </div>
        <div className="flex gap-1">
          {leverageOptions.map((lev) => (
            <button
              key={lev}
              onClick={() => setLeverage(lev)}
              className={`flex-1 py-2 rounded border text-xs font-medium transition-colors ${
                leverage === lev
                  ? "bg-accent/20 border-accent text-accent"
                  : "bg-bg border-border text-muted hover:border-muted"
              }`}
            >
              {lev}x
            </button>
          ))}
        </div>
      </div>

      {/* Outcome preview — labels use the live base + token symbols so adding
          any future whitelisted base (USDC, WBTC, …) just works. */}
      <div className="bg-bg border border-border rounded p-2 space-y-1">
        <Row label="position size">
          <span className="text-text">
            {estPositionTokens > 0 ? `${estPositionTokens.toFixed(1)} ${tokenSym}` : "—"}
          </span>
        </Row>
        <Row label="entry price">
          <span className="text-text tabular-nums">
            {currentPriceEth > 0 ? `${fmtPriceCompact(currentPriceEth)} ${baseSym}` : "—"}
          </span>
        </Row>
        <Row label="liquidation price">
          <span className="text-warn tabular-nums">
            {liqPriceEth > 0
              ? `${fmtPriceCompact(liqPriceEth)} ${baseSym} (${isShort ? "+" : "−"}${liqMovePct.toFixed(0)}%)`
              : "—"}
          </span>
        </Row>
        <Row label={isShort ? `borrowed (sold for ${baseSym})` : "borrowed"}>
          <span className="text-text">
            {borrowEth > 0 ? `${borrowEth.toFixed(4)} ${baseSym}` : "—"}
          </span>
        </Row>
        {/* Launchpad instances have no staking — fees accrue to the protocol
            fee wallet (FEE_RECIPIENT). v2's $PERP still routes to stakers. */}
        <Row label={isLaunch ? "borrow fee" : "borrow fee → stakers"}>
          <span className="text-danger">
            −{fee > 0 ? `${fee.toFixed(5)} ${baseSym}` : "0"}
          </span>
        </Row>
      </div>

      <SlippageControl value={slippagePct} onChange={setSlippagePct} defaultValue={DEFAULT_SLIPPAGE_PCT} />

      {/* Open button */}
      {!isConnected ? (
        <div className="text-center py-2 text-muted text-xs">connect wallet to trade</div>
      ) : (
        <button
          onClick={onOpen}
          disabled={!feasible || isBusy || simulating}
          className={`py-3 rounded font-medium text-sm transition-colors ${
            feasible && !isBusy && !simulating
              ? isShort
                ? "bg-danger text-bg hover:bg-danger/90"
                : "bg-long text-bg hover:bg-long/90"
              : "bg-border text-muted cursor-not-allowed"
          }`}
        >
          {simulating
            ? "simulating…"
            : isBusy
              ? "submitting…"
              : !feasible
                ? "enter collateral"
                : `open ${leverage}x ${dir}`}
        </button>
      )}
    </div>
  );
}

// Pulls a useful one-line reason out of viem's verbose revert errors.
function extractRevertReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const reasonMatch = msg.match(/reason:\s*([^\n]+)/i) || msg.match(/reverted with reason string '([^']+)'/i);
  if (reasonMatch) return reasonMatch[1];
  const customNameMatch = msg.match(/Error:\s*([A-Z][A-Za-z]+)\(/);
  if (customNameMatch) return customNameMatch[1];
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
