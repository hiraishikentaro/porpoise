import { useEffect, useState } from "react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { SavedConnections } from "@/components/SavedConnections";
import { activeConnections, type SavedConnection } from "@/lib/tauri";

function App() {
  const [selected, setSelected] = useState<SavedConnection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    activeConnections()
      .then((ids) => setActiveIds(new Set(ids)))
      .catch(() => {
        // 起動直後の取得失敗は致命的ではない
      });
  }, []);

  function handleSaved(conn: SavedConnection) {
    setRefreshKey((v) => v + 1);
    setSelected(conn);
  }

  function handleDeleted(id: string) {
    setRefreshKey((v) => v + 1);
    setActiveIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (selected?.id === id) setSelected(null);
  }

  function handleOpened(id: string, version: string) {
    setActiveIds((prev) => new Set(prev).add(id));
    setToast(`Connected — MySQL ${version}`);
    window.setTimeout(() => setToast(null), 2500);
  }

  function handleClosed(id: string) {
    setActiveIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  return (
    <main className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col gap-4 border-r p-4">
        <div>
          <h1 className="text-lg font-semibold">Porpoise</h1>
          <p className="text-muted-foreground text-xs">MySQL GUI client</p>
        </div>
        <SavedConnections
          refreshKey={refreshKey}
          selectedId={selected?.id ?? null}
          activeIds={activeIds}
          onSelect={setSelected}
          onDeleted={handleDeleted}
          onOpened={handleOpened}
          onClosed={handleClosed}
        />
        <div className="mt-auto">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="text-muted-foreground hover:text-foreground text-xs underline"
          >
            + New connection
          </button>
        </div>
      </aside>
      <section className="flex flex-1 items-start justify-center p-6">
        <ConnectionForm initial={selected} onSaved={handleSaved} />
      </section>
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-emerald-600 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}

export default App;
