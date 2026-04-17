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
      .catch(() => {});
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
    window.setTimeout(() => setToast(null), 2400);
  }

  function handleClosed(id: string) {
    setActiveIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  return (
    <main className="flex h-screen overflow-hidden">
      {/* Left pane — connection list */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <header className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sidebar-border text-lg text-sidebar-foreground transition-colors hover:border-accent hover:text-accent"
            aria-label="New connection"
          >
            +
          </button>
          <span className="text-sm font-semibold tracking-tight">Porpoise</span>
          <span className="w-8" />
        </header>
        <SavedConnections
          refreshKey={refreshKey}
          selectedId={selected?.id ?? null}
          activeIds={activeIds}
          onSelect={setSelected}
          onDeleted={handleDeleted}
          onOpened={handleOpened}
          onClosed={handleClosed}
        />
      </aside>

      {/* Right pane — connection detail / form */}
      <section className="flex flex-1 items-start justify-center overflow-y-auto px-10 py-10">
        <ConnectionForm initial={selected} onSaved={handleSaved} />
      </section>

      {toast && (
        <div className="pointer-events-none fixed bottom-8 left-1/2 -translate-x-1/2 rounded-md border border-accent/40 bg-card px-4 py-2 shadow-lg">
          <div className="flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_oklch(0.72_0.15_55/0.25)]"
            />
            <span className="text-foreground">{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
