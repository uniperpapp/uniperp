"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useAccount,
  useChainId,
  useReadContracts,
  usePublicClient,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { decodeEventLog } from "viem";

import { perpfactoryAbi } from "@/lib/abi-factory";
import {
  FACTORY_ADDRESS,
  FACTORY_LIVE,
  CANDIDATE_BASES,
  PERP_ADDRESS,
  HOOK_FLAGS,
  HOOK_FLAG_MASK,
  TARGET_CHAIN,
  type BaseMeta,
} from "@/lib/config";
import { uploadLaunchMetadata, ipfsConfigured } from "@/lib/ipfs";
import { fmtEthBig, shortAddr } from "@/lib/fmt";
import { fmtAmount } from "@/lib/format";
import { BaseSelect } from "./BaseSelect";

type Stage =
  | "idle"
  | "uploading-logo"
  | "uploading-meta"
  | "fetching-token-hash"
  | "mining-token-salt"
  | "fetching-hook-hash"
  | "mining-hook-salt"
  | "pre-flight"
  | "approving"
  | "awaiting-signature"
  | "mining-tx"
  | "launched"
  | "error";

const TOTAL_SUPPLY = 1_000_000n * 10n ** 18n;   // fixed 1M, all launches

// V/W are NOT hardcoded in the frontend — they're read from
// `factory.bases(selectedBase)` per base. Admin calibrates each whitelisted
// base so every launch (any base) opens at the SAME USD FDV (audited v2
// PERP geometry). `bases[base].minV == maxV` (locked) ⇒ creator has no V/W
// choice; the launch tx always submits the calibrated values.

// Minimal ERC-20 surface — just what we need for the optional seed-buy
// `approve` step. Both PERP (solady) and WETH expose this.
const erc20MinAbi = [
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/// Closed-form tokens-out quote for a fee-EXEMPT initial buy at e=0 (the
/// curve's genesis state, which is where the SEED_BUY swap runs because
/// it's part of `create()` and sender==self → no spot fee).
///
///   realTokens(e) = K / (V + e)         where K = TOTAL_SUPPLY · V
///   tokensOut(baseIn) = TOTAL_SUPPLY − realTokens(baseIn)
///                     = TOTAL_SUPPLY · baseIn / (V + baseIn)
///
/// Returns 0 for non-positive input. Pure bigint; no decimal math.
function quoteSeedTokens(baseIn: bigint, v: bigint): bigint {
  if (baseIn <= 0n || v <= 0n) return 0n;
  return (TOTAL_SUPPLY * baseIn) / (v + baseIn);
}

// Limits — same as Unicurve (meme-style brevity)
const NAME_MAX        = 32;
const SYMBOL_MAX      = 11;
const DESCRIPTION_MAX = 500;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;        // 4 MB

// Social validators — URL-only (full https:// link to the canonical platform).
// All three fields are OPTIONAL: empty input passes validation.
function validateSocials(f: {
  twitter: string; telegram: string; website: string;
}): string | null {
  if (f.twitter.trim()) {
    const v = f.twitter.trim();
    if (!/^https?:\/\/(www\.)?(twitter\.com|x\.com)\/[^/\s]+/i.test(v)) {
      return "Twitter must be a full URL (https://x.com/…).";
    }
  }
  if (f.telegram.trim()) {
    const v = f.telegram.trim();
    if (!/^https?:\/\/t\.me\/[^/\s]+/i.test(v)) {
      return "Telegram must be a full URL (https://t.me/…).";
    }
  }
  if (f.website.trim()) {
    const v = f.website.trim();
    const isFullUrl    = /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v);
    const isBareDomain = /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+(\/\S*)?$/.test(v);
    if (!isFullUrl && !isBareDomain) return "Website must be a URL (e.g. example.com or https://example.com).";
  }
  return null;
}

/// Prepend https:// to a bare domain (matches Unicurve normalizeWebsite).
function normalizeWebsite(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

interface BaseInfoResolved extends BaseMeta {
  allowed:   boolean;
  v:         bigint;
  tickWidth: bigint;
}

export function LaunchForm() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const wrongChain = isConnected && chainId !== TARGET_CHAIN.id;

  // ── form fields ──────────────────────────────────────────────────────────
  const [name, setName]               = useState("");
  const [symbol, setSymbol]           = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter]         = useState("");
  const [telegram, setTelegram]       = useState("");
  const [website, setWebsite]         = useState("");
  const [logo, setLogo]               = useState<File | null>(null);
  // Optional initial buy (D9). User types a human-decimal string; we parse to
  // bigint at submit. Empty / "0" / invalid ⇒ no seed buy.
  const [seedBuyStr, setSeedBuyStr]   = useState("");

  // Base selection (default: PERP, the launchpad's flagship base).
  const [selectedBaseAddr, setSelectedBaseAddr] =
    useState<`0x${string}`>(PERP_ADDRESS);

  // ── factory.bases() multicall over every candidate ───────────────────────
  const basesRead = useReadContracts({
    contracts: CANDIDATE_BASES.map((b) => ({
      address: FACTORY_ADDRESS,
      abi: perpfactoryAbi,
      functionName: "bases" as const,
      args: [b.address] as const,
    })),
    query: { enabled: FACTORY_LIVE },
  });

  const resolvedBases = useMemo<BaseInfoResolved[]>(() => {
    return CANDIDATE_BASES.map((b, i) => {
      // Preview-mode (factory not deployed yet): show every candidate as
      // selectable so the dropdown is interactive. The "Launchpad not
      // deployed yet" banner at the top still blocks submission.
      if (!FACTORY_LIVE) {
        return { ...b, allowed: true, v: 0n, tickWidth: 0n };
      }
      const r: any = basesRead.data?.[i]?.result;
      if (!r) {
        return { ...b, allowed: false, v: 0n, tickWidth: 0n };
      }
      const isArr = Array.isArray(r);
      return {
        ...b,
        allowed:   (isArr ? r[0] : r.allowed)   as boolean,
        v:         (isArr ? r[1] : r.v)         as bigint,
        tickWidth: (isArr ? r[2] : r.tickWidth) as bigint,
      };
    });
  }, [basesRead.data]);

  const allowedBases = useMemo(
    () => resolvedBases.filter((b) => b.allowed),
    [resolvedBases],
  );
  const selectedBase = useMemo(
    () => resolvedBases.find((b) => b.address.toLowerCase() === selectedBaseAddr.toLowerCase()) ?? null,
    [resolvedBases, selectedBaseAddr],
  );

  // If the default (PERP) isn't whitelisted but something else is, auto-switch
  // to the first allowed base. Otherwise leave PERP selected so the UI shows
  // the "default not yet whitelisted" state on the dropdown option label.
  useEffect(() => {
    if (selectedBase && !selectedBase.allowed && allowedBases.length > 0) {
      setSelectedBaseAddr(allowedBases[0]!.address);
    }
  }, [selectedBase?.allowed, allowedBases.length]);

  // ── mining UI state ──────────────────────────────────────────────────────
  const [stage,    setStage]    = useState<Stage>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [tokenUri, setTokenUri] = useState<string | null>(null);
  const [predToken, setPredToken] = useState<`0x${string}` | null>(null);
  const [predHook,  setPredHook]  = useState<`0x${string}` | null>(null);

  // worker
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    workerRef.current = new Worker(new URL("../lib/saltminer.worker.ts", import.meta.url), { type: "module" });
    return () => workerRef.current?.terminate();
  }, []);

  // tx
  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash ?? undefined });

  // ── live social validation (shown inline; also blocks submit) ────────────
  const socialErr = useMemo(
    () => validateSocials({ twitter, telegram, website }),
    [twitter, telegram, website],
  );

  // Seed-buy parsing — accept "1.5", "0.3", etc. Empty / 0 / NaN ⇒ 0 (no buy).
  // We use 18 decimals because every whitelisted base in CANDIDATE_BASES is
  // 18-dec; if/when a non-18-dec base is added the BaseMeta.decimals field
  // already exposes the right scaler.
  const seedBuyBase: bigint = useMemo(() => {
    const dec = selectedBase?.decimals ?? 18;
    const s   = seedBuyStr.trim();
    if (!s) return 0n;
    if (!/^\d+(\.\d+)?$/.test(s)) return 0n;
    const [whole, frac = ""] = s.split(".");
    const fracPadded = (frac + "0".repeat(dec)).slice(0, dec);
    try {
      return BigInt(whole) * 10n ** BigInt(dec) + BigInt(fracPadded || "0");
    } catch { return 0n; }
  }, [seedBuyStr, selectedBase?.decimals]);

  // Live V/W locked from the selected base's whitelist entry. Admin has
  // calibrated each base to the same USD FDV target, so V is base-specific.
  // Contract reads V/W straight from `bases[base]` at create() time — the
  // creator no longer submits them in CreateParams.
  const lockedV  = selectedBase?.v         ?? 0n;
  const lockedTW = selectedBase?.tickWidth ?? 0n;

  const seedQuoteTokens = useMemo(
    () => quoteSeedTokens(seedBuyBase, lockedV),
    [seedBuyBase, lockedV],
  );

  // ── form validation ──────────────────────────────────────────────────────
  const canSubmit =
    FACTORY_LIVE &&
    isConnected &&
    !wrongChain &&
    !!selectedBase?.allowed &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !!logo &&
    !socialErr &&
    ipfsConfigured() &&
    (stage === "idle" || stage === "error");

  // ── orchestration ────────────────────────────────────────────────────────
  async function go() {
    setErrorMsg(null);
    setTxHash(null);
    setPredToken(null);
    setPredHook(null);
    const ve = validateSocials({ twitter, telegram, website });
    if (ve) { setErrorMsg(ve); setStage("error"); return; }

    if (!selectedBase?.allowed) {
      setErrorMsg("Selected base isn't whitelisted yet.");
      setStage("error"); return;
    }

    setProgress(0);
    setStage("uploading-logo");
    try {
      // 1. logo + metadata JSON → IPFS (one server-side Filebase round-trip;
      //    the secret stays server-side, see app/api/ipfs/route.ts)
      const { imageURI: imgUri, metadataURI: mUri } = await uploadLaunchMetadata({
        file: logo!,
        name, symbol,
        description: description || undefined,
        twitter:  twitter.trim()  || undefined,
        telegram: telegram.trim() || undefined,
        website:  normalizeWebsite(website) || undefined,
      });
      setImageUri(imgUri);
      setTokenUri(mUri);

      // 3. factory.tokenInitCodeHash(name, symbol, tokenUri)
      setStage("fetching-token-hash");
      const tHash = (await publicClient!.readContract({
        address: FACTORY_ADDRESS,
        abi: perpfactoryAbi,
        functionName: "tokenInitCodeHash",
        args: [name, symbol, mUri],
      })) as `0x${string}`;

      // 4. mine tokenSalt (token > selectedBase) in Web Worker
      setStage("mining-token-salt");
      const tok = await runWorker<{ tokenSalt: `0x${string}`; tokenAddr: `0x${string}` }>({
        type: "findTokenSalt",
        factory: FACTORY_ADDRESS,
        base:    selectedBaseAddr,
        tokenInitHash: tHash,
        saltSpace: 5_000_000,
      });
      setPredToken(tok.tokenAddr);

      // 5. factory.hookInitCodeHash(token) + factory.hookDeployer().
      //    Hooks are CREATE2-deployed BY the HookDeployer sidecar (split off
      //    so the factory's bytecode fits EIP-170 — see src/HookDeployer.sol),
      //    so the salt-mining loop derives addresses from `hookDeployer`,
      //    NOT the factory.
      setStage("fetching-hook-hash");
      const [hHash, hookDeployerAddr] = await Promise.all([
        publicClient!.readContract({
          address: FACTORY_ADDRESS,
          abi: perpfactoryAbi,
          functionName: "hookInitCodeHash",
          args: [tok.tokenAddr],
        }) as Promise<`0x${string}`>,
        publicClient!.readContract({
          address: FACTORY_ADDRESS,
          abi: perpfactoryAbi,
          functionName: "hookDeployer",
        }) as Promise<`0x${string}`>,
      ]);

      // 6. mine hookSalt (& 0x3fff == FLAGS) in Web Worker — deployer = hookDeployer
      setStage("mining-hook-salt");
      const hk = await runWorker<{ hookSalt: `0x${string}`; hookAddr: `0x${string}` }>({
        type: "findHookSalt",
        factory: hookDeployerAddr,
        hookInitHash: hHash,
        flags: HOOK_FLAGS,
        flagMask: HOOK_FLAG_MASK,
        saltSpace: 5_000_000,
      });
      setPredHook(hk.hookAddr);

      // 7. cross-check via factory.predict*
      setStage("pre-flight");
      const [predT, predH] = await Promise.all([
        publicClient!.readContract({
          address: FACTORY_ADDRESS, abi: perpfactoryAbi, functionName: "predictToken",
          args: [tok.tokenSalt, name, symbol, mUri],
        }) as Promise<`0x${string}`>,
        publicClient!.readContract({
          address: FACTORY_ADDRESS, abi: perpfactoryAbi, functionName: "predictHook",
          args: [hk.hookSalt, tok.tokenAddr],
        }) as Promise<`0x${string}`>,
      ]);
      if (predT.toLowerCase() !== tok.tokenAddr.toLowerCase()) throw new Error("predictToken mismatch — please retry");
      if (predH.toLowerCase() !== hk.hookAddr.toLowerCase())   throw new Error("predictHook mismatch — please retry");

      // 8. (optional) approve the factory for the seed-buy amount.
      //    The factory pulls baseIn from the creator via transferFrom in the
      //    same create() tx, so we need allowance BEFORE the create call.
      //    We always issue the approve as a separate tx — simple + safe;
      //    if the creator pre-approved or just doesn't want a seed buy,
      //    we skip.
      if (seedBuyBase > 0n) {
        setStage("approving");
        const approveHash = await writeContractAsync({
          address: selectedBaseAddr,
          abi: erc20MinAbi,
          functionName: "approve",
          args: [FACTORY_ADDRESS, seedBuyBase],
        });
        await publicClient!.waitForTransactionReceipt({ hash: approveHash });
      }

      // 9. broadcast factory.create
      //    create() is a LARGE tx (~15-16M gas: deploys token+hook+lens, inits
      //    the pool, seeds 50 bands). MetaMask's own gas estimation on a tx
      //    this size is unreliable — it can submit with a too-low gas limit
      //    that the node rejects before the mempool ("tx not found"). So we
      //    estimate explicitly here and pass a +25% buffered gas limit.
      setStage("awaiting-signature");
      const createArgs = [{
        name, symbol, tokenUri: mUri,
        base: selectedBaseAddr,
        tokenSalt: tok.tokenSalt, hookSalt: hk.hookSalt,
        seedBuyBase,
      }] as const;

      // Diagnostic: log the EXACT args so a failed launch is debuggable from
      // the browser console.
      console.log("[launch] create args:", {
        name, symbol, tokenUri: mUri, base: selectedBaseAddr,
        tokenSalt: tok.tokenSalt, hookSalt: hk.hookSalt,
        predictedToken: tok.tokenAddr, predictedHook: hk.hookAddr,
        seedBuyBase: seedBuyBase.toString(),
        factory: FACTORY_ADDRESS,
      });

      // Pre-flight against OUR (uncapped) RPC. If create() genuinely reverts
      // we surface the real reason and STOP — no point asking the wallet to
      // sign a doomed tx. If it succeeds we get an honest gas estimate to pass
      // explicitly (the tx is ~15.6M gas; wallet auto-estimation is unreliable
      // and some wallet RPCs gas-cap the simulation, hiding the real result).
      let gasLimit: bigint;
      try {
        await publicClient!.simulateContract({
          address: FACTORY_ADDRESS, abi: perpfactoryAbi, functionName: "create",
          args: createArgs as any, account: address,
        });
        const est = await publicClient!.estimateContractGas({
          address: FACTORY_ADDRESS, abi: perpfactoryAbi, functionName: "create",
          args: createArgs as any, account: address,
        });
        // EIP-7825 (Fusaka) caps a SINGLE transaction's gas limit at
        // 2^24 = 16,777,216. create() needs ~15.6M (under the cap), but a naive
        // buffer pushes the LIMIT over it → the tx is rejected pre-broadcast
        // ("intrinsic gas too high", no hash). Clamp the limit just under the
        // cap while keeping it comfortably above the real need.
        const TX_GAS_CAP = 16_700_000n; // safely under 16,777,216
        if (est >= TX_GAS_CAP) {
          setErrorMsg(
            `This launch needs ${est.toString()} gas, over the ${TX_GAS_CAP.toString()} ` +
            `per-transaction cap (EIP-7825). It can't be launched in a single tx — contact the team.`,
          );
          setStage("error");
          return;
        }
        gasLimit = (est * 108n) / 100n;
        if (gasLimit > TX_GAS_CAP) gasLimit = TX_GAS_CAP; // never exceed the per-tx cap
        console.log("[launch] pre-flight OK · gas est:", est.toString(), "· limit:", gasLimit.toString());
      } catch (e: any) {
        console.error("[launch] create pre-flight FAILED (raw):", e);
        // Walk the FULL error chain for either (a) a decoded custom error, or
        // (b) raw revert data hex we can decode manually. Reverts from contracts
        // OTHER than the factory (HookDeployer, PoolManager, hook constructor)
        // arrive without a decoded name because their ABI isn't in `perpfactoryAbi`.
        let errorName: string | undefined;
        let errorArgs: any[] | undefined;
        let errorData: string | undefined;
        for (let cur: any = e; cur && !errorName && !errorData; cur = cur?.cause) {
          if (cur?.data?.errorName) { errorName = cur.data.errorName; errorArgs = cur.data.args; }
          if (cur?.raw && /^0x[0-9a-fA-F]+$/.test(cur.raw)) errorData = cur.raw;
          if (cur?.data && /^0x[0-9a-fA-F]+$/.test(cur.data)) errorData = errorData ?? cur.data;
        }
        const decoded = errorName
          ? `${errorName}(${(errorArgs ?? []).join(", ")})`
          : errorData
            ? `raw=${errorData.slice(0, 10)} (full revert data in console)`
            : "";
        const rawErr =
          decoded ||
          e?.shortMessage || e?.details || e?.cause?.shortMessage ||
          e?.cause?.message || e?.message || "unknown";
        if (errorData) console.error("[launch] FULL revert data:", errorData);
        console.error("[launch] full error object:", e);
        let collide = "";
        try {
          const [tCode, hCode] = await Promise.all([
            publicClient!.getBytecode({ address: tok.tokenAddr }),
            publicClient!.getBytecode({ address: hk.hookAddr }),
          ]);
          const tOcc = !!tCode && tCode !== "0x";
          const hOcc = !!hCode && hCode !== "0x";
          if (tOcc || hOcc) collide = ` · COLLISION(${tOcc ? "token" : ""}${tOcc && hOcc ? "+" : ""}${hOcc ? "hook" : ""})`;
        } catch { /* ignore */ }
        const detail =
          `${rawErr}${collide} · base=${selectedBaseAddr} · seedBuy=${seedBuyBase.toString()}` +
          ` · v=${lockedV?.toString?.() ?? "?"} · tw=${lockedTW?.toString?.() ?? "?"}` +
          ` · token=${tok.tokenAddr} · hook=${hk.hookAddr} · uriLen=${(mUri || "").length}`;
        console.error("[launch] diagnosis:", detail);
        setErrorMsg("Launch pre-check failed: " + detail);
        setStage("error");
        return;
      }

      // Fees: use viem's MARKET-RATE estimate (priority tip + maxFee). create()
      // is large (~15.6M gas), so we keep base-fee HEADROOM on the maxFee cap so
      // it stays valid while builders find room — but the cap is only a ceiling;
      // you still pay current baseFee + tip. (Earlier this forced a 2 gwei tip,
      // which overpaid ~0.03 ETH on a 16.7M-gas tx — now market rate.)
      let maxFeePerGas: bigint | undefined;
      let maxPriorityFeePerGas: bigint | undefined;
      try {
        const [blk, fee] = await Promise.all([
          publicClient!.getBlock({ blockTag: "latest" }),
          publicClient!.estimateFeesPerGas().catch(() => null),
        ]);
        const base = blk.baseFeePerGas ?? 1_000_000_000n; // fallback 1 gwei
        const suggestedTip = fee?.maxPriorityFeePerGas ?? 0n;
        // Market tip, with a tiny 0.1 gwei floor so it's never zero.
        maxPriorityFeePerGas = suggestedTip > 100_000_000n ? suggestedTip : 100_000_000n;
        // Cap = max(viem's maxFee, baseFee×2 + tip) — headroom for a slow-to-land
        // big tx without inflating what's actually paid.
        const headroom = base * 2n + maxPriorityFeePerGas;
        const suggestedMax = fee?.maxFeePerGas ?? 0n;
        maxFeePerGas = suggestedMax > headroom ? suggestedMax : headroom;
        console.log(
          "[launch] fees:",
          "base", base.toString(),
          "priority", maxPriorityFeePerGas.toString(),
          "max", maxFeePerGas.toString(),
        );
      } catch { /* let the wallet price it */ }

      const hash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: perpfactoryAbi,
        functionName: "create",
        args: createArgs as any,
        gas: gasLimit,
        ...(maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas } : {}),
      });
      setTxHash(hash);
      setStage("mining-tx");
      void warnIfTxNotPropagated(hash);
    } catch (e) {
      setErrorMsg(prettyErr(e));
      setStage("error");
    }
  }

  async function warnIfTxNotPropagated(hash: `0x${string}`) {
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    try {
      const tx = await publicClient!.getTransaction({ hash });
      if (!tx) {
        setErrorMsg(
          "Wallet returned a tx hash, but the RPC still cannot see it after 45s. " +
          "This usually means MetaMask did not propagate it, a lower nonce is stuck, " +
          "or the fee cap was edited too low in the wallet.",
        );
      }
    } catch {
      // Receipt polling is still active; ignore transient RPC failures here.
    }
  }

  function runWorker<T>(payload: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w = workerRef.current;
      if (!w) return reject(new Error("worker not ready"));
      const onMsg = (e: MessageEvent<any>) => {
        const m = e.data;
        if (m.type === "progress") { setProgress(m.tries); return; }
        if (m.type === "tokenFound" || m.type === "hookFound") {
          w.removeEventListener("message", onMsg);
          resolve(m as T);
        } else if (m.type === "error") {
          w.removeEventListener("message", onMsg);
          reject(new Error(m.message));
        }
      };
      w.addEventListener("message", onMsg);
      w.postMessage(payload);
    });
  }

  // navigate on confirmed launch
  useEffect(() => {
    if (txReceipt.isSuccess && txReceipt.data && predHook) {
      try {
        const log = txReceipt.data.logs.find((l) =>
          l.address.toLowerCase() === FACTORY_ADDRESS.toLowerCase(),
        );
        if (log) decodeEventLog({ abi: perpfactoryAbi, ...log });
      } catch { /* fall through */ }
      setStage("launched");
      router.push(`/t/${predHook}`);
    }
  }, [txReceipt.isSuccess, txReceipt.data, predHook, router]);

  const baseSym = selectedBase?.symbol ?? "base";

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Launch a token</h1>

      {!FACTORY_LIVE && (
        <Banner kind="warn">Launchpad not deployed yet (set NEXT_PUBLIC_FACTORY_ADDRESS).</Banner>
      )}
      {FACTORY_LIVE && basesRead.isSuccess && allowedBases.length === 0 && (
        <Banner kind="warn">No bases have been whitelisted by the factory admin yet.</Banner>
      )}
      {wrongChain && <Banner kind="warn">Wrong network — switch to {TARGET_CHAIN.name}.</Banner>}

      {/* Base token dropdown — defaults to $PERP */}
      <Field label="Base token">
        <BaseSelect
          options={resolvedBases.map((b) => ({
            address: b.address, symbol: b.symbol, name: b.name, logo: b.logo, allowed: b.allowed,
          }))}
          value={selectedBaseAddr}
          onChange={(addr) => setSelectedBaseAddr(addr)}
          disabled={allowedBases.length === 0}
        />
        <div className="mt-1 text-[10px] text-text/50">
          The token you launch will be priced + traded against ${baseSym}.
        </div>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX}
            className={INPUT}
            placeholder="Pepecoin"
          />
        </Field>
        <Field label="Symbol">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            maxLength={SYMBOL_MAX}
            className={INPUT}
            placeholder="PEPE"
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={DESCRIPTION_MAX}
          rows={3}
          className={INPUT}
          placeholder="What's the meme?"
        />
        <div className="mt-1 text-[10px] text-text/40 text-right">
          {description.length}/{DESCRIPTION_MAX}
        </div>
      </Field>

      <ImageDrop file={logo} onChange={setLogo} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Twitter (optional)">
          <input value={twitter} onChange={(e) => setTwitter(e.target.value)} className={INPUT}
            placeholder="https://x.com/…" />
        </Field>
        <Field label="Telegram (optional)">
          <input value={telegram} onChange={(e) => setTelegram(e.target.value)} className={INPUT}
            placeholder="https://t.me/…" />
        </Field>
        <Field label="Website (optional)">
          <input value={website} onChange={(e) => setWebsite(e.target.value)} className={INPUT}
            placeholder="https://…" />
        </Field>
      </div>

      {socialErr && (stage === "idle" || stage === "error") && (
        <Banner kind="warn">{socialErr}</Banner>
      )}

      <Field label={`Initial buy (optional, in ${baseSym})`}>
        <input
          inputMode="decimal"
          value={seedBuyStr}
          onChange={(e) => setSeedBuyStr(e.target.value)}
          className={INPUT}
          placeholder="0.5"
        />
        {seedBuyBase > 0n && symbol && (
          <div className="mt-1 text-[11px] text-text/60">
            ≈ <span className="font-medium text-text/90">{fmtEthBig(seedQuoteTokens, 0)} ${symbol}</span>
          </div>
        )}
      </Field>

      <div className="text-xs text-text/50">
        Curve params (locked, audited): V = {fmtAmount(lockedV, selectedBase?.decimals ?? 18, 3)} {baseSym} · band width {fmtAmount(lockedTW, selectedBase?.decimals ?? 18, 3)} {baseSym}
      </div>

      <button
        onClick={go}
        disabled={!canSubmit}
        className="w-full bg-accent text-bg font-semibold py-2 rounded disabled:opacity-40"
      >
        {ctaLabel(stage)}
      </button>

      <StageReadout
        stage={stage}
        progress={progress}
        imageUri={imageUri}
        tokenUri={tokenUri}
        predToken={predToken}
        predHook={predHook}
        txHash={txHash}
        errorMsg={errorMsg}
      />
    </div>
  );
}

// ─── small UI pieces ──────────────────────────────────────────────────────────

const INPUT =
  "w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-text/60 mb-1 inline-block">{label}</span>
      {children}
    </label>
  );
}

function Banner({ kind, children }: { kind: "warn" | "ok"; children: React.ReactNode }) {
  const cls =
    kind === "warn"
      ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
      : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400";
  return <div className={`text-sm border rounded px-3 py-2 ${cls}`}>{children}</div>;
}

/// Drop-zone w/ live square preview (mirrors Unicurve ImageDrop). Validates
/// max-size before passing the File up; revokes the object URL on unmount /
/// next pick to avoid memory leaks.
function ImageDrop({
  file, onChange,
}: { file: File | null; onChange: (f: File | null) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  function handle(f: File | null) {
    setErr(null);
    if (f && f.size > IMAGE_MAX_BYTES) {
      setErr(`Image too large (max ${IMAGE_MAX_BYTES / 1024 / 1024} MB).`);
      return;
    }
    onChange(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  return (
    <Field label="Image">
      <label
        className={
          "mt-1 grid cursor-pointer place-items-center overflow-hidden rounded-md " +
          "border-2 border-dashed border-border bg-bg text-text/60 text-sm " +
          "hover:border-accent/60 transition-colors " +
          (preview ? "mx-auto aspect-square w-full max-w-xs" : "h-32")
        }
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="preview" className="h-full w-full object-contain" />
        ) : (
          <span>drop image or click to upload (max 4 MB)</span>
        )}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handle(e.target.files?.[0] ?? null)}
        />
      </label>
      {file && !err && (
        <div className="mt-1 text-xs text-text/60">
          {file.name} · {(file.size / 1024).toFixed(1)} KB
        </div>
      )}
      {err && <div className="mt-1 text-xs text-amber-400">{err}</div>}
    </Field>
  );
}

function ctaLabel(s: Stage): string {
  switch (s) {
    case "idle":                return "Launch token";
    case "uploading-logo":      return "uploading logo to IPFS…";
    case "uploading-meta":      return "pinning metadata to IPFS…";
    case "fetching-token-hash": return "fetching token init hash…";
    case "mining-token-salt":   return "mining token salt…";
    case "fetching-hook-hash":  return "fetching hook init hash…";
    case "mining-hook-salt":    return "mining hook salt (~16k tries)…";
    case "pre-flight":          return "pre-flight checks…";
    case "approving":           return "approving seed-buy spend…";
    case "awaiting-signature":  return "awaiting wallet signature…";
    case "mining-tx":           return "tx mining…";
    case "launched":            return "launched! redirecting…";
    case "error":               return "retry";
  }
}

function StageReadout(props: {
  stage: Stage; progress: number;
  imageUri: string | null; tokenUri: string | null;
  predToken: string | null; predHook: string | null;
  txHash: string | null; errorMsg: string | null;
}) {
  const lines: { k: string; v: string }[] = [];
  if (props.imageUri)  lines.push({ k: "image",    v: props.imageUri });
  if (props.tokenUri)  lines.push({ k: "metadata", v: props.tokenUri });
  if (props.predToken) lines.push({ k: "token",    v: shortAddr(props.predToken) });
  if (props.predHook)  lines.push({ k: "hook",     v: shortAddr(props.predHook) });
  if (props.txHash)    lines.push({ k: "tx",       v: shortAddr(props.txHash) });

  return (
    <div className="space-y-2">
      {props.stage === "mining-hook-salt" && props.progress > 0 && (
        <div className="text-xs text-text/60">tried {props.progress.toLocaleString()} hook salts…</div>
      )}
      {props.errorMsg && <Banner kind="warn">{props.errorMsg}</Banner>}
      {lines.length > 0 && (
        <div className="bg-panel border border-border rounded p-3 text-xs space-y-1">
          {lines.map((l) => (
            <div key={l.k} className="flex justify-between gap-2">
              <span className="text-text/50">{l.k}</span>
              <span className="text-text/90 font-mono truncate ml-2">{l.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function prettyErr(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message;
    const cut = msg.split("\n")[0];
    return cut.length > 220 ? cut.slice(0, 220) + "…" : cut;
  }
  return String(e);
}
