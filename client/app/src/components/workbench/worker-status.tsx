"use client";

/**
 * 执行电脑在不在线。
 *
 * 工作台上的每一件事——会话、Git、执行——都要有一台登记过的 Worker 领命令。插件
 * 没开的时候，命令会静静排在队列里，界面只能等到超时才报错；这里把状态提前摆到
 * 用户眼前，让「转圈很久」变成「插件没开」。
 */

import { useCallback, useEffect, useState } from "react";
import { Laptop } from "lucide-react";
import { getWorkerStatus, type WorkerStatus } from "@/api/command.api";

/** 插件一分钟心跳一次，在线窗口是五分钟：界面 30 秒问一次就够快，也不吵。 */
const REFRESH_MS = 30_000;

export function useWorkerStatus(programId: number) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);

  const load = useCallback(async () => {
    if (!programId) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await getWorkerStatus(programId));
    } catch {
      // 状态本身读不到时保持上一次的判断：这条附属请求不该盖掉页面上的主流程报错。
    }
  }, [programId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { status, reload: load };
}

export function heartbeatLabel(value: string | null) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

function offlineText(status: WorkerStatus) {
  if (!status.workerId) return "未登记执行电脑";
  const label = heartbeatLabel(status.lastHeartbeatAt);
  return label ? `执行电脑离线 · ${label}` : "执行电脑离线";
}

export function WorkerStatusChip({ status }: { status: WorkerStatus | null }) {
  if (!status) return null;
  return (
    <span className={`status worker-status ${status.online ? "is-success" : "is-danger"}`} role="status">
      <Laptop size={13} aria-hidden="true" />
      {status.online ? `${status.displayName || "执行电脑"} 在线` : offlineText(status)}
    </span>
  );
}

/** 离线时才出现的一行提醒：命令仍会提交，但要先把插件开起来才有人领。 */
export function WorkerOfflineNotice({ status }: { status: WorkerStatus | null }) {
  if (!status || status.online) return null;
  return (
    <p className="worker-offline-notice" role="status">
      {status.workerId
        ? `${status.displayName || "执行电脑"}已离线（最后心跳 ${heartbeatLabel(status.lastHeartbeatAt) || "未知"}）。现在发出的指令会排队，等插件重新在线后才会执行。`
        : "这个项目还没有登记执行电脑。请先在项目所在的电脑上启动插件桥接，指令才有人领取。"}
    </p>
  );
}
