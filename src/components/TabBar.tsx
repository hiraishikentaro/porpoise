import { colorForName, initialsOf, statusColorVars } from "@/lib/status-color";
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

export type Tab = ConnectionTab | TableTab;

type Props = {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
};

export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew }: Props) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-sidebar/40">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`group flex h-full max-w-[320px] shrink-0 items-stretch overflow-hidden border-r border-border ${
                active
                  ? "bg-background text-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pl-3 pr-1 text-sm"
              >
                <ConnectionBadge connection={tab.connection} />
                {tab.kind === "table" && <TableBadge />}
                <span className="flex min-w-0 flex-1 flex-col items-start overflow-hidden leading-tight">
                  <span className="w-full truncate text-sm">
                    {tab.kind === "connection" ? tab.connection.name : tab.table}
                  </span>
                  {tab.kind === "table" && (
                    <span className="w-full truncate text-[0.65rem] text-muted-foreground/60">
                      {tab.connection.name} · {tab.database}
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
        className="flex h-full w-9 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground"
        aria-label="New tab"
        title="New connection"
      >
        +
      </button>
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: SavedConnection }) {
  const color = colorForName(connection.name);
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold"
      style={statusColorVars(color)}
    >
      {initialsOf(connection.name)}
    </span>
  );
}

function TableBadge() {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border text-muted-foreground">
      <svg viewBox="0 0 16 16" className="h-3 w-3" role="img" aria-label="table" fill="none">
        <title>table</title>
        <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 7h12M6 3v10" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </span>
  );
}
