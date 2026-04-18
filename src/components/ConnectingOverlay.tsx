import { useT } from "@/lib/i18n";
import { colorForName, type StatusColor } from "@/lib/status-color";
import type { SavedConnection } from "@/lib/tauri";

/**
 * 接続オープン中に画面全体を覆うブロッキングモーダル。
 * z-[70] で他のモーダルより上に出す。connection が null なら何も描画しない。
 */
export function ConnectingOverlay({ connection }: { connection: SavedConnection | null }) {
  const t = useT();
  if (!connection) return null;
  const color: StatusColor = colorForName(connection.name, connection.color_label);
  return (
    <div
      role="alertdialog"
      aria-busy="true"
      aria-label="Connecting"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-6 shadow-[0_20px_60px_-20px_oklch(0_0_0/60%),0_0_0_1px_oklch(1_0_0/3%)_inset]">
        <span className="relative inline-flex h-12 w-12 items-center justify-center">
          <span
            className="absolute inset-0 animate-ping rounded-full opacity-50"
            style={{ backgroundColor: `var(--status-${color})` }}
          />
          <span
            className="relative inline-block h-6 w-6 rounded-full shadow-[0_0_14px_4px_var(--accent-glow)]"
            style={{ backgroundColor: `var(--status-${color})` }}
          />
        </span>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-display text-[0.95rem] font-medium tracking-tight text-foreground">
            {t("conn.connectingTitle", connection.name)}
          </span>
          <span className="max-w-[22rem] text-[0.75rem] leading-relaxed text-muted-foreground/80">
            {t("conn.connectingDesc")}
          </span>
        </div>
        <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-accent/10">
          <span className="block h-full w-1/3 animate-[indeterminate_1.15s_ease-in-out_infinite] bg-accent" />
        </div>
      </div>
    </div>
  );
}
