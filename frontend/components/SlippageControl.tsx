"use client";

import { useState } from "react";

const PRESETS = [0.5, 1, 5] as const;

interface Props {
  /** Slippage as a percent (e.g. 1.0 = 1%) */
  value: number;
  onChange: (pct: number) => void;
  /** Show advanced row collapsed by default; expanded when slippage != default */
  defaultValue?: number;
}

export function SlippageControl({ value, onChange, defaultValue = 1 }: Props) {
  const [expanded, setExpanded] = useState(value !== defaultValue);
  const clamp = (v: number) => Math.max(0.01, Math.min(50, isFinite(v) ? v : defaultValue));

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between py-1 text-muted hover:text-text"
      >
        <span>slippage tolerance</span>
        <span className="tabular-nums">
          <span className={value === defaultValue ? "text-muted" : "text-warn"}>{value}%</span>
          <span className="ml-1">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 flex items-center gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={`flex-1 py-1 rounded border text-[11px] tabular-nums transition-colors ${
                value === p
                  ? "bg-accent/20 border-accent text-accent"
                  : "bg-bg border-border text-muted hover:border-muted"
              }`}
            >
              {p}%
            </button>
          ))}
          <input
            type="number"
            min={0.01}
            max={50}
            step={0.1}
            value={value}
            onChange={(e) => onChange(clamp(Number(e.target.value)))}
            className="w-14 bg-bg border border-border rounded px-1.5 py-1 text-[11px] text-right tabular-nums focus:border-accent"
          />
        </div>
      )}
    </div>
  );
}
