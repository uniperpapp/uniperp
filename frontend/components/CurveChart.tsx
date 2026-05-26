"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import { useUserPositions, usePoolSnapshot } from "@/lib/hooks";
import { useContracts } from "@/lib/contracts";
import { tokenPriceInBase, fmtPriceCompact, toNumber } from "@/lib/format";

const SYMBOL_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// ─── Bonding curve math (matches src/library/LDF.sol) ────────────────────────
// ETH/TOKEN = (V + eth)² / K_HUMAN — V/K_HUMAN come from the active contract set.
const LIQ_HEALTH = 1.05;

const fmtPrice = fmtPriceCompact;

export function CurveChart() {
  const { curve, tokenAddr, baseAddr, version, baseDecimals } = useContracts();
  const { V: V_ETH, KHuman: K_HUMAN } = curve;
  const { data: snap } = usePoolSnapshot();
  const { data: userPositions } = useUserPositions();

  // Symbol-aware labels: launch instances trade against an ERC-20 base (PERP/
  // WETH) — not native ETH. Read both symbols so the chart denominates in the
  // real base + token instead of hardcoded "ETH"/"PERP".
  const isLaunch = version === "launch";
  const { data: baseSymRaw } = useReadContract({
    address: baseAddr, abi: SYMBOL_ABI, functionName: "symbol",
    query: { enabled: isLaunch && baseAddr.toLowerCase() !== ZERO_ADDR, staleTime: 5 * 60_000 },
  });
  const { data: tokenSymRaw } = useReadContract({
    address: tokenAddr, abi: SYMBOL_ABI, functionName: "symbol",
    query: { enabled: isLaunch, staleTime: 5 * 60_000 },
  });
  const baseSym  = isLaunch ? ((baseSymRaw  as string | undefined) ?? "base")  : "ETH";
  const tokenSym = isLaunch ? ((tokenSymRaw as string | undefined) ?? "token") : "PERP";

  function priceAt(eth: number): number {
    return ((V_ETH + eth) ** 2) / K_HUMAN;
  }
  function ethAtPrice(price: number): number {
    return Math.max(0, Math.sqrt(price * K_HUMAN) - V_ETH);
  }
  const [hover, setHover] = useState<{ eth: number; price: number; xPx: number; yPx: number } | null>(null);
  const [hoveredPosId, setHoveredPosId] = useState<number | null>(null);

  // Container measurement so SVG renders at actual pixel dimensions
  // (no stretched text / hairline distortions).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 400 });
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: Math.max(320, width), h: Math.max(220, height) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // curveEth (cumulativeEthInPool) is in base-RAW units → use baseDecimals.
  const currentEth = snap ? toNumber(snap.cumulativeEthInPool, baseDecimals) : 0;
  const currentPrice = priceAt(currentEth);

  // Scale the x-range to the curve's OWN unit (V = base amount), not a fixed
  // ETH value. A high-V base (e.g. PERP, V≈13,980) would otherwise render a
  // near-flat sliver against a 0–25 axis. ~6×V covers the active early curve
  // (≈85% sold by 6×V); extend past the live pool position as it fills.
  const xMax = Math.max(V_ETH * 6, currentEth + V_ETH * 2);
  // Generous Y headroom so the topmost grid label sits clearly inside the
  // chart area (not at the top edge where it visually crashes into the header).
  const yMax = priceAt(xMax) * 1.25;

  // Sample curve
  const curvePoints = useMemo(() => {
    const N = 240;
    return Array.from({ length: N + 1 }, (_, i) => {
      const eth = (xMax * i) / N;
      return { eth, price: priceAt(eth) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xMax, V_ETH, K_HUMAN]);

  const positionMarkers = useMemo(() => {
    if (!userPositions) return [];
    return userPositions.map((p) => {
      const openSqrtP = p.openSqrtPriceX96;
      const lev = p.leverage;
      const entryPrice = openSqrtP > 0n ? tokenPriceInBase(openSqrtP, baseDecimals) : 0;
      const entryEth = entryPrice > 0 ? ethAtPrice(entryPrice) : 0;
      // Liq price: derive from CURRENT state (handles partial closes), not from
      // leverage at open. LONG → falls (1.05·debt/holding); SHORT → rises
      // (heldETH / (1.05·debtTokens)), ETH per token.
      let liqPrice = 0;
      if (p.side === "short") {
        const debtTokens = Number(p.debtTOKEN) / 1e18; // TOKEN fixed 18-dec
        const heldEth = toNumber(p.heldETH, baseDecimals);
        liqPrice = debtTokens > 0 && heldEth > 0
          ? heldEth / (1.05 * debtTokens)
          : 0;
      } else {
        const holdingTokens = Number(p.holdingTOKEN) / 1e18; // TOKEN fixed 18-dec
        const debtEth = toNumber(p.debtETH, baseDecimals);
        liqPrice = holdingTokens > 0 && debtEth > 0
          ? (1.05 * debtEth) / holdingTokens
          : 0;
      }
      const liqEth = liqPrice > 0 ? ethAtPrice(liqPrice) : 0;
      return { id: Number(p.id), leverage: lev, entryEth, entryPrice, liqEth, liqPrice };
    }).filter((m) => m.entryPrice > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPositions, V_ETH, K_HUMAN, baseDecimals]);

  // ─── Layout ──────────────────────────────────────────────────────────────
  const { w: W, h: H } = dims;
  const narrow = W < 480;                // tighter axis padding on phones
  const PAD = narrow
    ? { top: 18, right: 28, bottom: 26, left: 50 }
    : { top: 28, right: 64, bottom: 36, left: 92 };
  const PW = W - PAD.left - PAD.right;
  const PH = H - PAD.top - PAD.bottom;

  const xToPx = (eth: number) => PAD.left + (eth / xMax) * PW;
  const yToPx = (price: number) => PAD.top + PH - (price / yMax) * PH;

  const pathD = curvePoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xToPx(p.eth).toFixed(2)} ${yToPx(p.price).toFixed(2)}`)
    .join(" ");
  const areaD = `${pathD} L ${xToPx(xMax)} ${yToPx(0)} L ${xToPx(0)} ${yToPx(0)} Z`;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = W / rect.width;
    const xPx = (e.clientX - rect.left) * scaleX;
    if (xPx < PAD.left || xPx > PAD.left + PW) {
      setHover(null);
      return;
    }
    const eth = ((xPx - PAD.left) / PW) * xMax;
    const price = priceAt(eth);
    setHover({ eth, price, xPx, yPx: yToPx(price) });
  };

  const xTicks = niceTicks(0, xMax, 6);
  // Y ticks: keep only labels that have enough vertical space — drop any whose
  // pixel position is within 12px of the top padding line.
  const yTicks = niceTicks(0, yMax, 4).filter((y) => yToPx(y) >= PAD.top + 12);

  return (
    <div className="h-full flex flex-col">
      {/* Header — title, big price, token CA chip, legend */}
      <div className="px-3 sm:px-4 py-2.5 sm:py-3 border-b border-border flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted">{tokenSym} · price</span>
          <span className="text-xl sm:text-2xl font-semibold text-accent tabular-nums leading-none">
            {fmtPrice(currentPrice)}
          </span>
          <span className="text-muted text-[11px] leading-none">{baseSym}</span>
          <span className="text-muted text-[11px] leading-none tabular-nums">
            · pool {currentEth.toFixed(2)} {baseSym}
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <CopyAddr tokenAddr={tokenAddr} />
          <div className="hidden sm:flex items-center gap-3 sm:gap-4 text-[10px] text-muted">
            <LegendDot color="warn" label="now" />
            <LegendPill color="text" label="entry" />
            <LegendPill color="danger" label="liq" />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} className="flex-1 min-h-0 relative overflow-hidden">
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block absolute inset-0"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.20" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Y grid + labels */}
          {yTicks.map((y) => (
            <g key={`y${y}`}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yToPx(y)}
                y2={yToPx(y)}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.5}
              />
              <text
                x={PAD.left - 8}
                y={yToPx(y)}
                fill="currentColor"
                className="text-muted"
                fontSize="10"
                textAnchor="end"
                dominantBaseline="middle"
              >
                {fmtPrice(y, 2)}
              </text>
            </g>
          ))}

          {/* X grid + labels */}
          {xTicks.map((x) => (
            <g key={`x${x}`}>
              <line
                x1={xToPx(x)}
                x2={xToPx(x)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="currentColor"
                className="text-border"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.4}
              />
              <text
                x={xToPx(x)}
                y={H - PAD.bottom + 18}
                fill="currentColor"
                className="text-muted"
                fontSize="11"
                textAnchor="middle"
              >
                {x === 0 ? "0" : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : Math.round(x).toString()}
              </text>
            </g>
          ))}

          {/* Axis title for X (price axis values speak for themselves) */}
          <text
            x={W - PAD.right}
            y={H - 8}
            fill="currentColor"
            className="text-muted"
            fontSize="10"
            textAnchor="end"
          >
            pool {baseSym}
          </text>

          {/* Curve */}
          <path d={areaD} fill="url(#curveFill)" />
          <path
            d={pathD}
            fill="none"
            stroke="#6ee7b7"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Position price-lines (Hyperliquid/dYdX style) — horizontal dashed
              line at each position's entry and liq price, with a right-edge
              badge identifying which position it belongs to. Labels stagger
              vertically when prices cluster to avoid overlap.
            */}
          {(() => {
            // Build a flat list of all labels (entry + liq for each position),
            // sorted by Y position, then offset overlapping labels.
            type Label = {
              key: string;
              posId: number;
              yPrice: number;
              kind: "entry" | "liq";
              leverage: number;
            };
            const labels: Label[] = [];
            for (const m of positionMarkers) {
              if (m.entryPrice > 0 && m.entryPrice <= yMax) {
                labels.push({ key: `e${m.id}`, posId: m.id, yPrice: m.entryPrice, kind: "entry", leverage: m.leverage });
              }
              if (m.liqPrice > 0 && m.liqPrice <= yMax) {
                labels.push({ key: `l${m.id}`, posId: m.id, yPrice: m.liqPrice, kind: "liq", leverage: m.leverage });
              }
            }
            labels.sort((a, b) => yToPx(a.yPrice) - yToPx(b.yPrice));

            // Resolve y-pixel positions for badges with min vertical spacing.
            const BADGE_H = 18;
            const MIN_GAP = 2;
            const placed: { label: Label; yPx: number; lineYPx: number }[] = [];
            for (const lab of labels) {
              const lineY = yToPx(lab.yPrice);
              let labelY = lineY;
              if (placed.length > 0) {
                const lastY = placed[placed.length - 1].yPx;
                if (labelY < lastY + BADGE_H + MIN_GAP) {
                  labelY = lastY + BADGE_H + MIN_GAP;
                }
              }
              placed.push({ label: lab, yPx: labelY, lineYPx: lineY });
            }

            return placed.map(({ label, yPx, lineYPx }) => {
              const isHovered = hoveredPosId === label.posId;
              const isDimmed = hoveredPosId !== null && !isHovered;
              const lineColor = label.kind === "entry" ? "text-text" : "text-danger";
              const baseOpacity = isDimmed ? 0.15 : isHovered ? 1 : 0.6;
              const badgeW = 52;
              const badgeX = W - PAD.right - badgeW + 2;
              return (
                <g
                  key={label.key}
                  onMouseEnter={() => setHoveredPosId(label.posId)}
                  onMouseLeave={() => setHoveredPosId(null)}
                  style={{ cursor: "pointer" }}
                >
                  {/* Horizontal price line spanning chart */}
                  <line
                    x1={PAD.left}
                    x2={badgeX}
                    y1={lineYPx}
                    y2={lineYPx}
                    stroke="currentColor"
                    className={lineColor}
                    strokeOpacity={baseOpacity}
                    strokeWidth={isHovered ? 1.5 : 1}
                    strokeDasharray="3 3"
                  />
                  {/* Connector from line end to badge if staggered */}
                  {Math.abs(yPx - lineYPx) > 1 && (
                    <line
                      x1={badgeX}
                      x2={badgeX}
                      y1={lineYPx}
                      y2={yPx}
                      stroke="currentColor"
                      className={lineColor}
                      strokeOpacity={baseOpacity * 0.7}
                      strokeWidth={1}
                    />
                  )}
                  {/* Right-edge badge */}
                  <g transform={`translate(${badgeX} ${yPx - BADGE_H / 2})`}>
                    <rect
                      width={badgeW}
                      height={BADGE_H}
                      rx={3}
                      className={label.kind === "entry" ? "fill-text" : "fill-danger"}
                      fillOpacity={isDimmed ? 0.2 : 1}
                    />
                    <text
                      x={badgeW / 2}
                      y={BADGE_H / 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize="10"
                      fontWeight="600"
                      className="fill-bg"
                      fillOpacity={isDimmed ? 0.5 : 1}
                    >
                      {label.leverage}x {label.kind === "entry" ? "entry" : "liq"}
                    </text>
                  </g>
                </g>
              );
            });
          })()}

          {/* Current spot (on top of everything) */}
          {currentEth >= 0 && currentEth <= xMax && (
            <g>
              <line
                x1={xToPx(currentEth)}
                x2={xToPx(currentEth)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="currentColor"
                className="text-warn"
                strokeOpacity={0.6}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <circle
                cx={xToPx(currentEth)}
                cy={yToPx(currentPrice)}
                r={7}
                fill="currentColor"
                className="text-warn"
                stroke="#0a0a0a"
                strokeWidth={2}
              />
            </g>
          )}

          {/* Hover crosshair + tooltip */}
          {hover && (
            <g pointerEvents="none">
              <line
                x1={hover.xPx}
                x2={hover.xPx}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="currentColor"
                className="text-muted"
                strokeOpacity={0.4}
                strokeWidth={1}
              />
              <circle
                cx={hover.xPx}
                cy={hover.yPx}
                r={4}
                fill="currentColor"
                className="text-muted"
              />
              {(() => {
                const tipW = 160;
                const tipH = 50;
                const tipX = Math.min(hover.xPx + 12, W - tipW - 8);
                const tipY = Math.max(hover.yPx - tipH - 12, PAD.top + 4);
                return (
                  <g transform={`translate(${tipX} ${tipY})`}>
                    <rect
                      width={tipW}
                      height={tipH}
                      rx={4}
                      fill="#0a0a0a"
                      stroke="currentColor"
                      className="text-border"
                      strokeWidth={1}
                      opacity={0.95}
                    />
                    <text x={10} y={18} fontSize="11" fill="currentColor" className="text-muted">
                      pool {baseSym}:
                      <tspan className="text-text" dx={4}>{hover.eth.toFixed(2)}</tspan>
                    </text>
                    <text x={10} y={36} fontSize="11" fill="currentColor" className="text-muted">
                      price:
                      <tspan className="text-text" dx={4}>{fmtPrice(hover.price)}</tspan>
                    </text>
                  </g>
                );
              })()}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= 0) return [0];
  const range = max - min;
  const rawStep = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step: number;
  if (norm < 1.5) step = mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step / 2; v += step) {
    ticks.push(v);
  }
  return ticks;
}

function LegendDot({ color, label }: { color: "warn" | "text" | "danger"; label: string }) {
  const cls = color === "warn" ? "bg-warn" : color === "danger" ? "bg-danger" : "bg-text";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`block w-2.5 h-2.5 rounded-full ${cls}`} />
      <span>{label}</span>
    </span>
  );
}

function LegendPill({ color, label }: { color: "text" | "danger"; label: string }) {
  const cls = color === "danger" ? "bg-danger" : "bg-text";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`block w-5 h-2.5 rounded-sm ${cls}`} />
      <span>{label}</span>
    </span>
  );
}

// Token contract-address chip: 0xAAAA…ZZZZ + copy-to-clipboard.
function CopyAddr({ tokenAddr }: { tokenAddr: `0x${string}` }) {
  const [copied, setCopied] = useState(false);
  const short = `${tokenAddr.slice(0, 6)}…${tokenAddr.slice(-4)}`;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(tokenAddr);
    } catch {
      // older browsers / non-secure context — best-effort fallback
      const ta = document.createElement("textarea");
      ta.value = tokenAddr;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      onClick={onCopy}
      title={`Copy token contract address — ${tokenAddr}`}
      aria-label="copy token contract address"
      className="flex items-center gap-1 text-[10px] sm:text-[11px] tabular-nums bg-bg border border-border rounded px-1.5 py-1 text-muted hover:text-accent hover:border-accent transition-colors"
    >
      <span>{copied ? "copied!" : short}</span>
      <svg
        width="11" height="11" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  );
}
