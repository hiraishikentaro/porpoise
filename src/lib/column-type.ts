/**
 * MySQL の data_type 文字列を見て数値系かどうかを判定する。
 *  - 整数: tinyint, smallint, mediumint, int, bigint, year
 *  - 実数: decimal, numeric, dec, fixed, float, double, real
 *  - 修飾子 (unsigned, zerofill, (n)) は無視
 */
export function isNumericMysqlType(rawType: string | undefined | null): boolean {
  if (!rawType) return false;
  // "bigint(20) unsigned" → "bigint"
  const head = rawType.toLowerCase().replace(/\(.*$/, "").trim();
  return NUMERIC_TYPES.has(head);
}

const NUMERIC_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "year",
  "decimal",
  "numeric",
  "dec",
  "fixed",
  "float",
  "double",
  "double precision",
  "real",
]);

/**
 * QueryResult の `columns: string[]` には型情報が無いので、サンプル値を見て
 * 数値列っぽいか推定する。最初の N 行で全セルが数値文字列 (空/null は除外) なら true。
 */
export function looksNumericByValues(
  rows: (string | null)[][],
  colIdx: number,
  sample = 50,
): boolean {
  let seen = 0;
  const limit = Math.min(rows.length, sample);
  for (let i = 0; i < limit; i++) {
    const v = rows[i]?.[colIdx];
    if (v === null || v === undefined || v === "") continue;
    if (!/^-?\d+(\.\d+)?$/.test(v)) return false;
    seen += 1;
  }
  return seen > 0;
}
