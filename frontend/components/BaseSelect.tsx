"use client";

import { useEffect, useRef, useState } from "react";
import { TokenLogo } from "./TokenLogo";

export interface BaseOption {
  address: `0x${string}`;
  symbol: string;
  name: string;
  logo?: string;
  allowed: boolean;
}

/// Logo-aware base-token dropdown (native <select> can't show images). Shows the
/// selected base's logo + symbol in the trigger and a logo per row in the list.
/// Whitelisted-only: non-allowed bases render disabled.
export function BaseSelect({
  options,
  value,
  onChange,
  disabled,
}: {
  options: BaseOption[];
  value: string;
  onChange: (addr: `0x${string}`) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const selected = options.find((o) => o.address.toLowerCase() === value.toLowerCase());

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 bg-bg border border-border rounded px-2.5 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50"
      >
        {selected ? (
          <>
            <TokenLogo src={selected.logo} address={selected.address} symbol={selected.symbol} size={22} />
            <span className="font-medium">${selected.symbol}</span>
            <span className="text-text/50 truncate">— {selected.name}</span>
          </>
        ) : (
          <span className="text-text/50">Select a base…</span>
        )}
        <span className="ml-auto text-text/50">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-auto bg-panel border border-border rounded-lg shadow-2xl">
          {options.map((o) => (
            <button
              key={o.address}
              type="button"
              disabled={!o.allowed}
              onClick={() => { onChange(o.address); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2.5 py-2 text-sm text-left transition-colors ${
                o.allowed ? "hover:bg-bg" : "opacity-40 cursor-not-allowed"
              } ${o.address.toLowerCase() === value.toLowerCase() ? "bg-bg" : ""}`}
            >
              <TokenLogo src={o.logo} address={o.address} symbol={o.symbol} size={22} />
              <span className="font-medium">${o.symbol}</span>
              <span className="text-text/50 truncate">— {o.name}</span>
              {!o.allowed && <span className="ml-auto text-[10px] text-text/40 shrink-0">not whitelisted</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
