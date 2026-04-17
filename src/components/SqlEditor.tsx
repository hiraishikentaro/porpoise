import { autocompletion } from "@codemirror/autocomplete";
import { MySQL, sql as sqlLang } from "@codemirror/lang-sql";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import {
  clearQueryHistory,
  executeQuery,
  listDatabases,
  listQueryHistory,
  type QueryHistoryRow,
  type QueryResult,
  type SchemaSnapshot,
  schemaSnapshot,
} from "@/lib/tauri";

type Props = {
  connectionId: string;
  initialSql: string;
  initialDatabase: string | null;
  onChange: (sql: string) => void;
  onDatabaseChange: (database: string | null) => void;
  /** 履歴から SQL を新規エディタタブとして開く */
  onOpenInNewEditor?: (sql: string, database: string | null) => void;
};

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: QueryResult };

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
    backgroundColor: "rgba(220, 38, 38, 0.18)",
    textDecoration: "underline wavy rgba(220, 38, 38, 0.8)",
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
}: Props) {
  const [sqlText, setSqlText] = useState(initialSql);
  const [database, setDatabase] = useState<string | null>(initialDatabase);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [historyOpen, setHistoryOpen] = useState(false);
  const viewRef = useRef<EditorView | null>(null);

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
      // 実行開始時にエラーハイライトをクリア
      viewRef.current?.dispatch({ effects: setErrorLineEffect.of(null) });
      setRunState({ kind: "running" });
      try {
        const result = await executeQuery(connectionId, trimmed, databaseRef.current);
        setRunState({ kind: "done", result });
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

  const runAt = useCallback(() => {
    if (!viewRef.current) return;
    const { text, startLine } = statementAtCursor(viewRef.current);
    run(text, startLine);
  }, [run]);

  const runAll = useCallback(() => {
    run(sqlTextRef.current, 1);
  }, [run]);

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
        tabWidth: 2,
      });
    } catch {
      // パースに失敗したら整形だけスキップ (部分入力中など)
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      selection: { anchor: Math.min(view.state.selection.main.head, formatted.length) },
    });
  }, []);

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
      EditorView.lineWrapping,
      errorLineField,
      errorLineTheme,
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            runAt();
            return true;
          },
        },
        {
          key: "Shift-Mod-Enter",
          run: () => {
            runAll();
            return true;
          },
        },
        {
          key: "Alt-Enter",
          run: () => {
            explainAt();
            return true;
          },
        },
        {
          key: "Shift-Mod-f",
          run: () => {
            formatDocument();
            return true;
          },
        },
      ]),
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
          <span className="text-muted-foreground">
            <kbd className="rounded-sm border border-border px-1">⌘↵</kbd> run ·{" "}
            <kbd className="rounded-sm border border-border px-1">⇧⌘↵</kbd> run all ·{" "}
            <kbd className="rounded-sm border border-border px-1">⌥↵</kbd> explain ·{" "}
            <kbd className="rounded-sm border border-border px-1">⇧⌘F</kbd> format
          </span>
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
            title="Toggle query history"
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
          >
            Run
          </button>
          <button
            type="button"
            onClick={runAll}
            disabled={runState.kind === "running"}
            className="rounded-md border border-accent bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground disabled:opacity-50"
          >
            Run all
          </button>
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
          <ResultsPane runState={runState} />
        </div>

        {historyOpen && (
          <HistoryDrawer
            connectionId={connectionId}
            runStateKind={runState.kind}
            onLoad={(sql) => replaceEditor(sql)}
            onOpenNew={onOpenInNewEditor ? (sql, db) => onOpenInNewEditor(sql, db) : undefined}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function HistoryDrawer({
  connectionId,
  runStateKind,
  onLoad,
  onOpenNew,
  onClose,
}: {
  connectionId: string;
  runStateKind: RunState["kind"];
  onLoad: (sql: string) => void;
  onOpenNew?: (sql: string, database: string | null) => void;
  onClose: () => void;
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
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-sidebar/30">
      <header className="flex flex-col gap-2 px-3 pt-2.5 pb-2">
        <div className="flex items-center justify-between">
          <span className="tp-section-title">History</span>
          <div className="flex items-center gap-1">
            <span className="tp-num text-[0.65rem] text-muted-foreground/60">{items.length}</span>
            <button
              type="button"
              onClick={handleClear}
              className="rounded-md border border-border px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider text-muted-foreground transition-colors hover:border-destructive/60 hover:text-destructive"
              title="Clear history"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-1 text-muted-foreground/70 transition-colors hover:text-foreground"
              aria-label="Close history"
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex h-7 items-center gap-2 rounded-md border border-border bg-input/40 px-2 transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_2px_var(--accent-glow)]">
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
        <div className="inline-flex w-fit overflow-hidden rounded-md border border-border text-[0.62rem]">
          <ScopeButton active={scope === "connection"} onClick={() => setScope("connection")}>
            This conn
          </ScopeButton>
          <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
            All
          </ScopeButton>
        </div>
      </header>
      <div className="tp-hair" />

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
    </aside>
  );
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

function ResultsPane({ runState }: { runState: RunState }) {
  if (runState.kind === "idle") {
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        Ready. Press ⌘↵ to run.
      </div>
    );
  }
  if (runState.kind === "running") {
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">Running…</div>
    );
  }
  if (runState.kind === "error") {
    return (
      <div className="border-t border-border bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
        {runState.message}
      </div>
    );
  }
  const r = runState.result;
  if (r.kind === "affected") {
    return (
      <div className="border-t border-border px-4 py-3 text-xs">
        <span className="text-foreground">{r.rows}</span>{" "}
        <span className="text-muted-foreground">row{r.rows === 1 ? "" : "s"} affected</span>
        <span className="ml-2 text-muted-foreground/60">· {r.elapsed_ms} ms</span>
      </div>
    );
  }
  return (
    <div className="flex max-h-[45%] min-h-[200px] flex-col border-t border-border">
      <header className="flex items-center justify-between px-4 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {r.returned} row{r.returned === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground/60">{r.elapsed_ms} ms</span>
      </header>
      <div className="flex-1 overflow-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="sticky top-0 bg-background/95 text-[0.7rem] uppercase tracking-wide text-muted-foreground backdrop-blur">
            <tr className="border-b border-border">
              {r.columns.map((c) => (
                <th key={c} className="whitespace-nowrap border-r border-border/60 px-3 py-2">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row, i) => {
              const rowKey = `row-${i}`;
              return (
                <tr key={rowKey} className="border-b border-border/30 hover:bg-sidebar-accent/30">
                  {row.map((cell, ci) => (
                    <td
                      key={`${rowKey}:${r.columns[ci] ?? ci}`}
                      className="max-w-[360px] truncate border-r border-border/20 px-3 py-1.5"
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
        {r.rows.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">No rows.</p>}
      </div>
    </div>
  );
}
