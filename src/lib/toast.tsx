import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: string;
  kind: ToastKind;
  title?: string;
  message: string;
  /** ms, 0 で永続 (手動 dismiss のみ) */
  duration?: number;
};

type Ctx = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<Ctx | null>(null);

const DEFAULT_DURATION = 3500;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t-${Date.now().toString(36)}-${seq}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId();
      const duration = t.duration ?? DEFAULT_DURATION;
      setToasts((prev) => [...prev, { ...t, id }]);
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>{children}</ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
