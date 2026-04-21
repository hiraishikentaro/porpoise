export type StatusColor = "gray" | "blue" | "amber" | "green" | "red" | "pink";

export const STATUS_COLORS: StatusColor[] = ["gray", "blue", "amber", "green", "red", "pink"];

/**
 * Avatar palette: each entry is a two-stop gradient top → bottom plus a
 * contrasting foreground. Gradients read as "inked lozenge" rather than flat
 * circles, which is the one detail you notice at 20 px.
 */
// GitHub Primer 由来の 6 色を avatar palette に割り当てる
const palette: Record<StatusColor, { from: string; to: string; fg: string; ring: string }> = {
  gray: { from: "#484f58", to: "#30363d", fg: "#e6edf3", ring: "#484f58" },
  blue: { from: "#2f81f7", to: "#1f6feb", fg: "#0d1117", ring: "#2f81f7" },
  amber: { from: "#d29922", to: "#9e6a03", fg: "#0d1117", ring: "#d29922" },
  green: { from: "#3fb950", to: "#2ea043", fg: "#0d1117", ring: "#3fb950" },
  red: { from: "#f85149", to: "#da3633", fg: "#0d1117", ring: "#f85149" },
  pink: { from: "#bc8cff", to: "#8957e5", fg: "#0d1117", ring: "#bc8cff" },
};

export function statusColorVars(color: StatusColor): React.CSSProperties {
  const p = palette[color];
  return {
    backgroundImage: `linear-gradient(160deg, ${p.from} 0%, ${p.to} 100%)`,
    color: p.fg,
  };
}

export function ringColorFor(color: StatusColor): string {
  return palette[color].ring;
}

function isStatusColor(v: string | null | undefined): v is StatusColor {
  return typeof v === "string" && (STATUS_COLORS as string[]).includes(v);
}

/**
 * 接続色の決定: 明示ラベルがあればそれを使う。なければ name から hash 由来で
 * 安定的に決める (prod=red などの誤爆防止ラベル優先)。
 */
export function colorForName(name: string, override?: string | null | undefined): StatusColor {
  if (isStatusColor(override)) return override;
  if (!name) return "gray";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % STATUS_COLORS.length;
  return STATUS_COLORS[idx];
}

export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "·";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}
