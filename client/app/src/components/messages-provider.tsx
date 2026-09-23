"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import { loadMessageCenter, unreadCount, type MessageCenterSnapshot } from "@/api/messages.api";
import { useSpace } from "@/components/space-provider";
import { hasPersona } from "@/lib/auth";

/** 和 PC 消息中心同一个节奏：任务状态是人改出来的，一分钟一次足够。 */
const REFRESH_INTERVAL_MS = 60_000;

const EMPTY: MessageCenterSnapshot = { batches: [], completions: [], attention: [] };

interface MessagesContextValue {
  snapshot: MessageCenterSnapshot;
  unread: number;
  loading: boolean;
  error: string;
  /** 手动刷新；silent=true 时不闪 loading 态，供轮询使用。 */
  refresh: (silent?: boolean) => void;
  /** 本地把某条标成已读，跳转时先行生效，不等接口回来。 */
  applyRead: (patch: (snapshot: MessageCenterSnapshot) => MessageCenterSnapshot) => void;
}

const MessagesContext = createContext<MessagesContextValue>({
  snapshot: EMPTY, unread: 0, loading: false, error: "", refresh: () => {}, applyRead: () => {},
});

/**
 * 消息拉取放在外壳这一层，不放页面里。
 *
 * 一次快照要按项目逐个取三类数据（批次提醒、需求完成提醒、受阻/不做任务），
 * 请求数是项目数的三倍。底部导航的未读角标每屏都要显示，消息页自己也要这份
 * 数据 —— 各拉一遍就是两倍开销，所以在这里拉一次，两边共用。
 */
export function MessagesProvider({ children }: { children: ReactNode }) {
  // 空间是数据范围：换空间后消息必须重新拉，否则还停在上一个空间的项目上。
  const { bizLine } = useSpace();
  // 消息读的是交付数据，业务方身份没有这些项目的访问权，不必为它发请求。
  const enabled = hasPersona("product_research");
  const [snapshot, setSnapshot] = useState<MessageCenterSnapshot>(EMPTY);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!enabled) {
      setSnapshot(EMPTY);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    setError("");
    try {
      setSnapshot(await loadMessageCenter());
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取消息。");
    } finally {
      setLoading(false);
    }
  }, [bizLine, enabled]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, load]);

  const value = useMemo<MessagesContextValue>(() => ({
    snapshot,
    unread: unreadCount(snapshot),
    loading,
    error,
    refresh: (silent = false) => { void load(silent); },
    applyRead: (patch) => setSnapshot(patch),
  }), [error, load, loading, snapshot]);

  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

export function useMessages() {
  return useContext(MessagesContext);
}
