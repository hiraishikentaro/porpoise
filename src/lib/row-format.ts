export type CopyFormat = "tsv" | "csv" | "json" | "sql";

export function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

export function csvEscape(s: string): string {
  if (!/[,"\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function sqlValue(v: string | null): string {
  if (v === null) return "NULL";
  if (v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function formatRowsAs(
  rows: (string | null)[][],
  cols: string[],
  format: CopyFormat,
  tableName: string,
): string {
  if (format === "tsv") {
    const header = cols.join("\t");
    const body = rows.map((r) => r.map((c) => c ?? "").join("\t")).join("\n");
    return `${header}\n${body}`;
  }
  if (format === "csv") {
    const header = cols.map(csvEscape).join(",");
    const body = rows.map((r) => r.map((c) => csvEscape(c ?? "")).join(",")).join("\n");
    return `${header}\n${body}`;
  }
  if (format === "json") {
    const objs = rows.map((r) => {
      const o: Record<string, string | null> = {};
      cols.forEach((c, i) => {
        o[c] = r[i] ?? null;
      });
      return o;
    });
    return JSON.stringify(objs, null, 2);
  }
  const colList = cols.map(quoteIdent).join(", ");
  return rows
    .map((r) => {
      const vals = r.map(sqlValue).join(", ");
      return `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${vals});`;
    })
    .join("\n");
}
