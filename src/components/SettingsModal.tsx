import { useEffect } from "react";
import { type ThemeMode, useSettings } from "@/lib/settings";

type Props = {
  onClose: () => void;
};

export function SettingsModal({ onClose }: Props) {
  const { settings, update, reset, resolvedTheme } = useSettings();

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
        className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/50%),0_0_0_1px_oklch(1_0_0/4%)_inset]"
        role="dialog"
        aria-label="Settings"
      >
        <header className="flex items-baseline justify-between border-b border-border bg-sidebar/30 px-5 py-3">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/80">
              Preferences
            </span>
            <h2 className="font-display text-[1.02rem] font-medium tracking-tight">Settings</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-5 p-5">
          <Field
            label="Theme"
            hint={settings.theme === "system" ? `follows OS → ${resolvedTheme}` : undefined}
          >
            <SegmentedControl<ThemeMode>
              value={settings.theme}
              options={[
                { value: "system", label: "System" },
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
              onChange={(v) => update("theme", v)}
            />
          </Field>

          <Field label="Font size" hint={`${settings.fontScale}px base — 全体がスケール`}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={11}
                max={18}
                step={0.5}
                value={settings.fontScale}
                onChange={(e) => update("fontScale", Number(e.currentTarget.value))}
                className="flex-1 accent-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => update("fontScale", 14)}
                className="rounded-md border border-border px-2 py-0.5 text-[0.62rem] uppercase tracking-wider text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent"
              >
                Reset
              </button>
            </div>
          </Field>

          <Field label="Editor tab width">
            <SegmentedControl<2 | 4>
              value={settings.tabWidth}
              options={[
                { value: 2, label: "2" },
                { value: 4, label: "4" },
              ]}
              onChange={(v) => update("tabWidth", v)}
            />
          </Field>

          <Field
            label="Confirm destructive"
            hint="スニペット削除・履歴クリアなどで window.confirm を出す"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={settings.confirmDestructive}
                onChange={(e) => update("confirmDestructive", e.currentTarget.checked)}
              />
              <span>Ask before destructive actions</span>
            </label>
          </Field>
        </div>

        <footer className="flex items-center justify-between border-t border-border bg-sidebar/20 px-5 py-3">
          <button
            type="button"
            onClick={reset}
            className="text-[0.7rem] uppercase tracking-wider text-muted-foreground transition-colors hover:text-destructive"
          >
            Reset to defaults
          </button>
          <button type="button" onClick={onClose} className="tp-btn tp-btn-primary">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="tp-section-title">{label}</span>
        {hint && <span className="truncate text-[0.66rem] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-fit overflow-hidden rounded-md border border-border text-[0.7rem]">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1 font-semibold uppercase tracking-wider transition-colors ${
              active
                ? "bg-foreground text-background"
                : "bg-transparent text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
