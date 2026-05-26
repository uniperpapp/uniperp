"use client";

import { usePoolSnapshot } from "@/lib/hooks";
import { fmtEth, fmtTokens, tokenPriceInEth } from "@/lib/format";

export function PoolStats() {
  const { data: snap, isLoading } = usePoolSnapshot();

  if (isLoading) {
    return <Skeleton />;
  }

  if (!snap) {
    return (
      <div className="p-4 text-muted text-xs">
        Hook address not configured. Set NEXT_PUBLIC_HOOK_ADDRESS.
      </div>
    );
  }

  const tokenEth = tokenPriceInEth(snap.sqrtPriceX96);
  const fdv = (Number(snap.totalSupply) / 1e18) * tokenEth;
  const cumEth = Number(snap.cumulativeEthInPool) / 1e18;

  return (
    <div className="flex flex-col gap-3 text-xs">
      <Row label="$PERP price">
        <span className="text-accent font-medium">
          {tokenEth === 0 ? "—" : tokenEth.toExponential(3)} ETH
        </span>
      </Row>
      <Row label="FDV">
        <span className="text-text">{fdv === 0 ? "—" : fdv.toFixed(2) + " ETH"}</span>
      </Row>
      <Row label="Pool ETH">
        <span className="text-text">{cumEth.toFixed(2)}</span>
      </Row>
      <Row label="Total debt">
        <span className="text-warn">{fmtEth(snap.totalDebtETH)} ETH</span>
      </Row>
      {snap.totalBadDebtETH > 0n && (
        <Row label="Bad debt">
          <span className="text-danger">{fmtEth(snap.totalBadDebtETH)} ETH</span>
        </Row>
      )}
      <Row label="Open positions">
        <span className="text-text">{Number(snap.numOpenPositions)}</span>
      </Row>
      <Row label="Token supply">
        <span className="text-text">{fmtTokens(snap.totalSupply)}</span>
      </Row>
      <Row label="Status">
        <span className="text-accent">live</span>
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-3 bg-border rounded animate-pulse" />
      ))}
    </div>
  );
}
