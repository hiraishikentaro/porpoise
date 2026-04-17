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
  commitChanges,
  type RowChange,
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

/** edits のキーは row:col で索引 (既存行のセル編集バッファ)。値は新しいセル値 (null で NULL)。 */
type EditMap = Record<string, string | null>;
const editKey = (row: number, col: number) => `${row}:${col}`;

/** 新規行: tempId + 明示的に値が設定された列 (colIdx → string|null)。未設定列は DEFAULT */
type NewRow = {
  tempId: string;
  values: Record<number, string | null>;
};

/**
 * 編集中セルの位置。既存行は kind=existing(row は全体 index)、
 * 新規行は kind=new(tempId を直接保持)。
 */
type EditingCell =
  | { kind: "existing"; row: number; col: number }
  | { kind: "new"; tempId: string; col: number }
  | null;

function tempId(): string {
  return `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

type ContextTarget = { kind: "existing"; row: number } | { kind: "new"; tempId: string };

type ContextMenu = {
  x: number;
  y: number;
  target: ContextTarget;
};

export function TableView({ connectionId, database, table, columns }: Props) {
  const [state, setState] = useState<State>(initialState);
  const [edits, setEdits] = useState<EditMap>({});
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<EditingCell>(null);
  const [showCommit, setShowCommit] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // Click anywhere / Esc で閉じる
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const keyClose = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", keyClose);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", keyClose);
    };
  }, [contextMenu]);

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
        setNewRows([]);
        setDeletedRows(new Set());
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

  /**
   * Virtualized rendering は「新規行 + 既存行」のフラットリストで動かす。
   * virtual index < newRows.length なら新規行、以上なら既存行 (offset を引く)。
   */
  const totalVirtualRows = state.rows.length + newRows.length;
  const rowVirtualizer = useVirtualizer({
    count: totalVirtualRows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (state.reachedEnd || state.loading) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    // 既存行の末尾 50 行手前に到達したら次ページを呼ぶ
    if (last.index >= totalVirtualRows - 50) {
      loadPage(false);
    }
  }, [virtualItems, state.reachedEnd, state.loading, totalVirtualRows, loadPage]);

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

  /**
   * 削除予定に含まれる行の UPDATE は無駄なので除外する。
   * 削除した行を「戻して更新」する UX は後回し。
   */
  const effectiveEditCount = useMemo(() => {
    let n = 0;
    for (const key of Object.keys(edits)) {
      const row = Number(key.split(":")[0]);
      if (!deletedRows.has(row)) n++;
    }
    return n;
  }, [edits, deletedRows]);

  const insertCount = newRows.length;
  const deleteCount = deletedRows.size;
  const totalChanges = effectiveEditCount + insertCount + deleteCount;

  const pendingChanges: RowChange[] = useMemo(() => {
    const out: RowChange[] = [];

    const pkOf = (row: number): CellChange[] | null => {
      const r = state.rows[row];
      if (!r) return null;
      const values: CellChange[] = [];
      for (const pk of pkColumns) {
        const idx = state.columnNames.indexOf(pk);
        if (idx < 0) return null;
        values.push({ column: pk, value: r[idx] });
      }
      return values;
    };

    // UPDATE: 削除予定に含まれない編集のみ
    const byRow = new Map<number, CellChange[]>();
    for (const [key, value] of Object.entries(edits)) {
      const [rowStr, colStr] = key.split(":");
      const row = Number(rowStr);
      if (deletedRows.has(row)) continue;
      const col = Number(colStr);
      const column = state.columnNames[col];
      if (column === undefined) continue;
      const list = byRow.get(row) ?? [];
      list.push({ column, value });
      byRow.set(row, list);
    }
    for (const [row, changes] of byRow.entries()) {
      const pk = pkOf(row);
      if (!pk) continue;
      out.push({ kind: "update", database, table, changes, pk });
    }

    // INSERT: 新規行ごとに explicit に設定した列だけを送る (未設定は MySQL DEFAULT)
    for (const nr of newRows) {
      const values: CellChange[] = [];
      for (const [colIdxStr, v] of Object.entries(nr.values)) {
        const colIdx = Number(colIdxStr);
        const column = state.columnNames[colIdx];
        if (column === undefined) continue;
        values.push({ column, value: v });
      }
      out.push({ kind: "insert", database, table, values });
    }

    // DELETE
    for (const row of deletedRows) {
      const pk = pkOf(row);
      if (!pk) continue;
      out.push({ kind: "delete", database, table, pk });
    }

    return out;
  }, [edits, newRows, deletedRows, state.columnNames, state.rows, database, table, pkColumns]);

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

  function setNewRowCell(tempIdValue: string, col: number, value: string | null) {
    setNewRows((prev) =>
      prev.map((r) =>
        r.tempId === tempIdValue ? { ...r, values: { ...r.values, [col]: value } } : r,
      ),
    );
  }

  function addNewRow() {
    const row = { tempId: tempId(), values: {} as Record<number, string | null> };
    // 追加は先頭に差し込むのでテーブルの一番上に出る
    setNewRows((prev) => [row, ...prev]);
    // 追加直後にスクロール位置を一番上へ戻して見えやすく
    parentRef.current?.scrollTo({ top: 0 });
  }

  function removeNewRow(tempIdValue: string) {
    setNewRows((prev) => prev.filter((r) => r.tempId !== tempIdValue));
  }

  function toggleDelete(row: number) {
    setDeletedRows((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
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

  function canEditExistingCell(col: number): boolean {
    // PK 列は編集禁止 (変わると WHERE が壊れる)
    return editable && !columnIsPk(col);
  }

  async function handleCommit() {
    setCommitting(true);
    setCommitError(null);
    try {
      await commitChanges(connectionId, pendingChanges);
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
    setNewRows([]);
    setDeletedRows(new Set());
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
          {editable && (
            <button
              type="button"
              onClick={addNewRow}
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent"
              title="Add a new row"
            >
              + Row
            </button>
          )}
          {totalChanges > 0 && (
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
                Commit {totalChanges} change{totalChanges === 1 ? "" : "s"}
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
              const idx = virtualRow.index;
              const isNewRow = idx < newRows.length;
              if (isNewRow) {
                const nr = newRows[idx];
                if (!nr) return null;
                return (
                  <NewRowView
                    key={virtualRow.key}
                    virtualRow={virtualRow}
                    totalWidth={totalWidth}
                    columns={columns}
                    columnNames={state.columnNames}
                    colWidths={colWidths}
                    newRow={nr}
                    editing={editing}
                    setEditing={setEditing}
                    onCell={(col, v) => setNewRowCell(nr.tempId, col, v)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        target: { kind: "new", tempId: nr.tempId },
                      });
                    }}
                  />
                );
              }
              const existingRowIdx = idx - newRows.length;
              const row = state.rows[existingRowIdx];
              const rowDeleted = deletedRows.has(existingRowIdx);
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: right-click handler is primary; row has focusable cells
                // biome-ignore lint/a11y/noStaticElementInteractions: virtualised row container
                <div
                  key={virtualRow.key}
                  className={`absolute top-0 left-0 flex border-b border-border/30 text-sm odd:bg-sidebar-accent/20 hover:bg-sidebar-accent/40 ${
                    rowDeleted ? "bg-destructive/15" : ""
                  }`}
                  style={{
                    width: totalWidth,
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onContextMenu={(e) => {
                    if (!editable) return;
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      target: { kind: "existing", row: existingRowIdx },
                    });
                  }}
                >
                  {row.map((_, ci) => {
                    const rowIdx = existingRowIdx;
                    const colIdx = ci;
                    const value = cellValue(rowIdx, colIdx);
                    const dirty = isDirty(rowIdx, colIdx);
                    const canEdit = canEditExistingCell(colIdx) && !rowDeleted;
                    const col = columns[colIdx] ?? null;
                    const kind: EditorKind = col ? editorFor(col).kind : "text";
                    const longKind = isLongEditor(kind);
                    const isEditing =
                      editing?.kind === "existing" &&
                      editing.row === rowIdx &&
                      editing.col === colIdx;
                    const inlineEditing = isEditing && !longKind;

                    return (
                      // biome-ignore lint/a11y/useSemanticElements: virtualised grid needs div-based rows
                      <div
                        key={`${virtualRow.key}:${state.columnNames[colIdx] ?? colIdx}`}
                        style={{ width: colWidths[colIdx] }}
                        className={`relative shrink-0 border-r border-border/20 px-3 py-1.5 ${
                          dirty && !rowDeleted ? "bg-accent/20 text-foreground" : ""
                        } ${canEdit ? "cursor-text" : "cursor-default"} ${
                          rowDeleted ? "text-destructive line-through opacity-70" : ""
                        }`}
                        role="gridcell"
                        tabIndex={canEdit ? 0 : -1}
                        onDoubleClick={() => {
                          if (canEdit) setEditing({ kind: "existing", row: rowIdx, col: colIdx });
                        }}
                        onKeyDown={(e) => {
                          if (canEdit && (e.key === "Enter" || e.key === "F2")) {
                            e.preventDefault();
                            setEditing({ kind: "existing", row: rowIdx, col: colIdx });
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
                  {rowDeleted && (
                    <span
                      className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm bg-destructive px-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-background"
                      aria-hidden
                    >
                      deleted
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {!state.loading && state.rows.length === 0 && newRows.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No rows.</p>
        )}
      </div>

      {showCommit && (
        <CommitModal
          changes={pendingChanges}
          columnNames={state.columnNames}
          rows={state.rows}
          editsMap={edits}
          deletedRows={deletedRows}
          newRows={newRows}
          onCancel={() => setShowCommit(false)}
          onConfirm={handleCommit}
          committing={committing}
          error={commitError}
        />
      )}

      {contextMenu && (
        <RowContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          deletedRows={deletedRows}
          onDelete={(row) => {
            toggleDelete(row);
            setContextMenu(null);
          }}
          onDiscardNew={(tempId) => {
            removeNewRow(tempId);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {(() => {
        if (!editing) return null;
        const col = columns[editing.col] ?? null;
        if (!col) return null;
        const spec = editorFor(col);
        if (!isLongEditor(spec.kind)) return null;

        let currentValue: string | null;
        if (editing.kind === "existing") {
          currentValue = cellValue(editing.row, editing.col);
        } else {
          const nr = newRows.find((r) => r.tempId === editing.tempId);
          currentValue = nr ? (nr.values[editing.col] ?? null) : null;
        }
        return (
          <LongFieldEditorModal
            column={col}
            columnName={state.columnNames[editing.col] ?? col.name}
            initial={currentValue}
            kind={spec.kind}
            onCommit={(v) => {
              if (!editing) return;
              if (editing.kind === "existing") {
                setCell(editing.row, editing.col, v);
              } else {
                setNewRowCell(editing.tempId, editing.col, v);
              }
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        );
      })()}
    </div>
  );
}

function RowContextMenu({
  x,
  y,
  target,
  deletedRows,
  onDelete,
  onDiscardNew,
}: {
  x: number;
  y: number;
  target: ContextTarget;
  deletedRows: Set<number>;
  onDelete: (row: number) => void;
  onDiscardNew: (tempId: string) => void;
  onClose: () => void;
}) {
  // 画面端でクリップされないよう位置をオフセット
  const style: React.CSSProperties = {
    position: "fixed",
    top: y,
    left: x,
    minWidth: 180,
  };

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={style}
      className="z-40 rounded-md border border-border bg-popover p-1 text-sm shadow-xl"
    >
      {target.kind === "existing" ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => onDelete(target.row)}
          className={`flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left ${
            deletedRows.has(target.row)
              ? "text-muted-foreground hover:bg-muted"
              : "text-destructive hover:bg-destructive/15"
          }`}
        >
          <span className="font-medium">
            {deletedRows.has(target.row) ? "Undo delete" : "Delete row"}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">row #{target.row}</span>
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          onClick={() => onDiscardNew(target.tempId)}
          className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left text-destructive hover:bg-destructive/15"
        >
          <span className="font-medium">Discard new row</span>
        </button>
      )}
    </div>
  );
}

function NewRowView({
  virtualRow,
  totalWidth,
  columns,
  columnNames,
  colWidths,
  newRow,
  editing,
  setEditing,
  onCell,
  onContextMenu,
}: {
  virtualRow: { key: React.Key; size: number; start: number };
  totalWidth: number;
  columns: ColumnInfo[];
  columnNames: string[];
  colWidths: number[];
  newRow: NewRow;
  editing: EditingCell;
  setEditing: (c: EditingCell) => void;
  onCell: (col: number, v: string | null) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const keyPrefix = String(virtualRow.key);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: right-click handler
    // biome-ignore lint/a11y/noStaticElementInteractions: virtualised row container
    <div
      className="absolute top-0 left-0 flex border-b border-accent/40 bg-accent/10 text-sm hover:bg-accent/15"
      style={{
        width: totalWidth,
        height: virtualRow.size,
        transform: `translateY(${virtualRow.start}px)`,
      }}
      onContextMenu={onContextMenu}
    >
      {columnNames.map((name, colIdx) => {
        const col = columns[colIdx] ?? null;
        const kind: EditorKind = col ? editorFor(col).kind : "text";
        const longKind = isLongEditor(kind);
        const set = colIdx in newRow.values;
        const value = set ? newRow.values[colIdx] : null;
        const isEditing =
          editing?.kind === "new" && editing.tempId === newRow.tempId && editing.col === colIdx;
        const inlineEditing = isEditing && !longKind;

        return (
          // biome-ignore lint/a11y/useSemanticElements: virtualised grid needs div-based rows
          <div
            key={`${keyPrefix}:${name ?? colIdx}`}
            style={{ width: colWidths[colIdx] }}
            className="relative shrink-0 cursor-text border-r border-border/20 px-3 py-1.5"
            role="gridcell"
            tabIndex={0}
            onDoubleClick={() => setEditing({ kind: "new", tempId: newRow.tempId, col: colIdx })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "F2") {
                e.preventDefault();
                setEditing({ kind: "new", tempId: newRow.tempId, col: colIdx });
              }
            }}
            title="double-click or Enter to edit · leave blank for DEFAULT"
          >
            {inlineEditing ? (
              <TypedEditor
                column={col}
                columnName={name ?? ""}
                initial={value ?? null}
                onCommit={(v) => {
                  onCell(colIdx, v);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : !set ? (
              <span className="text-muted-foreground/50 italic">DEFAULT</span>
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
      <span
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm bg-accent/30 px-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-accent"
        aria-hidden
      >
        new
      </span>
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
    ref.current?.focus();
  }, []);

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
                    const next = e.currentTarget.checked;
                    setIsNull(next);
                    if (next) setValue("");
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
            value={value}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              // タイプし始めたら NULL モードは自動解除
              if (isNull) setIsNull(false);
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
            placeholder={isNull ? "(currently NULL — type to overwrite)" : ""}
            className={`flex-1 resize-none bg-background p-4 font-mono text-sm text-foreground outline-none ${
              isNull ? "text-muted-foreground italic" : ""
            }`}
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
  changes,
  columnNames,
  rows,
  editsMap,
  deletedRows,
  newRows,
  onCancel,
  onConfirm,
  committing,
  error,
}: {
  changes: RowChange[];
  columnNames: string[];
  rows: (string | null)[][];
  editsMap: EditMap;
  deletedRows: Set<number>;
  newRows: NewRow[];
  onCancel: () => void;
  onConfirm: () => void;
  committing: boolean;
  error: string | null;
}) {
  // 更新差分: 削除予定行はスキップ
  const updateDiffs = useMemo(() => {
    const list: {
      row: number;
      column: string;
      before: string | null;
      after: string | null;
    }[] = [];
    for (const [key, after] of Object.entries(editsMap)) {
      const [rowStr, colStr] = key.split(":");
      const row = Number(rowStr);
      if (deletedRows.has(row)) continue;
      const col = Number(colStr);
      const column = columnNames[col];
      if (column === undefined) continue;
      const before = rows[row]?.[col] ?? null;
      list.push({ row, column, before, after });
    }
    list.sort((a, b) => a.row - b.row || a.column.localeCompare(b.column));
    return list;
  }, [editsMap, columnNames, rows, deletedRows]);

  const updateCount = changes.filter((c) => c.kind === "update").length;
  const insertCount = changes.filter((c) => c.kind === "insert").length;
  const deleteCount = changes.filter((c) => c.kind === "delete").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl">
        <header className="flex items-baseline justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">Review changes</h2>
          <span className="text-xs text-muted-foreground">
            {updateCount} update{updateCount === 1 ? "" : "s"} · {insertCount} insert
            {insertCount === 1 ? "" : "s"} · {deleteCount} delete{deleteCount === 1 ? "" : "s"}
          </span>
        </header>
        <div className="flex-1 overflow-auto px-5 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            変更は 1 つのトランザクションでコミットされます。影響行が想定より多い場合は
            自動ロールバックします。
          </p>

          {updateDiffs.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Updates
              </h3>
              <ul className="flex flex-col divide-y divide-border/60">
                {updateDiffs.map((d) => (
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
                        {d.after === null ? (
                          <span className="italic text-accent">NULL</span>
                        ) : (
                          d.after
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {newRows.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Inserts
              </h3>
              <ul className="flex flex-col gap-2">
                {newRows.map((nr, i) => {
                  const setCols = Object.entries(nr.values).map(([colIdx, v]) => ({
                    column: columnNames[Number(colIdx)] ?? `#${colIdx}`,
                    value: v,
                  }));
                  return (
                    <li
                      key={nr.tempId}
                      className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm"
                    >
                      <span className="mb-1 block text-xs text-muted-foreground">
                        new row #{i + 1}
                      </span>
                      {setCols.length === 0 ? (
                        <span className="text-xs italic text-muted-foreground">
                          All columns DEFAULT
                        </span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {setCols.map((c) => (
                            <li
                              key={c.column}
                              className="grid grid-cols-[120px_1fr] gap-3 font-mono text-xs"
                            >
                              <span className="font-medium text-foreground">{c.column}</span>
                              <span className="truncate">
                                {c.value === null ? (
                                  <span className="italic text-accent">NULL</span>
                                ) : (
                                  c.value
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {deletedRows.size > 0 && (
            <section className="mb-2">
              <h3 className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Deletes
              </h3>
              <ul className="flex flex-col divide-y divide-border/60">
                {Array.from(deletedRows)
                  .sort((a, b) => a - b)
                  .map((row) => (
                    <li key={row} className="py-1.5 text-sm text-destructive">
                      row #{row}
                    </li>
                  ))}
              </ul>
            </section>
          )}
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
