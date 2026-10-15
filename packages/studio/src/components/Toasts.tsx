/**
 * KLI — Toasts
 *
 * Transient notifications rendered above every other layer (z-index above the
 * command palette and the drawers). They come from real failures and successes
 * of the app's own actions — attaching a workspace file, copying a path,
 * connecting to the harness — and auto-dismiss after a few seconds. The queue
 * lives in the app store but is deliberately **not** persisted.
 */

import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { Toast } from '@/types';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';

const ICONS: Record<Toast['variant'], typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
};

const TONES: Record<Toast['variant'], string> = {
  info: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

const AUTO_DISMISS_MS = 6000;

export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notificaciones"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useStore((state) => state.dismissToast);
  const Icon = ICONS[toast.variant];

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, dismissToast]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg',
        'animate-fade-in',
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[toast.variant])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="mt-0.5 break-words text-xs text-muted-foreground">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Cerrar notificación"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
