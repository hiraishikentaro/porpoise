import { useCallback, useEffect, useState } from "react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { DatabaseBrowser } from "@/components/DatabaseBrowser";
import { SavedConnections } from "@/components/SavedConnections";
import { SqlEditor } from "@/components/SqlEditor";
import { type Tab, TabBar } from "@/components/TabBar";
import { TableDetail } from "@/components/TableDetail";
import {
  activeConnections,
  closeConnection,
  listConnections,
  type SavedConnection,
} from "@/lib/tauri";

const connectionTabId = (connId: string) => `conn:${connId}`;
const tableTabId = (connId: string, database: string, table: string) =>
  `table:${connId}:${database}:${table}`;
const newEditorTabId = () =>
  `editor:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function App() {
  const [selected, setSelected] = useState<SavedConnection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editorSeq, setEditorSeq] = useState(1);

  useEffect(() => {
    (async () => {
      try {
        const [ids, list] = await Promise.all([activeConnections(), listConnections()]);
        const idSet = new Set(ids);
        setActiveIds(idSet);
        const restored: Tab[] = list
          .filter((c) => idSet.has(c.id))
          .map((c) => ({ id: connectionTabId(c.id), kind: "connection", connection: c }));
        if (restored.length > 0) {
          setTabs(restored);
          setActiveTabId(restored[0].id);
        }
      } catch {
        // noop
      }
    })();
  }, []);

  const upsertConnectionTab = useCallback((conn: SavedConnection) => {
    setTabs((prev) => {
      const id = connectionTabId(conn.id);
      const existing = prev.findIndex((t) => t.id === id);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = { id, kind: "connection", connection: conn };
        return next;
      }
      return [...prev, { id, kind: "connection", connection: conn }];
    });
    setActiveTabId(connectionTabId(conn.id));
  }, []);

  const upsertTableTab = useCallback((conn: SavedConnection, database: string, table: string) => {
    const id = tableTabId(conn.id, database, table);
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      return [...prev, { id, kind: "table", connection: conn, database, table }];
    });
    setActiveTabId(id);
  }, []);

  const openEditorTab = useCallback(
    (conn: SavedConnection, database: string | null) => {
      const id = newEditorTabId();
      const title = `Query ${editorSeq}`;
      setEditorSeq((v) => v + 1);
      setTabs((prev) => [
        ...prev,
        { id, kind: "editor", connection: conn, title, sql: "", database },
      ]);
      setActiveTabId(id);
    },
    [editorSeq],
  );

  const updateEditorSql = useCallback((id: string, sql: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, sql } : t)));
  }, []);

  const updateEditorDatabase = useCallback((id: string, database: string | null) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, database } : t)),
    );
  }, []);

  const removeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (activeTabId === id) {
          setActiveTabId(next[next.length - 1]?.id ?? null);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const removeConnectionTabs = useCallback(
    (connId: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.connection.id !== connId);
        if (activeTabId && !next.some((t) => t.id === activeTabId)) {
          setActiveTabId(next[next.length - 1]?.id ?? null);
        }
        return next;
      });
    },
    [activeTabId],
  );

  function handleSaved(conn: SavedConnection) {
    setRefreshKey((v) => v + 1);
    setSelected(conn);
    setTabs((prev) =>
      prev.map((t) => (t.connection.id === conn.id ? { ...t, connection: conn } : t)),
    );
  }

  function handleDeleted(id: string) {
    setRefreshKey((v) => v + 1);
    setActiveIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    removeConnectionTabs(id);
    if (selected?.id === id) setSelected(null);
  }

  function handleOpened(conn: SavedConnection, version: string) {
    setActiveIds((prev) => new Set(prev).add(conn.id));
    upsertConnectionTab(conn);
    setToast(`Connected — MySQL ${version}`);
    window.setTimeout(() => setToast(null), 2400);
  }

  function handleClosed(id: string) {
    setActiveIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    removeConnectionTabs(id);
  }

  async function handleCloseTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;

    if (tab.kind === "connection") {
      try {
        await closeConnection(tab.connection.id);
      } catch {
        // noop
      }
      handleClosed(tab.connection.id);
    } else {
      removeTab(id);
    }
  }

  function handleSelectTab(id: string) {
    setActiveTabId(id);
    const tab = tabs.find((t) => t.id === id);
    if (tab) setSelected(tab.connection);
  }

  function handleNewTab() {
    setActiveTabId(null);
    setSelected(null);
  }

  function handleSelectConnection(conn: SavedConnection) {
    setSelected(conn);
    const id = connectionTabId(conn.id);
    if (tabs.some((t) => t.id === id)) {
      setActiveTabId(id);
    } else {
      setActiveTabId(null);
    }
  }

  function handleOpenTableInTab(conn: SavedConnection, database: string, table: string) {
    upsertTableTab(conn, database, table);
  }

  const activeTab = activeTabId ? (tabs.find((t) => t.id === activeTabId) ?? null) : null;
  const browserConnectionActive =
    activeTab?.kind === "connection" && activeIds.has(activeTab.connection.id);
  const tableTabActive = activeTab?.kind === "table" && activeIds.has(activeTab.connection.id);
  const editorTabActive = activeTab?.kind === "editor" && activeIds.has(activeTab.connection.id);

  return (
    <main className="flex h-screen overflow-hidden">
      {!sidebarCollapsed && (
        <aside className="flex w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <header className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
            <button
              type="button"
              onClick={handleNewTab}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sidebar-border text-lg text-sidebar-foreground transition-colors hover:border-accent hover:text-accent"
              aria-label="New connection"
            >
              +
            </button>
            <span className="text-sm font-semibold tracking-tight">Porpoise</span>
            <button
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label="Collapse sidebar"
              title="Hide connections"
            >
              <SidebarCollapseIcon />
            </button>
          </header>
          <SavedConnections
            refreshKey={refreshKey}
            selectedId={activeTab?.connection.id ?? selected?.id ?? null}
            activeIds={activeIds}
            onSelect={handleSelectConnection}
            onDeleted={handleDeleted}
            onOpened={handleOpened}
            onClosed={handleClosed}
          />
        </aside>
      )}

      <section className="relative flex flex-1 flex-col overflow-hidden">
        {sidebarCollapsed && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed(false)}
            className="absolute top-1 left-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-accent hover:text-accent"
            aria-label="Show connections"
            title="Show connections"
          >
            <SidebarExpandIcon />
          </button>
        )}

        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {browserConnectionActive && activeTab?.kind === "connection" ? (
            <DatabaseBrowser
              key={activeTab.connection.id}
              connection={activeTab.connection}
              onOpenTable={handleOpenTableInTab}
              onNewQuery={openEditorTab}
            />
          ) : tableTabActive && activeTab?.kind === "table" ? (
            <TableDetail
              key={activeTab.id}
              connectionId={activeTab.connection.id}
              database={activeTab.database}
              table={activeTab.table}
            />
          ) : editorTabActive && activeTab?.kind === "editor" ? (
            <SqlEditor
              key={activeTab.id}
              connectionId={activeTab.connection.id}
              initialSql={activeTab.sql}
              initialDatabase={activeTab.database}
              onChange={(sql) => updateEditorSql(activeTab.id, sql)}
              onDatabaseChange={(db) => updateEditorDatabase(activeTab.id, db)}
            />
          ) : (
            <div className="flex flex-1 items-start justify-center overflow-y-auto px-10 py-10">
              <ConnectionForm initial={selected} onSaved={handleSaved} onOpened={handleOpened} />
            </div>
          )}
        </div>
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

function SidebarCollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" role="img" aria-label="collapse" fill="none">
      <title>collapse sidebar</title>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="m11 6-2 2 2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" role="img" aria-label="expand" fill="none">
      <title>expand sidebar</title>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="m9 6 2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default App;
