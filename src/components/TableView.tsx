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

import { save } from "@tauri-apps/plugin-dialog";
import { type CopyFormat, formatRowsAs } from "@/lib/row-format";
import {
  type CellChange,
  type ColumnInfo,
  commitChanges,
  type ExportFormat,
  exportTable,
  type Filter,
  type FilterMatch,
  type RowChange,
  type SortKey,
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

type ContextTarget =
  | { kind: "existing"; row: number; col?: number }
  | { kind: "new"; tempId: string }
  | { kind: "header"; col: number };

type ContextMenu = {
  x: number;
  y: number;
  target: ContextTarget;
};

type FilterOp = Filter["op"];

type FilterDraft = {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  /** Apply All の対象に含めるかのチェックボックス */
  checked: boolean;
};

function filterDraftToFilter(d: FilterDraft): Filter | null {
  const col = d.column.trim();
  if (!col) return null;
  if (d.op === "is_null" || d.op === "is_not_null") {
    return { column: col, op: d.op };
  }
  return { column: col, op: d.op, value: d.value };
}

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
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const lastSelectedRef = useRef<number | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [sortKeys, setSortKeys] = useState<SortKey[]>([]);
  const [filterDrafts, setFilterDrafts] = useState<FilterDraft[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [appliedFilters, setAppliedFilters] = useState<Filter[]>([]);
  /** 現在適用されている filter draft の id 集合。UI の "Applied" 表示用 */
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

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
          {
            sort: sortKeys.length > 0 ? sortKeys : undefined,
            filters: appliedFilters.length > 0 ? appliedFilters : undefined,
          },
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
    [connectionId, database, table, sortKeys, appliedFilters],
  );

  useEffect(() => {
    loadPage(true);
  }, [loadPage]);

  function cycleSort(column: string) {
    setSortKeys((prev) => {
      const existing = prev.find((k) => k.column === column);
      if (!existing) {
        // append as ASC (shift-click could extend multi-sort; MVP は単一ソート)
        return [{ column, descending: false }];
      }
      if (!existing.descending) {
        // ASC → DESC
        return prev.map((k) => (k.column === column ? { ...k, descending: true } : k));
      }
      // DESC → clear
      return prev.filter((k) => k.column !== column);
    });
  }

  /** チェックが入っている全 draft をまとめて適用 (AND) */
  function applyAllChecked() {
    const valid: Filter[] = [];
    const ids = new Set<string>();
    for (const d of filterDrafts) {
      if (!d.checked) continue;
      const f = filterDraftToFilter(d);
      if (f) {
        valid.push(f);
        ids.add(d.id);
      }
    }
    setAppliedFilters(valid);
    setAppliedIds(ids);
  }

  /** 単一 draft を適用 (既存 applied は全部置き換え) */
  function applyOne(id: string) {
    const d = filterDrafts.find((x) => x.id === id);
    if (!d) return;
    const f = filterDraftToFilter(d);
    if (!f) return;
    setAppliedFilters([f]);
    setAppliedIds(new Set([id]));
  }

  function clearAllFilters() {
    setFilterDrafts([]);
    setAppliedFilters([]);
    setAppliedIds(new Set());
  }

  /** 右クリック由来の Quick filter。既存 drafts に追加して即座に適用 */
  function applyQuickFilter(column: string, op: FilterOp, value: string) {
    const draft: FilterDraft = {
      id: `qf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      column,
      op,
      value,
      checked: true,
    };
    const nextDrafts = [...filterDrafts, draft];
    setFilterDrafts(nextDrafts);
    setFiltersOpen(true);
    const valid: Filter[] = [];
    const ids = new Set<string>();
    for (const d of nextDrafts) {
      if (!d.checked) continue;
      const f = filterDraftToFilter(d);
      if (f) {
        valid.push(f);
        ids.add(d.id);
      }
    }
    setAppliedFilters(valid);
    setAppliedIds(ids);
  }

  /** 列ヘッダから新規 filter を開いて入力待ちにする (checked=true で追加) */
  function openFilterForColumn(column: string) {
    setFilterDrafts((prev) => [
      ...prev,
      {
        id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        column,
        op: "like",
        value: "",
        checked: true,
      },
    ]);
    setFiltersOpen(true);
  }

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
      // TableView のセル文字と同じフォント指定 (index.css の --font-sans と揃える)
      ctx.font =
        '14px "Inter Variable", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", system-ui, sans-serif';
    }
    return ctx;
  }, []);

  /** ユーザーが pointer-drag でリサイズした列幅 (カラム名 → px)。計測値より優先される */
  const [userColWidths, setUserColWidths] = useState<Record<string, number>>({});

  const measuredColWidths = useMemo(() => {
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

  const colWidths = useMemo(
    () =>
      state.columnNames.map(
        (name, i) => userColWidths[name] ?? measuredColWidths[i] ?? MIN_COL_WIDTH,
      ),
    [state.columnNames, userColWidths, measuredColWidths],
  );
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  const startColResize = useCallback(
    (e: React.PointerEvent, colName: string, startWidth: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      let rafId: number | null = null;
      let pendingNext = startWidth;
      function flush() {
        rafId = null;
        setUserColWidths((prev) =>
          prev[colName] === pendingNext ? prev : { ...prev, [colName]: pendingNext },
        );
      }
      function handleMove(ev: PointerEvent) {
        pendingNext = Math.max(
          MIN_COL_WIDTH,
          Math.min(MAX_COL_WIDTH, startWidth + (ev.clientX - startX)),
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
    },
    [],
  );

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

  async function copyRowsAs(rowIdxs: number[], format: CopyFormat) {
    if (rowIdxs.length === 0) return;
    // cellValue で edits を反映した現在値をコピー対象にする
    const sortedIdxs = [...rowIdxs].sort((a, b) => a - b);
    const data = sortedIdxs.map((ri) => state.columnNames.map((_, ci) => cellValue(ri, ci)));
    const text = formatRowsAs(data, state.columnNames, format, table);
    try {
      await navigator.clipboard.writeText(text);
      setCopyToast(
        `Copied ${data.length} row${data.length > 1 ? "s" : ""} as ${format.toUpperCase()}`,
      );
      window.setTimeout(() => setCopyToast(null), 1600);
    } catch {
      setCopyToast("Copy failed");
      window.setTimeout(() => setCopyToast(null), 1600);
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
      <header className="flex h-9 items-center justify-between border-b border-border bg-sidebar/25 px-4 text-xs">
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="tp-num text-foreground/90">
            {state.rows.length.toLocaleString()}
            {state.reachedEnd ? "" : "+"}
          </span>
          <span className="text-muted-foreground/70">row{state.rows.length === 1 ? "" : "s"}</span>
          {appliedFilters.length > 0 && <span className="tp-chip-accent">filtered</span>}
          {!editable && columns.length > 0 && <span className="tp-chip-ghost">read-only</span>}
          {state.loading && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground/80">
              <span
                aria-hidden
                className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent"
              />
              loading
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[0.7rem] transition-colors ${
              filtersOpen || appliedFilters.length > 0
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-border text-muted-foreground hover:border-accent/60 hover:text-accent"
            }`}
            title="Toggle filter bar"
          >
            Filter{appliedFilters.length > 0 ? ` · ${appliedFilters.length}` : ""}
          </button>
          {editable && (
            <button
              type="button"
              onClick={addNewRow}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[0.7rem] text-muted-foreground transition-colors hover:border-accent/60 hover:text-accent"
              title="Add a new row"
            >
              <span aria-hidden>+</span> Row
            </button>
          )}
          <ExportMenu
            connectionId={connectionId}
            database={database}
            table={table}
            sort={sortKeys}
            filters={appliedFilters}
            filterMatch="all"
          />
          {totalChanges > 0 && (
            <>
              <button
                type="button"
                onClick={handleDiscard}
                className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[0.7rem] text-muted-foreground transition-colors hover:text-foreground"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setShowCommit(true)}
                className="tp-btn tp-btn-primary h-6 px-2.5 text-[0.7rem]"
              >
                Commit <span className="tp-num">{totalChanges}</span>
              </button>
            </>
          )}
        </div>
      </header>

      {filtersOpen && (
        <FilterBar
          columns={state.columnNames.length ? state.columnNames : columns.map((c) => c.name)}
          drafts={filterDrafts}
          setDrafts={setFilterDrafts}
          appliedIds={appliedIds}
          onApplyAll={applyAllChecked}
          onApplyOne={applyOne}
          onUnset={() => {
            clearAllFilters();
            setFiltersOpen(false);
          }}
          tableName={table}
          database={database}
          appliedCount={appliedFilters.length}
        />
      )}

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
            className="sticky top-0 z-10 flex border-b border-border bg-sidebar/85 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground backdrop-blur"
            style={{ width: totalWidth }}
          >
            {state.columnNames.map((col, i) => {
              const pk = columnIsPk(i);
              const sort = sortKeys.find((k) => k.column === col);
              const width = colWidths[i];
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: header cell wrapper; contextmenu on div is required because button children can swallow the event
                <div
                  key={col}
                  style={{ width }}
                  className="relative flex shrink-0 items-stretch"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      target: { kind: "header", col: i },
                    });
                  }}
                >
                  <button
                    type="button"
                    onClick={() => cycleSort(col)}
                    className={`flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/40 ${
                      sort ? "text-accent" : ""
                    }`}
                    title="Click to sort"
                  >
                    {pk && (
                      <span
                        className="rounded-sm bg-accent/15 px-1 text-[0.55rem] font-semibold tracking-wider text-accent"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        PK
                      </span>
                    )}
                    <span className="truncate">{col}</span>
                    {sort && (
                      <span aria-hidden className="ml-auto text-[0.65rem] text-accent">
                        {sort.descending ? "▼" : "▲"}
                      </span>
                    )}
                    {sort && (
                      <span
                        aria-hidden
                        className="absolute inset-x-0 bottom-0 h-[1.5px]"
                        style={{ backgroundColor: "var(--accent)" }}
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Resize ${col}`}
                    onPointerDown={(e) => startColResize(e, col, width)}
                    className="w-1.5 shrink-0 cursor-col-resize border-r border-border/60 bg-transparent transition-colors hover:bg-accent/50 active:bg-accent/70"
                    title="Drag to resize"
                  />
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
              const isSelected = selectedRows.has(existingRowIdx);
              return (
                // biome-ignore lint/a11y/useSemanticElements: virtualised grid needs div-based rows
                // biome-ignore lint/a11y/useKeyWithClickEvents: selection uses modifier+click; keyboard row-nav is future work
                <div
                  key={virtualRow.key}
                  role="row"
                  tabIndex={-1}
                  className={`absolute top-0 left-0 flex border-b border-border/30 text-sm odd:bg-sidebar-accent/20 hover:bg-sidebar-accent/40 ${
                    rowDeleted ? "bg-destructive/15" : ""
                  } ${isSelected ? "bg-accent/20 hover:bg-accent/25" : ""}`}
                  style={{
                    width: totalWidth,
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onClick={(e) => {
                    // セル編集中は選択処理をスキップ (ダブルクリック編集との整合性のため
                    // プレーンクリックも吸って selection を更新する)
                    if (e.metaKey || e.ctrlKey) {
                      setSelectedRows((prev) => {
                        const next = new Set(prev);
                        if (next.has(existingRowIdx)) next.delete(existingRowIdx);
                        else next.add(existingRowIdx);
                        return next;
                      });
                      lastSelectedRef.current = existingRowIdx;
                    } else if (e.shiftKey && lastSelectedRef.current !== null) {
                      const from = Math.min(lastSelectedRef.current, existingRowIdx);
                      const to = Math.max(lastSelectedRef.current, existingRowIdx);
                      setSelectedRows((prev) => {
                        const next = new Set(prev);
                        for (let i = from; i <= to; i++) next.add(i);
                        return next;
                      });
                    } else {
                      setSelectedRows(new Set([existingRowIdx]));
                      lastSelectedRef.current = existingRowIdx;
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // 右クリックした行が選択済みでなければ単独選択に切り替え
                    if (!selectedRows.has(existingRowIdx)) {
                      setSelectedRows(new Set([existingRowIdx]));
                      lastSelectedRef.current = existingRowIdx;
                    }
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
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!selectedRows.has(existingRowIdx)) {
                            setSelectedRows(new Set([existingRowIdx]));
                            lastSelectedRef.current = existingRowIdx;
                          }
                          setContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            target: { kind: "existing", row: existingRowIdx, col: colIdx },
                          });
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
          selectedRows={selectedRows}
          editable={editable}
          columnNames={state.columnNames}
          cellValue={cellValue}
          onDelete={(row) => {
            toggleDelete(row);
            setContextMenu(null);
          }}
          onDiscardNew={(tempId) => {
            removeNewRow(tempId);
            setContextMenu(null);
          }}
          onCopy={(rows, format) => {
            copyRowsAs(rows, format);
            setContextMenu(null);
          }}
          onQuickFilter={(column, op, value) => {
            applyQuickFilter(column, op, value);
            setContextMenu(null);
          }}
          onFilterColumn={(column) => {
            openFilterForColumn(column);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {copyToast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-foreground shadow-lg"
        >
          {copyToast}
        </div>
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

const FILTER_OPS: { value: FilterOp; label: string; hasValue: boolean }[] = [
  { value: "eq", label: "=", hasValue: true },
  { value: "ne", label: "≠", hasValue: true },
  { value: "like", label: "LIKE", hasValue: true },
  { value: "not_like", label: "NOT LIKE", hasValue: true },
  { value: "lt", label: "<", hasValue: true },
  { value: "le", label: "≤", hasValue: true },
  { value: "gt", label: ">", hasValue: true },
  { value: "ge", label: "≥", hasValue: true },
  { value: "is_null", label: "IS NULL", hasValue: false },
  { value: "is_not_null", label: "IS NOT NULL", hasValue: false },
];

function buildWhereSql(drafts: FilterDraft[], database: string, table: string): string {
  const valid = drafts.map(filterDraftToFilter).filter((f): f is Filter => f !== null);
  const ident = (s: string) => `\`${s.replace(/`/g, "``")}\``;
  const quote = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const opLabel: Record<Filter["op"], string> = {
    eq: "=",
    ne: "<>",
    lt: "<",
    le: "<=",
    gt: ">",
    ge: ">=",
    like: "LIKE",
    not_like: "NOT LIKE",
    is_null: "IS NULL",
    is_not_null: "IS NOT NULL",
  };
  const parts = valid.map((f) => {
    const left = ident(f.column);
    if (f.op === "is_null" || f.op === "is_not_null") {
      return `${left} ${opLabel[f.op]}`;
    }
    const value = (f as { value: string }).value;
    return `${left} ${opLabel[f.op]} ${quote(value)}`;
  });
  const where = parts.length === 0 ? "" : `\nWHERE ${parts.join("\n  AND ")}`;
  return `SELECT *\nFROM ${ident(database)}.${ident(table)}${where};`;
}

function FilterBar({
  columns,
  drafts,
  setDrafts,
  appliedIds,
  onApplyAll,
  onApplyOne,
  onUnset,
  tableName,
  database,
  appliedCount,
}: {
  columns: string[];
  drafts: FilterDraft[];
  setDrafts: React.Dispatch<React.SetStateAction<FilterDraft[]>>;
  appliedIds: Set<string>;
  onApplyAll: () => void;
  onApplyOne: (id: string) => void;
  onUnset: () => void;
  tableName: string;
  database: string;
  appliedCount: number;
}) {
  const [sqlOpen, setSqlOpen] = useState(false);
  function updateDraft(id: string, patch: Partial<FilterDraft>) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }
  function addDraft() {
    setDrafts((prev) => [
      ...prev,
      {
        id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        column: columns[0] ?? "",
        op: "like",
        value: "",
        checked: true,
      },
    ]);
  }
  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-sidebar-accent/20 px-4 py-2 text-xs">
      {drafts.length === 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">No filters.</span>
          <button
            type="button"
            onClick={addDraft}
            className="rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:border-accent hover:text-accent"
          >
            + Filter
          </button>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {drafts.map((d) => {
              const op = FILTER_OPS.find((o) => o.value === d.op) ?? FILTER_OPS[0];
              const isApplied = appliedIds.has(d.id);
              return (
                <li
                  key={d.id}
                  className="grid grid-cols-[auto_200px_140px_1fr_auto_auto] items-center gap-2"
                >
                  <input
                    type="checkbox"
                    checked={d.checked}
                    onChange={(e) => updateDraft(d.id, { checked: e.currentTarget.checked })}
                    aria-label="Include in Apply All"
                    className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  />
                  <select
                    value={d.column}
                    onChange={(e) => updateDraft(d.id, { column: e.currentTarget.value })}
                    className="h-7 rounded-md border border-border bg-input/50 px-2 outline-none focus:border-accent"
                  >
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={d.op}
                    onChange={(e) => updateDraft(d.id, { op: e.currentTarget.value as FilterOp })}
                    className="h-7 rounded-md border border-border bg-input/50 px-2 outline-none focus:border-accent"
                  >
                    {FILTER_OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder={op.hasValue ? "value" : "— no value —"}
                    value={d.value}
                    disabled={!op.hasValue}
                    onChange={(e) => updateDraft(d.id, { value: e.currentTarget.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onApplyOne(d.id);
                      }
                    }}
                    className="h-7 rounded-md border border-border bg-input/50 px-2 outline-none placeholder:text-muted-foreground/60 focus:border-accent disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => onApplyOne(d.id)}
                    className={`rounded-md border px-2 py-0.5 font-semibold ${
                      isApplied
                        ? "border-accent bg-accent/20 text-accent"
                        : "border-border text-muted-foreground hover:border-accent hover:text-accent"
                    }`}
                    title="Apply only this filter (↵)"
                  >
                    {isApplied ? "Applied" : "Apply"}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeDraft(d.id)}
                    className="rounded-md px-2 py-0.5 text-muted-foreground hover:text-destructive"
                    aria-label="Remove filter"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addDraft}
              className="rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:border-accent hover:text-accent"
              title="Add filter"
            >
              + Filter
            </button>
            <button
              type="button"
              onClick={() => setSqlOpen(true)}
              className="rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:border-accent hover:text-accent"
              title="Preview generated SQL"
            >
              SQL
            </button>
            <button
              type="button"
              onClick={onUnset}
              className="rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:text-destructive"
              title="Clear all filters and close filter bar"
            >
              Unset
            </button>
            <span className="ml-auto text-muted-foreground">
              {appliedCount > 0 ? `${appliedCount} applied` : "unapplied"}
            </span>
            <button
              type="button"
              onClick={onApplyAll}
              className="rounded-md border border-accent bg-accent px-2 py-0.5 font-semibold text-accent-foreground hover:opacity-90"
              title="Apply all checked filters (⌘↵)"
            >
              Apply All
            </button>
          </div>
        </>
      )}
      {sqlOpen && (
        <SqlPreviewModal
          sql={buildWhereSql(drafts, database, tableName)}
          onClose={() => setSqlOpen(false)}
        />
      )}
    </div>
  );
}

function SqlPreviewModal({ sql, onClose }: { sql: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      // noop
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-6 pt-[12vh] backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 z-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Generated SQL"
        className="relative z-10 flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border bg-sidebar/30 px-4 py-2">
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
            Generated SQL
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-accent hover:text-accent"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>
        <pre className="overflow-auto whitespace-pre px-4 py-3 font-mono text-[0.78rem] leading-relaxed text-foreground">
          {sql}
        </pre>
      </div>
    </div>
  );
}

function RowContextMenu({
  x,
  y,
  target,
  deletedRows,
  selectedRows,
  editable,
  columnNames,
  cellValue,
  onDelete,
  onDiscardNew,
  onCopy,
  onQuickFilter,
  onFilterColumn,
}: {
  x: number;
  y: number;
  target: ContextTarget;
  deletedRows: Set<number>;
  selectedRows: Set<number>;
  editable: boolean;
  columnNames: string[];
  cellValue: (row: number, col: number) => string | null;
  onDelete: (row: number) => void;
  onDiscardNew: (tempId: string) => void;
  onCopy: (rows: number[], format: CopyFormat) => void;
  onQuickFilter: (column: string, op: FilterOp, value: string) => void;
  onFilterColumn: (column: string) => void;
  onClose: () => void;
}) {
  const style: React.CSSProperties = {
    position: "fixed",
    top: y,
    left: x,
    minWidth: 220,
  };

  const copyTargets: number[] =
    target.kind === "existing"
      ? selectedRows.has(target.row)
        ? Array.from(selectedRows)
        : [target.row]
      : [];
  const copyLabel = `Copy ${copyTargets.length > 1 ? `${copyTargets.length} rows` : "row"} as`;

  // セル右クリック時は value 基準で Quick filter を出す
  const cellCol = target.kind === "existing" && typeof target.col === "number" ? target.col : null;
  const cellColumn = cellCol !== null ? columnNames[cellCol] : null;
  const cellVal =
    target.kind === "existing" && cellCol !== null ? cellValue(target.row, cellCol) : null;

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={style}
      className="z-40 rounded-md border border-border bg-popover p-1 text-sm shadow-xl"
    >
      {target.kind === "header" && (
        <>
          <div className="px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Column · {columnNames[target.col] ?? ""}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const col = columnNames[target.col];
              if (col) onFilterColumn(col);
            }}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left hover:bg-sidebar-accent/40"
          >
            Filter with this column…
          </button>
        </>
      )}
      {target.kind === "existing" && cellColumn && (
        <>
          <div className="px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Quick filter · {cellColumn}
          </div>
          {cellVal === null ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => onQuickFilter(cellColumn, "is_null", "")}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left hover:bg-sidebar-accent/40"
              >
                IS NULL
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => onQuickFilter(cellColumn, "is_not_null", "")}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left hover:bg-sidebar-accent/40"
              >
                IS NOT NULL
              </button>
            </>
          ) : (
            <>
              <QuickFilterButton
                label={"= "}
                value={cellVal}
                onClick={() => onQuickFilter(cellColumn, "eq", cellVal)}
              />
              <QuickFilterButton
                label={"≠ "}
                value={cellVal}
                onClick={() => onQuickFilter(cellColumn, "ne", cellVal)}
              />
              <QuickFilterButton
                label="LIKE %…% "
                value={cellVal}
                onClick={() => onQuickFilter(cellColumn, "like", `%${cellVal}%`)}
              />
            </>
          )}
          <div className="my-1 h-px bg-border/50" />
        </>
      )}
      {target.kind === "existing" && (
        <>
          <div className="px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {copyLabel}
          </div>
          {(["tsv", "csv", "json", "sql"] as const).map((fmt) => (
            <button
              key={fmt}
              type="button"
              role="menuitem"
              onClick={() => onCopy(copyTargets, fmt)}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left hover:bg-sidebar-accent/40"
            >
              <span>{fmt === "sql" ? "SQL INSERT" : fmt.toUpperCase()}</span>
            </button>
          ))}
          {editable && <div className="my-1 h-px bg-border/50" />}
          {editable && (
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
          )}
        </>
      )}
      {target.kind === "new" && (
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

function QuickFilterButton({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  const preview = value.length > 24 ? `${value.slice(0, 24)}…` : value;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-1 rounded-sm px-3 py-1.5 text-left hover:bg-sidebar-accent/40"
    >
      <span className="font-mono text-muted-foreground">{label}</span>
      <span className="truncate">{preview}</span>
    </button>
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
    // biome-ignore lint/a11y/useSemanticElements: virtualised grid needs div-based rows
    <div
      role="row"
      tabIndex={-1}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/80%),0_0_0_1px_oklch(1_0_0/4%)_inset]">
        <header className="flex items-baseline justify-between border-b border-border bg-sidebar/30 px-5 py-3">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/80">
              {kind === "json" ? "JSON" : "Text"}
            </span>
            <h2 className="font-display text-[1.02rem] font-medium tracking-tight">
              {columnName}{" "}
              <span className="font-mono text-[0.72rem] font-normal text-chart-3">
                {column.data_type}
                {column.nullable ? "" : <span className="text-muted-foreground"> · NOT NULL</span>}
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

function ExportMenu({
  connectionId,
  database,
  table,
  sort,
  filters,
  filterMatch,
}: {
  connectionId: string;
  database: string;
  table: string;
  sort: SortKey[];
  filters: Filter[];
  filterMatch: FilterMatch;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function doExport(format: ExportFormat) {
    setOpen(false);
    setBusy(format);
    setToast(null);
    try {
      const ext = format === "sql" ? "sql" : format;
      const path = await save({
        defaultPath: `${table}.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return;
      const result = await exportTable({
        connectionId,
        database,
        table,
        sort: sort.length > 0 ? sort : null,
        filters: filters.length > 0 ? filters : null,
        filterMatch: filters.length > 0 ? filterMatch : null,
        format,
        path,
      });
      setToast(`Exported ${result.rows.toLocaleString()} rows → ${result.path}`);
      window.setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast(`Export failed: ${String(e)}`);
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
        title="Export rows"
      >
        {busy ? "Exporting…" : "Export"}
        <span aria-hidden className="text-[0.55rem] opacity-60">
          ▾
        </span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close export menu"
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
                onClick={() => doExport(fmt)}
                className="block w-full px-3 py-1.5 text-left text-[0.75rem] text-foreground hover:bg-sidebar-accent/60"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {toast && (
        <div className="pointer-events-none absolute right-0 top-full z-40 mt-1 max-w-[400px] rounded-md border border-accent/40 bg-card/95 px-3 py-1.5 text-[0.7rem] shadow-lg backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}
