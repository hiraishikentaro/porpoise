import type React from "react";

type Props = {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** horizontal は width を狭めず width100 で広くとる。compact は padding 小さめ */
  variant?: "center" | "compact";
};

/**
 * 空状態・初期プロンプト用の統一プリミティブ。
 *  - グラフィカルな SVG/アイコン領域 + タイトル + 説明 + オプションの action
 *  - "何もない" をあえて見せ、次にとるべき行動を促す
 */
export function EmptyState({ icon, title, description, action, variant = "center" }: Props) {
  const pad = variant === "compact" ? "py-8" : "py-16";
  return (
    <div
      className={`flex w-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center ${pad}`}
    >
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-card/60 text-muted-foreground/80 shadow-[inset_0_1px_0_oklch(1_0_0/4%)]">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-[0.95rem] font-medium tracking-tight text-foreground">
          {title}
        </h3>
        {description && (
          <p className="max-w-sm text-[0.78rem] leading-relaxed text-muted-foreground/80">
            {description}
          </p>
        )}
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 inline-flex h-7 items-center rounded-md border border-accent/40 bg-accent/10 px-3 text-[0.76rem] font-medium text-accent transition-colors hover:bg-accent/20"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
