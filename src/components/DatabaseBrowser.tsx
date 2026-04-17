import { useCallback, useEffect, useMemo, useState } from "react";
import { CsvImportModal } from "@/components/CsvImportModal";
import { TableDetail } from "@/components/TableDetail";
import { listDatabases, listTables, type SavedConnection, type TableInfo } from "@/lib/tauri";

const WIDTHS_KEY = "porpoise.browser-widths.v1";
const DBS_MIN = 120;
const DBS_MAX = 400;
const TABLES_MIN = 140;
const TABLES_MAX = 480;
const DBS_DEFAULT = 180;
const TABLES_DEFAULT = 200;

type PanelWidths = { dbs: number; tables: number };

function readWidths(): PanelWidths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (!raw) return { dbs: DBS_DEFAULT, tables: TABLES_DEFAULT };
    const parsed = JSON.parse(raw) as Partial<PanelWidths>;
    return {
      dbs: clamp(parsed.dbs ?? DBS_DEFAULT, DBS_MIN, DBS_MAX),
      tables: clamp(parsed.tables ?? TABLES_DEFAULT, TABLES_MIN, TABLES_MAX),
    };
  } catch {
    return { dbs: DBS_DEFAULT, tables: TABLES_DEFAULT };
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type Props = {
  connection: SavedConnection;
  /** ダブルクリックでテーブルを独立タブとして開くコールバック */
  onOpenTable: (connection: SavedConnection, database: string, table: string) => void;
  /** SQL クエリタブを新規で開く (現在選択中の DB をデフォルトに) */
  onNewQuery: (connection: SavedConnection, database: string | null) => void;
};

export function DatabaseBrowser({ connection, onOpenTable, onNewQuery }: Props) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"dbs" | "tables" | null>(null);
  const [dbsCollapsed, setDbsCollapsed] = useState(false);
  const [importTarget, setImportTarget] = useState<{ database: string; table: string } | null>(
    null,
  );
  const [reloadTick, setReloadTick] = useState(0);
  const [widths, setWidths] = useState<PanelWidths>(() => readWidths());

  // Persist widths (debounced), 500ms
  useEffect(() => {
    const h = window.setTimeout(() => {
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
      } catch {
        // noop
      }
    }, 500);
    return () => window.clearTimeout(h);
  }, [widths]);

  const startResize = useCallback(
    (e: React.PointerEvent, panel: "dbs" | "tables") => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = panel === "dbs" ? widths.dbs : widths.tables;
      const min = panel === "dbs" ? DBS_MIN : TABLES_MIN;
      const max = panel === "dbs" ? DBS_MAX : TABLES_MAX;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      function onMove(ev: PointerEvent) {
        const next = clamp(startWidth + (ev.clientX - startX), min, max);
        setWidths((prev) => (panel === "dbs" ? { ...prev, dbs: next } : { ...prev, tables: next }));
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [widths],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: connection.id is the trigger
  useEffect(() => {
    setDatabases([]);
    setSelectedDb(null);
    setTables([]);
    setSelectedTable(null);
    setError(null);
  }, [connection.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading("dbs");
    setError(null);
    listDatabases(connection.id)
      .then((list) => {
        if (cancelled) return;
        setDatabases(list);
        const initial =
          connection.database && list.includes(connection.database)
            ? connection.database
            : (list[0] ?? null);
        setSelectedDb(initial);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, connection.database]);

  useEffect(() => {
    if (!selectedDb) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoading("tables");
    setError(null);
    listTables(connection.id, selectedDb)
      .then((list) => {
        if (cancelled) return;
        setTables(list);
        setSelectedTable(list[0]?.name ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, selectedDb]);

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableFilter]);

  return (
    <div
      className="grid h-full w-full min-w-0 overflow-hidden"
      style={{
        gridTemplateColumns: dbsCollapsed
          ? `0px ${widths.tables}px minmax(0, 1fr)`
          : `${widths.dbs}px ${widths.tables}px minmax(0, 1fr)`,
      }}
    >
      {/* Databases */}
      <aside
        className={`relative flex min-h-0 flex-col border-r border-border bg-sidebar/20 ${
          dbsCollapsed ? "w-0 overflow-hidden border-r-0" : ""
        }`}
      >
        <header className="flex h-9 items-center justify-between px-3">
          <span className="tp-section-title">Databases</span>
          <div className="flex items-center gap-2">
            <span className="tp-num text-[0.65rem] text-muted-foreground/60">
              {databases.length}
            </span>
            <button
              type="button"
              onClick={() => setDbsCollapsed(true)}
              className="text-muted-foreground/60 transition-colors hover:text-foreground"
              aria-label="Collapse databases panel"
              title="Collapse"
            >
              <ChevronLeft />
            </button>
          </div>
        </header>
        <div className="tp-hair" />
        <ul className="flex-1 overflow-y-auto py-1">
          {loading === "dbs" && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</li>
          )}
          {databases.map((db) => (
            <li key={db}>
              <button
                type="button"
                onClick={() => setSelectedDb(db)}
                className={`relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.82rem] transition-colors ${
                  selectedDb === db
                    ? "bg-accent/12 text-accent shadow-[inset_2px_0_0_var(--accent)]"
                    : "text-foreground hover:bg-sidebar-accent/40"
                }`}
              >
                <DatabaseIcon />
                <span className="truncate">{db}</span>
              </button>
            </li>
          ))}
          {databases.length === 0 && loading !== "dbs" && (
            <li className="px-3 py-2 text-xs text-muted-foreground">No databases accessible.</li>
          )}
        </ul>
        {!dbsCollapsed && <ResizeHandle onPointerDown={(e) => startResize(e, "dbs")} />}
      </aside>

      {/* Tables */}
      <aside className="relative flex min-h-0 flex-col border-r border-border bg-sidebar/10">
        <header className="flex flex-col gap-2 px-3 pt-2 pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {dbsCollapsed && (
                <button
                  type="button"
                  onClick={() => setDbsCollapsed(false)}
                  className="text-muted-foreground/60 transition-colors hover:text-foreground"
                  aria-label="Expand databases panel"
                  title="Show databases"
                >
                  <ChevronRight />
                </button>
              )}
              <span className="tp-section-title">Tables</span>
              {dbsCollapsed && selectedDb && (
                <span
                  className="truncate font-mono text-[0.62rem] text-muted-foreground/60"
                  title={selectedDb}
                >
                  · {selectedDb}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onNewQuery(connection, selectedDb)}
                className="inline-flex items-center gap-1 rounded-sm border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-accent transition-colors hover:bg-accent hover:text-accent-foreground"
                title="Open new SQL editor"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                <span aria-hidden>+</span> SQL
              </button>
              <span className="tp-num text-[0.65rem] text-muted-foreground/60">
                {filteredTables.length}
              </span>
            </div>
          </div>
          <div className="group flex h-7 items-center gap-1.5 rounded-md border border-border bg-input/40 px-2 transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_2px_var(--accent-glow)]">
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 text-muted-foreground/60"
              role="img"
              aria-label="filter tables"
              fill="none"
            >
              <title>filter</title>
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              placeholder="Filter"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.currentTarget.value)}
              className="h-full flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            />
          </div>
        </header>
        <div className="tp-hair" />
        <ul className="flex-1 overflow-y-auto py-1">
          {loading === "tables" && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</li>
          )}
          {filteredTables.map((t) => (
            <li key={t.name}>
              <div
                className={`group relative flex w-full items-center gap-2 px-3 py-1.5 text-[0.82rem] transition-colors ${
                  selectedTable === t.name
                    ? "bg-accent/12 text-accent shadow-[inset_2px_0_0_var(--accent)]"
                    : "text-foreground hover:bg-sidebar-accent/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTable(t.name)}
                  onDoubleClick={() => {
                    if (selectedDb) onOpenTable(connection, selectedDb, t.name);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 pr-1 text-left"
                  title="click: preview · double-click: open in new tab"
                >
                  {t.kind === "view" ? <ViewIcon /> : <TableIcon />}
                  <span className="truncate">{t.name}</span>
                  {t.kind === "view" && <span className="tp-chip-ghost shrink-0">view</span>}
                </button>
                {/*
                  hover 時だけ右端に浮かせる。absolute なのでレイアウトを占有しない
                  → 行のハイライトが幅いっぱいに広がる。
                */}
                <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {t.kind !== "view" && (
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedDb) setImportTarget({ database: selectedDb, table: t.name });
                      }}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-sidebar/80 text-muted-foreground backdrop-blur-sm hover:text-chart-2"
                      aria-label="Import CSV"
                      title="Import CSV"
                    >
                      <ImportIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedDb) onOpenTable(connection, selectedDb, t.name);
                    }}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-sidebar/80 text-muted-foreground backdrop-blur-sm hover:text-accent"
                    aria-label="Open in new tab"
                    title="Open in new tab"
                  >
                    <OpenInNewIcon />
                  </button>
                </div>
              </div>
            </li>
          ))}
          {tables.length === 0 && loading !== "tables" && selectedDb && (
            <li className="px-3 py-2 text-xs text-muted-foreground">No tables in this database.</li>
          )}
        </ul>
        <ResizeHandle onPointerDown={(e) => startResize(e, "tables")} />
      </aside>

      {/* Main — inline table detail */}
      {error && (
        <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {!error && selectedDb && selectedTable ? (
        <TableDetail
          key={`${connection.id}:${selectedDb}:${selectedTable}:${reloadTick}`}
          connectionId={connection.id}
          database={selectedDb}
          table={selectedTable}
        />
      ) : (
        <div className="flex items-center justify-center p-10 text-xs text-muted-foreground">
          {error ? null : "Select a table. Double-click to open in a new tab."}
        </div>
      )}

      {importTarget && (
        <CsvImportModal
          connectionId={connection.id}
          database={importTarget.database}
          table={importTarget.table}
          onClose={() => setImportTarget(null)}
          onImported={() => {
            setReloadTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function ResizeHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <hr
      aria-orientation="vertical"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      className="absolute top-0 right-0 z-20 m-0 h-full w-1.5 translate-x-1/2 cursor-col-resize border-0 bg-transparent transition-colors hover:bg-accent/40 active:bg-accent/60"
      title="Drag to resize"
    />
  );
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="collapse" fill="none">
      <title>collapse</title>
      <path
        d="m10 4-4 4 4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="expand" fill="none">
      <title>expand</title>
      <path
        d="m6 4 4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function DatabaseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      role="img"
      aria-label="database"
      fill="none"
    >
      <title>database</title>
      <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function TableIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      role="img"
      aria-label="table"
      fill="none"
    >
      <title>table</title>
      <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 7h12M6 3v10" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function ViewIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0"
      role="img"
      aria-label="view"
      fill="none"
    >
      <title>view</title>
      <path
        d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function ImportIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0"
      role="img"
      aria-label="import"
      fill="none"
    >
      <title>import CSV</title>
      <path
        d="M8 2v8m0 0-3-3m3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 12v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function OpenInNewIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0"
      role="img"
      aria-label="open in new tab"
      fill="none"
    >
      <title>open in new tab</title>
      <path
        d="M10 2h4v4M14 2 7 9M12 9v4H3V4h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
