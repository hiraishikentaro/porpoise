import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type EditorKind,
  type EditorSpec,
  editorFor,
  fromDatetimeLocal,
  toDatetimeLocal,
} from "@/lib/column-editor";

function isLongEditor(kind: EditorKind): boolean {
  return kind === "textarea" || kind === "json";
}

import {
  type CellChange,
  type ColumnInfo,
  commitEdits,
  type RowEdit,
  selectTableRows,
  type TablePage,
} from "@/lib/tauri";

const PAGE_SIZE = 500;
const MIN_COL_WIDTH = 80;
const MAX_COL_WIDTH = 480;
const MEASURE_PADDING = 32;
/** 列幅測定に使う行の上限 (多すぎると重いので抑える) */
const MEASURE_SAMPLE = 200;
/** 1 セルで測る文字数の上限 (長文テキストで爆発しないように) */
const MEASURE_CELL_MAX = 120;

type Props = {
  connectionId: string;
  database: string;
  table: string;
  columns: ColumnInfo[];
};

type Row = (string | null)[];

type State = {
  columnNames: string[];
  rows: Row[];
  reachedEnd: boolean;
  loading: boolean;
  error: string | null;
};

const initialState: State = {
  columnNames: [],
  rows: [],
  reachedEnd: false,
  loading: false,
  error: null,
};

/** edits のキーは row:col で索引。値は新しいセル値 (null で NULL)。 */
type EditMap = Record<string, string | null>;
const editKey = (row: number, col: number) => `${row}:${col}`;

type EditingCell = { row: number; col: number } | null;

export function TableView({ connectionId, database, table, columns }: Props) {
  const [state, setState] = useState<State>(initialState);
  const [edits, setEdits] = useState<EditMap>({});
  const [editing, setEditing] = useState<EditingCell>(null);
  const [showCommit, setShowCommit] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const pkColumns = useMemo(
    () => columns.filter((c) => c.key === "PRI").map((c) => c.name),
    [columns],
  );
  const editable = pkColumns.length > 0;

  const loadPage = useCallback(
    async (reset: boolean): Promise<void> => {
      if (reset) {
        setState({ ...initialState, loading: true });
        setEdits({});
        setEditing(null);
      } else {
        const current = stateRef.current;
        if (current.loading || current.reachedEnd) return;
        setState((s) => ({ ...s, loading: true }));
      }
      const offset = reset ? 0 : stateRef.current.rows.length;
      try {
        const page: TablePage = await selectTableRows(
          connectionId,
          database,
          table,
          offset,
          PAGE_SIZE,
        );
        setState((s) => {
          const rows = reset ? page.rows : [...s.rows, ...page.rows];
          return {
            columnNames: page.columns.length ? page.columns : s.columnNames,
            rows,
            reachedEnd: page.returned < PAGE_SIZE,
            loading: false,
            error: null,
          };
        });
      } catch (err) {
        setState((s) => ({ ...s, loading: false, error: String(err) }));
      }
    },
    [connectionId, database, table],
  );

  useEffect(() => {
    loadPage(true);
  }, [loadPage]);

  const rowVirtualizer = useVirtualizer({
    count: state.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (state.reachedEnd || state.loading) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= state.rows.length - 50) {
      loadPage(false);
    }
  }, [virtualItems, state.reachedEnd, state.loading, state.rows.length, loadPage]);

  // 列幅はヘッダ + サンプル行からコンテンツ長を測って決める。
  // canvas.measureText を使い、CJK 含めて実幅で計算する。
  const measureCtx = useMemo(() => {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // TableView のセル文字と同じフォント指定
      ctx.font = '14px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
    }
    return ctx;
  }, []);

  const colWidths = useMemo(() => {
    const measure = (s: string) => measureCtx?.measureText(s).width ?? s.length * 7.5;
    return state.columnNames.map((name, colIdx) => {
      let maxW = measure(name) + 40; // ヘッダは PK バッジの余白込み
      const limit = Math.min(state.rows.length, MEASURE_SAMPLE);
      for (let r = 0; r < limit; r++) {
        const v = state.rows[r]?.[colIdx];
        if (v == null) continue;
        const text = v.length > MEASURE_CELL_MAX ? v.slice(0, MEASURE_CELL_MAX) : v;
        const w = measure(text);
        if (w > maxW) maxW = w;
      }
      return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.ceil(maxW) + MEASURE_PADDING));
    });
  }, [state.columnNames, state.rows, measureCtx]);
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  const editCount = Object.keys(edits).length;

  const pendingRowEdits: RowEdit[] = useMemo(() => {
    const pkOf = (row: number): CellChange[] | null => {
      const r = state.rows[row];
      if (!r) return null;
      const out: CellChange[] = [];
      for (const pk of pkColumns) {
        const idx = state.columnNames.indexOf(pk);
        if (idx < 0) return null;
        out.push({ column: pk, value: r[idx] });
      }
      return out;
    };
    const byRow = new Map<number, CellChange[]>();
    for (const [key, value] of Object.entries(edits)) {
      const [rowStr, colStr] = key.split(":");
      const row = Number(rowStr);
      const col = Number(colStr);
      const column = state.columnNames[col];
      if (column === undefined) continue;
      const list = byRow.get(row) ?? [];
      list.push({ column, value });
      byRow.set(row, list);
    }
    const out: RowEdit[] = [];
    for (const [row, changes] of byRow.entries()) {
      const pk = pkOf(row);
      if (!pk) continue;
      out.push({ database, table, changes, pk });
    }
    return out;
  }, [edits, state.columnNames, state.rows, database, table, pkColumns]);

  function setCell(row: number, col: number, newValue: string | null) {
    const key = editKey(row, col);
    const original = state.rows[row]?.[col] ?? null;
    // 元の値と同じなら edits から外す (dirty マーキング解除)
    if (newValue === original) {
      setEdits((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } else {
      setEdits((prev) => ({ ...prev, [key]: newValue }));
    }
  }

  function cellValue(row: number, col: number): string | null {
    const key = editKey(row, col);
    if (key in edits) return edits[key];
    return state.rows[row]?.[col] ?? null;
  }

  function isDirty(row: number, col: number): boolean {
    return editKey(row, col) in edits;
  }

  function columnIsPk(col: number): boolean {
    return pkColumns.includes(state.columnNames[col] ?? "");
  }

  function canEditCell(col: number): boolean {
    // PK 列は編集禁止 (変わると WHERE が壊れる)
    return editable && !columnIsPk(col);
  }

  async function handleCommit() {
    setCommitting(true);
    setCommitError(null);
    try {
      await commitEdits(connectionId, pendingRowEdits);
      setShowCommit(false);
      // 全体再取得で真実を映す
      await loadPage(true);
    } catch (err) {
      setCommitError(String(err));
    } finally {
      setCommitting(false);
    }
  }

  function handleDiscard() {
    setEdits({});
    setEditing(null);
    setShowCommit(false);
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-4 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {state.rows.length} row{state.rows.length === 1 ? "" : "s"}
          {state.reachedEnd ? "" : "+"}
          {!editable && columns.length > 0 && (
            <span className="ml-2 text-muted-foreground/70">· read-only (no primary key)</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {state.loading && <span className="text-muted-foreground">Loading…</span>}
          {editCount > 0 && (
            <>
              <button
                type="button"
                onClick={handleDiscard}
                className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setShowCommit(true)}
                className="rounded-md border border-accent bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground hover:opacity-90"
              >
                Commit {editCount} change{editCount === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      </header>

      {state.error && (
        <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.error}
        </p>
      )}

      <div
        ref={parentRef}
        className="flex-1 overflow-auto"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <div style={{ width: totalWidth, position: "relative" }}>
          <div
            className="sticky top-0 z-10 flex border-b border-border bg-background/95 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur"
            style={{ width: totalWidth }}
          >
            {state.columnNames.map((col, i) => {
              const pk = columnIsPk(i);
              return (
                <div
                  key={col}
                  style={{ width: colWidths[i] }}
                  className="flex shrink-0 items-center gap-1.5 border-r border-border/60 px-3 py-2"
                >
                  {pk && (
                    <span className="rounded-sm bg-accent/15 px-1 text-[0.55rem] font-semibold tracking-wide text-accent">
                      PK
                    </span>
                  )}
                  <span className="truncate">{col}</span>
                </div>
              );
            })}
          </div>

          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((virtualRow) => {
              const row = state.rows[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  className="absolute top-0 left-0 flex border-b border-border/30 text-sm odd:bg-sidebar-accent/20 hover:bg-sidebar-accent/40"
                  style={{
                    width: totalWidth,
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.map((_, ci) => {
                    const rowIdx = virtualRow.index;
                    const colIdx = ci;
                    const value = cellValue(rowIdx, colIdx);
                    const dirty = isDirty(rowIdx, colIdx);
                    const canEdit = canEditCell(colIdx);
                    const col = columns[colIdx] ?? null;
                    const kind: EditorKind = col ? editorFor(col).kind : "text";
                    const longKind = isLongEditor(kind);
                    const isEditing = editing?.row === rowIdx && editing.col === colIdx;
                    // 長いテキストは別モーダルで編集するのでインライン描画しない
                    const inlineEditing = isEditing && !longKind;

                    return (
                      // biome-ignore lint/a11y/useSemanticElements: virtualised grid needs div-based rows
                      <div
                        key={`${virtualRow.key}:${state.columnNames[colIdx] ?? colIdx}`}
                        style={{ width: colWidths[colIdx] }}
                        className={`shrink-0 border-r border-border/20 px-3 py-1.5 ${
                          dirty ? "bg-accent/20 text-foreground" : ""
                        } ${canEdit ? "cursor-text" : "cursor-default"}`}
                        role="gridcell"
                        tabIndex={canEdit ? 0 : -1}
                        onDoubleClick={() => {
                          if (canEdit) setEditing({ row: rowIdx, col: colIdx });
                        }}
                        onKeyDown={(e) => {
                          if (canEdit && (e.key === "Enter" || e.key === "F2")) {
                            e.preventDefault();
                            setEditing({ row: rowIdx, col: colIdx });
                          }
                        }}
                        title={canEdit ? "double-click or Enter to edit" : undefined}
                      >
                        {inlineEditing ? (
                          <TypedEditor
                            column={col}
                            columnName={state.columnNames[colIdx] ?? ""}
                            initial={value}
                            onCommit={(v) => {
                              setCell(rowIdx, colIdx, v);
                              setEditing(null);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        ) : value === null ? (
                          <span className="text-muted-foreground/60 italic">NULL</span>
                        ) : (
                          <span className="block truncate" title={value}>
                            {value}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {!state.loading && state.rows.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No rows.</p>
        )}
      </div>

      {showCommit && (
        <CommitModal
          edits={pendingRowEdits}
          columnNames={state.columnNames}
          rows={state.rows}
          editsMap={edits}
          onCancel={() => setShowCommit(false)}
          onConfirm={handleCommit}
          committing={committing}
          error={commitError}
        />
      )}

      {(() => {
        if (!editing) return null;
        const col = columns[editing.col] ?? null;
        if (!col) return null;
        const spec = editorFor(col);
        if (!isLongEditor(spec.kind)) return null;
        const currentValue = cellValue(editing.row, editing.col);
        return (
          <LongFieldEditorModal
            column={col}
            columnName={state.columnNames[editing.col] ?? col.name}
            initial={currentValue}
            kind={spec.kind}
            onCommit={(v) => {
              if (editing) {
                setCell(editing.row, editing.col, v);
                setEditing(null);
              }
            }}
            onCancel={() => setEditing(null)}
          />
        );
      })()}
    </div>
  );
}

function TypedEditor({
  column,
  columnName,
  initial,
  onCommit,
  onCancel,
}: {
  column: ColumnInfo | null;
  columnName: string;
  initial: string | null;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
}) {
  const spec: EditorSpec = column ? editorFor(column) : { kind: "text" };
  const allowNull = column?.nullable ?? true;

  const commonKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const nullButton = allowNull ? (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onCommit(null);
      }}
      className="shrink-0 rounded-sm border border-border px-1 text-[0.6rem] text-muted-foreground hover:text-destructive"
      title="Set NULL"
      tabIndex={-1}
    >
      ∅
    </button>
  ) : null;

  if (spec.kind === "boolean") {
    return <BooleanEditor initial={initial} onCommit={onCommit} nullButton={nullButton} />;
  }

  if (spec.kind === "enum" && spec.options) {
    return (
      <SelectEditor
        initial={initial ?? ""}
        options={spec.options}
        allowEmpty={allowNull}
        onCommit={onCommit}
        nullButton={nullButton}
      />
    );
  }

  if (spec.kind === "datetime") {
    return (
      <TextishEditor
        type="datetime-local"
        initial={toDatetimeLocal(initial)}
        onCommit={(v) => onCommit(v === "" ? null : fromDatetimeLocal(v))}
        onKeyDown={commonKeyDown}
        nullButton={nullButton}
      />
    );
  }

  if (spec.kind === "date") {
    return (
      <TextishEditor
        type="date"
        initial={initial ?? ""}
        onCommit={(v) => onCommit(v === "" ? null : v)}
        onKeyDown={commonKeyDown}
        nullButton={nullButton}
      />
    );
  }

  if (spec.kind === "time") {
    return (
      <TextishEditor
        type="time"
        initial={initial ?? ""}
        onCommit={(v) => onCommit(v === "" ? null : v)}
        onKeyDown={commonKeyDown}
        nullButton={nullButton}
      />
    );
  }

  if (spec.kind === "year") {
    return (
      <TextishEditor
        type="number"
        step="1"
        initial={initial ?? ""}
        onCommit={(v) => onCommit(v === "" ? null : v)}
        onKeyDown={commonKeyDown}
        nullButton={nullButton}
      />
    );
  }

  if (spec.kind === "number" || spec.kind === "decimal") {
    return (
      <TextishEditor
        type="number"
        step={spec.step ?? "any"}
        initial={initial ?? ""}
        onCommit={(v) => onCommit(v === "" ? null : v)}
        onKeyDown={commonKeyDown}
        nullButton={nullButton}
      />
    );
  }

  if (spec.kind === "json" || spec.kind === "textarea") {
    return (
      <TextareaEditor
        initial={initial ?? ""}
        placeholder={spec.kind === "json" ? "JSON" : columnName}
        onCommit={(v) => onCommit(v)}
        onCancel={onCancel}
        nullButton={nullButton}
      />
    );
  }

  // default: plain text
  return (
    <TextishEditor
      type="text"
      initial={initial ?? ""}
      onCommit={(v) => onCommit(v)}
      onKeyDown={commonKeyDown}
      nullButton={nullButton}
    />
  );
}

function TextishEditor({
  type,
  step,
  initial,
  onCommit,
  onKeyDown,
  nullButton,
}: {
  type: string;
  step?: string;
  initial: string;
  onCommit: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  nullButton: React.ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (type === "text") ref.current?.select();
  }, [type]);
  return (
    <div className="flex items-center gap-1">
      <input
        ref={ref}
        type={type}
        step={step}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={onKeyDown}
        className="h-5 w-full rounded-sm border border-accent bg-background px-1 text-sm outline-none"
      />
      {nullButton}
    </div>
  );
}

function SelectEditor({
  initial,
  options,
  allowEmpty,
  onCommit,
  nullButton,
}: {
  initial: string;
  options: string[];
  allowEmpty: boolean;
  onCommit: (v: string | null) => void;
  nullButton: React.ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="flex items-center gap-1">
      <select
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => onCommit(value === "" ? null : value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCommit(initial === "" ? null : initial);
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className="h-5 w-full rounded-sm border border-accent bg-background px-1 text-sm outline-none"
      >
        {allowEmpty && <option value="">(unset)</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      {nullButton}
    </div>
  );
}

function BooleanEditor({
  initial,
  onCommit,
  nullButton,
}: {
  initial: string | null;
  onCommit: (v: string | null) => void;
  nullButton: React.ReactNode;
}) {
  const current = initial === "1" ? "1" : initial === "0" ? "0" : "";
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="flex items-center gap-1">
      <select
        ref={ref}
        value={current}
        onChange={(e) => onCommit(e.currentTarget.value === "" ? null : e.currentTarget.value)}
        onBlur={() => onCommit(current === "" ? null : current)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCommit(initial);
          }
        }}
        className="h-5 w-full rounded-sm border border-accent bg-background px-1 text-sm outline-none"
      >
        <option value="">—</option>
        <option value="1">true (1)</option>
        <option value="0">false (0)</option>
      </select>
      {nullButton}
    </div>
  );
}

function TextareaEditor({
  initial,
  placeholder,
  onCommit,
  onCancel,
  nullButton,
}: {
  initial: string;
  placeholder: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  nullButton: React.ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="flex items-start gap-1">
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommit(value);
          }
        }}
        className="h-16 w-full resize-y rounded-sm border border-accent bg-background p-1 font-mono text-xs outline-none"
      />
      {nullButton}
    </div>
  );
}

function LongFieldEditorModal({
  column,
  columnName,
  initial,
  kind,
  onCommit,
  onCancel,
}: {
  column: ColumnInfo;
  columnName: string;
  initial: string | null;
  kind: EditorKind;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<string>(initial ?? "");
  const [isNull, setIsNull] = useState(initial === null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isNull) ref.current?.focus();
  }, [isNull]);

  function save() {
    if (isNull) {
      onCommit(null);
      return;
    }
    if (kind === "json") {
      try {
        // 空でなければ JSON として成立するかチェック
        if (value.trim() !== "") JSON.parse(value);
      } catch (e) {
        setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    onCommit(value);
  }

  function formatJson() {
    try {
      const parsed = JSON.parse(value);
      setValue(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e) {
      setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl">
        <header className="flex items-baseline justify-between border-b border-border px-5 py-3">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {kind === "json" ? "JSON" : "Text"}
            </span>
            <h2 className="text-base font-semibold">
              {columnName}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {column.data_type}
                {column.nullable ? "" : " · NOT NULL"}
              </span>
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {column.nullable && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={isNull}
                  onChange={(e) => {
                    setIsNull(e.currentTarget.checked);
                    setError(null);
                  }}
                  className="h-3.5 w-3.5 accent-accent"
                />
                <span>NULL</span>
              </label>
            )}
            {kind === "json" && (
              <button
                type="button"
                onClick={formatJson}
                disabled={isNull}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Format
              </button>
            )}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <textarea
            ref={ref}
            value={isNull ? "" : value}
            disabled={isNull}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            spellCheck={false}
            className="flex-1 resize-none bg-background p-4 font-mono text-sm text-foreground outline-none disabled:bg-muted/20 disabled:text-muted-foreground"
          />
        </div>
        {error && (
          <p className="mx-5 mb-0 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {isNull ? "NULL" : `${value.length.toLocaleString()} chars`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground"
            >
              OK
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function CommitModal({
  edits,
  columnNames,
  rows,
  editsMap,
  onCancel,
  onConfirm,
  committing,
  error,
}: {
  edits: RowEdit[];
  columnNames: string[];
  rows: (string | null)[][];
  editsMap: EditMap;
  onCancel: () => void;
  onConfirm: () => void;
  committing: boolean;
  error: string | null;
}) {
  // row-ordered の diff 表示用に、元データとの差分をキーから再計算する
  const diffs = useMemo(() => {
    const list: {
      row: number;
      column: string;
      before: string | null;
      after: string | null;
    }[] = [];
    for (const [key, after] of Object.entries(editsMap)) {
      const [rowStr, colStr] = key.split(":");
      const row = Number(rowStr);
      const col = Number(colStr);
      const column = columnNames[col];
      if (column === undefined) continue;
      const before = rows[row]?.[col] ?? null;
      list.push({ row, column, before, after });
    }
    list.sort((a, b) => a.row - b.row || a.column.localeCompare(b.column));
    return list;
  }, [editsMap, columnNames, rows]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl">
        <header className="flex items-baseline justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">Review changes</h2>
          <span className="text-xs text-muted-foreground">
            {edits.length} row{edits.length === 1 ? "" : "s"} · {diffs.length} cell
            {diffs.length === 1 ? "" : "s"}
          </span>
        </header>
        <div className="flex-1 overflow-auto px-5 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            変更は 1 つのトランザクションでコミットされます。影響行が想定より多い場合は
            自動ロールバックします。
          </p>
          <ul className="flex flex-col divide-y divide-border/60">
            {diffs.map((d) => (
              <li
                key={`${d.row}:${d.column}`}
                className="grid grid-cols-[80px_120px_1fr] items-baseline gap-3 py-2 text-sm"
              >
                <span className="text-xs text-muted-foreground">row #{d.row}</span>
                <span className="font-medium">{d.column}</span>
                <span className="flex items-center gap-2 font-mono text-xs">
                  <span className="max-w-[40%] truncate text-muted-foreground line-through">
                    {d.before === null ? "NULL" : d.before}
                  </span>
                  <span className="text-muted-foreground/60">→</span>
                  <span className="max-w-[40%] truncate text-foreground">
                    {d.after === null ? <span className="italic text-accent">NULL</span> : d.after}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {error && (
          <p className="mx-5 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={committing}
            className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={committing}
            className="rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground disabled:opacity-50"
          >
            {committing ? "Committing…" : "Commit"}
          </button>
        </footer>
      </div>
    </div>
  );
}
