import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
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
  onOpened: (conn: SavedConnection, version: string) => void;
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

  const liveCount = useMemo(
    () => items.filter((c) => activeIds.has(c.id)).length,
    [items, activeIds],
  );

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
      onOpened(conn, result.version);
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
      <div className="px-3 pt-3 pb-2">
        <div className="group flex h-9 items-center gap-2 rounded-md border border-sidebar-border bg-input/40 px-3 transition-colors focus-within:border-accent/70 focus-within:shadow-[0_0_0_3px_var(--accent-glow)]">
          <SearchIcon />
          <input
            placeholder="Search connections"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-muted-foreground/50 hover:text-foreground"
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : (
            <span className="tp-kbd">⌘F</span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pt-1 pb-2">
        <span className="tp-section-title">Connections</span>
        <span className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground/70">
          {liveCount > 0 && (
            <>
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_1px_var(--accent-glow)]"
              />
              <span className="tp-num">{liveCount}</span>
              <span className="text-muted-foreground/50">live ·</span>
            </>
          )}
          <span className="tp-num">{items.length}</span>
        </span>
      </div>

      {error && (
        <p className="mx-3 mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {loading && (
          <ul className="flex flex-col gap-0.5 px-1 pt-1">
            {Array.from({ length: 4 }, (_, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
                key={`conn-skel-${i}`}
                className="flex items-center gap-2 rounded-md px-2 py-1.5"
              >
                <Skeleton className="h-5 w-5 rounded-full" />
                <div className="flex flex-1 flex-col gap-1">
                  <Skeleton className="h-3" style={{ width: `${55 + i * 8}%` }} />
                  <Skeleton className="h-2" style={{ width: `${30 + i * 4}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {!loading && filtered.length === 0 && items.length === 0 && (
          <EmptyState
            variant="compact"
            icon={
              <svg
                viewBox="0 0 16 16"
                className="h-5 w-5"
                fill="none"
                role="img"
                aria-label="no connections"
              >
                <title>no connections</title>
                <rect
                  x="2.5"
                  y="3"
                  width="11"
                  height="10"
                  rx="1.4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M5 7h6M5 10h3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            }
            title="No connections yet"
            description="Save your first MySQL connection to get started. Tap the + button above."
          />
        )}
        {!loading && filtered.length === 0 && items.length > 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">No match.</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {filtered.map((conn) => {
            const selected = conn.id === selectedId;
            const open = activeIds.has(conn.id);
            const isOpening = pending?.kind === "open" && pending.id === conn.id;
            const isClosing = pending?.kind === "close" && pending.id === conn.id;
            const color = colorForName(conn.name, conn.color_label);
            const local = isLocalHost(conn.host);

            return (
              <li key={conn.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conn)}
                  className={`group relative flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                    selected
                      ? "bg-sidebar-accent/90 shadow-[inset_1px_0_0_var(--accent)]"
                      : "hover:bg-sidebar-accent/50"
                  }`}
                >
                  <Avatar label={initialsOf(conn.name)} color={color} active={open} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium tracking-tight">
                        {conn.name}
                      </span>
                      {local && (
                        <span
                          className="text-[0.64rem] font-normal tracking-wide"
                          style={{ color: "oklch(0.78 0.14 148)" }}
                        >
                          local
                        </span>
                      )}
                      {conn.ssh && (
                        <span className="tp-chip-accent" title="via SSH tunnel">
                          ssh
                        </span>
                      )}
                    </div>
                    <span className="truncate font-mono text-[0.68rem] text-muted-foreground/80">
                      {conn.host}
                      {conn.port !== 3306 && `:${conn.port}`}
                      {conn.database && (
                        <span className="text-muted-foreground/50"> / {conn.database}</span>
                      )}
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
                        className="rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-accent transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
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
                        className="rounded-md border border-border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
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
                      className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-destructive"
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
    <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center">
      <span
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full text-[0.68rem] font-semibold tracking-wide transition-shadow ${
          active ? "tp-live" : "shadow-[0_1px_0_oklch(0_0_0/30%),inset_0_1px_0_oklch(1_0_0/15%)]"
        }`}
        style={statusColorVars(color)}
      >
        {label}
      </span>
      {active && (
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar"
          style={{ backgroundColor: "oklch(0.74 0.18 148)" }}
        />
      )}
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 text-muted-foreground/70"
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
