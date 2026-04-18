import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { DatabaseBrowser } from "@/components/DatabaseBrowser";
import { SavedConnections } from "@/components/SavedConnections";
import { SettingsModal } from "@/components/SettingsModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { SqlEditor } from "@/components/SqlEditor";
import { type Tab, TabBar } from "@/components/TabBar";
import { TableDetail } from "@/components/TableDetail";
import { TablePalette } from "@/components/TablePalette";
import { useSettings } from "@/lib/settings";
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

const PERSIST_KEY = "porpoise.tabs.v1";

type PersistedTab =
  | { id: string; kind: "connection"; connectionId: string }
  | { id: string; kind: "table"; connectionId: string; database: string; table: string }
  | {
      id: string;
      kind: "editor";
      connectionId: string;
      title: string;
      sql: string;
      database: string | null;
    };

type PersistedState = {
  tabs: PersistedTab[];
  activeTabId: string | null;
  editorSeq: number;
};

function readPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function serializeTabs(tabs: Tab[], activeTabId: string | null, editorSeq: number): PersistedState {
  return {
    tabs: tabs.map((t): PersistedTab => {
      if (t.kind === "connection") {
        return { id: t.id, kind: "connection", connectionId: t.connection.id };
      }
      if (t.kind === "table") {
        return {
          id: t.id,
          kind: "table",
          connectionId: t.connection.id,
          database: t.database,
          table: t.table,
        };
      }
      return {
        id: t.id,
        kind: "editor",
        connectionId: t.connection.id,
        title: t.title,
        sql: t.sql,
        database: t.database,
      };
    }),
    activeTabId,
    editorSeq,
  };
}

function hydrateTabs(
  persisted: PersistedState,
  connectionsById: Map<string, SavedConnection>,
  activeIds: Set<string>,
): { tabs: Tab[]; activeTabId: string | null } {
  const restored: Tab[] = [];
  for (const p of persisted.tabs) {
    const conn = connectionsById.get(p.connectionId);
    if (!conn) continue;
    // 接続がまだ open でなければタブを復元しない
    // (接続を開く時に復元されるため二重にならない)
    if (!activeIds.has(p.connectionId)) continue;
    if (p.kind === "connection") {
      restored.push({ id: p.id, kind: "connection", connection: conn });
    } else if (p.kind === "table") {
      restored.push({
        id: p.id,
        kind: "table",
        connection: conn,
        database: p.database,
        table: p.table,
      });
    } else {
      restored.push({
        id: p.id,
        kind: "editor",
        connection: conn,
        title: p.title,
        sql: p.sql,
        database: p.database,
      });
    }
  }
  const activeStillExists =
    persisted.activeTabId && restored.some((t) => t.id === persisted.activeTabId);
  return {
    tabs: restored,
    activeTabId: activeStillExists ? persisted.activeTabId : (restored[0]?.id ?? null),
  };
}

function App() {
  const [selected, setSelected] = useState<SavedConnection | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editorSeq, setEditorSeq] = useState(1);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { settings, update: updateSetting } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const updateSettingRef = useRef(updateSetting);
  updateSettingRef.current = updateSetting;

  useEffect(() => {
    (async () => {
      try {
        const [ids, list] = await Promise.all([activeConnections(), listConnections()]);
        const idSet = new Set(ids);
        setActiveIds(idSet);
        const connectionsById = new Map(list.map((c) => [c.id, c]));
        const persisted = readPersisted();
        if (persisted) {
          const { tabs: restored, activeTabId: nextActive } = hydrateTabs(
            persisted,
            connectionsById,
            idSet,
          );
          // 永続化されていない接続タブ (新規 open 中など) を補完
          for (const id of idSet) {
            if (!restored.some((t) => t.id === connectionTabId(id))) {
              const conn = connectionsById.get(id);
              if (conn) {
                restored.push({ id: connectionTabId(id), kind: "connection", connection: conn });
              }
            }
          }
          setTabs(restored);
          setActiveTabId(nextActive ?? restored[0]?.id ?? null);
          setEditorSeq(Math.max(1, persisted.editorSeq));
          return;
        }
        // フォールバック: 永続化なし → 開いている接続だけ connection タブにする
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

  // 変更のたびに localStorage に保存。SQL エディタの打鍵など高頻度更新で
  // JSON.stringify + setItem が走り続けないよう 500ms debounce する。
  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        const serialized = serializeTabs(tabs, activeTabId, editorSeq);
        localStorage.setItem(PERSIST_KEY, JSON.stringify(serialized));
      } catch {
        // noop — quota exceeded などは無視
      }
    }, 500);
    return () => window.clearTimeout(handle);
  }, [tabs, activeTabId, editorSeq]);

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
    (conn: SavedConnection, database: string | null, sql = "") => {
      const id = newEditorTabId();
      const title = `Query ${editorSeq}`;
      setEditorSeq((v) => v + 1);
      setTabs((prev) => [...prev, { id, kind: "editor", connection: conn, title, sql, database }]);
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

  const reorderTabs = useCallback(
    (draggingId: string, targetId: string, position: "before" | "after") => {
      setTabs((prev) => {
        const from = prev.findIndex((t) => t.id === draggingId);
        if (from < 0) return prev;
        const dragged = prev[from];
        const without = prev.filter((t) => t.id !== draggingId);
        const targetIdx = without.findIndex((t) => t.id === targetId);
        if (targetIdx < 0) return prev;
        const insertAt = position === "before" ? targetIdx : targetIdx + 1;
        const next = [...without];
        next.splice(insertAt, 0, dragged);
        return next;
      });
    },
    [],
  );

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

  // グローバルショートカット:
  //   Cmd+W : アクティブタブを閉じる (デフォルト window close を抑制)
  //   Cmd+T : 新規 SQL エディタタブ (アクティブタブの接続がある時のみ)
  //   Cmd+S : サイドバー (接続一覧) の開閉
  // いずれも capture phase で拾ってメニュー accelerator より先に preventDefault する
  const closeTabRef = useRef<(id: string) => void>(() => {});
  closeTabRef.current = handleCloseTab;
  const activeTabIdRef = useRef<string | null>(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const openEditorTabRef = useRef(openEditorTab);
  openEditorTabRef.current = openEditorTab;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();

      if (key === "w" && !e.shiftKey) {
        const id = activeTabIdRef.current;
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        closeTabRef.current(id);
        return;
      }

      if (key === "t" && !e.shiftKey) {
        const id = activeTabIdRef.current;
        const activeTab = id ? tabsRef.current.find((t) => t.id === id) : null;
        if (!activeTab) return;
        // エディタタブの database を引き継ぐ、無ければ null
        const db =
          activeTab.kind === "editor"
            ? activeTab.database
            : activeTab.kind === "table"
              ? activeTab.database
              : null;
        e.preventDefault();
        e.stopPropagation();
        openEditorTabRef.current(activeTab.connection, db);
        return;
      }

      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setSidebarCollapsed((v) => !v);
        return;
      }

      if (key === "p" && !e.shiftKey) {
        const id = activeTabIdRef.current;
        const activeTab = id ? tabsRef.current.find((t) => t.id === id) : null;
        if (!activeTab) return;
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen(true);
        return;
      }

      // ⌘/ or ⌘? で shortcuts help modal
      if (key === "/" || key === "?") {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen((v) => !v);
        return;
      }

      // ⌘, で settings (macOS 慣習)
      if (key === ",") {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen((v) => !v);
        return;
      }

      // ⌘+ / ⌘= で font scale を 1px 拡大、⌘- で 1px 縮小 (11〜18 で clamp)
      if (key === "+" || key === "=") {
        e.preventDefault();
        e.stopPropagation();
        const next = Math.min(18, settingsRef.current.fontScale + 1);
        updateSettingRef.current("fontScale", next);
        return;
      }
      if (key === "-") {
        e.preventDefault();
        e.stopPropagation();
        const next = Math.max(11, settingsRef.current.fontScale - 1);
        updateSettingRef.current("fontScale", next);
        return;
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

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
  const showEmptyState = !activeTab || !activeIds.has(activeTab.connection.id);

  return (
    <main className="flex h-screen overflow-hidden">
      {!sidebarCollapsed && (
        <aside className="flex w-80 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <header className="flex h-12 items-center justify-between border-b border-sidebar-border/70 px-3">
            <button
              type="button"
              onClick={handleNewTab}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/90 transition-colors hover:border-accent hover:text-accent"
              aria-label="New connection"
              title="New connection"
            >
              <PlusIcon />
            </button>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_1px_var(--accent-glow)]"
              />
              <span
                className="text-[0.85rem] tracking-tight"
                style={{
                  fontFamily: "var(--font-display)",
                  fontVariationSettings: '"SOFT" 50, "wght" 520, "opsz" 24',
                }}
              >
                Porpoise
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                aria-label="Settings"
                title="Settings"
              >
                <GearIcon />
              </button>
              <button
                type="button"
                onClick={() => setSidebarCollapsed(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                aria-label="Collapse sidebar"
                title="Hide connections"
              >
                <SidebarCollapseIcon />
              </button>
            </div>
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
          onReorder={reorderTabs}
        />

        <div className="relative flex min-h-0 flex-1 flex-col">
          {/*
            状態保持のため、接続が open な全てのタブを常時マウントし、
            アクティブでないタブは hidden で隠すだけにする。
            これで DatabaseBrowser の selectedDb や TableView の edit/filter、
            SqlEditor の実行結果などがタブ移動で飛ばなくなる。
          */}
          {tabs.map((tab) => {
            if (!activeIds.has(tab.connection.id)) return null;
            const isActive = tab.id === activeTabId;
            const visibilityClass = isActive ? "flex" : "hidden";
            if (tab.kind === "connection") {
              return (
                <div key={tab.id} className={`${visibilityClass} min-h-0 flex-1 flex-col`}>
                  <DatabaseBrowser
                    connection={tab.connection}
                    onOpenTable={handleOpenTableInTab}
                    onNewQuery={openEditorTab}
                  />
                </div>
              );
            }
            if (tab.kind === "table") {
              return (
                <div key={tab.id} className={`${visibilityClass} min-h-0 flex-1 flex-col`}>
                  <TableDetail
                    connectionId={tab.connection.id}
                    database={tab.database}
                    table={tab.table}
                  />
                </div>
              );
            }
            return (
              <div key={tab.id} className={`${visibilityClass} min-h-0 flex-1 flex-col`}>
                <SqlEditor
                  connectionId={tab.connection.id}
                  initialSql={tab.sql}
                  initialDatabase={tab.database}
                  onChange={(sql) => updateEditorSql(tab.id, sql)}
                  onDatabaseChange={(db) => updateEditorDatabase(tab.id, db)}
                  onOpenInNewEditor={(sql, db) => openEditorTab(tab.connection, db, sql)}
                />
              </div>
            );
          })}

          {showEmptyState && (
            <div className="relative flex flex-1 items-start justify-center overflow-y-auto px-10 py-10">
              {/* Atmospheric backdrop */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-[0.35]"
                style={{
                  backgroundImage:
                    "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
                  backgroundSize: "32px 32px",
                  maskImage:
                    "radial-gradient(ellipse 80% 60% at 50% 35%, black 30%, transparent 75%)",
                }}
              />
              <div className="relative z-10 w-full max-w-3xl">
                <ConnectionForm initial={selected} onSaved={handleSaved} onOpened={handleOpened} />
              </div>
            </div>
          )}
        </div>
      </section>

      {paletteOpen && activeTab && (
        <TablePalette
          connection={activeTab.connection}
          onSelect={(database, table) => {
            upsertTableTab(activeTab.connection, database, table);
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

      {toast && (
        <div className="pointer-events-none fixed bottom-8 left-1/2 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 rounded-md border border-accent/40 bg-card/90 px-4 py-2 shadow-[0_10px_30px_-10px_oklch(0_0_0/60%),0_0_0_1px_oklch(1_0_0/3%)_inset] backdrop-blur">
          <div className="flex items-center gap-2.5 text-[0.82rem]">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-glow),0_0_10px_2px_var(--accent-glow)]"
            />
            <span className="text-foreground">{toast}</span>
          </div>
        </div>
      )}
    </main>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="settings" fill="none">
      <title>settings</title>
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3 3.4 12.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" role="img" aria-label="plus" fill="none">
      <title>add</title>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
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
