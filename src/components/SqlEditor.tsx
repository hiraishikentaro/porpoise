import { autocompletion } from "@codemirror/autocomplete";
import { MySQL, sql as sqlLang } from "@codemirror/lang-sql";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import {
  executeQuery,
  listDatabases,
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
}: Props) {
  const [sqlText, setSqlText] = useState(initialSql);
  const [database, setDatabase] = useState<string | null>(initialDatabase);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
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
              // biome-ignore lint/suspicious/noArrayIndexKey: query rows are positional only
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
