export type StatusColor = "gray" | "blue" | "amber" | "green" | "red" | "pink";

export const STATUS_COLORS: StatusColor[] = ["gray", "blue", "amber", "green", "red", "pink"];

const palette: Record<StatusColor, { bg: string; fg: string }> = {
  gray: { bg: "oklch(0.45 0.01 270)", fg: "oklch(0.95 0.005 90)" },
  blue: { bg: "oklch(0.52 0.18 255)", fg: "oklch(0.97 0.005 90)" },
  amber: { bg: "oklch(0.72 0.15 70)", fg: "oklch(0.2 0.008 270)" },
  green: { bg: "oklch(0.6 0.17 145)", fg: "oklch(0.97 0.005 90)" },
  red: { bg: "oklch(0.62 0.21 25)", fg: "oklch(0.97 0.005 90)" },
  pink: { bg: "oklch(0.7 0.2 340)", fg: "oklch(0.2 0.008 270)" },
};

export function statusColorVars(color: StatusColor): React.CSSProperties {
  const p = palette[color];
  return { backgroundColor: p.bg, color: p.fg };
}

/**
 * Stable auto-pick for a color based on the connection name so existing
 * connections get a distinct avatar without a stored preference yet.
 */
export function colorForName(name: string): StatusColor {
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
