export type StatusColor = "gray" | "blue" | "amber" | "green" | "red" | "pink";

export const STATUS_COLORS: StatusColor[] = ["gray", "blue", "amber", "green", "red", "pink"];

/**
 * Avatar palette: each entry is a two-stop gradient top → bottom plus a
 * contrasting foreground. Gradients read as "inked lozenge" rather than flat
 * circles, which is the one detail you notice at 20 px.
 */
// Gruvbox の 6 色をそのまま avatar palette に割り当てる
const palette: Record<StatusColor, { from: string; to: string; fg: string; ring: string }> = {
  gray: { from: "#928374", to: "#665c54", fg: "#fbf1c7", ring: "#928374" },
  blue: { from: "#83a598", to: "#458588", fg: "#282828", ring: "#458588" },
  amber: { from: "#fabd2f", to: "#d79921", fg: "#282828", ring: "#d79921" },
  green: { from: "#b8bb26", to: "#98971a", fg: "#282828", ring: "#98971a" },
  red: { from: "#fb4934", to: "#cc241d", fg: "#fbf1c7", ring: "#cc241d" },
  pink: { from: "#d3869b", to: "#b16286", fg: "#282828", ring: "#b16286" },
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
