import { useEffect, useMemo, useState } from "react";
import { TableDetail } from "@/components/TableDetail";
import { listDatabases, listTables, type SavedConnection, type TableInfo } from "@/lib/tauri";

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
          ? "0px 200px minmax(0, 1fr)"
          : "180px 200px minmax(0, 1fr)",
      }}
    >
      {/* Databases */}
      <aside
        className={`flex min-h-0 flex-col border-r border-border transition-[width] ${
          dbsCollapsed ? "w-0 overflow-hidden border-r-0" : ""
        }`}
      >
        <header className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Databases</span>
          <div className="flex items-center gap-2">
            <span className="font-normal text-muted-foreground/60">{databases.length}</span>
            <button
              type="button"
              onClick={() => setDbsCollapsed(true)}
              className="text-muted-foreground/70 hover:text-foreground"
              aria-label="Collapse databases panel"
              title="Collapse"
            >
              <ChevronLeft />
            </button>
          </div>
        </header>
        <ul className="flex-1 overflow-y-auto">
          {loading === "dbs" && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</li>
          )}
          {databases.map((db) => (
            <li key={db}>
              <button
                type="button"
                onClick={() => setSelectedDb(db)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  selectedDb === db
                    ? "bg-accent/15 text-accent"
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
      </aside>

      {/* Tables */}
      <aside className="flex min-h-0 flex-col border-r border-border">
        <header className="flex flex-col gap-2 px-3 py-2">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <div className="flex items-center gap-1.5">
              {dbsCollapsed && (
                <button
                  type="button"
                  onClick={() => setDbsCollapsed(false)}
                  className="text-muted-foreground/70 hover:text-foreground"
                  aria-label="Expand databases panel"
                  title="Show databases"
                >
                  <ChevronRight />
                </button>
              )}
              <span>Tables</span>
              {dbsCollapsed && selectedDb && (
                <span
                  className="truncate text-[0.65rem] font-normal normal-case text-muted-foreground/60"
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
                className="rounded-sm border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-[0.6rem] font-semibold tracking-wide uppercase text-accent hover:bg-accent hover:text-accent-foreground"
                title="Open new SQL editor"
              >
                + SQL
              </button>
              <span className="font-normal text-muted-foreground/60">{filteredTables.length}</span>
            </div>
          </div>
          <input
            placeholder="Filter…"
            value={tableFilter}
            onChange={(e) => setTableFilter(e.currentTarget.value)}
            className="h-7 w-full rounded-md border border-border bg-input/50 px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-accent"
          />
        </header>
        <ul className="flex-1 overflow-y-auto">
          {loading === "tables" && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</li>
          )}
          {filteredTables.map((t) => (
            <li key={t.name}>
              <div
                className={`group flex w-full items-center gap-2 px-3 py-1.5 text-sm ${
                  selectedTable === t.name
                    ? "bg-accent/15 text-accent"
                    : "text-foreground hover:bg-sidebar-accent/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTable(t.name)}
                  onDoubleClick={() => {
                    if (selectedDb) onOpenTable(connection, selectedDb, t.name);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="click: preview · double-click: open in new tab"
                >
                  {t.kind === "view" ? <ViewIcon /> : <TableIcon />}
                  <span className="truncate">{t.name}</span>
                  {t.kind === "view" && (
                    <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                      view
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedDb) onOpenTable(connection, selectedDb, t.name);
                  }}
                  className="text-muted-foreground/50 opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                  aria-label="Open in new tab"
                  title="Open in new tab"
                >
                  <OpenInNewIcon />
                </button>
              </div>
            </li>
          ))}
          {tables.length === 0 && loading !== "tables" && selectedDb && (
            <li className="px-3 py-2 text-xs text-muted-foreground">No tables in this database.</li>
          )}
        </ul>
      </aside>

      {/* Main — inline table detail */}
      {error && (
        <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {!error && selectedDb && selectedTable ? (
        <TableDetail
          key={`${connection.id}:${selectedDb}:${selectedTable}`}
          connectionId={connection.id}
          database={selectedDb}
          table={selectedTable}
        />
      ) : (
        <div className="flex items-center justify-center p-10 text-xs text-muted-foreground">
          {error ? null : "Select a table. Double-click to open in a new tab."}
        </div>
      )}
    </div>
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
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="database" fill="none">
      <title>database</title>
      <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function TableIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="table" fill="none">
      <title>table</title>
      <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 7h12M6 3v10" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function ViewIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="view" fill="none">
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
function OpenInNewIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
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
