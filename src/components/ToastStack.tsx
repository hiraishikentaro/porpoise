import type { ToastKind } from "@/lib/toast";
import { useToast } from "@/lib/toast";

/**
 * 右下にスタックする toast 表示。最新が下端、古いものが上に積まれる。
 * `useToast().push(...)` で発火。
 */
export function ToastStack() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-[80] flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem
          key={t.id}
          kind={t.kind}
          title={t.title}
          message={t.message}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </div>
  );
}

function ToastItem({
  kind,
  title,
  message,
  onDismiss,
}: {
  kind: ToastKind;
  title?: string;
  message: string;
  onDismiss: () => void;
}) {
  const accentClass =
    kind === "success"
      ? "before:bg-[var(--cyan)]"
      : kind === "error"
        ? "before:bg-destructive"
        : "before:bg-accent";
  return (
    <div
      role="status"
      className={`pointer-events-auto relative flex min-w-[260px] max-w-sm items-start gap-3 overflow-hidden rounded-md border border-border bg-popover px-3 py-2 pl-4 text-[0.78rem] text-foreground shadow-[0_8px_24px_-8px_oklch(0_0_0/55%),0_0_0_1px_oklch(1_0_0/3%)_inset] before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${accentClass} animate-in fade-in slide-in-from-bottom-2`}
    >
      <div className="flex flex-1 flex-col gap-0.5 leading-snug">
        {title && (
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/80">
            {title}
          </span>
        )}
        <span className="break-words">{message}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="-mr-1 -mt-0.5 shrink-0 rounded-sm px-1 text-muted-foreground/60 transition-colors hover:text-foreground"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
