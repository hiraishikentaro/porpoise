import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type TabStatus = {
  /** 表示中の行数 (フィルタ適用後) */
  rows?: number;
  /** 取得済みの行数 (filter 前) */
  fetched?: number;
  /** 最終クエリ実行時間 (ms) */
  elapsedMs?: number;
  /** pending な未コミット編集の件数 (TableView) */
  pending?: number;
  /** 選択中 pane / テーブルの database */
  database?: string | null;
};

type Ctx = {
  statuses: Map<string, TabStatus>;
  publish: (tabId: string, patch: Partial<TabStatus> | null) => void;
};

const TabStatusContext = createContext<Ctx | null>(null);

export function TabStatusProvider({ children }: { children: React.ReactNode }) {
  const [statuses, setStatuses] = useState<Map<string, TabStatus>>(new Map());
  const publish = useCallback((tabId: string, patch: Partial<TabStatus> | null) => {
    setStatuses((prev) => {
      const next = new Map(prev);
      if (patch === null) {
        next.delete(tabId);
      } else {
        next.set(tabId, { ...next.get(tabId), ...patch });
      }
      return next;
    });
  }, []);
  return (
    <TabStatusContext.Provider value={{ statuses, publish }}>{children}</TabStatusContext.Provider>
  );
}

export function useTabStatus(tabId: string | null): TabStatus | undefined {
  const ctx = useContext(TabStatusContext);
  if (!ctx || !tabId) return undefined;
  return ctx.statuses.get(tabId);
}

/**
 * 子タブコンポーネント用のパブリッシュ hook。
 * アンマウント時には自動で status を破棄する。
 */
export function useTabStatusPublish(tabId: string | undefined) {
  const ctx = useContext(TabStatusContext);
  const publish = ctx?.publish;
  useEffect(() => {
    if (!publish || !tabId) return;
    return () => publish(tabId, null);
  }, [publish, tabId]);
  return useCallback(
    (patch: Partial<TabStatus>) => {
      if (!publish || !tabId) return;
      publish(tabId, patch);
    },
    [publish, tabId],
  );
}
