import { useState } from "react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { SavedConnections } from "@/components/SavedConnections";
import type { SavedConnection } from "@/lib/tauri";

function App() {
  const [selected, setSelected] = useState<SavedConnection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function handleSaved(conn: SavedConnection) {
    setRefreshKey((v) => v + 1);
    setSelected(conn);
  }

  function handleDeleted(id: string) {
    setRefreshKey((v) => v + 1);
    if (selected?.id === id) setSelected(null);
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
          onSelect={setSelected}
          onDeleted={handleDeleted}
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
    </main>
  );
}

export default App;
