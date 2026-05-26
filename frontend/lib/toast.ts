"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

export type ToastKind = "pending" | "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  hash?: `0x${string}`;
  // when set, toast is shown for this many ms then auto-dismissed
  ttlMs?: number;
}

// Tiny external store so toast() can be called from anywhere (handlers, hooks)
// without React context plumbing.
let _toasts: Toast[] = [];
let _nextId = 1;
const _listeners = new Set<() => void>();

function emit() {
  for (const l of _listeners) l();
}

export function toast(t: Omit<Toast, "id">): number {
  const id = _nextId++;
  _toasts = [..._toasts, { id, ...t }];
  emit();
  if (t.ttlMs && t.kind !== "pending") {
    setTimeout(() => dismissToast(id), t.ttlMs);
  }
  return id;
}

export function updateToast(id: number, patch: Partial<Omit<Toast, "id">>) {
  _toasts = _toasts.map((t) => (t.id === id ? { ...t, ...patch } : t));
  emit();
  const updated = _toasts.find((t) => t.id === id);
  if (updated && updated.ttlMs && updated.kind !== "pending") {
    setTimeout(() => dismissToast(id), updated.ttlMs);
  }
}

export function dismissToast(id: number) {
  _toasts = _toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      _listeners.add(cb);
      return () => _listeners.delete(cb);
    },
    () => _toasts,
    () => _toasts, // SSR snapshot (always empty server-side)
  );
}
