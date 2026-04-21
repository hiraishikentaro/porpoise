import type React from "react";
import { PorpoiseMark } from "@/components/ui/porpoise-mark";
import { useT } from "@/lib/i18n";
import { colorForName, type StatusColor } from "@/lib/status-color";
import type { SavedConnection } from "@/lib/tauri";

/**
 * 接続オープン中に画面全体を覆うブロッキングモーダル。
 * z-[70] で他のモーダルより上に出す。connection が null なら何も描画しない。
 *
 * 表現: Porpoise mark を静かに泳がせる (set in motion)。背景は card 色なので
 * --mark-bg を card にあわせて目・口のくり抜きを成立させる。ringの色は
 * 接続ラベル色から取るので、prod 接続時は赤い暈を帯びる。
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
      <div
        className="flex w-full max-w-sm flex-col items-center gap-5 rounded-lg border border-border bg-card px-6 py-7 shadow-[0_20px_60px_-20px_oklch(0_0_0/60%),0_0_0_1px_oklch(1_0_0/3%)_inset]"
        style={{ "--mark-bg": "var(--card)" } as React.CSSProperties}
      >
        <span className="relative inline-flex h-16 w-16 items-center justify-center">
          {/* 接続色の halo — prod なら赤く滲む */}
          <span
            aria-hidden
            className="absolute inset-0 rounded-full opacity-30 blur-xl"
            style={{ backgroundColor: `var(--status-${color})` }}
          />
          {/* accent glow */}
          <span aria-hidden className="absolute inset-1 rounded-full bg-accent/10 blur-md" />
          {/* mark 本体 — swim で上下にゆるく漂う。背びれは pulse で拍動 */}
          <span className="relative inline-flex items-center justify-center text-foreground animate-[porpoise-swim_2.6s_ease-in-out_infinite]">
            <PorpoiseMark size={56} title={t("conn.connectingTitle", connection.name)} />
          </span>
        </span>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="text-[0.95rem] font-medium tracking-tight text-foreground">
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
