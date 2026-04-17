import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTableRows, type TablePage } from "@/lib/tauri";

const PAGE_SIZE = 500;

type Props = {
  connectionId: string;
  database: string;
  table: string;
};

type State = {
  columns: string[];
  rows: (string | null)[][];
  offset: number;
  reachedEnd: boolean;
  loading: boolean;
  error: string | null;
};

const initialState: State = {
  columns: [],
  rows: [],
  offset: 0,
  reachedEnd: false,
  loading: false,
  error: null,
};

export function TableView({ connectionId, database, table }: Props) {
  const [state, setState] = useState<State>(initialState);
  const parentRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadPage = useCallback(
    async (reset: boolean): Promise<void> => {
      if (reset) {
        setState({ ...initialState, loading: true });
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
            columns: page.columns.length ? page.columns : s.columns,
            rows,
            offset: offset + page.returned,
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

  // Reset + load first page when table changes
  useEffect(() => {
    loadPage(true);
  }, [loadPage]);

  const rowVirtualizer = useVirtualizer({
    count: state.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  // Trigger load-more when near bottom
  const virtualItems = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (state.reachedEnd || state.loading) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= state.rows.length - 50) {
      loadPage(false);
    }
  }, [virtualItems, state.reachedEnd, state.loading, state.rows.length, loadPage]);

  // 列幅: 固定 180px。親より広ければ横スクロールで全列表示
  const COL_WIDTH = 180;
  const colWidths = useMemo(() => state.columns.map(() => COL_WIDTH), [state.columns]);
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-4 py-1.5 text-xs">
        <span className="text-muted-foreground">
          {state.rows.length} row{state.rows.length === 1 ? "" : "s"}
          {state.reachedEnd ? "" : "+"}
        </span>
        {state.loading && <span className="text-muted-foreground">Loading…</span>}
      </header>

      {state.error && (
        <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {state.error}
        </p>
      )}

      <div
        ref={parentRef}
        className="flex-1 overflow-auto"
        // tabular-nums for aligned digit widths
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <div style={{ width: totalWidth, position: "relative" }}>
          {/* Sticky header */}
          <div
            className="sticky top-0 z-10 flex border-b border-border bg-background/95 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur"
            style={{ width: totalWidth }}
          >
            {state.columns.map((col, i) => (
              <div
                key={col}
                style={{ width: colWidths[i] }}
                className="shrink-0 border-r border-border/60 px-3 py-2"
              >
                {col}
              </div>
            ))}
          </div>

          {/* Virtual rows */}
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
                  {row.map((cell, ci) => (
                    <div
                      // index-based keys are fine here: rows are append-only,
                      // column positions are stable within one result set
                      key={`${virtualRow.key}:${state.columns[ci] ?? ci}`}
                      style={{ width: colWidths[ci] }}
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

        {!state.loading && state.rows.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No rows.</p>
        )}
      </div>
    </div>
  );
}
