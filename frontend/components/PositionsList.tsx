"use client";

import { useState, useEffect } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useUserPositions, useClaimable, usePoolSnapshot, useUserHistory, useSymbols, type HistoryItem } from "@/lib/hooks";
import { useContracts } from "@/lib/contracts";
import { fmtAmount, tokenPriceInBase, fmtPriceCompact, toNumber } from "@/lib/format";
import { useTx } from "@/lib/useTx";
import { toast } from "@/lib/toast";
import { SlippageControl } from "./SlippageControl";

const DEFAULT_SLIPPAGE_PCT = 1;

interface PosData {
  id: bigint;
  side: "long" | "short";
  leverage: number;
  holdingTokens: number;   // human PERP (long: held tokens; short: borrowed tokens)
  debtEth: number;         // human ETH (long debt; 0 for short)
  heldEth: number;         // human ETH held (short only; 0 for long)
  collateralEth: number;
  entryPriceEth: number;
  currentPriceEth: number;
  liqPriceEth: number;
  pnlEth: number;
  pnlPct: number;
  healthPct: number;
  liquidatable: boolean;
}

type Tab = "active" | "history";

export function PositionsList() {
  const { hookAddr, hookAbi, baseDecimals } = useContracts();
  const { baseSym, tokenSym } = useSymbols();
  const { data: positions, isLoading } = useUserPositions();
  const { data: claimableAmt } = useClaimable();
  const { data: snap } = usePoolSnapshot();
  const { data: history } = useUserHistory();
  const { writeContract: writeClose, isBusy: closeBusy } = useTx("close position");
  const { writeContract: writeClaim, isBusy: claimBusy } = useTx("claim payout");
  const [closeTarget, setCloseTarget] = useState<PosData | null>(null);
  const [tab, setTab] = useState<Tab>("active");

  const currentPriceEth = snap ? tokenPriceInBase(snap.sqrtPriceX96, baseDecimals) : 0;

  const rows: PosData[] = (positions ?? []).map((p) => {
    // useUserPositions returns a normalized PositionData with side + raw fields.
    // Base-denominated fields (debt/collateral/held/realized/value) are in
    // base-RAW units → convert with baseDecimals. TOKEN amounts are fixed 18-dec.
    const openSqrtP = p.openSqrtPriceX96;
    const leverage = p.leverage;
    const realizedEth = toNumber(p.realizedETHOut, baseDecimals);
    const entryPriceEth = openSqrtP > 0n ? tokenPriceInBase(openSqrtP, baseDecimals) : 0;

    const debtEth = toNumber(p.debtETH, baseDecimals);
    const collateralEth = toNumber(p.collateralETH, baseDecimals);

    if (p.side === "short") {
      // SHORT: borrowed TOKEN was sold for heldETH. Equity = heldETH − cost to
      // buy back debt tokens at current price + realized. Liq price RISES:
      // P_liq = heldETH / (1.05 × debtTokens)  (ETH per token).
      const debtTokens = Number(p.debtTOKEN) / 1e18; // TOKEN is fixed 18-dec
      const heldEth = toNumber(p.heldETH, baseDecimals);
      const buybackEth = debtTokens * currentPriceEth;
      const liqPriceEth = debtTokens > 0 && heldEth > 0
        ? heldEth / (1.05 * debtTokens)
        : 0;
      const equityNow = heldEth - buybackEth + realizedEth;
      const pnlEth = equityNow - collateralEth;
      const pnlPct = collateralEth > 0 ? (pnlEth / collateralEth) * 100 : 0;
      return {
        id: p.id,
        side: "short" as const,
        leverage,
        holdingTokens: debtTokens, // tokens owed (display)
        debtEth,
        heldEth,
        collateralEth,
        entryPriceEth,
        currentPriceEth,
        liqPriceEth,
        pnlEth,
        pnlPct,
        healthPct: Number(p.healthBps) / 100,
        liquidatable: p.liquidatable,
      };
    }

    const holdingTokens = Number(p.holdingTOKEN) / 1e18; // TOKEN is fixed 18-dec
    const holdingValueEth = toNumber(p.currentValueEth, baseDecimals);

    // Liq price derives from CURRENT debt/holding ratio (changes with partial
    // closes), not original leverage. At liq: holding × P_liq = 1.05 × debt
    //   → P_liq = 1.05 × debt / holding   (ETH per PERP)
    const liqPriceEth = holdingTokens > 0 && debtEth > 0
      ? (1.05 * debtEth) / holdingTokens
      : 0;

    // PnL: realised payouts from prior partial closes + (value of remaining
    // holding after sell fee − remaining debt) compared against original
    // collateral.
    const estSellProceeds = holdingValueEth * (1 - 0.01); // 1% sell fee
    const equityNow = estSellProceeds - debtEth + realizedEth;
    const pnlEth = equityNow - collateralEth;
    const pnlPct = collateralEth > 0 ? (pnlEth / collateralEth) * 100 : 0;

    return {
      id: p.id,
      side: "long" as const,
      leverage,
      holdingTokens,
      debtEth,
      heldEth: 0,
      collateralEth,
      entryPriceEth,
      currentPriceEth,
      liqPriceEth,
      pnlEth,
      pnlPct,
      healthPct: Number(p.healthBps) / 100,
      liquidatable: p.liquidatable,
    };
  });

  const onClaim = () => {
    writeClaim({
      address: hookAddr,
      abi: hookAbi,
      functionName: "claim",
      args: [],
    });
  };

  // Simulate-then-submit for close: eth_call with minEthOut=0 to obtain the
  // exact returnedETH at current state, then apply user's slippage tolerance.
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const [simulatingClose, setSimulatingClose] = useState(false);
  const onRequestClose = async (id: bigint, sellBps: number, slippagePct: number) => {
    if (!publicClient || !address) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    setSimulatingClose(true);
    let expectedReturnedETH: bigint;
    try {
      const sim = await publicClient.simulateContract({
        address: hookAddr,
        abi: hookAbi,
        functionName: "close",
        args: [id, BigInt(sellBps), 0n, deadline],
        account: address,
      });
      const result = sim.result as unknown as readonly [bigint, bigint];
      expectedReturnedETH = result[0];
    } catch (err) {
      setSimulatingClose(false);
      toast({
        kind: "error",
        title: "close failed (simulation)",
        message: extractRevertReason(err),
        ttlMs: 8000,
      });
      return;
    }
    setSimulatingClose(false);

    const slipBps = BigInt(Math.round(slippagePct * 100));
    const minEthOut = (expectedReturnedETH * (10_000n - slipBps)) / 10_000n;

    writeClose({
      address: hookAddr,
      abi: hookAbi,
      functionName: "close",
      args: [id, BigInt(sellBps), minEthOut, deadline],
    });
    setCloseTarget(null);
  };

  const showClaim = claimableAmt && claimableAmt > 0n;

  if (isLoading) {
    return <div className="text-muted text-xs p-4">loading positions…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
        <div className="flex items-center gap-1">
          <TabButton active={tab === "active"} onClick={() => setTab("active")}>
            Active{rows.length > 0 ? ` (${rows.length})` : ""}
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => setTab("history")}>
            History{history && history.length > 0 ? ` (${history.length})` : ""}
          </TabButton>
        </div>
        {showClaim && (
          <button
            onClick={onClaim}
            disabled={claimBusy}
            className="px-3 py-1 bg-accent/20 border border-accent text-accent rounded text-[11px] hover:bg-accent/30 disabled:opacity-50"
          >
            {claimBusy ? "claiming…" : `claim ${fmtAmount(claimableAmt!, baseDecimals, 5)} ${baseSym}`}
          </button>
        )}
      </div>

      {tab === "history" ? (
        <HistoryView items={history ?? []} baseSym={baseSym} baseDecimals={baseDecimals} />
      ) : rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted text-xs italic">
          no open positions
        </div>
      ) : (
        <>
          {/* desktop: dense table */}
          <div className="hidden md:block flex-1 min-h-0 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-muted sticky top-0 bg-panel">
                <tr className="border-b border-border">
                  <Th>position</Th>
                  <Th align="right">entry</Th>
                  <Th align="right">current</Th>
                  <Th align="right">PnL</Th>
                  <Th align="right">liq price</Th>
                  <Th align="right">health</Th>
                  <Th>{" "}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const c = rowStyles(r, tokenSym);
                  return (
                    <tr key={String(r.id)} className="border-b border-border/50 hover:bg-bg">
                      <Td>
                        <div className="flex items-center gap-2">
                          {r.leverage > 0 && (
                            <span className="px-2 py-0.5 text-[11px] font-semibold bg-accent/15 border border-accent/40 text-accent rounded">{r.leverage}x</span>
                          )}
                          <div className="flex flex-col leading-tight">
                            <SideBadge side={r.side} />
                            <span className="text-muted text-[10px]">{c.tokens}</span>
                          </div>
                        </div>
                      </Td>
                      <Td align="right" className="text-muted tabular-nums">{r.entryPriceEth > 0 ? fmtPriceCompact(r.entryPriceEth) : "—"}</Td>
                      <Td align="right" className="text-text tabular-nums">{r.currentPriceEth > 0 ? fmtPriceCompact(r.currentPriceEth) : "—"}</Td>
                      <Td align="right">
                        <div className="flex flex-col tabular-nums">
                          <span className={c.pnlColor}>{c.pnlSign}{r.pnlEth.toFixed(5)} {baseSym}</span>
                          <span className={`text-[10px] ${c.pnlColor}`}>{c.pnlSign}{r.pnlPct.toFixed(1)}%</span>
                        </div>
                      </Td>
                      <Td align="right" className="text-danger tabular-nums">{r.liqPriceEth > 0 ? fmtPriceCompact(r.liqPriceEth) : "—"}</Td>
                      <Td align="right" className={`${c.healthColor} tabular-nums`}>{r.healthPct.toFixed(0)}%</Td>
                      <Td align="right">
                        <button onClick={() => setCloseTarget(r)} disabled={closeBusy} className="px-2.5 py-1 text-[10px] bg-border hover:bg-accent/20 hover:text-accent rounded transition-colors disabled:opacity-50">close</button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* mobile: stacked cards */}
          <div className="md:hidden flex-1 min-h-0 overflow-auto p-2 space-y-2">
            {rows.map((r) => (
              <PositionCard key={String(r.id)} r={r} baseSym={baseSym} tokenSym={tokenSym} onClose={() => setCloseTarget(r)} closeBusy={closeBusy} />
            ))}
          </div>
        </>
      )}

      {closeTarget && (
        <CloseModal
          pos={closeTarget}
          baseSym={baseSym}
          tokenSym={tokenSym}
          disabled={closeBusy || simulatingClose}
          simulating={simulatingClose}
          onClose={() => setCloseTarget(null)}
          onConfirm={(bps, slippagePct) => onRequestClose(closeTarget.id, bps, slippagePct)}
        />
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

// ─────────────────────────────────────────────────────────────────────────────
// Close modal — centered overlay with live preview of what the user receives.
// ─────────────────────────────────────────────────────────────────────────────
const PRESETS = [25, 50, 75, 100] as const;

function CloseModal({
  pos,
  baseSym,
  tokenSym,
  disabled,
  simulating,
  onClose,
  onConfirm,
}: {
  pos: PosData;
  baseSym: string;
  tokenSym: string;
  disabled: boolean;
  simulating: boolean;
  onClose: () => void;
  onConfirm: (sellBps: number, slippagePct: number) => void;
}) {
  const [pct, setPct] = useState(50);
  const [slippagePct, setSlippagePct] = useState(DEFAULT_SLIPPAGE_PCT);
  const clamp = (v: number) => Math.max(1, Math.min(100, Math.floor(v) || 0));

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !disabled) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, disabled]);

  const isShort = pos.side === "short";

  // Preview math. LONG (debt-first): sell X% holding → proceeds → pay debt →
  // surplus. SHORT: buy back X% of the borrowed TOKEN with held ETH → ETH left
  // is what you receive. Both are estimates — the simulate-then-submit path is
  // the source of truth for the actual returned ETH and minOut.
  const closeTokens = (pos.holdingTokens * pct) / 100; // long: held; short: owed
  let proceedsEth: number;
  let debtCostEth: number;
  let userReceives: number;
  let liqActual: number;
  if (isShort) {
    // short: holdingTokens = borrowed tokens owed; heldEth = ETH held. Closing
    // X% buys back X% of the owed tokens at current price and releases X% of
    // the held ETH; you receive the difference.
    const buybackEth = closeTokens * pos.currentPriceEth;
    const heldShare = (pos.heldEth * pct) / 100;
    proceedsEth = heldShare;
    debtCostEth = buybackEth;
    userReceives = Math.max(0, heldShare - buybackEth);
    const newOwed = pos.holdingTokens - closeTokens;
    const newHeld = pos.heldEth - heldShare;
    liqActual = newOwed > 0 && newHeld > 0 ? newHeld / (1.05 * newOwed) : 0;
  } else {
    proceedsEth = closeTokens * pos.currentPriceEth;
    debtCostEth = Math.min(proceedsEth, pos.debtEth);
    userReceives = Math.max(0, proceedsEth - pos.debtEth);
    const newHolding = pos.holdingTokens - closeTokens;
    const newDebt = pos.debtEth - debtCostEth;
    liqActual = newDebt > 0 && newHolding > 0 ? (1.05 * newDebt) / newHolding : 0;
  }

  const positionLabel = `${pos.leverage}x ${pos.side}`;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !disabled) onClose();
      }}
    >
      <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">Close Position</div>
            <div className="text-text font-medium">{positionLabel}</div>
          </div>
          <button
            onClick={onClose}
            disabled={disabled}
            className="text-muted hover:text-text text-xl leading-none px-2 disabled:opacity-50"
            aria-label="cancel"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Amount selector */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted">amount to close</span>
              <span className="text-text tabular-nums text-sm font-medium">{pct}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={pct}
              onChange={(e) => setPct(clamp(Number(e.target.value)))}
              className="w-full"
            />
            <div className="flex items-center gap-2 mt-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPct(p)}
                  className={`flex-1 py-1 rounded border text-[11px] ${
                    pct === p
                      ? "bg-accent/20 border-accent text-accent"
                      : "bg-bg border-border text-muted hover:border-muted"
                  }`}
                >
                  {p}%
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={100}
                value={pct}
                onChange={(e) => setPct(clamp(Number(e.target.value)))}
                className="w-16 bg-bg border border-border rounded px-2 py-1 text-xs text-right focus:border-accent"
              />
            </div>
          </div>

          {/* Preview (estimate — simulate is source of truth) */}
          <div className="bg-bg border border-border rounded-lg p-3 space-y-1.5 text-xs">
            <Row label={isShort ? "buying back" : "selling"}>
              <span className="text-text tabular-nums">{closeTokens.toFixed(2)} {tokenSym}</span>
            </Row>
            <Row label={isShort ? `held ${baseSym} released` : "est. proceeds"}>
              <span className="text-text tabular-nums">{proceedsEth.toFixed(6)} {baseSym}</span>
            </Row>
            <Row label={isShort ? "buyback cost" : "debt repaid"}>
              <span className="text-text tabular-nums">−{debtCostEth.toFixed(6)} {baseSym}</span>
            </Row>
            <div className="border-t border-border my-1" />
            <Row label="you receive (est.)">
              <span className="text-accent font-medium tabular-nums">
                {userReceives.toFixed(6)} {baseSym}
              </span>
            </Row>
            {pct < 100 && (
              <Row label="new liq price">
                <span className="text-danger tabular-nums">
                  {liqActual > 0 ? fmtPriceCompact(liqActual) : "—"}
                </span>
              </Row>
            )}
          </div>

          <SlippageControl
            value={slippagePct}
            onChange={setSlippagePct}
            defaultValue={DEFAULT_SLIPPAGE_PCT}
          />
        </div>

        <div className="px-5 py-4 border-t border-border flex items-center gap-2">
          <button
            onClick={onClose}
            disabled={disabled}
            className="px-4 py-2 rounded bg-border text-text text-sm hover:bg-border/70 disabled:opacity-50"
          >
            cancel
          </button>
          <button
            onClick={() => onConfirm(pct * 100, slippagePct)}
            disabled={disabled || pct === 0}
            className="flex-1 py-2 rounded bg-accent text-bg font-medium text-sm hover:bg-accent/90 disabled:bg-border disabled:text-muted"
          >
            {simulating ? "simulating…" : disabled ? "submitting…" : `close ${pct}%`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}

function SideBadge({ side }: { side: "long" | "short" }) {
  return (
    <span className={side === "short" ? "text-danger" : "text-long"}>
      {side}
    </span>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`text-${align} font-normal py-2 px-3 text-[10px] uppercase tracking-wider`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return <td className={`text-${align} py-2 px-3 ${className}`}>{children}</td>;
}

// ─── Tab button ─────────────────────────────────────────────────────────────
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
        active
          ? "bg-bg text-text"
          : "text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

// ─── History view ───────────────────────────────────────────────────────────
function HistoryView({ items, baseSym, baseDecimals }: { items: HistoryItem[]; baseSym: string; baseDecimals: number }) {
  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-xs italic">
        no past trades
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-xs">
        <thead className="text-muted sticky top-0 bg-panel">
          <tr className="border-b border-border">
            <Th>outcome</Th>
            <Th>position</Th>
            <Th align="right">collateral</Th>
            <Th align="right">payout</Th>
            <Th align="right">PnL</Th>
            <Th align="right">when</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((h, idx) => {
            const collateralEth = toNumber(h.collateralETH, baseDecimals);
            const amountOutEth = toNumber(h.amountOut, baseDecimals);
            const pnlEth = toNumber(h.pnlETH, baseDecimals);
            const pnlPct = collateralEth > 0 ? (pnlEth / collateralEth) * 100 : 0;
            const pnlColor =
              pnlEth > 0 ? "text-accent" :
              pnlEth < 0 ? "text-danger" :
              "text-muted";
            const pnlSign = pnlEth > 0 ? "+" : "";
            const when = formatRelativeTime(Number(h.timestamp));
            const tone =
              h.type === "close"
                ? "bg-text/10 border border-text/30 text-text"
                : "bg-danger/15 border border-danger/40 text-danger";

            return (
              <tr key={`${h.positionId}-${idx}`} className="border-b border-border/50 hover:bg-bg">
                <Td>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded ${tone}`}>
                    <span className={`px-1 py-px text-[9px] rounded ${h.side === "short" ? "bg-danger/20 text-danger" : "bg-long/20 text-long"}`}>
                      {h.leverage}x {h.side}
                    </span>
                    {h.type === "close" ? "CLOSED" : "LIQUIDATED"}
                  </span>
                </Td>
                <Td className="text-muted">#{Number(h.positionId)}</Td>
                <Td align="right" className="tabular-nums text-muted">
                  {collateralEth.toFixed(5)} {baseSym}
                </Td>
                <Td align="right" className="tabular-nums text-text">
                  {amountOutEth.toFixed(5)} {baseSym}
                </Td>
                <Td align="right">
                  <div className="flex flex-col leading-tight tabular-nums">
                    <span className={pnlColor}>
                      {pnlSign}{pnlEth.toFixed(5)} {baseSym}
                    </span>
                    <span className={`text-[10px] ${pnlColor}`}>
                      {pnlSign}{pnlPct.toFixed(1)}%
                    </span>
                  </div>
                </Td>
                <Td align="right" className="text-muted text-[10px]">{when}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatRelativeTime(unixSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = now - unixSec;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

// ─── Shared row styling + the mobile position card ──────────────────────────
function rowStyles(r: PosData, tokenSym: string) {
  const healthColor =
    r.healthPct >= 200 ? "text-accent" :
    r.healthPct >= 130 ? "text-text" :
    r.healthPct >= 110 ? "text-warn" :
    "text-danger";
  const pnlColor = r.pnlEth > 0 ? "text-accent" : r.pnlEth < 0 ? "text-danger" : "text-muted";
  const pnlSign = r.pnlEth > 0 ? "+" : "";
  const tokens = r.holdingTokens >= 1000
    ? `${(r.holdingTokens / 1000).toFixed(2)}K ${tokenSym}`
    : `${r.holdingTokens.toFixed(2)} ${tokenSym}`;
  return { healthColor, pnlColor, pnlSign, tokens };
}

function CardStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-muted text-[9px] uppercase tracking-wider">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

function PositionCard({ r, baseSym, tokenSym, onClose, closeBusy }: { r: PosData; baseSym: string; tokenSym: string; onClose: () => void; closeBusy: boolean }) {
  const c = rowStyles(r, tokenSym);
  return (
    <div className="bg-bg border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {r.leverage > 0 && (
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-accent/15 border border-accent/40 text-accent rounded shrink-0">{r.leverage}x</span>
          )}
          <span className={`text-sm ${r.side === "short" ? "text-danger" : "text-long"}`}>{r.side}</span>
          <span className="text-muted text-[11px] truncate">{c.tokens}</span>
        </div>
        <button
          onClick={onClose}
          disabled={closeBusy}
          className="px-3 py-1.5 text-xs bg-border hover:bg-accent/20 hover:text-accent rounded transition-colors disabled:opacity-50 shrink-0"
        >
          close
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <CardStat label="PnL">
          <span className={c.pnlColor}>
            {c.pnlSign}{r.pnlEth.toFixed(5)} {baseSym} <span className="text-[10px]">({c.pnlSign}{r.pnlPct.toFixed(1)}%)</span>
          </span>
        </CardStat>
        <CardStat label="health"><span className={c.healthColor}>{r.healthPct.toFixed(0)}%</span></CardStat>
        <CardStat label="entry"><span className="text-muted">{r.entryPriceEth > 0 ? fmtPriceCompact(r.entryPriceEth) : "—"}</span></CardStat>
        <CardStat label="liq price"><span className="text-danger">{r.liqPriceEth > 0 ? fmtPriceCompact(r.liqPriceEth) : "—"}</span></CardStat>
        <CardStat label="current"><span className="text-text">{r.currentPriceEth > 0 ? fmtPriceCompact(r.currentPriceEth) : "—"}</span></CardStat>
      </div>
    </div>
  );
}
