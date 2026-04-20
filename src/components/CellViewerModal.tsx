import { useEffect, useState } from "react";

type Props = {
  column: string;
  value: string | null;
  onClose: () => void;
};

/**
 * セル値のフルテキストを read-only で見るモーダル。
 * JSON っぽければ整形表示、その他は monospaced のままで折り返し。
 * Esc / 背景クリック / ✕ で閉じる。
 */
export function CellViewerModal({ column, value, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const display = formatForDisplay(value);
  const isJson = display.kind === "json";

  async function copy() {
    try {
      await navigator.clipboard.writeText(value ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // noop
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-6 pt-[10vh] backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 z-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label={`Value of ${column}`}
        className="relative z-10 flex w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/60%),0_0_0_1px_oklch(1_0_0/3%)_inset]"
      >
        <header className="flex items-baseline justify-between border-b border-border bg-sidebar/30 px-5 py-3">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/80">
              Cell · {isJson ? "JSON" : value === null ? "NULL" : "TEXT"}
            </span>
            <h2 className="font-display text-[1rem] font-medium tracking-tight">{column}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-border px-2 py-0.5 text-[0.7rem] text-muted-foreground transition-colors hover:border-accent hover:text-accent"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>
        {value === null ? (
          <div className="px-5 py-6 text-sm italic text-muted-foreground/70">NULL</div>
        ) : (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-5 py-3 font-mono text-[0.78rem] leading-relaxed text-foreground">
            {display.text}
          </pre>
        )}
        <footer className="flex items-center justify-end border-t border-border bg-sidebar/20 px-5 py-2">
          <span className="text-[0.65rem] text-muted-foreground/70">
            esc to close · {value === null ? 0 : value.length} chars
          </span>
        </footer>
      </div>
    </div>
  );
}

function formatForDisplay(value: string | null): { kind: "json" | "text"; text: string } {
  if (value === null) return { kind: "text", text: "" };
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return { kind: "json", text: JSON.stringify(parsed, null, 2) };
    } catch {
      // fall through
    }
  }
  return { kind: "text", text: value };
}
