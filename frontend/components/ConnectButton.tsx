"use client";

import { useState, useRef, useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { TARGET_CHAIN } from "@/lib/config";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const onWrongChain = isConnected && chainId && chainId !== TARGET_CHAIN.id;

  // Close menu on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

    if (onWrongChain) {
      return (
        <button
          onClick={() => switchChain({ chainId: TARGET_CHAIN.id })}
          disabled={switchPending}
          className="px-3 py-1.5 text-xs bg-danger/20 border border-danger text-danger rounded hover:bg-danger/30 transition-colors disabled:opacity-50"
          title={`Wrong network. Click to switch to ${TARGET_CHAIN.name}.`}
        >
          {switchPending ? "switching…" : `switch to ${TARGET_CHAIN.name}`}
        </button>
      );
    }

    return (
      <button
        onClick={() => disconnect()}
        className="px-3 py-1.5 text-xs bg-bg border border-border rounded hover:border-accent hover:text-accent transition-colors"
        title="Click to disconnect"
      >
        {short}
      </button>
    );
  }

  // Dedupe connectors by name (EIP-6963 + legacy `injected` may double-list MetaMask)
  const seen = new Set<string>();
  const wallets = connectors.filter((c) => {
    const key = (c.name || c.id).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen((o) => !o)}
        disabled={isPending}
        className="px-3 py-1.5 text-xs bg-accent/20 border border-accent text-accent rounded hover:bg-accent/30 transition-colors disabled:opacity-50"
      >
        {isPending ? "connecting…" : "connect wallet"}
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-panel border border-border rounded shadow-lg p-1">
          {wallets.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">
              No wallet detected. Install MetaMask, Rabby, or another browser wallet.
            </div>
          ) : (
            wallets.map((c) => (
              <button
                key={c.uid}
                onClick={() => {
                  connect({ connector: c });
                  setMenuOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-bg rounded transition-colors"
              >
                {c.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon} alt="" className="w-4 h-4" />
                )}
                <span>{c.name || c.id}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
