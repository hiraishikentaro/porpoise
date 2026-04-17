import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "system" | "dark" | "light";

export type Settings = {
  theme: ThemeMode;
  /** base font-size in px (Tailwind の rem スケールに効く) */
  fontScale: number;
  /** SQL エディタ / フォーマッタの tab 幅 */
  tabWidth: 2 | 4;
  /** 破壊的操作 (スニペット削除など) の前に confirm を出すか */
  confirmDestructive: boolean;
};

const DEFAULTS: Settings = {
  theme: "dark",
  fontScale: 14,
  tabWidth: 2,
  confirmDestructive: true,
};

const STORAGE_KEY = "porpoise.settings.v1";

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      theme: normalizeTheme(parsed.theme),
      fontScale: clamp(parsed.fontScale ?? DEFAULTS.fontScale, 11, 18),
      tabWidth: parsed.tabWidth === 4 ? 4 : 2,
      confirmDestructive: parsed.confirmDestructive !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

function normalizeTheme(v: unknown): ThemeMode {
  return v === "light" || v === "system" ? v : "dark";
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type Ctx = {
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
  /** 現在の「解決済み」テーマ (system を OS に従い dark/light に解決した値) */
  resolvedTheme: "dark" | "light";
};

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  );

  // localStorage に永続化 (debounce 不要、設定変更は稀)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // noop
    }
  }, [settings]);

  // 解決済みテーマ
  const resolvedTheme: "dark" | "light" = useMemo(() => {
    if (settings.theme === "system") return systemPrefersDark ? "dark" : "light";
    return settings.theme;
  }, [settings.theme, systemPrefersDark]);

  // system mode の変化を購読
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // html に class 反映
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.classList.toggle("light", resolvedTheme === "light");
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  // font-size 反映 (html の base font-size → Tailwind の rem 全部に効く)
  useEffect(() => {
    document.documentElement.style.fontSize = `${settings.fontScale}px`;
    return () => {
      document.documentElement.style.fontSize = "";
    };
  }, [settings.fontScale]);

  const update = useCallback<Ctx["update"]>((key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULTS);
  }, []);

  const value = useMemo<Ctx>(
    () => ({ settings, update, reset, resolvedTheme }),
    [settings, update, reset, resolvedTheme],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}

/**
 * Destructive な操作に confirm を出す。settings.confirmDestructive が false なら
 * 無条件で true を返す。
 */
export function useConfirm(): (message: string) => boolean {
  const { settings } = useSettings();
  return useCallback(
    (message: string) => {
      if (!settings.confirmDestructive) return true;
      return window.confirm(message);
    },
    [settings.confirmDestructive],
  );
}
