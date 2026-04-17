import { colorForName, initialsOf, ringColorFor, statusColorVars } from "@/lib/status-color";
import type { SavedConnection } from "@/lib/tauri";

export type ConnectionTab = {
  id: string;
  kind: "connection";
  connection: SavedConnection;
};

export type TableTab = {
  id: string;
  kind: "table";
  connection: SavedConnection;
  database: string;
  table: string;
};

export type EditorTab = {
  id: string;
  kind: "editor";
  connection: SavedConnection;
  title: string;
  sql: string;
  database: string | null;
};

export type Tab = ConnectionTab | TableTab | EditorTab;

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
};

export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew }: Props) {
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border bg-sidebar/30 backdrop-blur-[1px]">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const color = colorForName(tab.connection.name);
          const ring = ringColorFor(color);
          return (
            <div
              key={tab.id}
              className={`group relative flex h-full max-w-[320px] shrink-0 items-stretch overflow-hidden border-r border-border/70 transition-colors ${
                active
                  ? "bg-background text-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-sidebar-accent/30 hover:text-foreground"
              }`}
            >
              {/* Active indicator — a 2px bar colored after the connection */}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-[2px]"
                  style={{
                    backgroundImage: `linear-gradient(90deg, transparent, ${ring} 15%, ${ring} 85%, transparent)`,
                  }}
                />
              )}

              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-1 pl-3 text-sm"
              >
                <ConnectionBadge connection={tab.connection} />
                {tab.kind === "table" && <TableBadge />}
                {tab.kind === "editor" && <QueryBadge />}
                <span className="flex min-w-0 flex-1 flex-col items-start overflow-hidden leading-tight">
                  <span className="w-full truncate text-[0.82rem] tracking-tight">
                    {tab.kind === "connection"
                      ? tab.connection.name
                      : tab.kind === "table"
                        ? tab.table
                        : tab.title}
                  </span>
                  {tab.kind === "table" && (
                    <span className="w-full truncate font-mono text-[0.6rem] text-muted-foreground/60">
                      {tab.connection.name} · {tab.database}
                    </span>
                  )}
                  {tab.kind === "editor" && (
                    <span className="w-full truncate font-mono text-[0.6rem] text-muted-foreground/60">
                      {tab.connection.name}
                      {tab.database && ` · ${tab.database}`}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={`mr-1 inline-flex h-full w-6 shrink-0 items-center justify-center rounded-sm text-xs transition-opacity hover:bg-muted hover:text-destructive ${
                  active
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60 opacity-0 group-hover:opacity-100"
                }`}
                aria-label="Close tab"
                title="Close"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNew}
        className="flex h-full w-10 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-accent"
        aria-label="New tab"
        title="New connection"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: SavedConnection }) {
  const color = colorForName(connection.name);
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.58rem] font-semibold shadow-[0_1px_0_oklch(0_0_0/30%),inset_0_1px_0_oklch(1_0_0/15%)]"
      style={statusColorVars(color)}
    >
      {initialsOf(connection.name)}
    </span>
  );
}

function TableBadge() {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border border-border/70 bg-card text-muted-foreground">
      <svg viewBox="0 0 16 16" className="h-3 w-3" role="img" aria-label="table" fill="none">
        <title>table</title>
        <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 7h12M6 3v10" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </span>
  );
}

function QueryBadge() {
  return (
    <span
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[4px] border border-accent/50 bg-accent/10 px-1 text-[0.55rem] font-bold tracking-wider text-accent"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      SQL
    </span>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="new tab" fill="none">
      <title>new tab</title>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
