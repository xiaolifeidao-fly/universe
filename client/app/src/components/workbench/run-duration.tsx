"use client";

import { useEffect, useState } from "react";
import type { DeliveryItem } from "@/api/management.api";

/** 执行耗时只给两级：面板要的是量级，不是秒表读数。 */
export function formatRunDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * 这一轮开始了但还没结束时返回开始时刻，否则返回 0。
 * 还要求任务确实在执行中：执行侧被杀掉的那一轮收不到终态，
 * 只看开始时刻会让秒表在界面上一直走下去。
 */
function runningSince(item: DeliveryItem) {
  if (item.status !== "doing") return 0;
  if (!item.lastRunStartedAt || item.lastRunFinishedAt) return 0;
  const startedAt = Date.parse(item.lastRunStartedAt);
  return Number.isNaN(startedAt) ? 0 : startedAt;
}

/** 跑着的那一轮每秒自己走：进度轮询的间隔远大于一秒，靠它刷新等于秒表走走停停。 */
function useRunClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** 任务行上的那一行：本次耗时 + 这条任务的累计耗时。任务缺失（进度没读回来）时不显示。 */
export function TaskRunDuration({ item }: { item?: DeliveryItem }) {
  const since = item ? runningSince(item) : 0;
  const now = useRunClock(Boolean(since));
  if (!item) return null;
  const running = since ? Math.max(0, now - since) : 0;
  const last = running || item.lastRunDurationMs || 0;
  const total = (item.totalRunDurationMs || 0) + running;
  if (!last && !total) return null;
  return (
    <div className="task-row__usage">
      <span className="usage-row__nums">
        <em>本次 {formatRunDuration(last)}</em>
        <i>累计 {formatRunDuration(total)}</i>
      </span>
    </div>
  );
}

/** 需求下全部任务的累计耗时；正在跑的那几轮由前端现加上去。 */
export function useTotalRunDuration(items: DeliveryItem[], totalRunDurationMs: number) {
  const running = items.map(runningSince).filter(Boolean);
  const now = useRunClock(running.length > 0);
  return (totalRunDurationMs || 0) + running.reduce((sum, since) => sum + Math.max(0, now - since), 0);
}
