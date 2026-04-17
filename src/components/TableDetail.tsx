import { useEffect, useState } from "react";
import { TableView } from "@/components/TableView";
import { type ColumnInfo, describeTable } from "@/lib/tauri";

type RightTab = "data" | "structure";

type Props = {
  connectionId: string;
  database: string;
  table: string;
  /** 親側のタブヘッダを使う場合、内部の Data/Structure タブを省略できる */
  showTabs?: boolean;
};

export function TableDetail({ connectionId, database, table, showTabs = true }: Props) {
  const [tab, setTab] = useState<RightTab>("data");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    describeTable(connectionId, database, table)
      .then((cols) => {
        if (!cancelled) setColumns(cols);
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
  }, [connectionId, database, table]);

  return (
    <section className="flex min-h-0 w-full min-w-0 flex-col overflow-hidden">
      {showTabs && (
        <header className="flex items-center justify-between border-b border-border bg-sidebar/20 px-4 py-2.5">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-muted-foreground/70">
              {database}
            </span>
            <h2 className="font-display text-[0.98rem] font-medium tracking-tight">{table}</h2>
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-card/60 text-xs shadow-[inset_0_1px_0_oklch(1_0_0/4%)]">
            <TabButton active={tab === "data"} onClick={() => setTab("data")}>
              Data
            </TabButton>
            <TabButton active={tab === "structure"} onClick={() => setTab("structure")}>
              Structure
            </TabButton>
          </div>
        </header>
      )}

      {error && (
        <p className="m-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {tab === "data" ? (
          <TableView
            key={`${connectionId}:${database}:${table}`}
            connectionId={connectionId}
            database={database}
            table={table}
            columns={columns}
          />
        ) : (
          <StructureTable loading={loading} columns={columns} />
        )}
      </div>
    </section>
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
      className={`px-3 py-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.1em] transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-transparent text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
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
          <thead className="sticky top-0 bg-background/95 text-[0.66rem] uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">
            <tr className="border-b border-border">
              <th className="px-4 py-2.5 font-semibold">Column</th>
              <th className="px-3 py-2.5 font-semibold">Type</th>
              <th className="px-3 py-2.5 font-semibold">Null</th>
              <th className="px-3 py-2.5 font-semibold">Key</th>
              <th className="px-3 py-2.5 font-semibold">Default</th>
              <th className="px-3 py-2.5 font-semibold">Extra</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr
                key={c.name}
                className="border-b border-border/40 transition-colors hover:bg-sidebar-accent/30"
              >
                <td className="px-4 py-1.5 font-mono text-[0.82rem] font-medium">{c.name}</td>
                <td className="px-3 py-1.5 font-mono text-[0.72rem] text-chart-3">{c.data_type}</td>
                <td className="px-3 py-1.5 text-[0.7rem]">
                  {c.nullable ? (
                    <span className="font-mono text-muted-foreground/70">NULL</span>
                  ) : (
                    <span className="font-mono text-foreground/90">NOT NULL</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-xs">{c.key && <KeyBadge value={c.key} />}</td>
                <td className="px-3 py-1.5 font-mono text-[0.72rem] text-muted-foreground">
                  {c.default ?? <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="px-3 py-1.5 font-mono text-[0.72rem] text-muted-foreground">
                  {c.extra ?? <span className="text-muted-foreground/40">—</span>}
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
