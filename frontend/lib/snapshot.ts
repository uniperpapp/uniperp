"use client";
import { useEffect, useState } from "react";

export type SnapEntry = { address: string; amount: string; proof: `0x${string}`[] };
export type SnapFile = {
  root: `0x${string}`;
  total: string;
  count: number;
  snapshotBlock: string;
  entries: SnapEntry[];
};

let _cache: Promise<{ file: SnapFile; byAddr: Map<string, SnapEntry> }> | null = null;

function load() {
  if (!_cache) {
    _cache = fetch("/snapshot.json")
      .then((r) => r.json() as Promise<SnapFile>)
      .then((file) => {
        const byAddr = new Map<string, SnapEntry>();
        for (const e of file.entries) byAddr.set(e.address.toLowerCase(), e);
        return { file, byAddr };
      });
  }
  return _cache;
}

export function useSnapshot() {
  const [data, setData] = useState<{ file: SnapFile; byAddr: Map<string, SnapEntry> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then((d) => live && setData(d)).catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, []);
  return {
    file: data?.file ?? null,
    lookup: (addr?: string): SnapEntry | undefined =>
      addr && data ? data.byAddr.get(addr.toLowerCase()) : undefined,
    loading: !data && !err,
    error: err,
  };
}
