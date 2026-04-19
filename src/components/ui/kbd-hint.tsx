import type React from "react";

type Props = {
  keys: string[];
  /** 位置: default は "bottom" (ボタンの下に出る) */
  placement?: "top" | "bottom";
  /** hover 以外に、常時表示したい時 (Apply ボタンの内部ラベル等で使う) */
  alwaysVisible?: boolean;
  className?: string;
};

/**
 * Vercel/Linear 風のホバー時キーボードヒント。親に `relative group` を付けると
 * hover 時にフェードインする小さな kbd チップを position:absolute で出す。
 *
 *   <button className="relative group">
 *     Run
 *     <KbdHint keys={["⌘", "↵"]} />
 *   </button>
 */
export function KbdHint({ keys, placement = "bottom", alwaysVisible = false, className = "" }: Props) {
  const pos = placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5";
  const visible = alwaysVisible
    ? "opacity-100"
    : "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100";
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute ${pos} left-1/2 z-20 -translate-x-1/2 ${visible} ${className}`}
    >
      <span className="inline-flex items-center gap-0.5 rounded-md border border-border/70 bg-popover px-1.5 py-0.5 font-mono text-[0.6rem] text-muted-foreground shadow-[0_4px_14px_-4px_oklch(0_0_0/40%),0_0_0_1px_oklch(1_0_0/4%)_inset]">
        {keys.map((k, i) => (
          <KeyCap key={`${k}-${i}`}>{k}</KeyCap>
        ))}
      </span>
    </span>
  );
}

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] border border-border/60 bg-sidebar px-1 text-[0.58rem] font-semibold text-foreground/85">
      {children}
    </span>
  );
}
