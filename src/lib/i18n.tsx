import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useSettings } from "@/lib/settings";

export type Locale = "en" | "ja";

type Messages = {
  // Settings modal
  "settings.title": string;
  "settings.theme.label": string;
  "settings.theme.system": string;
  "settings.theme.dark": string;
  "settings.theme.light": string;
  "settings.fontSize.label": string;
  "settings.fontSize.hint": (size: number) => string;
  "settings.tabWidth.label": string;
  "settings.tabWidth.hint": string;
  "settings.confirm.label": string;
  "settings.confirm.hint": string;
  "settings.language.label": string;
  "settings.language.auto": string;
  "settings.language.en": string;
  "settings.language.ja": string;
  "settings.reset": string;
  "settings.done": string;

  // Shortcuts modal
  "shortcuts.title": string;
  "shortcuts.group.global": string;
  "shortcuts.group.tabs": string;
  "shortcuts.group.editor": string;
  "shortcuts.group.table": string;
  "shortcuts.pressEscToClose": string;
  "shortcuts.item.palette": string;
  "shortcuts.item.settings": string;
  "shortcuts.item.help": string;
  "shortcuts.item.sidebar": string;
  "shortcuts.item.fontIn": string;
  "shortcuts.item.fontOut": string;
  "shortcuts.item.newTab": string;
  "shortcuts.item.closeTab": string;
  "shortcuts.item.runAt": string;
  "shortcuts.item.runAll": string;
  "shortcuts.item.explain": string;
  "shortcuts.item.format": string;
  "shortcuts.item.splitRight": string;
  "shortcuts.item.filterResults": string;
  "shortcuts.item.editCellDbl": string;
  "shortcuts.item.editCellEnter": string;
  "shortcuts.item.rowActions": string;
  "shortcuts.item.openTable": string;

  // Command palette
  "cmdk.placeholder": string;
  "cmdk.noMatches": string;
  "cmdk.counter": (matched: number, total: number) => string;
  "cmdk.select": string;
  "cmdk.nav": string;
  "cmdk.close": string;
  "cmdk.action.newSql": string;
  "cmdk.action.newConnection": string;
  "cmdk.action.closeTab": string;
  "cmdk.action.openSettings": string;
  "cmdk.action.showShortcuts": string;
  "cmdk.action.toggleTheme": string;
  "cmdk.action.toggleSidebar": string;

  // Status bar
  "status.noConnection": string;
  "status.rows": (n: number) => string;
  "status.ms": string;
  "status.pending": (n: number) => string;
  "status.connections": (n: number) => string;
  "status.tabs": (n: number) => string;

  // Empty / loading
  "empty.noConnections.title": string;
  "empty.noConnections.desc": string;
  "empty.browse.title": string;
  "empty.browse.desc": string;
  "empty.noRowsFiltered.title": string;
  "empty.noRowsFiltered.desc": string;
  "empty.noRows.title": string;
  "empty.noRows.desc": string;
  "empty.runQuery.title": string;
  "empty.runQuery.desc": string;

  // TableView filter bar
  "filter.toggleBtn": string;
  "filter.noFilters": string;
  "filter.add": string;
  "filter.sql": string;
  "filter.unset": string;
  "filter.applyAll": string;
  "filter.apply": string;
  "filter.applied": string;
  "filter.valuePlaceholder": string;
  "filter.noValue": string;
  "filter.quickHeaderLabel": (col: string) => string;
  "filter.quickRowLabel": (col: string) => string;
  "filter.filterWithColumn": string;
  "filter.copyAs": (n: number) => string;

  // TableView general
  "table.row.delete": string;
  "table.row.undo": string;
  "table.discardNew": string;
  "table.readOnly": string;
  "table.filtered": string;
  "table.loading": string;
  "table.columns": string;
  "table.filters": string;
  "table.commit": string;
  "table.discard": string;
  "table.refresh": string;
  "table.addRow": string;
  "table.copied": (n: number, fmt: string) => string;
  "table.copyFailed": string;
  "table.commit.note": string;

  // SqlEditor
  "editor.dbPlaceholder": string;
  "editor.run": string;
  "editor.runAll": string;
  "editor.explain": string;
  "editor.format": string;
  "editor.history": string;
  "editor.snippets": string;
  "editor.running": string;
  "editor.closePane": string;
  "editor.split": string;
  "editor.cancel": string;
  "editor.cancelled": string;

  // Connection form
  "conn.save": string;
  "conn.saveAndOpen": string;
  "conn.cancel": string;
  "conn.test": string;
  "conn.delete": string;
  "conn.open": string;
  "conn.close": string;
  "conn.connecting": string;
  "conn.closing": string;
  "conn.connectingTitle": (name: string) => string;
  "conn.connectingDesc": string;
};

const EN: Messages = {
  "settings.title": "Settings",
  "settings.theme.label": "Theme",
  "settings.theme.system": "System",
  "settings.theme.dark": "Dark",
  "settings.theme.light": "Light",
  "settings.fontSize.label": "Font size",
  "settings.fontSize.hint": (n) => `${n}px base — everything scales`,
  "settings.tabWidth.label": "Tab width",
  "settings.tabWidth.hint": "Editor / formatter indentation",
  "settings.confirm.label": "Confirm destructive actions",
  "settings.confirm.hint": "Show window.confirm on snippet delete, clear history, etc.",
  "settings.language.label": "Language",
  "settings.language.auto": "Auto",
  "settings.language.en": "English",
  "settings.language.ja": "日本語",
  "settings.reset": "Reset to defaults",
  "settings.done": "Done",

  "shortcuts.title": "Shortcuts",
  "shortcuts.group.global": "Global",
  "shortcuts.group.tabs": "Tabs",
  "shortcuts.group.editor": "SQL Editor",
  "shortcuts.group.table": "Table view",
  "shortcuts.pressEscToClose": "Press esc to close",
  "shortcuts.item.palette": "Command palette (actions, connections, tables; ⌘P also works)",
  "shortcuts.item.settings": "Open Settings",
  "shortcuts.item.help": "Show this help",
  "shortcuts.item.sidebar": "Toggle connections sidebar",
  "shortcuts.item.fontIn": "Increase font size",
  "shortcuts.item.fontOut": "Decrease font size",
  "shortcuts.item.newTab": "New SQL editor tab (on active connection)",
  "shortcuts.item.closeTab": "Close active tab",
  "shortcuts.item.runAt": "Run statement at cursor",
  "shortcuts.item.runAll": "Run all statements",
  "shortcuts.item.explain": "EXPLAIN this statement",
  "shortcuts.item.format": "Format SQL",
  "shortcuts.item.splitRight": "Split pane right",
  "shortcuts.item.filterResults": "Filter results (when editor not focused)",
  "shortcuts.item.editCellDbl": "Edit cell",
  "shortcuts.item.editCellEnter": "Edit cell (when selected)",
  "shortcuts.item.rowActions": "Row actions (delete / undo)",
  "shortcuts.item.openTable": "Open in new tab",

  "cmdk.placeholder": "Type a command, connection, or table…",
  "cmdk.noMatches": "No matches.",
  "cmdk.counter": (m, t) => `${m} of ${t}`,
  "cmdk.select": "select",
  "cmdk.nav": "nav",
  "cmdk.close": "close",
  "cmdk.action.newSql": "New SQL Editor Tab",
  "cmdk.action.newConnection": "New Connection",
  "cmdk.action.closeTab": "Close Active Tab",
  "cmdk.action.openSettings": "Open Settings",
  "cmdk.action.showShortcuts": "Show Keyboard Shortcuts",
  "cmdk.action.toggleTheme": "Toggle Theme (Dark / Light / System)",
  "cmdk.action.toggleSidebar": "Toggle Connections Sidebar",

  "status.noConnection": "no connection",
  "status.rows": (n) => `${n.toLocaleString("en-US")} rows`,
  "status.ms": "ms",
  "status.pending": (n) => `${n} pending`,
  "status.connections": (n) => `${n} conn`,
  "status.tabs": (n) => `${n} tab${n === 1 ? "" : "s"}`,

  "empty.noConnections.title": "No connections yet",
  "empty.noConnections.desc":
    "Save your first MySQL connection to get started. Tap the + button above.",
  "empty.browse.title": "Pick a table to browse",
  "empty.browse.desc":
    "Choose a database in the left column, then click a table. Double-click to open it in its own tab.",
  "empty.noRowsFiltered.title": "No rows match your filters",
  "empty.noRowsFiltered.desc": "Try adjusting the filters or hit Unset to clear them.",
  "empty.noRows.title": "No rows",
  "empty.noRows.desc": "This table has no rows yet. Use + Row to add one if the table is editable.",
  "empty.runQuery.title": "Run a query",
  "empty.runQuery.desc":
    "Press ⌘↵ to run the statement at cursor, or ⇧⌘↵ to run every statement in the editor.",

  "filter.toggleBtn": "Filter",
  "filter.noFilters": "No filters.",
  "filter.add": "+ Filter",
  "filter.sql": "SQL",
  "filter.unset": "Unset",
  "filter.applyAll": "Apply All",
  "filter.apply": "Apply",
  "filter.applied": "Applied",
  "filter.valuePlaceholder": "value",
  "filter.noValue": "— no value —",
  "filter.quickHeaderLabel": (col) => `Column · ${col}`,
  "filter.quickRowLabel": (col) => `Quick filter · ${col}`,
  "filter.filterWithColumn": "Filter with this column…",
  "filter.copyAs": (n) => `Copy ${n > 1 ? `${n} rows` : "row"} as`,

  "table.row.delete": "Delete row",
  "table.row.undo": "Undo delete",
  "table.discardNew": "Discard new row",
  "table.readOnly": "read-only",
  "table.filtered": "filtered",
  "table.loading": "loading",
  "table.columns": "Columns",
  "table.filters": "Filters",
  "table.commit": "Commit",
  "table.discard": "Discard",
  "table.refresh": "Refresh",
  "table.addRow": "+ Row",
  "table.copied": (n, fmt) => `Copied ${n} row${n > 1 ? "s" : ""} as ${fmt}`,
  "table.copyFailed": "Copy failed",
  "table.commit.note":
    "Changes are committed in a single transaction. If the impact exceeds the expected row count, the commit is automatically rolled back.",

  "editor.dbPlaceholder": "(no database)",
  "editor.run": "Run",
  "editor.runAll": "Run All",
  "editor.explain": "Explain",
  "editor.format": "Format",
  "editor.history": "History",
  "editor.snippets": "Snippets",
  "editor.running": "Running",
  "editor.closePane": "Close pane",
  "editor.split": "Split",
  "editor.cancel": "Cancel",
  "editor.cancelled": "Query cancelled",

  "conn.save": "Save",
  "conn.saveAndOpen": "Save & Open",
  "conn.cancel": "Cancel",
  "conn.test": "Test",
  "conn.delete": "Delete",
  "conn.open": "Open",
  "conn.close": "Close",
  "conn.connecting": "Connecting…",
  "conn.closing": "Closing…",
  "conn.connectingTitle": (name) => `Connecting to ${name}…`,
  "conn.connectingDesc":
    "Establishing connection — this may take a few seconds over SSH. Please wait.",
};

const JA: Messages = {
  "settings.title": "設定",
  "settings.theme.label": "テーマ",
  "settings.theme.system": "システム",
  "settings.theme.dark": "ダーク",
  "settings.theme.light": "ライト",
  "settings.fontSize.label": "フォントサイズ",
  "settings.fontSize.hint": (n) => `${n}px ベース — 全体がスケール`,
  "settings.tabWidth.label": "タブ幅",
  "settings.tabWidth.hint": "エディタ・フォーマッタのインデント",
  "settings.confirm.label": "破壊的操作の確認",
  "settings.confirm.hint": "スニペット削除・履歴クリアなどで window.confirm を出す",
  "settings.language.label": "言語",
  "settings.language.auto": "自動",
  "settings.language.en": "English",
  "settings.language.ja": "日本語",
  "settings.reset": "デフォルトに戻す",
  "settings.done": "完了",

  "shortcuts.title": "ショートカット",
  "shortcuts.group.global": "グローバル",
  "shortcuts.group.tabs": "タブ",
  "shortcuts.group.editor": "SQL エディタ",
  "shortcuts.group.table": "テーブルビュー",
  "shortcuts.pressEscToClose": "esc で閉じる",
  "shortcuts.item.palette": "コマンドパレット (アクション / 接続 / テーブル。⌘P でも可)",
  "shortcuts.item.settings": "設定を開く",
  "shortcuts.item.help": "このヘルプを表示",
  "shortcuts.item.sidebar": "接続サイドバー開閉",
  "shortcuts.item.fontIn": "フォントを大きく",
  "shortcuts.item.fontOut": "フォントを小さく",
  "shortcuts.item.newTab": "新規 SQL エディタタブ (アクティブ接続で)",
  "shortcuts.item.closeTab": "アクティブタブを閉じる",
  "shortcuts.item.runAt": "カーソル位置のクエリ実行",
  "shortcuts.item.runAll": "全クエリ実行",
  "shortcuts.item.explain": "EXPLAIN",
  "shortcuts.item.format": "SQL 整形",
  "shortcuts.item.splitRight": "右に分割",
  "shortcuts.item.filterResults": "結果を絞り込み (エディタ非フォーカス時)",
  "shortcuts.item.editCellDbl": "セル編集",
  "shortcuts.item.editCellEnter": "セル編集 (選択時)",
  "shortcuts.item.rowActions": "行アクション (削除 / 戻す)",
  "shortcuts.item.openTable": "新規タブで開く",

  "cmdk.placeholder": "アクション・接続・テーブル…",
  "cmdk.noMatches": "一致なし。",
  "cmdk.counter": (m, t) => `${m} / ${t}`,
  "cmdk.select": "選択",
  "cmdk.nav": "移動",
  "cmdk.close": "閉じる",
  "cmdk.action.newSql": "新しい SQL エディタタブ",
  "cmdk.action.newConnection": "新しい接続",
  "cmdk.action.closeTab": "アクティブタブを閉じる",
  "cmdk.action.openSettings": "設定を開く",
  "cmdk.action.showShortcuts": "ショートカットを表示",
  "cmdk.action.toggleTheme": "テーマ切替 (Dark / Light / System)",
  "cmdk.action.toggleSidebar": "接続サイドバーを開閉",

  "status.noConnection": "接続なし",
  "status.rows": (n) => `${n.toLocaleString("ja-JP")} 行`,
  "status.ms": "ミリ秒",
  "status.pending": (n) => `${n} 件保留`,
  "status.connections": (n) => `${n} 接続`,
  "status.tabs": (n) => `${n} タブ`,

  "empty.noConnections.title": "接続がありません",
  "empty.noConnections.desc": "最初の MySQL 接続を保存しましょう。上の + を押してください。",
  "empty.browse.title": "テーブルを選んで閲覧",
  "empty.browse.desc":
    "左のカラムから DB を選んで、テーブルをクリック。ダブルクリックで独立タブで開きます。",
  "empty.noRowsFiltered.title": "条件に合う行がありません",
  "empty.noRowsFiltered.desc": "フィルタを調整するか Unset で全解除してください。",
  "empty.noRows.title": "行がありません",
  "empty.noRows.desc": "このテーブルには行がありません。編集可能なら + Row で追加できます。",
  "empty.runQuery.title": "クエリを実行",
  "empty.runQuery.desc": "⌘↵ でカーソル位置のステートメント、⇧⌘↵ で全ステートメントを実行します。",

  "filter.toggleBtn": "フィルタ",
  "filter.noFilters": "フィルタなし。",
  "filter.add": "+ フィルタ",
  "filter.sql": "SQL",
  "filter.unset": "Unset",
  "filter.applyAll": "Apply All",
  "filter.apply": "Apply",
  "filter.applied": "Applied",
  "filter.valuePlaceholder": "値",
  "filter.noValue": "— 値なし —",
  "filter.quickHeaderLabel": (col) => `列 · ${col}`,
  "filter.quickRowLabel": (col) => `クイックフィルタ · ${col}`,
  "filter.filterWithColumn": "この列でフィルタ…",
  "filter.copyAs": (n) => `${n > 1 ? `${n} 行` : "行"} をコピー:`,

  "table.row.delete": "行を削除",
  "table.row.undo": "削除を戻す",
  "table.discardNew": "新規行を破棄",
  "table.readOnly": "読み取り専用",
  "table.filtered": "フィルタ適用",
  "table.loading": "読み込み中",
  "table.columns": "列",
  "table.filters": "フィルタ",
  "table.commit": "コミット",
  "table.discard": "破棄",
  "table.refresh": "再読み込み",
  "table.addRow": "+ 行",
  "table.copied": (n, fmt) => `${n} 行を ${fmt} でコピーしました`,
  "table.copyFailed": "コピー失敗",
  "table.commit.note":
    "変更は 1 つのトランザクションでコミットされます。影響行が想定より多い場合は自動ロールバックします。",

  "editor.dbPlaceholder": "(DB 未選択)",
  "editor.run": "実行",
  "editor.runAll": "全実行",
  "editor.explain": "EXPLAIN",
  "editor.format": "整形",
  "editor.history": "履歴",
  "editor.snippets": "スニペット",
  "editor.running": "実行中",
  "editor.closePane": "ペインを閉じる",
  "editor.split": "分割",
  "editor.cancel": "キャンセル",
  "editor.cancelled": "クエリをキャンセルしました",

  "conn.save": "保存",
  "conn.saveAndOpen": "保存して開く",
  "conn.cancel": "キャンセル",
  "conn.test": "テスト",
  "conn.delete": "削除",
  "conn.open": "開く",
  "conn.close": "閉じる",
  "conn.connecting": "接続中…",
  "conn.closing": "切断中…",
  "conn.connectingTitle": (name) => `${name} に接続中…`,
  "conn.connectingDesc": "SSH 経由だと数秒かかる場合があります。しばらくお待ちください。",
};

const DICTS: Record<Locale, Messages> = { en: EN, ja: JA };

function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase();
  return lang.startsWith("ja") ? "ja" : "en";
}

type TFn = <K extends keyof Messages>(
  key: K,
  ...args: Messages[K] extends (...a: infer A) => string ? A : []
) => string;

type Ctx = {
  locale: Locale;
  t: TFn;
};

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const locale: Locale = useMemo(() => {
    if (settings.locale === "auto") return detectLocale();
    return settings.locale;
  }, [settings.locale]);

  const value = useMemo<Ctx>(() => {
    const dict = DICTS[locale];
    const t: TFn = (key, ...args) => {
      const v = dict[key];
      if (typeof v === "function") {
        // biome-ignore lint/suspicious/noExplicitAny: args are narrowed via TFn signature
        return (v as (...a: any[]) => string)(...args);
      }
      return v;
    };
    return { locale, t };
  }, [locale]);

  // html lang 属性を同期
  useMemo(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", locale);
    }
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used inside I18nProvider");
  return ctx.t;
}

export function useLocale(): Locale {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLocale must be used inside I18nProvider");
  return ctx.locale;
}
