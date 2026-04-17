import { useEffect } from "react";

type Shortcut = { keys: string[]; desc: string };
type Group = { title: string; items: Shortcut[] };

const GROUPS: Group[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘", ","], desc: "Open Settings" },
      { keys: ["⌘", "/"], desc: "Show this help" },
      { keys: ["⌘", "S"], desc: "Toggle connections sidebar" },
    ],
  },
  {
    title: "Tabs",
    items: [
      { keys: ["⌘", "T"], desc: "New SQL editor tab (on active connection)" },
      { keys: ["⌘", "W"], desc: "Close active tab" },
      { keys: ["⌘", "P"], desc: "Search tables across databases (fuzzy)" },
    ],
  },
  {
    title: "SQL Editor",
    items: [
      { keys: ["⌘", "↵"], desc: "Run statement at cursor" },
      { keys: ["⇧", "⌘", "↵"], desc: "Run all statements" },
      { keys: ["⌥", "↵"], desc: "EXPLAIN this statement" },
      { keys: ["⇧", "⌘", "F"], desc: "Format SQL" },
    ],
  },
  {
    title: "Table view",
    items: [
      { keys: ["dblclick"], desc: "Edit cell" },
      { keys: ["↵"], desc: "Edit cell (when selected)" },
      { keys: ["right-click"], desc: "Row actions (delete / undo)" },
      { keys: ["dblclick", "on table"], desc: "Open in new tab" },
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-6 pt-[10vh] backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 z-0 cursor-default"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/50%),0_0_0_1px_oklch(1_0_0/4%)_inset]"
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <header className="flex items-baseline justify-between border-b border-border bg-sidebar/30 px-5 py-3">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/80">
              Keyboard
            </span>
            <h2 className="font-display text-[1.02rem] font-medium tracking-tight">Shortcuts</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close shortcuts"
          >
            ✕
          </button>
        </header>
        <div className="flex max-h-[65vh] flex-col gap-5 overflow-auto p-5">
          {GROUPS.map((g) => (
            <section key={g.title} className="flex flex-col gap-1.5">
              <h3 className="tp-section-title">{g.title}</h3>
              <dl className="flex flex-col divide-y divide-border/40">
                {g.items.map((s) => (
                  <div
                    key={`${g.title}:${s.desc}`}
                    className="flex items-center justify-between gap-4 py-1.5"
                  >
                    <dt className="text-[0.82rem] text-foreground/90">{s.desc}</dt>
                    <dd className="flex items-center gap-1">
                      {s.keys.map((k) => (
                        <span key={`${s.desc}-${k}`} className="tp-kbd px-1.5">
                          {k}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border bg-sidebar/20 px-5 py-2">
          <span className="text-[0.65rem] text-muted-foreground/70">
            Press <span className="tp-kbd">esc</span> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
