import type { ColumnInfo } from "@/lib/tauri";

export type EditorKind =
  | "text"
  | "textarea"
  | "number"
  | "decimal"
  | "date"
  | "datetime"
  | "time"
  | "year"
  | "boolean"
  | "enum"
  | "set"
  | "json";

export type EditorSpec = {
  kind: EditorKind;
  /** enum / set の候補値 */
  options?: string[];
  /** 数値の step (decimal なら 0.01 など) */
  step?: string;
};

/**
 * MySQL の data_type 文字列から編集に使うエディタ種別を推定する。
 * 型情報は SHOW FULL COLUMNS の第 2 列 (例: "int unsigned", "decimal(10,2)", "enum('a','b')")
 */
export function editorFor(column: ColumnInfo): EditorSpec {
  const raw = column.data_type.toLowerCase();
  const base = raw.split(/[\s(]/)[0];

  switch (base) {
    case "tinyint": {
      // MySQL 慣習: tinyint(1) は bool として使うことが多い
      const m = raw.match(/^tinyint\((\d+)\)/);
      if (m && m[1] === "1") return { kind: "boolean" };
      return { kind: "number", step: "1" };
    }
    case "smallint":
    case "mediumint":
    case "int":
    case "integer":
    case "bigint":
      return { kind: "number", step: "1" };

    case "decimal":
    case "numeric":
    case "float":
    case "double":
    case "real": {
      const m = raw.match(/^(?:decimal|numeric)\(\s*\d+\s*,\s*(\d+)\s*\)/);
      if (m) {
        const scale = Number(m[1]);
        return { kind: "decimal", step: `0.${"0".repeat(Math.max(0, scale - 1))}1` };
      }
      return { kind: "decimal", step: "any" };
    }

    case "date":
      return { kind: "date" };
    case "datetime":
    case "timestamp":
      return { kind: "datetime" };
    case "time":
      return { kind: "time" };
    case "year":
      return { kind: "year" };

    case "json":
      return { kind: "json" };

    case "enum":
      return { kind: "enum", options: parseEnumLike(raw) };
    case "set":
      return { kind: "set", options: parseEnumLike(raw) };

    case "text":
    case "mediumtext":
    case "longtext":
    case "tinytext":
      return { kind: "textarea" };

    default:
      return { kind: "text" };
  }
}

/**
 * enum('a','b','c') の () 内から 'a', 'b', 'c' を取り出す。
 * MySQL の quoted string は '' で " を二重化 / \' でエスケープする。
 */
function parseEnumLike(type: string): string[] {
  const m = type.match(/^(?:enum|set)\((.*)\)$/);
  if (!m) return [];
  const inner = m[1];
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] !== "'") {
      i++;
      continue;
    }
    i++;
    let cur = "";
    while (i < inner.length) {
      if (inner[i] === "\\" && i + 1 < inner.length) {
        cur += inner[i + 1];
        i += 2;
        continue;
      }
      if (inner[i] === "'" && inner[i + 1] === "'") {
        cur += "'";
        i += 2;
        continue;
      }
      if (inner[i] === "'") {
        i++;
        break;
      }
      cur += inner[i];
      i++;
    }
    out.push(cur);
  }
  return out;
}

/**
 * "YYYY-MM-DD HH:MM:SS" ↔ "YYYY-MM-DDTHH:MM:SS" の相互変換。
 * <input type="datetime-local"> は T 区切りを要求するが MySQL はスペース区切り。
 */
export function toDatetimeLocal(value: string | null): string {
  if (!value) return "";
  return value.replace(" ", "T");
}

export function fromDatetimeLocal(value: string): string {
  return value.replace("T", " ");
}
