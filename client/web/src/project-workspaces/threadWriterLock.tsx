"use client";

import { Modal, message } from "antd";
import type { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { getDeliveryTaskPlannerBridgeUrl } from "./deliveryTaskPlanner";

/**
 * 「这条会话线程正被别的 Codex 进程占着」这一种失败的处理。
 *
 * Codex 对每条线程只允许一个写入者，桥接每续一次聊都要先 `thread/resume` 接回原来的
 * 线程。抢不到锁时，面板上原来只会蹦出一句英文 `thread <id> already has an active
 * writer` —— 看不懂，也不知道该做什么。
 *
 * 桥接现在把这句话翻成了带线程号和持锁进程的结构（code = thread_writer_busy），这里
 * 接住它，弹一个说清楚「谁占着」的确认框：占用者是任务面板自己拉起、多半已经跑崩的
 * 执行器，才给「结束该进程并重发」这个按钮；是用户自己开着的 Codex 桌面端，就只说明
 * 情况，绝不代为关闭。
 *
 * 挂在 axios 应答拦截器上而不是某个会话窗口里，是因为任务会话、需求会话、需求分析、
 * 业务访谈这十几个入口都会撞上同一把锁，各写一遍既漏又不一致。
 */

/** 桥接翻译过的失败码，前端不必去匹配英文原话。 */
const THREAD_WRITER_BUSY_CODE = "thread_writer_busy";

/** 补发标记：释放之后只重发一次，别让「释放 → 还是被占」滚成死循环。 */
const RETRY_FLAG = "__threadWriterRetried";

/** 结束进程要等对方把 rollout 落盘，比普通请求慢，单独放宽超时。 */
const RELEASE_TIMEOUT_MS = 20000;

/** 命令行原样展示太长，确认框里留够认出是什么进程就行。 */
const COMMAND_PREVIEW_LIMIT = 220;

type HolderKind = "desktop" | "bridge" | "unknown";

type ThreadWriterHolder = {
  pid: number;
  kind: HolderKind;
  killable: boolean;
  label: string;
  command: string;
};

type ThreadWriterBusyPayload = {
  error: string;
  threadId: string;
  holder: ThreadWriterHolder | null;
};

type RetryableConfig = InternalAxiosRequestConfig & { [RETRY_FLAG]?: boolean };

/**
 * 同一瞬间可能有几个会话窗口一起撞上同一把锁，确认框只该出现一个。
 * 后到的请求等前一个的结果，用户点一次，它们一起重发。
 */
const askingByThread = new Map<string, Promise<boolean>>();

function threadWriterBusyOf(data: unknown): ThreadWriterBusyPayload | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  if (payload.code !== THREAD_WRITER_BUSY_CODE) return null;
  if (typeof payload.threadId !== "string" || !payload.threadId) return null;
  const holder = payload.holder;
  return {
    error: typeof payload.error === "string" ? payload.error : "这条会话线程正被别的 Codex 进程占用。",
    threadId: payload.threadId,
    holder: holder && typeof holder === "object" ? (holder as ThreadWriterHolder) : null,
  };
}

function holderDescription(payload: ThreadWriterBusyPayload) {
  const { holder } = payload;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>{payload.error}</div>
      {holder ? (
        <div
          style={{
            background: "var(--manager-surface-muted, rgba(0,0,0,0.04))",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.6,
            wordBreak: "break-all",
          }}
        >
          <div>
            占用进程：{holder.label}（PID {holder.pid}）
          </div>
          <code>{holder.command.slice(0, COMMAND_PREVIEW_LIMIT)}</code>
        </div>
      ) : null}
      {holder?.killable ? (
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          结束它只会中断这个执行器手上的那一轮，会话记录已经落盘的部分不受影响。
        </div>
      ) : null}
    </div>
  );
}

async function releaseThreadWriterLock(instance: AxiosInstance, threadId: string) {
  const response = await instance.post<{ released: boolean; message?: string }>(
    `${getDeliveryTaskPlannerBridgeUrl()}/v1/codex/thread-writer-lock/release`,
    { threadId },
    { timeout: RELEASE_TIMEOUT_MS },
  );
  return response.data;
}

/** 返回 true 表示锁已经放开、可以重发；false 表示用户没让动，或者没能释放。 */
function askToRelease(instance: AxiosInstance, payload: ThreadWriterBusyPayload): Promise<boolean> {
  const asking = askingByThread.get(payload.threadId);
  if (asking) return asking;

  const question = new Promise<boolean>((resolve) => {
    // 占用者不是面板自己拉起的执行器时不给按钮：桌面端那条会话是用户自己开着的，
    // 替他关掉等于把人家的应用收了。
    if (!payload.holder?.killable) {
      Modal.warning({
        title: "会话线程被占用",
        width: 560,
        content: holderDescription(payload),
        okText: "我知道了",
        onOk: () => resolve(false),
        // 按 ESC 关掉也要收尾：这个 Promise 记在 askingByThread 里，落不了地
        // 就会把这条线程后续的失败全挂住。
        onCancel: () => resolve(false),
      });
      return;
    }
    Modal.confirm({
      title: "会话线程被占用",
      width: 560,
      content: holderDescription(payload),
      okText: "结束该进程并重发",
      okButtonProps: { danger: true },
      cancelText: "先不处理",
      onOk: async () => {
        try {
          const released = await releaseThreadWriterLock(instance, payload.threadId);
          resolve(Boolean(released?.released));
        } catch (error) {
          // 释放本身失败（对方已经不在、没权限收）就把原因摆出来，关掉确认框，
          // 让用户自己决定下一步，别把弹窗卡在那里。
          message.error((error as Error).message);
          resolve(false);
        }
      },
      onCancel: () => resolve(false),
    });
  });

  const tracked = question.finally(() => askingByThread.delete(payload.threadId));
  askingByThread.set(payload.threadId, tracked);
  return tracked;
}

/**
 * 认出「线程被占用」并处理掉：用户同意结束占用进程时，原样重发一次刚才失败的请求，
 * 把重发的应答交回去——调用方看到的就是这次发送成功了。其余情况一律返回 null，
 * 让失败按原来的路径抛出去。
 */
export async function resolveThreadWriterBusy(
  instance: AxiosInstance,
  error: unknown,
): Promise<AxiosResponse | null> {
  const failure = error as AxiosError;
  const config = failure?.config as RetryableConfig | undefined;
  if (!config || config[RETRY_FLAG]) return null;
  // 只接管发消息这一类请求：读会话正文走的是 thread/read，压根不抢写入锁，
  // 真失败了重发一次也没有意义。
  if (String(config.method ?? "get").toLowerCase() !== "post") return null;
  const payload = threadWriterBusyOf(failure.response?.data);
  if (!payload) return null;
  if (!(await askToRelease(instance, payload))) return null;
  const resend: RetryableConfig = { ...config, [RETRY_FLAG]: true };
  return instance.request(resend);
}
