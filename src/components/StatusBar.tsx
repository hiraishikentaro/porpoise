import type { Tab } from "@/components/TabBar";
import { colorForName, ringColorFor } from "@/lib/status-color";
import { useTabStatus } from "@/lib/tab-status";
import type { SavedConnection } from "@/lib/tauri";

type Props = {
  activeTab: Tab | null;
  connectionVersions: Map<string, string>;
  activeConnectionsCount: number;
  totalTabs: number;
};

const numFmt = new Intl.NumberFormat("en-US");

export function StatusBar({
  activeTab,
  connectionVersions,
  activeConnectionsCount,
  totalTabs,
}: Props) {
  const conn = activeTab?.connection ?? null;
  const version = conn ? connectionVersions.get(conn.id) : undefined;
  const database = databaseOf(activeTab);
  const tableInfo = tableInfoOf(activeTab);
  const tabStatus = useTabStatus(activeTab?.id ?? null);

  return (
    <footer
      role="status"
      aria-label="Status bar"
      className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-sidebar/60 px-3.5 font-mono text-[0.82rem] text-muted-foreground backdrop-blur-[1px]"
    >
      {conn ? (
        <ConnectionBadge connection={conn} />
      ) : (
        <span className="text-muted-foreground/60">no connection</span>
      )}
      <Dot />
      <span className="text-foreground/80">{conn ? conn.host : "—"}</span>
      <span className="text-muted-foreground/60">:{conn?.port ?? "—"}</span>
      {version && (
        <>
          <Dot />
          <span title="MySQL server version">MySQL {version}</span>
        </>
      )}
      {database && (
        <>
          <Dot />
          <span className="text-foreground/85">
            <span className="text-muted-foreground/60">db </span>
            {database}
          </span>
        </>
      )}
      {tableInfo && (
        <>
          <Dot />
          <span className="text-foreground/85">{tableInfo}</span>
        </>
      )}
      {tabStatus?.rows !== undefined && (
        <>
          <Dot />
          <span className="text-foreground/85" title="Rows displayed">
            {numFmt.format(tabStatus.rows)}
            {tabStatus.fetched !== undefined && tabStatus.fetched !== tabStatus.rows && (
              <span className="text-muted-foreground/60">
                {" "}
                / {numFmt.format(tabStatus.fetched)}
              </span>
            )}
            <span className="text-muted-foreground/60"> rows</span>
          </span>
        </>
      )}
      {tabStatus?.elapsedMs !== undefined && (
        <>
          <Dot />
          <span className="text-foreground/85" title="Last query elapsed">
            {numFmt.format(tabStatus.elapsedMs)}
            <span className="text-muted-foreground/60"> ms</span>
          </span>
        </>
      )}
      {tabStatus?.pending !== undefined && tabStatus.pending > 0 && (
        <>
          <Dot />
          <span
            className="rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-[1px] text-accent"
            title="Unsaved pending changes"
          >
            {tabStatus.pending} pending
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <span>
          {activeConnectionsCount} conn · {totalTabs} tab{totalTabs === 1 ? "" : "s"}
        </span>
      </span>
    </footer>
  );
}

function ConnectionBadge({ connection }: { connection: SavedConnection }) {
  const color = colorForName(connection.name, connection.color_label);
  const ring = ringColorFor(color);
  return (
    <span className="inline-flex items-center gap-1.5" title={`Connection color: ${color}`}>
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{
          backgroundColor: ring,
          boxShadow: `0 0 0 1.5px ${ring}33, 0 0 8px ${ring}80`,
        }}
      />
      <span className="font-semibold tracking-[0.02em] text-foreground">{connection.name}</span>
    </span>
  );
}

function Dot() {
  return <span className="text-muted-foreground/30">·</span>;
}

function databaseOf(tab: Tab | null): string | null {
  if (!tab) return null;
  if (tab.kind === "table") return tab.database;
  if (tab.kind === "editor") return tab.panes[0]?.database ?? null;
  return null;
}

function tableInfoOf(tab: Tab | null): string | null {
  if (!tab) return null;
  if (tab.kind === "table") return `${tab.table}`;
  if (tab.kind === "editor" && tab.panes.length > 1) {
    return `${tab.panes.length} panes`;
  }
  return null;
}
