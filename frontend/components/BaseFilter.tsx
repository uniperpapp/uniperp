"use client";

import { useEffect, useRef, useState } from "react";
import { CANDIDATE_BASES } from "@/lib/config";
import { TokenLogo } from "./TokenLogo";

/// Compact base-filter dropdown for the directory. Custom (not native <select>)
/// so it always opens DOWNWARD and can show token logos. value = "all" or a
/// base symbol lowercased.
export function BaseFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);

  const opts = [
    { value: "all", label: "All", address: undefined as string | undefined, logo: undefined as string | undefined },
    ...CANDIDATE_BASES.map((b) => ({ value: b.symbol.toLowerCase(), label: b.symbol, address: b.address, logo: b.logo })),
  ];
  const sel = opts.find((o) => o.value === value) ?? opts[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 bg-panel border border-border rounded px-2 py-1 text-xs text-text/80 hover:border-muted"
      >
        {sel.address && <TokenLogo address={sel.address} symbol={sel.label} src={sel.logo} size={14} />}
        <span>Base: {sel.label}</span>
        <span className="text-text/50">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 max-h-72 overflow-auto bg-panel border border-border rounded-lg shadow-2xl">
          {opts.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-bg ${o.value === value ? "bg-bg text-accent" : ""}`}
            >
              {o.address
                ? <TokenLogo address={o.address} symbol={o.label} src={o.logo} size={16} />
                : <span className="w-4 h-4 inline-flex items-center justify-center text-text/40">∗</span>}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
