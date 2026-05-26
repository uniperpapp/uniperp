"use client";

import { useEffect, useRef, useCallback } from "react";
import { useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { TARGET_CHAIN } from "./config";
import { toast, updateToast } from "./toast";

/// Wraps `useWriteContract` + receipt-watch + toast lifecycle.
/// Returns the same .writeContract surface plus an `isBusy` flag covering
/// both submit-pending and on-chain-confirming.
export function useTx(label: string) {
  const { writeContract: rawWriteContract, data: hash, isPending: submitting, error: submitError, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess, error: receiptError } =
    useWaitForTransactionReceipt({ hash });
  const chainId = useChainId();

  // Defense-in-depth: ChainGuard should already block the UI on wrong chain,
  // but if it ever fails to render, refuse to broadcast — better to show a
  // toast and bail than send a transaction against the wrong network.
  const writeContract: typeof rawWriteContract = useCallback((args: Parameters<typeof rawWriteContract>[0], opts?: Parameters<typeof rawWriteContract>[1]) => {
    if (chainId !== TARGET_CHAIN.id) {
      toast({
        kind: "error",
        title: `${label} blocked`,
        message: `Wrong network. Switch to ${TARGET_CHAIN.name} (chainId ${TARGET_CHAIN.id}).`,
        ttlMs: 6000,
      });
      return;
    }
    return rawWriteContract(args, opts);
  }, [rawWriteContract, chainId, label]) as typeof rawWriteContract;

  // Track which toast belongs to which submitted hash so we update, not duplicate
  const toastIdRef = useRef<number | null>(null);
  const seenHashRef = useRef<`0x${string}` | null>(null);

  // When submitting starts (no hash yet, no error), show pending toast
  useEffect(() => {
    if (submitting && toastIdRef.current == null) {
      toastIdRef.current = toast({
        kind: "pending",
        title: `${label} — waiting for wallet`,
      });
    }
  }, [submitting, label]);

  // When the tx hash arrives, update the existing toast
  useEffect(() => {
    if (hash && hash !== seenHashRef.current) {
      seenHashRef.current = hash;
      if (toastIdRef.current != null) {
        updateToast(toastIdRef.current, {
          kind: "pending",
          title: `${label} — confirming on-chain`,
          hash,
        });
      } else {
        toastIdRef.current = toast({
          kind: "pending",
          title: `${label} — confirming on-chain`,
          hash,
        });
      }
    }
  }, [hash, label]);

  // Submit-time error (user rejected, insufficient funds, etc.)
  useEffect(() => {
    if (submitError && toastIdRef.current != null) {
      updateToast(toastIdRef.current, {
        kind: "error",
        title: `${label} failed`,
        message: extractRevertReason(submitError),
        ttlMs: 8000,
      });
      toastIdRef.current = null;
      seenHashRef.current = null;
      reset();
    }
  }, [submitError, label, reset]);

  // On-chain success
  useEffect(() => {
    if (isSuccess && hash && toastIdRef.current != null) {
      updateToast(toastIdRef.current, {
        kind: "success",
        title: `${label} confirmed`,
        hash,
        ttlMs: 5000,
      });
      toastIdRef.current = null;
      seenHashRef.current = null;
    }
  }, [isSuccess, hash, label]);

  // On-chain revert
  useEffect(() => {
    if (receiptError && hash && toastIdRef.current != null) {
      updateToast(toastIdRef.current, {
        kind: "error",
        title: `${label} reverted`,
        message: extractRevertReason(receiptError),
        hash,
        ttlMs: 10000,
      });
      toastIdRef.current = null;
      seenHashRef.current = null;
    }
  }, [receiptError, hash, label]);

  const isBusy = submitting || confirming;

  return { writeContract, isBusy, submitting, confirming, hash };
}

function extractRevertReason(err: Error): string {
  const msg = err.message || String(err);
  // Try to extract the meaningful revert from wagmi's verbose error
  const reasonMatch = msg.match(/reason:\s*([^\n]+)/i) || msg.match(/reverted with reason string '([^']+)'/i);
  if (reasonMatch) return reasonMatch[1];
  const customErrorMatch = msg.match(/reverted with the following reason:\s*([^\n]+)/i);
  if (customErrorMatch) return customErrorMatch[1];
  // Custom-error name (e.g., "CapBreached")
  const customNameMatch = msg.match(/Error:\s*([A-Z][A-Za-z]+)\(/);
  if (customNameMatch) return customNameMatch[1];
  // Fallback: first line
  return msg.split("\n")[0].slice(0, 140);
}
