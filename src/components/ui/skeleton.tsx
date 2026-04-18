type Props = {
  className?: string;
  /** width を明示したい時に style で渡す */
  style?: React.CSSProperties;
};

/**
 * ローディング状態用のシマープレースホルダ。
 * 控えめな pulse で "ここに何か出てくる" を示唆。
 */
export function Skeleton({ className = "", style }: Props) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded-sm bg-muted/60 ${className}`}
      style={style}
    />
  );
}
