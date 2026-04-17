import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { deleteConnection, listConnections, type SavedConnection } from "@/lib/tauri";

type Props = {
  refreshKey: number;
  selectedId: string | null;
  onSelect: (conn: SavedConnection) => void;
  onDeleted: (id: string) => void;
};

export function SavedConnections({ refreshKey, selectedId, onSelect, onDeleted }: Props) {
  const [items, setItems] = useState<SavedConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          return (
            <li key={conn.id}>
              <div
                className={`group flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
                  selected ? "border-primary bg-accent" : "border-transparent hover:bg-accent"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(conn)}
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                >
                  <span className="truncate font-medium">{conn.name}</span>
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
