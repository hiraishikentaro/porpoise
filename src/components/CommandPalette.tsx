import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "@/lib/fuzzy";
import { colorForName, ringColorFor } from "@/lib/status-color";
import { type AllTablesEntry, listAllTables, type SavedConnection } from "@/lib/tauri";

type Action = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  connections: SavedConnection[];
  activeIds: Set<string>;
  activeConnection: SavedConnection | null;
  actions: Action[];
  onSelectConnection: (conn: SavedConnection) => void;
  onOpenTable: (conn: SavedConnection, database: string, table: string) => void;
};

type Item =
  | { kind: "action"; id: string; label: string; hint?: string; run: () => void }
  | {
      kind: "connection";
      id: string;
      connection: SavedConnection;
      open: boolean;
    }
  | {
      kind: "table";
      id: string;
      connection: SavedConnection;
      database: string;
      table: string;
    };

const MAX_VISIBLE = 60;

export function CommandPalette({
  open,
  onClose,
  connections,
  activeIds,
  activeConnection,
  actions,
  onSelectConnection,
  onOpenTable,
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tablesByConn, setTablesByConn] = useState<Map<string, AllTablesEntry[]>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // open 時に active connection のテーブルを遅延ロード (ほかの conn は使われた時に)
  useEffect(() => {
    if (!open || !activeConnection) return;
    if (tablesByConn.has(activeConnection.id)) return;
    let cancelled = false;
    listAllTables(activeConnection.id)
      .then((list) => {
        if (cancelled) return;
        setTablesByConn((prev) => {
          const next = new Map(prev);
          next.set(activeConnection.id, list);
          return next;
        });
      })
      .catch(() => {
        // noop
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeConnection, tablesByConn]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const a of actions) {
      out.push({ kind: "action", id: `act:${a.id}`, label: a.label, hint: a.hint, run: a.run });
    }
    for (const c of connections) {
      out.push({
        kind: "connection",
        id: `conn:${c.id}`,
        connection: c,
        open: activeIds.has(c.id),
      });
    }
    // テーブル: activeConnection があればそこから
    if (activeConnection) {
      const list = tablesByConn.get(activeConnection.id) ?? [];
      for (const t of list) {
        out.push({
          kind: "table",
          id: `tbl:${activeConnection.id}:${t.database}:${t.name}`,
          connection: activeConnection,
          database: t.database,
          table: t.name,
        });
      }
    }
    return out;
  }, [actions, connections, activeIds, activeConnection, tablesByConn]);

  const scored = useMemo(() => {
    const q = query.trim();
    if (!q) {
      return items
        .slice(0, MAX_VISIBLE)
        .map((item) => ({ item, score: 0, indices: [] as number[] }));
    }
    const results: { item: Item; score: number; indices: number[] }[] = [];
    for (const item of items) {
      const label = labelOf(item);
      const m = fuzzyMatch(q, label);
      if (m) results.push({ item, score: m.score + priorityBoost(item), indices: m.indices });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, MAX_VISIBLE);
  }, [items, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query 変更時に先頭選択へ戻すため必要
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function runItem(it: Item) {
    if (it.kind === "action") {
      it.run();
    } else if (it.kind === "connection") {
      onSelectConnection(it.connection);
    } else {
      onOpenTable(it.connection, it.database, it.table);
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, scored.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = scored[active];
      if (sel) runItem(sel.item);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-6 pt-[10vh] backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 z-0 cursor-default"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/60%),0_0_0_1px_oklch(1_0_0/3%)_inset]"
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/60">
            ⌘K
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command, connection, or table…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-7 flex-1 bg-transparent text-[0.88rem] outline-none placeholder:text-muted-foreground/60"
          />
          <span className="font-mono text-[0.62rem] text-muted-foreground/50">
            {scored.length} of {items.length}
          </span>
        </div>
        <div ref={listRef} className="flex max-h-[60vh] flex-col overflow-auto py-1">
          {scored.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">No matches.</div>
          ) : (
            scored.map((s, idx) => (
              <Row
                key={s.item.id}
                idx={idx}
                item={s.item}
                active={idx === active}
                onClick={() => runItem(s.item)}
              />
            ))
          )}
        </div>
        <footer className="flex items-center gap-4 border-t border-border bg-sidebar/20 px-4 py-1.5 font-mono text-[0.62rem] text-muted-foreground/70">
          <span>
            <kbd className="tp-kbd mr-1">↵</kbd> select
          </span>
          <span>
            <kbd className="tp-kbd mr-1">↑↓</kbd> nav
          </span>
          <span className="ml-auto">
            <kbd className="tp-kbd mr-1">esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}

function labelOf(item: Item): string {
  switch (item.kind) {
    case "action":
      return item.label;
    case "connection":
      return `${item.connection.name} ${item.connection.host}`;
    case "table":
      return `${item.database}.${item.table}`;
  }
}

function priorityBoost(item: Item): number {
  if (item.kind === "action") return 4;
  if (item.kind === "connection") return 2;
  return 0;
}

function Row({
  idx,
  item,
  active,
  onClick,
}: {
  idx: number;
  item: Item;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm transition-colors ${
        active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted"
      }`}
    >
      <KindBadge item={item} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{primaryLabel(item)}</span>
        {secondaryLabel(item) && (
          <span
            className={`truncate font-mono text-[0.64rem] ${
              active ? "text-accent-foreground/75" : "text-muted-foreground/70"
            }`}
          >
            {secondaryLabel(item)}
          </span>
        )}
      </span>
      {hintOf(item) && (
        <span
          className={`font-mono text-[0.64rem] ${
            active ? "text-accent-foreground/70" : "text-muted-foreground/50"
          }`}
        >
          {hintOf(item)}
        </span>
      )}
    </button>
  );
}

function KindBadge({ item }: { item: Item }) {
  if (item.kind === "connection") {
    const color = colorForName(item.connection.name, item.connection.color_label);
    const ring = ringColorFor(color);
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: ring, boxShadow: `0 0 6px ${ring}70` }}
      />
    );
  }
  if (item.kind === "table") {
    return (
      <span className="inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-sm border border-border/70 font-mono text-[0.55rem] text-muted-foreground">
        TBL
      </span>
    );
  }
  // action
  return (
    <span className="inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-sm border border-accent/40 bg-accent/10 font-mono text-[0.55rem] text-accent">
      ACT
    </span>
  );
}

function primaryLabel(item: Item): string {
  switch (item.kind) {
    case "action":
      return item.label;
    case "connection":
      return item.connection.name;
    case "table":
      return item.table;
  }
}

function secondaryLabel(item: Item): string | null {
  switch (item.kind) {
    case "action":
      return null;
    case "connection":
      return `${item.connection.host}${item.open ? " · open" : ""}`;
    case "table":
      return `${item.connection.name} · ${item.database}`;
  }
}

function hintOf(item: Item): string | null {
  if (item.kind === "action") return item.hint ?? null;
  return null;
}
