"use client";

/**
 * 执行电脑在不在线。
 *
 * 工作台上的每一件事——会话、Git、执行——都要有一台登记过的 Worker 领命令。插件
 * 没开的时候，命令会静静排在队列里，界面只能等到超时才报错；这里把状态提前摆到
 * 用户眼前，让「转圈很久」变成「插件没开」。
 */

import { useCallback, useEffect, useState } from "react";
import { getWorkerStatus, type WorkerStatus } from "@/api/command.api";
import { useNetworkStatus } from "@/components/network-provider";

/** 插件一分钟心跳一次，在线窗口是五分钟：界面 30 秒问一次就够快，也不吵。 */
const REFRESH_MS = 30_000;

function useWorkerStatusPoll(enabled: boolean, programId: number) {
  const [status, setStatus] = useState<WorkerStatus | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await getWorkerStatus(programId));
    } catch {
      // 状态本身读不到时保持上一次的判断：这条附属请求不该盖掉页面上的主流程报错。
    }
  }, [enabled, programId]);

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

/** 页面里用：指令发给哪个项目，就看那个项目登记过的执行电脑。 */
export function useWorkerStatus(programId: number) {
  return useWorkerStatusPoll(programId > 0, programId);
}

/** 顶栏用：不挑项目，看当前空间里心跳最新的那台执行电脑。 */
export function useSpaceWorkerStatus(enabled: boolean) {
  return useWorkerStatusPoll(enabled, 0);
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

/**
 * 顶栏那枚状态。
 *
 * 这里原先挂的是 navigator.onLine：网卡通着就写「已连接」，可它既没问过服务端，
 * 也不知道有没有人来领命令，看着安心其实什么都没保证。换成插件心跳之后，绿点
 * 说的是「现在发指令有人接」——顶栏上唯一值得占一格的连通性。
 */
export function WorkerHeaderState({ enabled }: { enabled: boolean }) {
  const deviceOnline = useNetworkStatus();
  const { status } = useSpaceWorkerStatus(enabled);
  // 没有产研身份就不该问 /workers/status，也没有执行电脑可言：顶栏这格干脆空着。
  if (!enabled) return null;
  const view = headerView(deviceOnline, status);
  if (!view) return null;
  return (
    <span className={`connection-state${view.online ? "" : " is-offline"}`} role="status" title={view.detail}>
      <span className="connection-state__dot" aria-hidden="true" />
      {view.name ? <span className="connection-state__name">{view.name}</span> : null}
      <span className="connection-state__word">{view.word}</span>
    </span>
  );
}

/**
 * 徽标拆成「机器名 + 在线/离线」两截。
 *
 * 机器名是主机随便起的，`flydeMacBook-Pro.local` 这种长度在 375 宽的手机上必然
 * 溢出；真正要看的那两个字反而会被省略号吃掉。所以名字归名字、状态归状态，挤
 * 的时候只省名字，剩下的细节交给 title。
 */
function headerView(deviceOnline: boolean, status: WorkerStatus | null) {
  // 本机都没网时，上一次问到的心跳已经不作数了，别拿它冒充「在线」。
  if (!deviceOnline) return { online: false, name: "", word: "本机离线", detail: "这台设备当前没有网络，执行电脑在不在线无从确认。" };
  // 第一次还没问到结果就先空着，免得顶栏闪一下再改口。
  if (!status) return null;
  if (!status.workerId) {
    return { online: false, name: "", word: "未登记执行电脑", detail: "这个空间还没有登记执行电脑。请先在电脑上启动插件桥接，指令才有人领取。" };
  }
  const name = status.displayName || "执行电脑";
  const beat = heartbeatLabel(status.lastHeartbeatAt) || "未知";
  if (status.online) {
    return { online: true, name, word: "在线", detail: `${name} 心跳正常（${beat}），现在发出的指令会有人领。` };
  }
  return {
    online: false,
    name,
    word: "离线",
    detail: `${name} 已离线（最后心跳 ${beat}）。指令仍会提交，但要等插件重新在线才有人领取。`,
  };
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
