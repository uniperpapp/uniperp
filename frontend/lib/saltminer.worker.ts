// Web Worker — runs the salt-mining loops off the main thread so the UI
// never jankis. Uses viem's keccak256 / getCreate2Address (browser-safe).
//
// Input  (postMessage):  { factory, base, tokenInitHash, name, symbol,
//                          tokenUri, hookInitHashByToken: 'lazy' }
//      Actually we run in two stages so the host can fetch hookInitCodeHash
//      from the factory once the token addr is known.
//
// Output (postMessage):  { type: 'tokenFound', tokenSalt, tokenAddr }
//                        { type: 'progress', stage, tries }
//                        { type: 'hookFound', hookSalt, hookAddr }
//                        { type: 'error', message }
//                        { type: 'cancelled' }
//
// The host (lib/use-salt-miner.ts) drives the staged exchange.

import { keccak256, encodePacked, getCreate2Address, toHex } from "viem";

interface FindTokenSaltMsg {
  type: "findTokenSalt";
  factory: `0x${string}`;
  base: `0x${string}`;
  tokenInitHash: `0x${string}`;
  saltSpace: number;       // how many salts to try max (e.g. 5_000_000)
  reportEvery?: number;    // emit progress every N tries (default 50_000)
}
interface FindHookSaltMsg {
  type: "findHookSalt";
  factory: `0x${string}`;
  hookInitHash: `0x${string}`;
  flags: number;           // e.g. 0x2acc
  flagMask: number;        // 0x3fff
  saltSpace: number;       // e.g. 5_000_000
  reportEvery?: number;
}
interface CancelMsg { type: "cancel" }
type In = FindTokenSaltMsg | FindHookSaltMsg | CancelMsg;

let cancelled = false;

function saltOf(i: number): `0x${string}` {
  return toHex(BigInt(i), { size: 32 }) as `0x${string}`;
}

function predict(factory: `0x${string}`, saltIdx: number, initHash: `0x${string}`): `0x${string}` {
  return getCreate2Address({ from: factory, salt: saltOf(saltIdx), bytecodeHash: initHash });
}

self.addEventListener("message", (e: MessageEvent<In>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  cancelled = false;

  const reportEvery = msg.reportEvery ?? 50_000;
  try {
    if (msg.type === "findTokenSalt") {
      const baseBig = BigInt(msg.base);
      for (let i = 0; i < msg.saltSpace; i++) {
        if (cancelled) {
          (self as any).postMessage({ type: "cancelled" });
          return;
        }
        const a = predict(msg.factory, i, msg.tokenInitHash);
        if (BigInt(a) > baseBig) {
          (self as any).postMessage({
            type: "tokenFound",
            tokenSalt: saltOf(i),
            tokenAddr: a,
            tries: i + 1,
          });
          return;
        }
        if ((i + 1) % reportEvery === 0) {
          (self as any).postMessage({ type: "progress", stage: "token", tries: i + 1 });
        }
      }
      (self as any).postMessage({
        type: "error",
        message: `no tokenSalt found in ${msg.saltSpace} tries (token > base)`,
      });
      return;
    }

    if (msg.type === "findHookSalt") {
      const flags = BigInt(msg.flags);
      const mask  = BigInt(msg.flagMask);
      for (let i = 0; i < msg.saltSpace; i++) {
        if (cancelled) {
          (self as any).postMessage({ type: "cancelled" });
          return;
        }
        const a = predict(msg.factory, i, msg.hookInitHash);
        if ((BigInt(a) & mask) === flags) {
          (self as any).postMessage({
            type: "hookFound",
            hookSalt: saltOf(i),
            hookAddr: a,
            tries: i + 1,
          });
          return;
        }
        if ((i + 1) % reportEvery === 0) {
          (self as any).postMessage({ type: "progress", stage: "hook", tries: i + 1 });
        }
      }
      (self as any).postMessage({
        type: "error",
        message: `no hookSalt found in ${msg.saltSpace} tries (hook & 0x3fff == FLAGS)`,
      });
    }
  } catch (err) {
    (self as any).postMessage({ type: "error", message: String(err) });
  }
});

// noop import-keep to satisfy bundler tree-shaking checks
export {};
