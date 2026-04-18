import { useEffect } from "react";
import { useT } from "@/lib/i18n";

type Shortcut = { keys: string[]; descKey: Parameters<ReturnType<typeof useT>>[0] };
type Group = { titleKey: Parameters<ReturnType<typeof useT>>[0]; items: Shortcut[] };

const GROUPS: Group[] = [
  {
    titleKey: "shortcuts.group.global",
    items: [
      { keys: ["⌘", "K"], descKey: "shortcuts.item.palette" },
      { keys: ["⌘", ","], descKey: "shortcuts.item.settings" },
      { keys: ["⌘", "/"], descKey: "shortcuts.item.help" },
      { keys: ["⌘", "S"], descKey: "shortcuts.item.sidebar" },
      { keys: ["⌘", "+"], descKey: "shortcuts.item.fontIn" },
      { keys: ["⌘", "-"], descKey: "shortcuts.item.fontOut" },
    ],
  },
  {
    titleKey: "shortcuts.group.tabs",
    items: [
      { keys: ["⌘", "T"], descKey: "shortcuts.item.newTab" },
      { keys: ["⌘", "W"], descKey: "shortcuts.item.closeTab" },
    ],
  },
  {
    titleKey: "shortcuts.group.editor",
    items: [
      { keys: ["⌘", "↵"], descKey: "shortcuts.item.runAt" },
      { keys: ["⇧", "⌘", "↵"], descKey: "shortcuts.item.runAll" },
      { keys: ["⌥", "↵"], descKey: "shortcuts.item.explain" },
      { keys: ["⇧", "⌘", "F"], descKey: "shortcuts.item.format" },
      { keys: ["⇧", "⌘", "D"], descKey: "shortcuts.item.splitRight" },
      { keys: ["⌘", "F"], descKey: "shortcuts.item.filterResults" },
    ],
  },
  {
    titleKey: "shortcuts.group.table",
    items: [
      { keys: ["dblclick"], descKey: "shortcuts.item.editCellDbl" },
      { keys: ["↵"], descKey: "shortcuts.item.editCellEnter" },
      { keys: ["right-click"], descKey: "shortcuts.item.rowActions" },
      { keys: ["dblclick"], descKey: "shortcuts.item.openTable" },
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
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
            <h2 className="font-display text-[1.02rem] font-medium tracking-tight">
              {t("shortcuts.title")}
            </h2>
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
            <section key={g.titleKey} className="flex flex-col gap-1.5">
              <h3 className="tp-section-title">{t(g.titleKey)}</h3>
              <dl className="flex flex-col divide-y divide-border/40">
                {g.items.map((s) => (
                  <div
                    key={`${g.titleKey}:${s.descKey}`}
                    className="flex items-center justify-between gap-4 py-1.5"
                  >
                    <dt className="text-[0.82rem] text-foreground/90">{t(s.descKey)}</dt>
                    <dd className="flex items-center gap-1">
                      {s.keys.map((k) => (
                        <span key={`${s.descKey}-${k}`} className="tp-kbd px-1.5">
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
            {t("shortcuts.pressEscToClose")}
          </span>
        </footer>
      </div>
    </div>
  );
}
