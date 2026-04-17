import { useEffect, useMemo, useState } from "react";
import { colorForName, initialsOf, isLocalHost, statusColorVars } from "@/lib/status-color";
import {
  closeConnection,
  deleteConnection,
  listConnections,
  openConnection,
  type SavedConnection,
} from "@/lib/tauri";

type Props = {
  refreshKey: number;
  selectedId: string | null;
  activeIds: Set<string>;
  onSelect: (conn: SavedConnection) => void;
  onDeleted: (id: string) => void;
  onOpened: (id: string, version: string) => void;
  onClosed: (id: string) => void;
};

type PendingAction = { kind: "open" | "close"; id: string };

export function SavedConnections({
  refreshKey,
  selectedId,
  activeIds,
  onSelect,
  onDeleted,
  onOpened,
  onClosed,
}: Props) {
  const [items, setItems] = useState<SavedConnection[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a trigger-only dep
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listConnections()
      .then((list) => {
        if (!cancelled) {
          setItems(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => {
      const hay = `${c.name} ${c.host} ${c.user} ${c.database ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  async function handleDelete(id: string) {
    try {
      await deleteConnection(id);
      onDeleted(id);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleOpen(conn: SavedConnection) {
    setPending({ kind: "open", id: conn.id });
    setError(null);
    try {
      const result = await openConnection(conn.id);
      onSelect(conn);
      onOpened(result.id, result.version);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(null);
    }
  }

  async function handleClose(id: string) {
    setPending({ kind: "close", id });
    setError(null);
    try {
      await closeConnection(id);
      onClosed(id);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="flex h-9 flex-1 items-center gap-2 rounded-md border border-border bg-input/50 px-3">
          <SearchIcon />
          <input
            placeholder="Search connections…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          />
          <span className="hidden text-[0.7rem] text-muted-foreground/50 sm:inline">⌘F</span>
        </div>
      </div>

      {error && (
        <p className="mx-3 mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {loading && <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {items.length === 0 ? "No saved connections yet." : "No match."}
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {filtered.map((conn) => {
            const selected = conn.id === selectedId;
            const open = activeIds.has(conn.id);
            const isOpening = pending?.kind === "open" && pending.id === conn.id;
            const isClosing = pending?.kind === "close" && pending.id === conn.id;
            const color = colorForName(conn.name);
            const local = isLocalHost(conn.host);

            return (
              <li key={conn.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conn)}
                  className={`group relative flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                    selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                  }`}
                >
                  <Avatar label={initialsOf(conn.name)} color={color} active={open} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{conn.name}</span>
                      {local && (
                        <span
                          className="text-xs font-normal"
                          style={{ color: "oklch(0.72 0.15 145)" }}
                        >
                          (local)
                        </span>
                      )}
                      {conn.ssh && (
                        <span
                          className="rounded-sm bg-accent/15 px-1 text-[0.65rem] font-semibold tracking-wide uppercase text-accent"
                          title="via SSH tunnel"
                        >
                          ssh
                        </span>
                      )}
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {conn.host}
                      {conn.port !== 3306 && `:${conn.port}`}
                      {conn.database && ` / ${conn.database}`}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {open ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleClose(conn.id);
                        }}
                        disabled={isClosing}
                        className="rounded-md border border-accent/60 px-2 py-0.5 text-xs text-accent hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                      >
                        {isClosing ? "…" : "Close"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpen(conn);
                        }}
                        disabled={isOpening}
                        className="rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:border-accent hover:text-accent disabled:opacity-50"
                      >
                        {isOpening ? "…" : "Open"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(conn.id);
                      }}
                      className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${conn.name}`}
                    >
                      ✕
                    </button>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Avatar({
  label,
  color,
  active,
}: {
  label: string;
  color: ReturnType<typeof colorForName>;
  active: boolean;
}) {
  return (
    <span
      className={`relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold tracking-wide transition-shadow ${
        active ? "ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : ""
      }`}
      style={statusColorVars(color)}
    >
      {label}
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 text-muted-foreground"
      role="img"
      aria-label="search"
      fill="none"
    >
      <title>search</title>
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
