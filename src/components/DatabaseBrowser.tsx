import { useEffect, useMemo, useState } from "react";
import { TableView } from "@/components/TableView";
import {
  type ColumnInfo,
  describeTable,
  listDatabases,
  listTables,
  type SavedConnection,
  type TableInfo,
} from "@/lib/tauri";

type RightTab = "data" | "structure";

type Props = {
  connection: SavedConnection;
};

export function DatabaseBrowser({ connection }: Props) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [tableFilter, setTableFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"dbs" | "tables" | "columns" | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("data");

  // biome-ignore lint/correctness/useExhaustiveDependencies: connection.id is the trigger
  useEffect(() => {
    setDatabases([]);
    setSelectedDb(null);
    setTables([]);
    setSelectedTable(null);
    setColumns([]);
    setError(null);
  }, [connection.id]);

  // Load databases for the selected connection
  useEffect(() => {
    let cancelled = false;
    setLoading("dbs");
    setError(null);
    listDatabases(connection.id)
      .then((list) => {
        if (cancelled) return;
        setDatabases(list);
        // auto-select connection.database if present
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

  // Load tables when db changes
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

  // Load columns when table changes
  useEffect(() => {
    if (!selectedDb || !selectedTable) {
      setColumns([]);
      return;
    }
    let cancelled = false;
    setLoading("columns");
    setError(null);
    describeTable(connection.id, selectedDb, selectedTable)
      .then((cols) => {
        if (!cancelled) setColumns(cols);
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
  }, [connection.id, selectedDb, selectedTable]);

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableFilter]);

  return (
    <div
      className="grid h-full w-full min-w-0 overflow-hidden"
      style={{ gridTemplateColumns: "180px 200px minmax(0, 1fr)" }}
    >
      {/* Databases */}
      <aside className="flex min-h-0 flex-col border-r border-border">
        <header className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Databases</span>
          <span className="font-normal text-muted-foreground/60">{databases.length}</span>
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
            <span>Tables</span>
            <span className="font-normal text-muted-foreground/60">{filteredTables.length}</span>
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
              <button
                type="button"
                onClick={() => setSelectedTable(t.name)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  selectedTable === t.name
                    ? "bg-accent/15 text-accent"
                    : "text-foreground hover:bg-sidebar-accent/40"
                }`}
              >
                {t.kind === "view" ? <ViewIcon /> : <TableIcon />}
                <span className="truncate">{t.name}</span>
                {t.kind === "view" && (
                  <span className="ml-auto text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                    view
                  </span>
                )}
              </button>
            </li>
          ))}
          {tables.length === 0 && loading !== "tables" && selectedDb && (
            <li className="px-3 py-2 text-xs text-muted-foreground">No tables in this database.</li>
          )}
        </ul>
      </aside>

      {/* Main — Data / Structure tabs */}
      <section className="flex min-h-0 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex flex-col">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {selectedDb ?? "—"}
            </span>
            <h2 className="text-sm font-semibold">{selectedTable ?? "Select a table"}</h2>
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
            <TabButton active={rightTab === "data"} onClick={() => setRightTab("data")}>
              Data
            </TabButton>
            <TabButton active={rightTab === "structure"} onClick={() => setRightTab("structure")}>
              Structure
            </TabButton>
          </div>
        </header>

        {error && (
          <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {!selectedDb || !selectedTable ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">Select a table.</p>
          ) : rightTab === "data" ? (
            <TableView
              key={`${connection.id}:${selectedDb}:${selectedTable}`}
              connectionId={connection.id}
              database={selectedDb}
              table={selectedTable}
            />
          ) : (
            <StructureTable loading={loading === "columns"} columns={columns} />
          )}
        </div>
      </section>
    </div>
  );
}

function TabButton({
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
      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function StructureTable({ loading, columns }: { loading: boolean; columns: ColumnInfo[] }) {
  return (
    <div className="flex-1 overflow-auto">
      {loading && <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>}
      {columns.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-background/95 text-[0.7rem] uppercase tracking-wide text-muted-foreground backdrop-blur">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-semibold">Column</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-3 py-2 font-semibold">Null</th>
              <th className="px-3 py-2 font-semibold">Key</th>
              <th className="px-3 py-2 font-semibold">Default</th>
              <th className="px-3 py-2 font-semibold">Extra</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.name} className="border-b border-border/60 hover:bg-sidebar-accent/30">
                <td className="px-4 py-1.5 font-medium">{c.name}</td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{c.data_type}</td>
                <td className="px-3 py-1.5 text-xs">
                  {c.nullable ? (
                    <span className="text-muted-foreground">YES</span>
                  ) : (
                    <span className="text-foreground">NO</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-xs">{c.key && <KeyBadge value={c.key} />}</td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">
                  {c.default ?? <span className="text-muted-foreground/50">—</span>}
                </td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">
                  {c.extra ?? <span className="text-muted-foreground/50">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function KeyBadge({ value }: { value: string }) {
  const style = (() => {
    switch (value) {
      case "PRI":
        return { label: "PK", bg: "bg-accent/15", text: "text-accent" };
      case "UNI":
        return { label: "UQ", bg: "bg-chart-3/15", text: "text-chart-3" };
      case "MUL":
        return { label: "IDX", bg: "bg-chart-2/15", text: "text-chart-2" };
      default:
        return { label: value, bg: "bg-muted", text: "text-muted-foreground" };
    }
  })();
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide ${style.bg} ${style.text}`}
      style={style.label === "UQ" ? { color: "oklch(0.7 0.16 145)" } : undefined}
    >
      {style.label}
    </span>
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
