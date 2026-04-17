export type StatusColor = "gray" | "blue" | "amber" | "green" | "red" | "pink";

export const STATUS_COLORS: StatusColor[] = ["gray", "blue", "amber", "green", "red", "pink"];

/**
 * Avatar palette: each entry is a two-stop gradient top → bottom plus a
 * contrasting foreground. Gradients read as "inked lozenge" rather than flat
 * circles, which is the one detail you notice at 20 px.
 */
const palette: Record<StatusColor, { from: string; to: string; fg: string; ring: string }> = {
  gray: {
    from: "oklch(0.55 0.02 250)",
    to: "oklch(0.38 0.015 250)",
    fg: "oklch(0.97 0.005 90)",
    ring: "oklch(0.55 0.02 250)",
  },
  blue: {
    from: "oklch(0.62 0.18 252)",
    to: "oklch(0.44 0.17 256)",
    fg: "oklch(0.98 0.005 90)",
    ring: "oklch(0.62 0.18 252)",
  },
  amber: {
    from: "oklch(0.84 0.16 74)",
    to: "oklch(0.66 0.15 62)",
    fg: "oklch(0.2 0.01 60)",
    ring: "oklch(0.78 0.16 68)",
  },
  green: {
    from: "oklch(0.74 0.16 148)",
    to: "oklch(0.54 0.15 152)",
    fg: "oklch(0.98 0.005 90)",
    ring: "oklch(0.7 0.16 148)",
  },
  red: {
    from: "oklch(0.7 0.22 22)",
    to: "oklch(0.52 0.2 18)",
    fg: "oklch(0.98 0.005 90)",
    ring: "oklch(0.64 0.22 22)",
  },
  pink: {
    from: "oklch(0.76 0.2 340)",
    to: "oklch(0.58 0.2 342)",
    fg: "oklch(0.2 0.01 340)",
    ring: "oklch(0.7 0.2 340)",
  },
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
