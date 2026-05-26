"use client";

import { useToasts, dismissToast, type Toast } from "@/lib/toast";

export function Toaster() {
  const toasts = useToasts();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToastCard({ t }: { t: Toast }) {
  const tone =
    t.kind === "success" ? "border-accent text-accent" :
    t.kind === "error"   ? "border-danger text-danger" :
    t.kind === "pending" ? "border-warn   text-warn"   :
    "border-border text-text";

  const icon =
    t.kind === "success" ? "✓" :
    t.kind === "error"   ? "✕" :
    t.kind === "pending" ? <Spinner /> :
    "·";

  return (
    <div className={`bg-panel border ${tone} rounded-lg shadow-lg p-3 text-xs flex items-start gap-3 min-w-[260px]`}>
      <div className="mt-0.5 flex items-center justify-center w-5 h-5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{t.title}</div>
        {t.message && (
          <div className="text-muted mt-0.5 break-words">{t.message}</div>
        )}
        {t.hash && (
          <a
            href={`https://etherscan.io/tx/${t.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted hover:text-accent underline mt-1 inline-block"
          >
            view tx ↗
          </a>
        )}
      </div>
      <button
        onClick={() => dismissToast(t.id)}
        className="text-muted hover:text-text px-1"
        aria-label="close"
      >
        ×
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3"/>
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}
