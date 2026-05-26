"use client";

import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { TARGET_CHAIN } from "@/lib/config";

/// Full-page overlay shown when the connected wallet is on the wrong chain.
/// Blocks ALL interaction with the trading UI until the user switches — they
/// can't accidentally sign an open/close/stake against the wrong network
/// (which on a fork chain like Sepolia ↔ mainnet would silently route their
/// funds to a contract address that may not even exist, with no recourse).
///
/// Layered on top of the per-button protection in ConnectButton: even if
/// every individual call site forgot to gate writes, this overlay catches
/// them at the UX level.
export function ChainGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) return null;
  if (chainId === TARGET_CHAIN.id) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      // Prevent clicks from reaching the underlying UI even if portal stacking
      // is wrong on some browser.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-panel border border-danger rounded-xl shadow-2xl max-w-md w-full p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="text-danger text-2xl leading-none">⚠</span>
          <div>
            <div className="text-text font-medium text-base">Wrong network</div>
            <div className="text-muted text-xs mt-1">
              Your wallet is connected to a network this app doesn&apos;t support.
              Signing transactions here could send funds to addresses that don&apos;t
              exist on your current chain.
            </div>
          </div>
        </div>

        <div className="bg-bg border border-border rounded-lg p-3 text-xs">
          <Row label="Required network">
            <span className="text-text">{TARGET_CHAIN.name}</span>
          </Row>
          <Row label="Required chain ID">
            <span className="text-text tabular-nums">{TARGET_CHAIN.id}</span>
          </Row>
          <Row label="Your current chain ID">
            <span className="text-danger tabular-nums">{chainId}</span>
          </Row>
        </div>

        <button
          onClick={() => switchChain({ chainId: TARGET_CHAIN.id })}
          disabled={isPending}
          className="py-2.5 rounded bg-accent text-bg font-medium text-sm hover:bg-accent/90 disabled:opacity-60"
        >
          {isPending ? "switching…" : `Switch to ${TARGET_CHAIN.name}`}
        </button>

        <div className="text-[10px] text-muted text-center">
          If switching fails, add {TARGET_CHAIN.name} to your wallet manually and retry.
        </div>
      </div>
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
