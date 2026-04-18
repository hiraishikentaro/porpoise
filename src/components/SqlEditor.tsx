import { autocompletion } from "@codemirror/autocomplete";
import { MySQL, sql as sqlLang } from "@codemirror/lang-sql";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import { type CopyFormat, formatRowsAs } from "@/lib/row-format";
import { useSettings } from "@/lib/settings";
import { sqlLinter } from "@/lib/sql-lint";
import {
  clearQueryHistory,
  deleteSnippet,
  type ExportFormat,
  executeQuery,
  exportQuery,
  listDatabases,
  listQueryHistory,
  listSnippets,
  type QueryHistoryRow,
  type QueryResult,
  type SavedQuery,
  type SchemaSnapshot,
  saveSnippet,
  schemaSnapshot,
  updateSnippet,
} from "@/lib/tauri";

type Props = {
  connectionId: string;
  initialSql: string;
  initialDatabase: string | null;
  onChange: (sql: string) => void;
  onDatabaseChange: (database: string | null) => void;
  /** 履歴から SQL を新規エディタタブとして開く */
  onOpenInNewEditor?: (sql: string, database: string | null) => void;
  /** 分割: このエディタの右に新しい pane を追加 */
  onSplit?: () => void;
  /** この pane を閉じる (複数 pane がある時のみ指定される) */
  onClose?: () => void;
};

type RunTabResult =
  | { kind: "ok"; sql: string; result: QueryResult }
  | { kind: "error"; sql: string; message: string };

type RunState =
  | { kind: "idle" }
  | { kind: "running"; index?: number; total?: number }
  | { kind: "error"; message: string }
  | { kind: "done"; tabs: RunTabResult[] };

/**
 * カーソル位置のステートメントを切り出し、エディタ内の開始行も返す。
 * エラー行ハイライトでは relative line を絶対行に変換するのに使う。
 */
function statementAtCursor(view: EditorView): { text: string; startLine: number } {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty) {
    const text = state.doc.sliceString(sel.from, sel.to).trim();
    return { text, startLine: state.doc.lineAt(sel.from).number };
  }
  const doc = state.doc.toString();
  const pos = sel.head;

  // カーソル位置の直前の `;` を探す (文字列中の ; は無視しないが MVP)
  let start = 0;
  for (let i = 0; i < pos; i++) {
    if (doc[i] === ";") start = i + 1;
  }
  let end = doc.length;
  for (let i = pos; i < doc.length; i++) {
    if (doc[i] === ";") {
      end = i;
      break;
    }
  }
  // 先頭の空白を除いた位置で行番号を取る
  let firstNonWs = start;
  while (firstNonWs < end && /\s/.test(doc[firstNonWs])) firstNonWs++;
  return {
    text: doc.slice(start, end).trim(),
    startLine: state.doc.lineAt(firstNonWs).number,
  };
}

/**
 * ; で区切られた複数ステートメントを配列に分割する。
 * ' " ` で囲まれた string 内の ; や -- / * ... * / コメント内の ; は無視。
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let quote: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      cur += ch;
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      cur += ch;
      if (ch === "*" && next === "/") {
        cur += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === "\\" && next !== undefined) {
        cur += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      cur += `${ch}${next}`;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      cur += `${ch}${next}`;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ";") {
      const trimmed = cur.trim();
      if (trimmed) out.push(trimmed);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * MySQL エラーメッセージから "at line N" を拾う。N はサーバに送った
 * SQL 内でのインデックス (1-origin) なので、統合するときは
 * statement の startLine を足す。
 */
function extractErrorLine(message: string): number | null {
  const m = /at line (\d+)/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** エディタのエラー行ハイライト用 State Effect + Field */
const setErrorLineEffect = StateEffect.define<number | null>();
const errorLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let updated = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLineEffect)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) {
          updated = Decoration.none;
        } else {
          const line = tr.state.doc.line(e.value);
          updated = Decoration.set([
            Decoration.line({ class: "cm-porpoise-error-line" }).range(line.from),
          ]);
        }
      }
    }
    // ユーザーが編集を始めたら自動的にクリア
    if (tr.docChanged && tr.effects.every((e) => !e.is(setErrorLineEffect))) {
      updated = Decoration.none;
    }
    return updated;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const errorLineTheme = EditorView.baseTheme({
  ".cm-porpoise-error-line": {
    backgroundColor: "rgba(247, 118, 142, 0.18)",
    textDecoration: "underline wavy rgba(247, 118, 142, 0.9)",
    textUnderlineOffset: "4px",
  },
});

export function SqlEditor({
  connectionId,
  initialSql,
  initialDatabase,
  onChange,
  onDatabaseChange,
  onOpenInNewEditor,
  onSplit,
  onClose,
}: Props) {
  const [sqlText, setSqlText] = useState(initialSql);
  const [database, setDatabase] = useState<string | null>(initialDatabase);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const { settings } = useSettings();

  // runAt / runAll は keymap に渡すため最新値を ref で保つ
  const sqlTextRef = useRef(sqlText);
  sqlTextRef.current = sqlText;
  const databaseRef = useRef(database);
  databaseRef.current = database;

  useEffect(() => {
    let cancelled = false;
    listDatabases(connectionId)
      .then((list) => {
        if (!cancelled) setDatabases(list);
      })
      .catch(() => {
        // noop — ユーザーが手入力で database を指定することもできる前提
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // DB が決まったらスキーマスナップショット (table → columns) を取得して補完に渡す
  useEffect(() => {
    if (!database) {
      setSchema(null);
      return;
    }
    let cancelled = false;
    schemaSnapshot(connectionId, database)
      .then((snap) => {
        if (!cancelled) setSchema(snap);
      })
      .catch(() => {
        if (!cancelled) setSchema(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, database]);

  const run = useCallback(
    async (sql: string, stmtStartLine: number) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (!trimmed) {
        setRunState({ kind: "error", message: "Empty statement." });
        return;
      }
      viewRef.current?.dispatch({ effects: setErrorLineEffect.of(null) });
      setRunState({ kind: "running" });
      try {
        const result = await executeQuery(connectionId, trimmed, databaseRef.current);
        setRunState({ kind: "done", tabs: [{ kind: "ok", sql: trimmed, result }] });
      } catch (e) {
        const message = String(e);
        setRunState({ kind: "error", message });
        const relLine = extractErrorLine(message);
        if (relLine !== null && viewRef.current) {
          const abs = stmtStartLine + relLine - 1;
          viewRef.current.dispatch({ effects: setErrorLineEffect.of(abs) });
        }
      }
    },
    [connectionId],
  );

  /** 複数ステートメントを順に実行し、全結果をタブに並べる */
  const runMany = useCallback(
    async (sql: string) => {
      const stmts = splitStatements(sql);
      if (stmts.length === 0) {
        setRunState({ kind: "error", message: "Empty statement." });
        return;
      }
      if (stmts.length === 1) {
        await run(stmts[0], 1);
        return;
      }
      viewRef.current?.dispatch({ effects: setErrorLineEffect.of(null) });
      const tabs: RunTabResult[] = [];
      for (let i = 0; i < stmts.length; i++) {
        setRunState({ kind: "running", index: i + 1, total: stmts.length });
        try {
          const result = await executeQuery(connectionId, stmts[i], databaseRef.current);
          tabs.push({ kind: "ok", sql: stmts[i], result });
        } catch (e) {
          tabs.push({ kind: "error", sql: stmts[i], message: String(e) });
          // エラーでも残りは継続 (TablePlus と同じ挙動)
        }
      }
      setRunState({ kind: "done", tabs });
    },
    [connectionId, run],
  );

  const runAt = useCallback(() => {
    if (!viewRef.current) return;
    const { text, startLine } = statementAtCursor(viewRef.current);
    run(text, startLine);
  }, [run]);

  const runAll = useCallback(() => {
    runMany(sqlTextRef.current);
  }, [runMany]);

  const explainAt = useCallback(() => {
    if (!viewRef.current) return;
    const { text, startLine } = statementAtCursor(viewRef.current);
    if (!text) return;
    // 先頭が EXPLAIN なら重ねない
    const already = /^\s*explain\b/i.test(text);
    const wrapped = already ? text : `EXPLAIN ${text}`;
    run(wrapped, startLine);
  }, [run]);

  const replaceEditor = useCallback(
    (sql: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: sql },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
      view.focus();
      setSqlText(sql);
      onChange(sql);
    },
    [onChange],
  );

  const formatDocument = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (!current.trim()) return;
    let formatted: string;
    try {
      formatted = formatSql(current, {
        language: "mysql",
        keywordCase: "upper",
        tabWidth: settings.tabWidth,
      });
    } catch {
      // パースに失敗したら整形だけスキップ (部分入力中など)
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      selection: { anchor: Math.min(view.state.selection.main.head, formatted.length) },
    });
  }, [settings.tabWidth]);

  const extensions = useMemo(() => {
    const schemaConfig = schema
      ? Object.fromEntries(
          Object.entries(schema.tables).map(([table, cols]) => [
            table,
            cols.map((name) => ({ label: name, type: "property" as const })),
          ]),
        )
      : undefined;
    return [
      sqlLang({ dialect: MySQL, schema: schemaConfig, upperCaseKeywords: true }),
      autocompletion(),
      sqlLinter(),
      EditorView.lineWrapping,
      errorLineField,
      errorLineTheme,
      // デフォルト keymap より先にマッチさせるため Prec.highest
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              runAt();
              return true;
            },
          },
          {
            key: "Shift-Mod-Enter",
            preventDefault: true,
            run: () => {
              runAll();
              return true;
            },
          },
          {
            key: "Alt-Enter",
            preventDefault: true,
            run: () => {
              explainAt();
              return true;
            },
          },
          {
            key: "Shift-Mod-f",
            preventDefault: true,
            run: () => {
              formatDocument();
              return true;
            },
          },
        ]),
      ),
    ];
  }, [runAt, runAll, explainAt, schema, formatDocument]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-4 py-1.5 text-xs">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <span>DB</span>
            <select
              value={database ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value;
                const next = v === "" ? null : v;
                setDatabase(next);
                onDatabaseChange(next);
              }}
              className="h-6 rounded-md border border-border bg-input/50 px-1.5 text-xs outline-none focus:border-accent"
            >
              <option value="">(no default)</option>
              {databases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
              {database && !databases.includes(database) && (
                <option value={database}>{database}</option>
              )}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors ${
              historyOpen
                ? "border-chart-3/60 bg-chart-3/10 text-chart-3"
                : "border-border text-muted-foreground hover:border-chart-3/50 hover:text-chart-3"
            }`}
            title="Toggle history & snippets drawer"
          >
            <HistoryIcon />
            History
          </button>
          <button
            type="button"
            onClick={formatDocument}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent"
            title="Format SQL (⇧⌘F)"
          >
            Format
          </button>
          <button
            type="button"
            onClick={explainAt}
            disabled={runState.kind === "running"}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
            title="EXPLAIN this statement (⌥↵)"
          >
            Explain
          </button>
          <button
            type="button"
            onClick={runAt}
            disabled={runState.kind === "running"}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
            title="Run statement at cursor (⌘↵)"
          >
            Run
          </button>
          <button
            type="button"
            onClick={runAll}
            disabled={runState.kind === "running"}
            className="rounded-md border border-accent bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground disabled:opacity-50"
            title="Run all statements (⇧⌘↵)"
          >
            Run all
          </button>
          {onSplit && (
            <button
              type="button"
              onClick={onSplit}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-accent hover:text-accent"
              title="Split pane right (⌘⇧D)"
              aria-label="Split pane right"
            >
              <SplitIcon />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
              title="Close this pane"
              aria-label="Close pane"
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden">
            <CodeMirror
              value={sqlText}
              height="100%"
              theme="dark"
              extensions={extensions}
              onChange={(v) => {
                setSqlText(v);
                onChange(v);
              }}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                indentOnInput: true,
              }}
              className="h-full text-sm"
            />
          </div>
          <ResultsPane
            runState={runState}
            connectionId={connectionId}
            database={database}
            lastSql={sqlTextRef}
          />
        </div>

        {historyOpen && (
          <EditorSideDrawer
            connectionId={connectionId}
            runStateKind={runState.kind}
            getCurrentSql={() => sqlTextRef.current}
            currentDatabase={database}
            onLoad={(sql) => replaceEditor(sql)}
            onOpenNew={onOpenInNewEditor ? (sql, db) => onOpenInNewEditor(sql, db) : undefined}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

type DrawerMode = "history" | "snippets";

function EditorSideDrawer({
  connectionId,
  runStateKind,
  getCurrentSql,
  currentDatabase,
  onLoad,
  onOpenNew,
  onClose,
}: {
  connectionId: string;
  runStateKind: RunState["kind"];
  getCurrentSql: () => string;
  currentDatabase: string | null;
  onLoad: (sql: string) => void;
  onOpenNew?: (sql: string, database: string | null) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<DrawerMode>("history");

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-sidebar/30">
      <header className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border text-[0.65rem]">
          <ModeTabButton active={mode === "history"} onClick={() => setMode("history")}>
            History
          </ModeTabButton>
          <ModeTabButton active={mode === "snippets"} onClick={() => setMode("snippets")}>
            Snippets
          </ModeTabButton>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-1 text-muted-foreground/70 transition-colors hover:text-foreground"
          aria-label="Close drawer"
          title="Close"
        >
          ✕
        </button>
      </header>
      <div className="tp-hair" />
      {mode === "history" ? (
        <HistoryBody
          connectionId={connectionId}
          runStateKind={runStateKind}
          onLoad={onLoad}
          onOpenNew={onOpenNew}
        />
      ) : (
        <SnippetsBody
          connectionId={connectionId}
          getCurrentSql={getCurrentSql}
          currentDatabase={currentDatabase}
          onLoad={onLoad}
          onOpenNew={onOpenNew}
        />
      )}
    </aside>
  );
}

function ModeTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 font-semibold uppercase tracking-wider transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function HistoryBody({
  connectionId,
  runStateKind,
  onLoad,
  onOpenNew,
}: {
  connectionId: string;
  runStateKind: RunState["kind"];
  onLoad: (sql: string) => void;
  onOpenNew?: (sql: string, database: string | null) => void;
}) {
  const [items, setItems] = useState<QueryHistoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"connection" | "all">("connection");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listQueryHistory({
      connectionId: scope === "connection" ? connectionId : null,
      search: query.trim() ? query.trim() : null,
      limit: 200,
    })
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, scope, query]);

  useEffect(() => load(), [load]);

  // クエリ実行が終わったら履歴を更新。runStateKind のみで起動したい
  // biome-ignore lint/correctness/useExhaustiveDependencies: runStateKind が変わった瞬間だけ load したい
  useEffect(() => {
    if (runStateKind === "done" || runStateKind === "error") {
      load();
    }
  }, [runStateKind]);

  async function handleClear() {
    const label = scope === "connection" ? "this connection" : "all connections";
    if (!window.confirm(`Clear query history for ${label}?`)) return;
    try {
      await clearQueryHistory(scope === "connection" ? connectionId : null);
      setSelectedId(null);
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 px-3 pt-2 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-input/40 px-2 transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_2px_var(--accent-glow)]">
            <SearchIcon />
            <input
              placeholder="Search SQL"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              className="h-full flex-1 bg-transparent text-[0.75rem] outline-none placeholder:text-muted-foreground/60"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-muted-foreground/50 hover:text-foreground"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-md border border-border px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider text-muted-foreground transition-colors hover:border-destructive/60 hover:text-destructive"
            title="Clear history"
          >
            Clear
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="inline-flex overflow-hidden rounded-md border border-border text-[0.6rem]">
            <ScopeButton active={scope === "connection"} onClick={() => setScope("connection")}>
              This conn
            </ScopeButton>
            <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
              All
            </ScopeButton>
          </div>
          <span className="tp-num text-[0.62rem] text-muted-foreground/60">{items.length}</span>
        </div>
      </div>

      {error && (
        <p className="mx-3 my-2 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[0.7rem] text-destructive">
          {error}
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && items.length === 0 && (
          <li className="px-3 py-2 text-[0.72rem] text-muted-foreground">Loading…</li>
        )}
        {!loading && items.length === 0 && (
          <li className="px-3 py-6 text-center text-[0.72rem] text-muted-foreground/70">
            No history.
          </li>
        )}
        {items.map((it) => {
          const isSelected = selectedId === it.id;
          const hasError = Boolean(it.error);
          return (
            <li key={it.id}>
              <div
                className={`group relative flex flex-col gap-0.5 px-3 py-1.5 transition-colors ${
                  isSelected
                    ? "bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]"
                    : "hover:bg-sidebar-accent/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(it.id)}
                  onDoubleClick={() => onLoad(it.sql)}
                  className="flex w-full flex-col gap-0.5 text-left"
                  title="click: select · double-click: load into editor"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[0.72rem] text-foreground/90">
                      {firstLine(it.sql)}
                    </span>
                    {hasError ? (
                      <span className="tp-chip-accent shrink-0 bg-destructive/20 text-destructive">
                        err
                      </span>
                    ) : it.row_count != null ? (
                      <span className="shrink-0 font-mono text-[0.6rem] text-muted-foreground/70">
                        {it.row_count}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5 text-[0.6rem] text-muted-foreground/60">
                    <span className="tp-num">{formatRelative(it.executed_at)}</span>
                    {it.database && <span className="truncate font-mono">{it.database}</span>}
                    {it.duration_ms != null && (
                      <span className="ml-auto tp-num">{it.duration_ms}ms</span>
                    )}
                  </div>
                </button>
                {isSelected && (
                  <div className="mt-1 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onLoad(it.sql)}
                      className="tp-btn tp-btn-primary h-6 px-2 text-[0.62rem]"
                      title="Replace current editor contents"
                    >
                      Load
                    </button>
                    {onOpenNew && (
                      <button
                        type="button"
                        onClick={() => onOpenNew(it.sql, it.database)}
                        className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.62rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent"
                        title="Open in a new editor tab"
                      >
                        New tab
                      </button>
                    )}
                  </div>
                )}
                {hasError && isSelected && it.error && (
                  <pre className="mt-1 max-h-24 overflow-auto rounded-sm border border-destructive/30 bg-destructive/10 p-1.5 font-mono text-[0.62rem] text-destructive">
                    {it.error}
                  </pre>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SnippetsBody({
  connectionId,
  getCurrentSql,
  currentDatabase,
  onLoad,
  onOpenNew,
}: {
  connectionId: string;
  getCurrentSql: () => string;
  currentDatabase: string | null;
  onLoad: (sql: string) => void;
  onOpenNew?: (sql: string, database: string | null) => void;
}) {
  const [items, setItems] = useState<SavedQuery[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string; sql: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSnippets(connectionId)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  useEffect(() => load(), [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((s) => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));
  }, [items, query]);

  async function handleSaveCurrent() {
    const sql = getCurrentSql().trim();
    if (!sql) {
      setError("Editor is empty.");
      return;
    }
    const name = window.prompt("Snippet name:", defaultSnippetName(sql));
    if (!name?.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSnippet(connectionId, name.trim(), sql);
      setItems((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
      setSelectedId(saved.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this snippet?")) return;
    try {
      await deleteSnippet(id);
      setItems((prev) => prev.filter((s) => s.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      setError(String(e));
    }
  }

  function startEdit(snippet: SavedQuery) {
    setEditing({ id: snippet.id, name: snippet.name, sql: snippet.sql });
  }

  async function commitEdit() {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    try {
      const updated = await updateSnippet(editing.id, name, editing.sql);
      setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditing(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleOverwrite(id: number) {
    const sql = getCurrentSql();
    const existing = items.find((s) => s.id === id);
    if (!existing) return;
    if (!window.confirm(`Overwrite "${existing.name}" with current editor contents?`)) return;
    try {
      const updated = await updateSnippet(id, existing.name, sql);
      setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 px-3 pt-2 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-input/40 px-2 transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_2px_var(--accent-glow)]">
            <SearchIcon />
            <input
              placeholder="Search snippets"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              className="h-full flex-1 bg-transparent text-[0.75rem] outline-none placeholder:text-muted-foreground/60"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-muted-foreground/50 hover:text-foreground"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={handleSaveCurrent}
            disabled={saving}
            className="tp-btn tp-btn-primary h-7 px-2 text-[0.65rem] disabled:opacity-50"
            title="Save current SQL as a named snippet"
          >
            {saving ? "…" : "+ Save"}
          </button>
        </div>
        <span className="tp-num self-end text-[0.62rem] text-muted-foreground/60">
          {filtered.length}
        </span>
      </div>

      {error && (
        <p className="mx-3 my-2 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[0.7rem] text-destructive">
          {error}
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && items.length === 0 && (
          <li className="px-3 py-2 text-[0.72rem] text-muted-foreground">Loading…</li>
        )}
        {!loading && items.length === 0 && (
          <li className="px-3 py-6 text-center text-[0.72rem] text-muted-foreground/70">
            No snippets yet. Press <span className="tp-kbd">+ Save</span> to store the current
            query.
          </li>
        )}
        {!loading && items.length > 0 && filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-[0.72rem] text-muted-foreground/70">
            No match.
          </li>
        )}
        {filtered.map((it) => {
          const isSelected = selectedId === it.id;
          const isEditing = editing?.id === it.id;
          return (
            <li key={it.id}>
              <div
                className={`group relative flex flex-col gap-1 px-3 py-2 transition-colors ${
                  isSelected
                    ? "bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]"
                    : "hover:bg-sidebar-accent/40"
                }`}
              >
                {isEditing ? (
                  <div className="flex flex-col gap-1.5">
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.currentTarget.value })}
                      className="h-7 w-full rounded-md border border-border bg-input/40 px-2 text-[0.75rem] outline-none focus:border-accent"
                      placeholder="Name"
                    />
                    <textarea
                      value={editing.sql}
                      onChange={(e) => setEditing({ ...editing, sql: e.currentTarget.value })}
                      rows={4}
                      className="w-full rounded-md border border-border bg-input/40 px-2 py-1 font-mono text-[0.72rem] outline-none focus:border-accent"
                    />
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={commitEdit}
                        className="tp-btn tp-btn-primary h-6 px-2 text-[0.62rem]"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.62rem] text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setSelectedId(it.id)}
                      onDoubleClick={() => onLoad(it.sql)}
                      className="flex w-full flex-col gap-0.5 text-left"
                      title="click: select · double-click: load into editor"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[0.78rem] font-medium">{it.name}</span>
                        <span className="shrink-0 font-mono text-[0.6rem] text-muted-foreground/60">
                          {formatRelative(it.updated_at)}
                        </span>
                      </div>
                      <span className="truncate font-mono text-[0.68rem] text-muted-foreground/80">
                        {firstLine(it.sql)}
                      </span>
                    </button>
                    {isSelected && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onLoad(it.sql)}
                          className="tp-btn tp-btn-primary h-6 px-2 text-[0.62rem]"
                          title="Replace current editor contents"
                        >
                          Load
                        </button>
                        {onOpenNew && (
                          <button
                            type="button"
                            onClick={() => onOpenNew(it.sql, currentDatabase)}
                            className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.62rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent"
                            title="Open in a new editor tab"
                          >
                            New tab
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleOverwrite(it.id)}
                          className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.62rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent"
                          title="Overwrite with current editor SQL"
                        >
                          Overwrite
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(it)}
                          className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.62rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(it.id)}
                          className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.62rem] text-muted-foreground transition-colors hover:border-destructive/60 hover:text-destructive"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function defaultSnippetName(sql: string): string {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 40 ? line.slice(0, 40) : line;
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 font-semibold uppercase tracking-wider transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function firstLine(sql: string): string {
  const stripped = sql.replace(/\s+/g, " ").trim();
  return stripped.length > 80 ? `${stripped.slice(0, 80)}…` : stripped;
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" role="img" aria-label="history" fill="none">
      <title>history</title>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 5v3l2 1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 text-muted-foreground/60"
      role="img"
      aria-label="search"
      fill="none"
    >
      <title>search</title>
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ResultsPane({
  runState,
  connectionId,
  database,
  lastSql,
}: {
  runState: RunState;
  connectionId: string;
  database: string | null;
  lastSql: React.RefObject<string>;
}) {
  const [activeTab, setActiveTab] = useState(0);

  // done に遷移したら先頭タブをアクティブにする (前回インデックスが超過しないよう)
  useEffect(() => {
    if (runState.kind === "done") setActiveTab(0);
  }, [runState.kind]);

  if (runState.kind === "idle") {
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        Ready. Press ⌘↵ to run.
      </div>
    );
  }
  if (runState.kind === "running") {
    const suffix =
      runState.total && runState.total > 1 ? ` (${runState.index} / ${runState.total})` : "";
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        Running…{suffix}
      </div>
    );
  }
  if (runState.kind === "error") {
    return (
      <div className="border-t border-border bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
        {runState.message}
      </div>
    );
  }

  const tabs = runState.tabs;
  const active = tabs[Math.min(activeTab, tabs.length - 1)];
  if (!active) {
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        No result.
      </div>
    );
  }

  return (
    <div className="flex max-h-[55%] min-h-[220px] flex-col border-t border-border">
      {tabs.length > 1 && (
        <div className="flex h-7 shrink-0 items-stretch overflow-x-auto border-b border-border bg-sidebar/20 text-[0.7rem]">
          {tabs.map((t, i) => {
            const isActive = i === activeTab;
            const label =
              t.kind === "error"
                ? `Query ${i + 1}`
                : t.result.kind === "select"
                  ? `Query ${i + 1} · ${t.result.returned} rows`
                  : `Query ${i + 1} · ${t.result.rows} affected`;
            return (
              <button
                key={`tab-${t.sql.slice(0, 24)}-${t.kind === "error" ? "e" : "o"}`}
                type="button"
                onClick={() => setActiveTab(i)}
                title={t.sql}
                className={`inline-flex h-full items-center gap-1.5 border-r border-border/70 px-3 transition-colors ${
                  isActive
                    ? "bg-background text-foreground shadow-[inset_0_2px_0_var(--accent)]"
                    : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
                }`}
              >
                {t.kind === "error" && (
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full bg-destructive"
                  />
                )}
                <span className="truncate font-mono">{label}</span>
              </button>
            );
          })}
        </div>
      )}
      <SingleResultView
        tab={active}
        connectionId={connectionId}
        database={database}
        lastSql={lastSql}
      />
    </div>
  );
}

const RES_COL_MIN = 60;
const RES_COL_MAX = 600;
const RES_COL_DEFAULT = 140;
const RES_MEASURE_PAD = 28;
const RES_MEASURE_SAMPLE = 60;
const RES_CELL_MAX_CHARS = 100;

function measureResultCols(
  ctx: CanvasRenderingContext2D | null,
  columns: string[],
  rows: (string | null)[][],
): number[] {
  if (!ctx) return columns.map(() => RES_COL_DEFAULT);
  return columns.map((col, ci) => {
    let maxPx = ctx.measureText(col).width;
    const cap = Math.min(rows.length, RES_MEASURE_SAMPLE);
    for (let i = 0; i < cap; i++) {
      const cell = rows[i]?.[ci];
      const text = cell === null || cell === undefined ? "NULL" : cell.slice(0, RES_CELL_MAX_CHARS);
      const w = ctx.measureText(text).width;
      if (w > maxPx) maxPx = w;
    }
    return Math.max(RES_COL_MIN, Math.min(RES_COL_MAX, Math.round(maxPx + RES_MEASURE_PAD)));
  });
}

type SortState = { col: number; dir: "asc" | "desc" } | null;

function SingleResultView({
  tab,
  connectionId,
  database,
  lastSql,
}: {
  tab: RunTabResult;
  connectionId: string;
  database: string | null;
  lastSql: React.RefObject<string>;
}) {
  const [filter, setFilter] = useState("");
  const [colWidths, setColWidths] = useState<number[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [sort, setSort] = useState<SortState>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // 新しい結果に切り替わったら filter/selection/sort クリア + 列幅再計算
  useEffect(() => {
    setFilter("");
    setSelected(new Set());
    setAnchor(null);
    setSort(null);
    if (tab.kind !== "ok" || tab.result.kind !== "select") {
      setColWidths([]);
      return;
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font =
        '14px "Inter Variable", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", system-ui, sans-serif';
    }
    setColWidths(measureResultCols(ctx, tab.result.columns, tab.result.rows));
  }, [tab]);

  // ctxMenu は click anywhere / Esc で閉じる
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const keyClose = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", keyClose);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", keyClose);
    };
  }, [ctxMenu]);

  const colWidthsRef = useRef<number[]>(colWidths);
  colWidthsRef.current = colWidths;

  const startColResize = useCallback((e: React.PointerEvent, colIdx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidthsRef.current[colIdx] ?? RES_COL_DEFAULT;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let rafId: number | null = null;
    let pendingNext = startWidth;
    function flush() {
      rafId = null;
      setColWidths((prev) => {
        if (prev[colIdx] === pendingNext) return prev;
        const out = prev.slice();
        out[colIdx] = pendingNext;
        return out;
      });
    }
    function handleMove(ev: PointerEvent) {
      pendingNext = Math.max(
        RES_COL_MIN,
        Math.min(RES_COL_MAX, startWidth + (ev.clientX - startX)),
      );
      if (rafId === null) rafId = requestAnimationFrame(flush);
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        flush();
      }
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }, []);

  const filteredRows = useMemo(() => {
    if (tab.kind !== "ok" || tab.result.kind !== "select") return null;
    const q = filter.trim().toLowerCase();
    if (!q) return tab.result.rows;
    return tab.result.rows.filter((row) => row.some((cell) => cell?.toLowerCase().includes(q)));
  }, [tab, filter]);

  const sortedRows = useMemo(() => {
    if (!filteredRows || !sort) return filteredRows;
    const idx = sort.col;
    const dir = sort.dir === "asc" ? 1 : -1;
    return filteredRows.slice().sort((a, b) => {
      const av = a[idx];
      const bv = b[idx];
      if (av === null && bv === null) return 0;
      if (av === null) return -1 * dir;
      if (bv === null) return 1 * dir;
      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn) && av.trim() !== "" && bv.trim() !== "") {
        return (an - bn) * dir;
      }
      return av.localeCompare(bv) * dir;
    });
  }, [filteredRows, sort]);

  function cycleSort(colIdx: number) {
    setSort((prev) => {
      if (!prev || prev.col !== colIdx) return { col: colIdx, dir: "asc" };
      if (prev.dir === "asc") return { col: colIdx, dir: "desc" };
      return null;
    });
    setSelected(new Set());
    setAnchor(null);
  }

  function handleRowClick(e: React.MouseEvent, i: number) {
    if (e.shiftKey && anchor !== null) {
      const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
      const next = new Set<number>();
      for (let k = lo; k <= hi; k++) next.add(k);
      setSelected(next);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        return n;
      });
      setAnchor(i);
      return;
    }
    setSelected(new Set([i]));
    setAnchor(i);
  }

  function handleRowContextMenu(e: React.MouseEvent, i: number) {
    e.preventDefault();
    if (!selected.has(i)) {
      setSelected(new Set([i]));
      setAnchor(i);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  async function copySelectedAs(format: CopyFormat) {
    if (tab.kind !== "ok" || tab.result.kind !== "select") return;
    const visible = sortedRows ?? tab.result.rows;
    const pickRows = Array.from(selected)
      .sort((a, b) => a - b)
      .map((i) => visible[i])
      .filter((r): r is (string | null)[] => Array.isArray(r));
    if (pickRows.length === 0) return;
    const cols = tab.result.columns;
    const text = formatRowsAs(pickRows, cols, format, extractFromTable(tab.sql));
    try {
      await navigator.clipboard.writeText(text);
      setToast(
        `Copied ${pickRows.length} row${pickRows.length === 1 ? "" : "s"} as ${format.toUpperCase()}`,
      );
      window.setTimeout(() => setToast(null), 2500);
    } catch {
      setToast("Copy failed");
      window.setTimeout(() => setToast(null), 2500);
    }
    setCtxMenu(null);
  }

  if (tab.kind === "error") {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-destructive/10 p-4">
        <pre className="mb-2 font-mono text-[0.72rem] whitespace-pre-wrap text-destructive">
          {tab.message}
        </pre>
        <pre className="font-mono text-[0.7rem] whitespace-pre-wrap text-muted-foreground">
          {tab.sql}
        </pre>
      </div>
    );
  }
  const r = tab.result;
  if (r.kind === "affected") {
    return (
      <div className="flex-1 px-4 py-3 text-xs">
        <span className="text-foreground">{r.rows}</span>{" "}
        <span className="text-muted-foreground">row{r.rows === 1 ? "" : "s"} affected</span>
        <span className="ml-2 text-muted-foreground/60">· {r.elapsed_ms} ms</span>
      </div>
    );
  }
  const rows = sortedRows ?? r.rows;
  const isFiltered = filter.trim().length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {isFiltered ? (
            <>
              <span className="tp-num text-foreground/90">{rows.length}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="tp-num">{r.returned}</span>
              <span className="ml-1">shown</span>
            </>
          ) : (
            <>
              {r.returned} row{r.returned === 1 ? "" : "s"}
            </>
          )}
          <span className="ml-2 text-muted-foreground/60">· {r.elapsed_ms} ms</span>
        </span>
        <div className="flex items-center gap-2">
          <div className="group flex h-6 items-center gap-1.5 rounded-md border border-border bg-input/40 px-2 transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_2px_var(--accent-glow)]">
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 shrink-0 text-muted-foreground/60"
              role="img"
              aria-label="filter"
              fill="none"
            >
              <title>filter</title>
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              ref={filterRef}
              data-results-filter="true"
              placeholder="Filter rows (⌘F)"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.currentTarget.blur();
                  setFilter("");
                }
              }}
              className="h-full w-[180px] bg-transparent text-[0.72rem] outline-none placeholder:text-muted-foreground/60"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                className="text-muted-foreground/50 hover:text-foreground"
                aria-label="Clear filter"
              >
                ✕
              </button>
            )}
          </div>
          <QueryExportMenu connectionId={connectionId} database={database} lastSql={lastSql} />
        </div>
      </header>
      <div className="flex-1 overflow-auto">
        <table className="text-left text-sm" style={{ tableLayout: "fixed" }}>
          <thead className="sticky top-0 bg-background/95 text-[0.7rem] uppercase tracking-wide text-muted-foreground backdrop-blur">
            <tr className="border-b border-border">
              {r.columns.map((c, ci) => {
                const sorted = sort?.col === ci ? sort.dir : null;
                const w = colWidths[ci] ?? RES_COL_DEFAULT;
                return (
                  <th
                    key={c}
                    style={{ width: w, minWidth: w, maxWidth: w }}
                    className="relative whitespace-nowrap p-0"
                  >
                    <div className="flex h-full w-full items-stretch">
                      <button
                        type="button"
                        onClick={() => cycleSort(ci)}
                        className={`flex min-w-0 flex-1 items-center gap-1 px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/40 ${
                          sorted ? "text-accent" : ""
                        }`}
                        title="Click to sort"
                      >
                        <span className="truncate">{c}</span>
                        {sorted && (
                          <span aria-hidden className="ml-auto text-[0.65rem]">
                            {sorted === "desc" ? "▼" : "▲"}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`Resize ${c}`}
                        onPointerDown={(e) => startColResize(e, ci)}
                        className="w-1.5 shrink-0 cursor-col-resize border-r border-border/60 bg-transparent transition-colors hover:bg-accent/50 active:bg-accent/70"
                        title="Drag to resize"
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const rowKey = `row-${i}`;
              const isSelected = selected.has(i);
              return (
                <tr
                  key={rowKey}
                  onClick={(e) => handleRowClick(e, i)}
                  onContextMenu={(e) => handleRowContextMenu(e, i)}
                  className={`border-b border-border/30 ${
                    isSelected ? "bg-accent/20 hover:bg-accent/25" : "hover:bg-sidebar-accent/30"
                  }`}
                >
                  {row.map((cell, ci) => (
                    <td
                      key={`${rowKey}:${r.columns[ci] ?? ci}`}
                      className="truncate border-r border-border/20 px-3 py-1.5"
                      title={cell ?? ""}
                    >
                      {cell === null ? (
                        <span className="text-muted-foreground/60 italic">NULL</span>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            {isFiltered ? "No rows match filter." : "No rows."}
          </p>
        )}
      </div>

      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-border bg-popover shadow-[0_10px_30px_-10px_oklch(0_0_0/60%)]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="menu"
          aria-label="Copy row options"
        >
          <div className="border-b border-border/70 px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/70">
            {selected.size} row{selected.size === 1 ? "" : "s"} selected
          </div>
          {(
            [
              ["tsv", "Copy as TSV (paste to spreadsheet)"],
              ["csv", "Copy as CSV"],
              ["json", "Copy as JSON"],
              ["sql", "Copy as SQL INSERT"],
            ] as const
          ).map(([fmt, label]) => (
            <button
              key={fmt}
              type="button"
              onClick={() => copySelectedAs(fmt)}
              className="block w-full px-3 py-1.5 text-left text-[0.75rem] text-foreground hover:bg-sidebar-accent/60"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute right-4 bottom-4 rounded-md border border-accent/40 bg-card/95 px-3 py-1.5 text-[0.72rem] shadow-lg backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}

function extractFromTable(sql: string): string {
  const m = sql.match(/\bFROM\s+`?([\w$]+)`?(?:\s*\.\s*`?([\w$]+)`?)?/i);
  if (!m) return "exported_rows";
  return m[2] ?? m[1] ?? "exported_rows";
}

function QueryExportMenu({
  connectionId,
  database,
  lastSql,
}: {
  connectionId: string;
  database: string | null;
  lastSql: React.RefObject<string>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function run(format: ExportFormat) {
    setOpen(false);
    const sql = lastSql.current.trim().replace(/;+\s*$/, "");
    if (!sql) {
      setToast("No query to export");
      window.setTimeout(() => setToast(null), 3000);
      return;
    }
    setBusy(format);
    try {
      const ext = format === "sql" ? "sql" : format;
      const path = await saveDialog({
        defaultPath: `query.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return;
      const result = await exportQuery({ connectionId, database, sql, format, path });
      setToast(`Exported ${result.rows.toLocaleString()} rows`);
      window.setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast(`Failed: ${String(e)}`);
      window.setTimeout(() => setToast(null), 6000);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[0.7rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent disabled:opacity-50"
      >
        {busy ? "…" : "Export"}
        <span aria-hidden className="text-[0.55rem] opacity-60">
          ▾
        </span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            {(
              [
                ["csv", "CSV (.csv)"],
                ["json", "JSON Lines (.json)"],
                ["sql", "SQL INSERTs (.sql)"],
              ] as const
            ).map(([fmt, label]) => (
              <button
                key={fmt}
                type="button"
                onClick={() => run(fmt)}
                className="block w-full px-3 py-1.5 text-left text-[0.75rem] text-foreground hover:bg-sidebar-accent/60"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {toast && (
        <div className="pointer-events-none absolute right-0 top-full z-40 mt-1 max-w-[360px] rounded-md border border-accent/40 bg-card/95 px-3 py-1.5 text-[0.7rem] shadow-lg backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="split" fill="none">
      <title>split pane</title>
      <rect x="2" y="3" width="12" height="10" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
