import { useEffect, useMemo, useRef, useState } from "react";
import { type AllTablesEntry, listAllTables, type SavedConnection } from "@/lib/tauri";

type Props = {
  connection: SavedConnection;
  onSelect: (database: string, table: string) => void;
  onClose: () => void;
};

type Scored = {
  entry: AllTablesEntry;
  score: number;
  matches: number[]; // match indices within display label
};

const MAX_VISIBLE = 50;

export function TablePalette({ connection, onSelect, onClose }: Props) {
  const [entries, setEntries] = useState<AllTablesEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAllTables(connection.id)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  const scored = useMemo(() => {
    const q = query.trim();
    if (!q) {
      // 初期表示はアルファベット順に先頭 N 件
      return entries
        .slice(0, MAX_VISIBLE)
        .map((e): Scored => ({ entry: e, score: 0, matches: [] }));
    }
    const out: Scored[] = [];
    for (const e of entries) {
      const label = `${e.database}.${e.name}`;
      const m = fuzzyMatch(q, label);
      if (m) out.push({ entry: e, score: m.score, matches: m.indices });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, MAX_VISIBLE);
  }, [entries, query]);

  useEffect(() => {
    // active が view の外に出たら scroll
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(scored.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = scored[active];
      if (pick) onSelect(pick.entry.database, pick.entry.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-6 pt-[12vh] backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close palette"
        className="absolute inset-0 z-0 cursor-default"
        onClick={onClose}
      />
      <div
        className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/80%),0_0_0_1px_oklch(1_0_0/4%)_inset]"
        role="dialog"
        aria-label="Table search"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={`Search tables in ${connection.name}`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-7 flex-1 bg-transparent text-[0.82rem] outline-none placeholder:text-muted-foreground/60"
          />
          <span className="tp-num text-[0.62rem] text-muted-foreground/60">
            {scored.length}
            {entries.length > 0 && query ? ` / ${entries.length}` : ""}
          </span>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {loading && <p className="px-4 py-3 text-xs text-muted-foreground">Loading tables…</p>}
          {error && (
            <p className="mx-3 my-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {!loading && scored.length === 0 && (
            <p className="px-4 py-4 text-center text-xs text-muted-foreground/70">
              {entries.length === 0 ? "No tables." : "No match."}
            </p>
          )}
          {scored.map((s, i) => {
            const label = `${s.entry.database}.${s.entry.name}`;
            const isActive = i === active;
            return (
              <button
                key={`${s.entry.database}:${s.entry.name}`}
                type="button"
                data-palette-idx={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => onSelect(s.entry.database, s.entry.name)}
                className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-[0.8rem] transition-colors ${
                  isActive
                    ? "bg-accent/15 text-foreground"
                    : "text-foreground/90 hover:bg-sidebar-accent/40"
                }`}
              >
                <span className="shrink-0 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/70">
                  {s.entry.kind === "view" ? "view" : "tbl"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {renderHighlighted(label, s.matches)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-sidebar/30 px-4 py-1.5 text-[0.6rem] text-muted-foreground/70">
          <span className="tp-kbd">↑↓</span>
          <span>navigate</span>
          <span className="tp-kbd">↵</span>
          <span>open in new tab</span>
          <span className="tp-kbd">esc</span>
          <span>close</span>
        </div>
      </div>
    </div>
  );
}

function renderHighlighted(label: string, matches: number[]): React.ReactNode {
  if (matches.length === 0) return label;
  const set = new Set(matches);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (set.has(i)) {
      out.push(
        <span key={i} className="font-semibold text-accent">
          {ch}
        </span>,
      );
    } else {
      out.push(ch);
    }
  }
  return out;
}

/**
 * 素朴な fuzzy マッチ。文字を順番に見つけて、連続マッチや単語境界にボーナス。
 * 見つからなければ null を返す。
 */
function fuzzyMatch(needle: string, haystack: string): { score: number; indices: number[] } | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let prev = -2;
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const target = n[ni];
    while (hi < h.length && h[hi] !== target) hi++;
    if (hi >= h.length) return null;
    indices.push(hi);
    // 連続でマッチ: +10
    if (hi === prev + 1) score += 10;
    else score += 1;
    // 先頭 or '.' / '_' / '-' の直後: +5 (単語境界)
    if (hi === 0 || /[._\- ]/.test(h[hi - 1] ?? "")) score += 5;
    prev = hi;
    hi++;
  }
  // 短い label ほど優遇
  score -= Math.floor(h.length / 20);
  // マッチ位置の早さを少し評価 (最初のマッチ index が小さいほうが良い)
  if (indices.length > 0) score -= Math.floor(indices[0] / 4);
  return { score, indices };
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
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
