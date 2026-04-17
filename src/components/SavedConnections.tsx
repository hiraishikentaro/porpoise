import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

  async function handleDelete(id: string) {
    try {
      await deleteConnection(id);
      onDeleted(id);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleOpen(id: string) {
    setPending({ kind: "open", id });
    setError(null);
    try {
      const result = await openConnection(id);
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Saved connections</h2>
        <span className="text-muted-foreground text-xs">{items.length}</span>
      </div>
      {loading && <p className="text-muted-foreground text-xs">Loading…</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
      {!loading && items.length === 0 && (
        <p className="text-muted-foreground text-xs">No saved connections yet.</p>
      )}
      <ul className="flex flex-col gap-1">
        {items.map((conn) => {
          const selected = conn.id === selectedId;
          const open = activeIds.has(conn.id);
          const isOpening = pending?.kind === "open" && pending.id === conn.id;
          const isClosing = pending?.kind === "close" && pending.id === conn.id;
          return (
            <li key={conn.id}>
              <div
                className={`group flex flex-col gap-1 rounded-md border px-3 py-2 text-sm ${
                  selected ? "border-primary bg-accent" : "border-transparent hover:bg-accent"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(conn)}
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                  >
                    <span className="flex items-center gap-2 truncate font-medium">
                      <span
                        role="img"
                        aria-label={open ? "connected" : "disconnected"}
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          open ? "bg-emerald-500" : "bg-muted-foreground/40"
                        }`}
                      />
                      <span className="truncate">{conn.name}</span>
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {conn.user}@{conn.host}:{conn.port}
                      {conn.database ? `/${conn.database}` : ""}
                    </span>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(conn.id)}
                    className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                    aria-label={`Delete ${conn.name}`}
                  >
                    ×
                  </Button>
                </div>
                <div className="flex justify-end">
                  {open ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isClosing}
                      onClick={() => handleClose(conn.id)}
                    >
                      {isClosing ? "Closing…" : "Disconnect"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isOpening}
                      onClick={() => handleOpen(conn.id)}
                    >
                      {isOpening ? "Connecting…" : "Connect"}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
