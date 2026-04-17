import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CellChange,
  type ColumnInfo,
  commitEdits,
  type RowEdit,
  selectTableRows,
  type TablePage,
} from "@/lib/tauri";

const PAGE_SIZE = 500;
const COL_WIDTH = 180;

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

  const colWidths = useMemo(() => state.columnNames.map(() => COL_WIDTH), [state.columnNames]);
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
                    const isEditing = editing?.row === rowIdx && editing.col === colIdx;

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
                        {isEditing ? (
                          <EditInput
                            initial={value ?? ""}
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
    </div>
  );
}

function EditInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-5 w-full rounded-sm border border-accent bg-background px-1 text-sm outline-none"
      />
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onCommit(null);
        }}
        className="shrink-0 rounded-sm border border-border px-1 text-[0.6rem] text-muted-foreground hover:text-destructive"
        title="Set NULL"
      >
        ∅
      </button>
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
