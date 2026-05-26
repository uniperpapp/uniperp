"use client";

import { useState } from "react";
import { logoCandidates } from "@/lib/logos";

/// Token avatar with a graceful fallback chain: an explicit `src` (e.g. a
/// launch's own metadata image) → configured base logo → dexscreener CDN →
/// a 3-letter monogram. Used for base assets across the directory + launch UI.
export function TokenLogo({
  address,
  symbol,
  src,
  size = 24,
  className = "",
}: {
  address?: string;
  symbol?: string;
  src?: string;
  size?: number;
  className?: string;
}) {
  const [i, setI] = useState(0);
  const candidates = src ? [src, ...logoCandidates(address)] : logoCandidates(address);
  const url = candidates[i];
  const box = { width: size, height: size };

  if (!url) {
    return (
      <span
        style={box}
        className={`shrink-0 rounded-full bg-bg border border-border flex items-center justify-center font-semibold text-muted ${className}`}
      >
        <span style={{ fontSize: Math.max(8, Math.floor(size * 0.34)) }}>
          {(symbol || "?").slice(0, 3).toUpperCase()}
        </span>
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={symbol || ""}
      width={size}
      height={size}
      onError={() => setI((n) => n + 1)}
      style={box}
      className={`shrink-0 rounded-full object-cover bg-bg border border-border ${className}`}
    />
  );
}
