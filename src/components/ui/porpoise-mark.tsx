import type { CSSProperties } from "react";

/*
 * Porpoise ロゴマーク。design_system/Porpoise Logo Final.html 由来。
 *  - 本体: currentColor  (font の color をそのまま拾う)
 *  - 背びれ: var(--accent)
 *  - 目 / 口 / ヒレ切れ込み: var(--mark-bg) — 背景色でくり抜き
 *
 * --mark-bg を指定しない場合は --background を使う。sidebar や card の上に載せる時は
 * style で --mark-bg を上書きする。
 */

type MarkStyle = CSSProperties & Record<"--mark-bg", string | undefined>;

type Props = {
  size?: number;
  /** <title> を入れるとスクリーンリーダーで読まれる。装飾のみなら省略して aria-hidden にする。 */
  title?: string;
  className?: string;
  style?: CSSProperties;
};

export function PorpoiseMark({ size = 24, title, className, style }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={className}
      style={style as MarkStyle}
    >
      {title && <title>{title}</title>}
      <path
        d="M 6 44 C 6 30, 16 22, 28 22 C 38 22, 44 24, 48 22 L 58 18 L 55 28 C 58 34, 55 40, 48 42 C 38 44, 22 42, 14 42 C 10 42, 8 43, 6 44 Z"
        fill="currentColor"
      />
      <path d="M 26 24 L 30 10 L 36 24 Z" fill="var(--accent)" />
      <circle cx="44" cy="29" r="1.6" fill="var(--mark-bg, var(--background))" />
      <path
        d="M 49 33 L 55 31"
        stroke="var(--mark-bg, var(--background))"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M 22 40 C 20 38, 18 38, 16 40 Z"
        fill="var(--mark-bg, var(--background))"
        opacity="0.5"
      />
    </svg>
  );
}

/**
 * マーク + "porpoise" ワードマーク の横並び lockup。
 * 仕様 (design system §02): Geist Light 300, letter-spacing -0.035em, gap = mark × 0.22
 */
export function PorpoiseLockup({
  size = 24,
  wordmarkSize,
  className,
  style,
}: {
  size?: number;
  wordmarkSize?: number;
  className?: string;
  style?: CSSProperties;
}) {
  // lockup は Geist の weight を size に応じて段階的に持ち上げる。
  // 仕様書: 64px→42px/300, 40px→26px/400, 24px→15px/500
  const fontSize = wordmarkSize ?? Math.round(size * 0.62);
  const weight = size >= 56 ? 300 : size >= 36 ? 400 : 500;
  return (
    <span
      className={`inline-flex items-center ${className ?? ""}`}
      style={{ gap: `${Math.max(4, size * 0.22)}px`, ...style }}
    >
      <PorpoiseMark size={size} />
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontWeight: weight,
          fontSize: `${fontSize}px`,
          letterSpacing: "-0.035em",
          lineHeight: 1,
        }}
      >
        porpoise
      </span>
    </span>
  );
}
