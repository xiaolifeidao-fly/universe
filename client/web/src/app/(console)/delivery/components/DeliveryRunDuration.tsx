"use client";

import { ClockCircleOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import type { DeliveryItemRecord } from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * 执行耗时只给两级：面板要的是量级，不是秒表读数。
 * 一轮跑了两小时零几秒时，秒数不影响任何判断，反而让这行数字每秒都在跳。
 */
export function formatRunDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * 这一轮开始了但还没结束时，返回它的开始时刻；否则返回 0。
 * 服务端在绑定运行实例时写开始时刻、收到终态时写结束时刻，两者的差就是本轮耗时。
 *
 * 同时要求任务确实还在执行中：执行侧被杀掉时那一轮永远收不到终态，
 * 只看开始时刻的话，这条任务的秒表会在面板上一直走下去。
 */
function runningSince(item: DeliveryItemRecord) {
  if (item.status !== "doing") return 0;
  if (!item.lastRunStartedAt || item.lastRunFinishedAt) return 0;
  const startedAt = Date.parse(item.lastRunStartedAt);
  return Number.isNaN(startedAt) ? 0 : startedAt;
}

/** 正在跑的那一轮每秒自己走：进度十秒才轮询一次，靠它刷新等于秒表停一半的时间。 */
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

/**
 * 这条任务的「本次」和「累计」耗时。还在跑时「本次」就是已经跑掉的时间，
 * 跑完了才换成服务端结算出来的那一轮耗时；累计同样把在跑的这一轮先加进去，
 * 免得一条跑了半小时的任务在窗口里显示成还是上一轮的数。
 */
function taskRunDurations(item: DeliveryItemRecord, now: number) {
  const since = runningSince(item);
  const running = since ? Math.max(0, now - since) : 0;
  return {
    running: Boolean(since),
    last: running || item.lastRunDurationMs || 0,
    total: (item.totalRunDurationMs || 0) + running,
  };
}

/** 表格单元里的单个耗时：本次或累计，跑着的那一轮实时走。 */
export function TaskRunDurationValue({ item, field }: { item?: DeliveryItemRecord; field: "last" | "total" }) {
  const since = item ? runningSince(item) : 0;
  const now = useRunClock(Boolean(since));
  if (!item) return <span className="delivery-usage-muted">—</span>;
  const durations = taskRunDurations(item, now);
  const value = field === "last" ? durations.last : durations.total;
  if (!value) return <span className="delivery-usage-muted">—</span>;
  return <span className={durations.running ? "is-running" : undefined}>{formatRunDuration(value)}</span>;
}

/** 需求下全部任务的累计耗时；正在跑的那几轮由前端现加上去。 */
export function useTotalRunDuration(items: DeliveryItemRecord[], totalRunDurationMs: number) {
  const running = items.map(runningSince).filter(Boolean);
  const now = useRunClock(running.length > 0);
  return (totalRunDurationMs || 0) + running.reduce((sum, since) => sum + Math.max(0, now - since), 0);
}

/** 任务卡片上的那一行：本次耗时 + 这条任务的累计耗时。跑着的那一轮实时走。 */
export function DeliveryTaskRunDuration({ item }: { item: DeliveryItemRecord }) {
  const { t } = useLocale();
  const since = runningSince(item);
  const now = useRunClock(Boolean(since));
  const { last, total } = taskRunDurations(item, now);
  if (!last && !total) return null;
  return (
    <span className={`delivery-progress-node__duration${since ? " is-running" : ""}`}>
      <ClockCircleOutlined />
      <em>
        {t("delivery.progress.duration.last")}
        <b className="manager-mono">{formatRunDuration(last)}</b>
      </em>
      <i>
        {t("delivery.progress.duration.total")}
        <b className="manager-mono">{formatRunDuration(total)}</b>
      </i>
    </span>
  );
}

interface DeliveryRunDurationTotalProps {
  items: DeliveryItemRecord[];
  /** 服务端算好的全部任务累计耗时；正在跑的那几轮由前端现加上去。 */
  totalRunDurationMs: number;
  runCount: number;
}

/** 进度窗顶部那一格：这条需求的全部任务一共跑了多久。 */
export function DeliveryRunDurationTotal({ items, totalRunDurationMs, runCount }: DeliveryRunDurationTotalProps) {
  const { t } = useLocale();
  const total = useTotalRunDuration(items, totalRunDurationMs);
  const running = items.some((item) => runningSince(item));
  return (
    <div className={`delivery-progress-duration${running ? " is-running" : ""}`}>
      <span className="delivery-progress-duration__icon"><ClockCircleOutlined /></span>
      <b className="manager-mono">{total ? formatRunDuration(total) : "—"}</b>
      <small>{t("delivery.progress.duration.overall")}</small>
      <em>
        {total
          ? t("delivery.progress.duration.runs").replace("{count}", String(runCount))
          : t("delivery.progress.duration.none")}
      </em>
    </div>
  );
}
