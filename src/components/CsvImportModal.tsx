import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  type ColumnInfo,
  type ColumnMapping,
  type CsvPreview,
  describeTable,
  type ImportMode,
  type ImportResult,
  importCsv,
  previewCsv,
} from "@/lib/tauri";

type Props = {
  connectionId: string;
  database: string;
  table: string;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
};

const PREVIEW_LIMIT = 50;

export function CsvImportModal({ connectionId, database, table, onClose, onImported }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [mode, setMode] = useState<ImportMode>("insert");
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [status, setStatus] = useState<"idle" | "loading" | "running">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    describeTable(connectionId, database, table)
      .then((cols) => {
        if (cancelled) return;
        setColumns(cols);
        // default mapping: auto-match by name (case-insensitive) against CSV header
        setMapping(cols.map((c) => ({ target: c.name, csv_index: null })));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, database, table]);

  async function pickFile() {
    setError(null);
    const p = await openDialog({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (!p || Array.isArray(p)) return;
    setPath(p);
    setStatus("loading");
    try {
      const pv = await previewCsv(p, PREVIEW_LIMIT);
      setPreview(pv);
      // Auto-map by header name
      setMapping((prev) =>
        prev.map((m) => {
          const idx = pv.header.findIndex((h) => h.toLowerCase().trim() === m.target.toLowerCase());
          return { ...m, csv_index: idx >= 0 ? idx : null };
        }),
      );
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setStatus("idle");
    }
  }

  const mappedCount = useMemo(() => mapping.filter((m) => m.csv_index !== null).length, [mapping]);

  // 配列 index を key に使うと Biome に叱られるので、preview load 時に一度だけ UUID を発行して使う
  const previewKeys = useMemo(() => {
    if (!preview) return { header: [] as string[], rows: [] as string[] };
    return {
      header: preview.header.map(() => crypto.randomUUID()),
      rows: preview.rows.map(() => crypto.randomUUID()),
    };
  }, [preview]);

  async function run(dryRun: boolean) {
    if (!path) return;
    if (mappedCount === 0) {
      setError("At least one column must be mapped.");
      return;
    }
    setStatus("running");
    setError(null);
    setResult(null);
    try {
      const res = await importCsv({
        connectionId,
        database,
        table,
        path,
        mapping,
        mode,
        hasHeader,
        emptyAsNull,
        dryRun,
      });
      setResult(res);
      if (!dryRun) onImported(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setStatus("idle");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_20px_60px_-20px_oklch(0_0_0/80%),0_0_0_1px_oklch(1_0_0/4%)_inset]">
        <header className="flex items-baseline justify-between border-b border-border bg-sidebar/30 px-5 py-3">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em] text-muted-foreground/80">
              Import CSV into
            </span>
            <h2 className="font-display text-[1.02rem] font-medium tracking-tight">
              {table}{" "}
              <span className="font-mono text-[0.72rem] font-normal text-muted-foreground">
                {database}
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-5 text-sm">
          <section className="flex items-center gap-3">
            <button type="button" onClick={pickFile} className="tp-btn">
              Pick CSV…
            </button>
            {path ? (
              <span className="truncate font-mono text-[0.72rem] text-muted-foreground">
                {path}
              </span>
            ) : (
              <span className="text-[0.75rem] text-muted-foreground/70">
                Choose a .csv file to preview and map columns.
              </span>
            )}
          </section>

          {status === "loading" && <p className="text-xs text-muted-foreground">Reading file…</p>}

          {preview && (
            <>
              <section className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-sidebar/20 px-3 py-2 text-xs">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={hasHeader}
                    onChange={(e) => setHasHeader(e.currentTarget.checked)}
                  />
                  <span>Has header row</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={emptyAsNull}
                    onChange={(e) => setEmptyAsNull(e.currentTarget.checked)}
                  />
                  <span>Empty cells → NULL</span>
                </label>
                <label className="ml-auto flex items-center gap-1.5">
                  <span className="text-muted-foreground">Mode</span>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.currentTarget.value as ImportMode)}
                    className="h-7 rounded-md border border-border bg-input/50 px-1.5 text-xs outline-none focus:border-accent"
                  >
                    <option value="insert">INSERT</option>
                    <option value="upsert">UPSERT (ON DUPLICATE KEY)</option>
                  </select>
                </label>
                <span className="tp-num text-[0.65rem] text-muted-foreground/60">
                  mapped {mappedCount}/{columns.length}
                </span>
              </section>

              <section className="flex flex-col gap-1.5">
                <h3 className="tp-section-title">Column mapping</h3>
                <div className="overflow-hidden rounded-md border border-border">
                  <table className="w-full text-left text-[0.78rem]">
                    <thead className="bg-sidebar/30 text-[0.65rem] uppercase tracking-[0.1em] text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5">DB column</th>
                        <th className="px-3 py-1.5">Type</th>
                        <th className="px-3 py-1.5">CSV column</th>
                        <th className="px-3 py-1.5">Sample</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((c, i) => {
                        const m = mapping[i];
                        const sample =
                          m?.csv_index != null ? (preview.rows[0]?.[m.csv_index] ?? "") : "";
                        return (
                          <tr key={c.name} className="border-t border-border/60">
                            <td className="px-3 py-1.5 font-mono">
                              {c.name}
                              {c.key === "PRI" && <span className="ml-1 tp-chip-accent">pk</span>}
                              {!c.nullable && (
                                <span className="ml-1 text-[0.6rem] text-muted-foreground">
                                  NOT NULL
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[0.7rem] text-chart-3">
                              {c.data_type}
                            </td>
                            <td className="px-3 py-1.5">
                              <select
                                value={m?.csv_index ?? ""}
                                onChange={(e) => {
                                  const v = e.currentTarget.value;
                                  const next = v === "" ? null : Number(v);
                                  setMapping((prev) =>
                                    prev.map((p, pi) => (pi === i ? { ...p, csv_index: next } : p)),
                                  );
                                }}
                                className="h-7 w-full rounded-md border border-border bg-input/50 px-1.5 text-xs outline-none focus:border-accent"
                              >
                                <option value="">— skip —</option>
                                {preview.header.map((h, hi) => (
                                  <option key={previewKeys.header[hi]} value={hi}>
                                    {hasHeader ? h : `#${hi + 1}`}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="max-w-[240px] truncate px-3 py-1.5 font-mono text-[0.7rem] text-muted-foreground">
                              {sample}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="flex flex-col gap-1.5">
                <h3 className="tp-section-title">Preview (first {preview.rows.length} rows)</h3>
                <div className="max-h-[240px] overflow-auto rounded-md border border-border">
                  <table className="w-full text-left font-mono text-[0.7rem]">
                    <thead className="bg-sidebar/30 text-[0.62rem] uppercase tracking-[0.08em] text-muted-foreground">
                      <tr>
                        {preview.header.map((h, i) => (
                          <th key={previewKeys.header[i]} className="px-2 py-1.5">
                            {hasHeader ? h : `#${i + 1}`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, ri) => (
                        <tr key={previewKeys.rows[ri]} className="border-t border-border/40">
                          {r.map((cell, ci) => (
                            <td
                              key={`${previewKeys.rows[ri]}:${previewKeys.header[ci] ?? ci}`}
                              className="max-w-[180px] truncate px-2 py-1"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {error && (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {result && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                result.dry_run
                  ? "border-accent/40 bg-accent/10 text-foreground"
                  : "border-chart-2/50 bg-chart-2/10 text-foreground"
              }`}
            >
              <span className="font-semibold">
                {result.dry_run ? "Dry run OK — " : "Committed — "}
              </span>
              <span className="tp-num">{result.inserted.toLocaleString()}</span> rows inserted from{" "}
              <span className="tp-num">{result.rows_read.toLocaleString()}</span> read (
              <span className="tp-num">{result.batches}</span> batches).
              {result.dry_run && (
                <span className="ml-1 text-muted-foreground">No changes written.</span>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-sidebar/20 px-5 py-3">
          <button type="button" onClick={onClose} className="tp-btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!path || status === "running"}
            className="tp-btn disabled:opacity-50"
          >
            {status === "running" ? "Running…" : "Dry run"}
          </button>
          <button
            type="button"
            onClick={() => run(false)}
            disabled={!path || status === "running"}
            className="tp-btn tp-btn-primary disabled:opacity-50"
          >
            {status === "running" ? "Importing…" : "Import"}
          </button>
        </footer>
      </div>
    </div>
  );
}
