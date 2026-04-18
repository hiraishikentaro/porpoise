import { useCallback, useRef, useState } from "react";
import { SqlEditor } from "@/components/SqlEditor";
import type { EditorPane } from "@/components/TabBar";
import type { SavedConnection } from "@/lib/tauri";

type Props = {
  tabId: string;
  connection: SavedConnection;
  panes: EditorPane[];
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  onPaneSqlChange: (paneId: string, sql: string) => void;
  onPaneDatabaseChange: (paneId: string, database: string | null) => void;
  onAddPane: () => void;
  onRemovePane: (paneId: string) => void;
  onOpenInNewEditor: (sql: string, database: string | null) => void;
};

const MIN_PANE_PX = 280;

/**
 * 複数 pane を横並びに配置して境界を pointer-drag で resize する。
 * 各 pane の flex-grow を state に持って比率を保持。
 */
export function EditorPanes({
  tabId,
  connection,
  panes,
  focusedPaneId,
  onFocusPane,
  onPaneSqlChange,
  onPaneDatabaseChange,
  onAddPane,
  onRemovePane,
  onOpenInNewEditor,
}: Props) {
  // 各 pane の flex-grow (合計=panes.length になるように正規化しなくても flex で効く)
  const [grows, setGrows] = useState<Record<string, number>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const growsRef = useRef(grows);
  growsRef.current = grows;

  const startResize = useCallback((e: React.PointerEvent, leftId: string, rightId: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const currentGrows = growsRef.current;
    const startLeft = currentGrows[leftId] ?? 1;
    const startRight = currentGrows[rightId] ?? 1;
    const totalGrow = startLeft + startRight;
    const leftEl = container.querySelector<HTMLElement>(`[data-pane-id="${leftId}"]`);
    const rightEl = container.querySelector<HTMLElement>(`[data-pane-id="${rightId}"]`);
    if (!leftEl || !rightEl) return;
    const startLeftPx = leftEl.getBoundingClientRect().width;
    const startRightPx = rightEl.getBoundingClientRect().width;
    const totalPx = startLeftPx + startRightPx;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handleMove(ev: PointerEvent) {
      const delta = ev.clientX - startX;
      const newLeftPx = Math.max(MIN_PANE_PX, Math.min(totalPx - MIN_PANE_PX, startLeftPx + delta));
      const newRightPx = totalPx - newLeftPx;
      const ratio = newLeftPx / Math.max(1, newRightPx);
      // totalGrow を newLeft : newRight に配分
      const newLeftGrow = (totalGrow * ratio) / (1 + ratio);
      const newRightGrow = totalGrow - newLeftGrow;
      setGrows((prev) => ({
        ...prev,
        [leftId]: newLeftGrow,
        [rightId]: newRightGrow,
      }));
    }
    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      {panes.map((pane, i) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: focus tracking wrapper
        <div
          key={pane.id}
          data-pane-id={pane.id}
          onPointerDown={() => onFocusPane(pane.id)}
          onFocus={() => onFocusPane(pane.id)}
          className={`relative flex min-h-0 min-w-0 flex-col transition-shadow ${
            i > 0 ? "border-l border-border" : ""
          } ${
            panes.length > 1 && focusedPaneId === pane.id
              ? "shadow-[inset_0_2px_0_var(--accent)]"
              : ""
          }`}
          style={{ flexGrow: grows[pane.id] ?? 1, flexBasis: 0 }}
        >
          <SqlEditor
            key={`${tabId}:${pane.id}`}
            connectionId={connection.id}
            initialSql={pane.sql}
            initialDatabase={pane.database}
            onChange={(sql) => onPaneSqlChange(pane.id, sql)}
            onDatabaseChange={(db) => onPaneDatabaseChange(pane.id, db)}
            onOpenInNewEditor={onOpenInNewEditor}
            onSplit={onAddPane}
            onClose={panes.length > 1 ? () => onRemovePane(pane.id) : undefined}
          />
          {i < panes.length - 1 && (
            <button
              type="button"
              aria-label="Resize pane"
              onPointerDown={(e) => startResize(e, pane.id, panes[i + 1]?.id ?? "")}
              className="absolute top-0 right-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40 active:bg-accent/60"
              title="Drag to resize"
            />
          )}
        </div>
      ))}
    </div>
  );
}
