import { autocompletion } from "@codemirror/autocomplete";
import { MySQL, sql as sqlLang } from "@codemirror/lang-sql";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import { CellViewerModal } from "@/components/CellViewerModal";
import { EmptyState } from "@/components/ui/empty-state";
import { KbdHint } from "@/components/ui/kbd-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { looksNumericByValues } from "@/lib/column-type";
import { useT } from "@/lib/i18n";
import { type CopyFormat, formatRowsAs } from "@/lib/row-format";
import { useSettings } from "@/lib/settings";
import { sqlLinter } from "@/lib/sql-lint";
import {
  cancelQuery,
  clearQueryHistory,
  deleteSnippet,
  type ExportFormat,
  executeQueryStream,
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
  /** Status bar へ実行情報を publish するコールバック */
  onRunComplete?: (info: { rows: number; elapsedMs: number }) => void;
};

type RunTabResult =
  | { kind: "ok"; sql: string; result: QueryResult }
  | { kind: "error"; sql: string; message: string };

/** SELECT を streaming 実行中の部分結果。行は ref で蓄積、fetched だけ state 管理 */
type PartialSelect = {
  columns: string[];
  /** ref に置いた累積行への参照。描画時のみ index アクセス */
  rowsRef: { current: (string | null)[][] };
  /** これまでにサーバから届いた行数 */
  fetched: number;
};

type RunState =
  | { kind: "idle" }
  | {
      kind: "running";
      requestId: string;
      index?: number;
      total?: number;
      partial?: PartialSelect;
    }
  | { kind: "error"; message: string }
  | { kind: "done"; tabs: RunTabResult[] };

function newRequestId(): string {
  // Rust 側で Uuid として受け取るため RFC 4122 準拠の UUIDv4 を使う。
  // 古い WebView fallback: crypto.randomUUID が無ければ v4 を自前生成。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  onRunComplete,
}: Props) {
  const onRunCompleteRef = useRef(onRunComplete);
  onRunCompleteRef.current = onRunComplete;
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
  const runStateRef = useRef(runState);
  runStateRef.current = runState;

  const cancelActive = useCallback(() => {
    const s = runStateRef.current;
    if (s.kind !== "running") return false;
    void cancelQuery(s.requestId);
    return true;
  }, []);

  // runState が done になったら結果サマリを親に通知 (status bar 用)
  useEffect(() => {
    if (runState.kind !== "done") return;
    let rows = 0;
    let elapsedMs = 0;
    for (const t of runState.tabs) {
      if (t.kind === "ok") {
        elapsedMs += t.result.elapsed_ms;
        rows += t.result.kind === "select" ? t.result.returned : t.result.rows;
      }
    }
    onRunCompleteRef.current?.({ rows, elapsedMs });
  }, [runState]);

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

  /**
   * 1 statement を streaming で実行し、RunTabResult にまとめる。
   * index/total は runMany 用 (単独実行時は undefined)。
   */
  const runOneStreaming = useCallback(
    async (
      stmt: string,
      stmtStartLine: number,
      opts: { index?: number; total?: number } = {},
    ): Promise<RunTabResult> => {
      const trimmed = stmt.trim().replace(/;+\s*$/, "");
      if (!trimmed) {
        return { kind: "error", sql: stmt, message: "Empty statement." };
      }
      const requestId = newRequestId();
      const rowsRef: { current: (string | null)[][] } = { current: [] };
      let columnsSeen: string[] = [];
      setRunState({
        kind: "running",
        requestId,
        index: opts.index,
        total: opts.total,
      });
      try {
        const result = await executeQueryStream(
          connectionId,
          trimmed,
          databaseRef.current,
          requestId,
          {
            onColumns: (cols) => {
              columnsSeen = cols;
              setRunState((prev) =>
                prev.kind === "running" && prev.requestId === requestId
                  ? {
                      ...prev,
                      partial: { columns: cols, rowsRef, fetched: 0 },
                    }
                  : prev,
              );
            },
            onRows: (batch, fetched) => {
              // rows は ref に累積、state は fetched だけ更新して再描画を軽くする
              for (const r of batch) rowsRef.current.push(r);
              setRunState((prev) =>
                prev.kind === "running" && prev.requestId === requestId && prev.partial
                  ? {
                      ...prev,
                      partial: { ...prev.partial, fetched },
                    }
                  : prev,
              );
            },
          },
        );
        if (result.kind === "select") {
          const qr: QueryResult = {
            kind: "select",
            columns: columnsSeen.length ? columnsSeen : result.columns,
            rows: rowsRef.current,
            returned: result.returned,
            elapsed_ms: result.elapsedMs,
          };
          return { kind: "ok", sql: trimmed, result: qr };
        }
        const qr: QueryResult = {
          kind: "affected",
          rows: result.rows,
          elapsed_ms: result.elapsedMs,
        };
        return { kind: "ok", sql: trimmed, result: qr };
      } catch (e) {
        const message = String(e);
        const relLine = extractErrorLine(message);
        if (relLine !== null && viewRef.current) {
          const abs = stmtStartLine + relLine - 1;
          viewRef.current.dispatch({ effects: setErrorLineEffect.of(abs) });
        }
        return { kind: "error", sql: trimmed, message };
      }
    },
    [connectionId],
  );

  const run = useCallback(
    async (sql: string, stmtStartLine: number) => {
      const trimmed = sql.trim();
      if (!trimmed) {
        setRunState({ kind: "error", message: "Empty statement." });
        return;
      }
      viewRef.current?.dispatch({ effects: setErrorLineEffect.of(null) });
      const tab = await runOneStreaming(trimmed, stmtStartLine);
      if (tab.kind === "error") {
        setRunState({ kind: "error", message: tab.message });
      } else {
        setRunState({ kind: "done", tabs: [tab] });
      }
    },
    [runOneStreaming],
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
        const tab = await runOneStreaming(stmts[i], 1, {
          index: i + 1,
          total: stmts.length,
        });
        tabs.push(tab);
        // エラーでも残りは継続 (TablePlus と同じ挙動)
      }
      setRunState({ kind: "done", tabs });
    },
    [run, runOneStreaming],
  );

  const runAt = useCallback(() => {
    if (!viewRef.current) return;
    const { text, startLine } = statementAtCursor(viewRef.current);
    run(text, startLine);
  }, [run]);

  const runAll = useCallback(() => {
    // 選択範囲があればそれだけを runMany 対象にする (TablePlus 流の "Run selected")。
    // 無ければドキュメント全体。
    const view = viewRef.current;
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        const selected = view.state.doc.sliceString(sel.from, sel.to).trim();
        if (selected) {
          runMany(selected);
          return;
        }
      }
    }
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
          {
            key: "Mod-.",
            preventDefault: true,
            run: () => {
              cancelActive();
              return true;
            },
          },
        ]),
      ),
    ];
  }, [runAt, runAll, explainAt, schema, formatDocument, cancelActive]);

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
            className="group relative rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent"
            title="Format SQL"
          >
            Format
            <KbdHint keys={["⇧", "⌘", "F"]} />
          </button>
          <button
            type="button"
            onClick={explainAt}
            disabled={runState.kind === "running"}
            className="group relative rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
            title="EXPLAIN this statement"
          >
            Explain
            <KbdHint keys={["⌥", "↵"]} />
          </button>
          <button
            type="button"
            onClick={runAt}
            disabled={runState.kind === "running"}
            className="group relative rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
            title="Run statement at cursor"
          >
            Run
            <KbdHint keys={["⌘", "↵"]} />
          </button>
          <button
            type="button"
            onClick={runAll}
            disabled={runState.kind === "running"}
            className="group relative rounded-md border border-accent bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground disabled:opacity-50"
            title="Run all statements"
          >
            Run all
            <KbdHint keys={["⇧", "⌘", "↵"]} />
          </button>
          {onSplit && (
            <button
              type="button"
              onClick={onSplit}
              className="group relative inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-accent hover:text-accent"
              title="Split pane right"
              aria-label="Split pane right"
            >
              <SplitIcon />
              <KbdHint keys={["⇧", "⌘", "D"]} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="group relative inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
              title="Close this pane"
              aria-label="Close pane"
            >
              ✕
              <KbdHint keys={["⌘", "W"]} />
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
  const t = useT();

  // done に遷移したら先頭タブをアクティブにする (前回インデックスが超過しないよう)
  useEffect(() => {
    if (runState.kind === "done") setActiveTab(0);
  }, [runState.kind]);

  if (runState.kind === "idle") {
    return (
      <div className="flex flex-1 flex-col border-t border-border">
        <EmptyState
          variant="compact"
          icon={
            <svg viewBox="0 0 16 16" className="h-5 w-5" fill="none" role="img" aria-label="play">
              <title>play</title>
              <path
                d="M5 3.5v9l7-4.5-7-4.5z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          }
          title={t("empty.runQuery.title")}
          description={t("empty.runQuery.desc")}
        />
      </div>
    );
  }
  if (runState.kind === "running") {
    const suffix =
      runState.total && runState.total > 1 ? ` (${runState.index} / ${runState.total})` : "";
    return (
      <div className="flex flex-1 min-h-0 flex-col border-t border-border">
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
          />
          <span>
            {t("editor.running")}
            {suffix}…
          </span>
          {runState.partial && (
            <span className="tp-num text-foreground/85">
              {runState.partial.fetched.toLocaleString()}
              <span className="text-muted-foreground/70"> rows</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              if (runState.kind === "running") void cancelQuery(runState.requestId);
            }}
            className="ml-auto rounded-md border border-destructive/60 bg-destructive/10 px-2 py-0.5 text-[0.7rem] font-semibold text-destructive transition-colors hover:bg-destructive hover:text-background"
            title="⌘."
          >
            {t("editor.cancel")}
          </button>
        </div>
        <div className="relative h-[2px] w-full overflow-hidden bg-accent/10">
          <span className="block h-full w-1/3 animate-[indeterminate_1.15s_ease-in-out_infinite] bg-accent" />
        </div>
        {runState.partial && runState.partial.columns.length > 0 ? (
          <StreamingPreview partial={runState.partial} />
        ) : (
          <div className="flex flex-col gap-1.5 px-4 py-3 text-xs text-muted-foreground">
            <Skeleton className="h-2.5" style={{ width: "70%" }} />
            <Skeleton className="h-2.5" style={{ width: "50%" }} />
            <Skeleton className="h-2.5" style={{ width: "60%" }} />
          </div>
        )}
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
  const [cellView, setCellView] = useState<{ column: string; value: string | null } | null>(null);
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
      <VirtualizedResultGrid
        columns={r.columns}
        rows={rows}
        colWidths={colWidths}
        sort={sort}
        selected={selected}
        onCycleSort={cycleSort}
        onStartResize={startColResize}
        onRowClick={handleRowClick}
        onRowContextMenu={handleRowContextMenu}
        onCellExpand={(column, value) => setCellView({ column, value })}
      />
      {rows.length === 0 && (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {isFiltered ? "No rows match filter." : "No rows."}
        </p>
      )}

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

      {cellView && (
        <CellViewerModal
          column={cellView.column}
          value={cellView.value}
          onClose={() => setCellView(null)}
        />
      )}
    </div>
  );
}

function extractFromTable(sql: string): string {
  const m = sql.match(/\bFROM\s+`?([\w$]+)`?(?:\s*\.\s*`?([\w$]+)`?)?/i);
  if (!m) return "exported_rows";
  return m[2] ?? m[1] ?? "exported_rows";
}

/**
 * Streaming 中の簡易プレビュー。現在届いている列と行数を仮想化グリッドで出す。
 * soft (column resize/sort/selection は無し) — 流れてくる行をとりあえず見せることに特化。
 */
function StreamingPreview({ partial }: { partial: PartialSelect }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: partial.fetched,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const colWidth = 160;
  const totalWidth = partial.columns.length * colWidth;
  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ width: totalWidth, position: "relative" }}>
        <div
          className="sticky top-0 z-10 flex border-b border-border bg-background/95 text-[0.7rem] uppercase tracking-wide text-muted-foreground backdrop-blur"
          style={{ width: totalWidth }}
        >
          {partial.columns.map((c) => (
            <div
              key={c}
              style={{ width: colWidth }}
              className="truncate border-r border-border/60 px-3 py-2"
            >
              {c}
            </div>
          ))}
        </div>
        <div style={{ height: totalHeight, position: "relative" }}>
          {virtualItems.map((v) => {
            const row = partial.rowsRef.current[v.index];
            if (!row) return null;
            return (
              <div
                key={v.key}
                className="absolute top-0 left-0 flex border-b border-border/30 text-sm hover:bg-sidebar-accent/30"
                style={{
                  width: totalWidth,
                  height: v.size,
                  transform: `translateY(${v.start}px)`,
                }}
              >
                {row.map((cell, ci) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells in a row have no stable identity
                    key={`${v.key}:${ci}`}
                    style={{ width: colWidth }}
                    className="shrink-0 truncate border-r border-border/20 px-3 py-1.5"
                    title={cell ?? ""}
                  >
                    {cell === null ? (
                      <span className="text-muted-foreground/60 italic">NULL</span>
                    ) : (
                      cell
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * SELECT の結果行を仮想化して描画するグリッド。DOM 行を画面内の可視 + overscan 分に
 * 制限するので、数万〜数十万行返すクエリでも UI が固まらない。
 */
function VirtualizedResultGrid({
  columns,
  rows,
  colWidths,
  sort,
  selected,
  onCycleSort,
  onStartResize,
  onRowClick,
  onRowContextMenu,
  onCellExpand,
}: {
  columns: string[];
  rows: (string | null)[][];
  colWidths: number[];
  sort: SortState;
  selected: Set<number>;
  onCycleSort: (col: number) => void;
  onStartResize: (e: React.PointerEvent, col: number) => void;
  onRowClick: (e: React.MouseEvent, row: number) => void;
  onRowContextMenu: (e: React.MouseEvent, row: number) => void;
  onCellExpand: (column: string, value: string | null) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // 値ベースで列の数値性を判定 (QueryResult には型情報が無いため)
  const numericCols = useMemo(
    () => columns.map((_, ci) => looksNumericByValues(rows, ci, 50)),
    [columns, rows],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const totalWidth = colWidths.reduce((sum, w) => sum + (w ?? RES_COL_DEFAULT), 0);

  return (
    <div
      ref={parentRef}
      className="min-h-0 flex-1 overflow-auto"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      <div style={{ width: totalWidth, position: "relative" }}>
        {/* Sticky header */}
        <div
          className="sticky top-0 z-10 flex border-b border-border bg-background/95 text-[0.7rem] uppercase tracking-wide text-muted-foreground backdrop-blur"
          style={{ width: totalWidth }}
        >
          {columns.map((c, ci) => {
            const sorted = sort?.col === ci ? sort.dir : null;
            const w = colWidths[ci] ?? RES_COL_DEFAULT;
            return (
              <div key={c} style={{ width: w }} className="relative flex shrink-0 items-stretch">
                <button
                  type="button"
                  onClick={() => onCycleSort(ci)}
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
                  onPointerDown={(e) => onStartResize(e, ci)}
                  className="w-1.5 shrink-0 cursor-col-resize border-r border-border/60 bg-transparent transition-colors hover:bg-accent/50 active:bg-accent/70"
                  title="Drag to resize"
                />
              </div>
            );
          })}
        </div>

        {/* Virtualised rows */}
        <div style={{ height: totalHeight, position: "relative" }}>
          {virtualItems.map((virtualRow) => {
            const rowIdx = virtualRow.index;
            const row = rows[rowIdx];
            if (!row) return null;
            const isSelected = selected.has(rowIdx);
            return (
              // biome-ignore lint/a11y/useSemanticElements: virtualised grid needs div-based rows
              // biome-ignore lint/a11y/useKeyWithClickEvents: selection via modifier+click; keyboard navigation is a future pass
              <div
                key={virtualRow.key}
                role="row"
                tabIndex={-1}
                onClick={(e) => onRowClick(e, rowIdx)}
                onContextMenu={(e) => onRowContextMenu(e, rowIdx)}
                className={`absolute top-0 left-0 flex border-b border-border/30 text-sm ${
                  isSelected ? "bg-accent/20 hover:bg-accent/25" : "hover:bg-sidebar-accent/30"
                }`}
                style={{
                  width: totalWidth,
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.map((cell, ci) => (
                  // biome-ignore lint/a11y/noStaticElementInteractions: cell expand uses dblclick; keyboard equivalent is the row context menu
                  <div
                    key={`${virtualRow.key}:${columns[ci] ?? ci}`}
                    style={{ width: colWidths[ci] ?? RES_COL_DEFAULT }}
                    className={`shrink-0 cursor-default truncate border-r border-border/20 px-3 py-1.5 ${
                      numericCols[ci] ? "text-right tabular-nums" : ""
                    }`}
                    title={cell ?? ""}
                    onDoubleClick={() => onCellExpand(columns[ci] ?? `col_${ci}`, cell)}
                  >
                    {cell === null ? (
                      <span className="text-muted-foreground/60 italic">NULL</span>
                    ) : (
                      cell
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
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
