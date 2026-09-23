import { ApiError, apiUrl, authenticatedApiHeaders, request, upload } from "@/api/client";

export type CommandState = "pending" | "leased" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface CommandSummary {
  commandId: string;
  commandType: string;
  state: CommandState;
  programId: number;
  progress: number;
  errorMessage: string;
  cancelRequested: boolean;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type CommandDetail = CommandSummary;

export interface CommandEvent {
  id: number;
  kind: string;
  state: CommandState;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CommandAttachment {
  attachmentId: string;
  programId: number;
  itemKey: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface WorkerStatus {
  online: boolean;
  workerId: string;
  displayName: string;
  lastHeartbeatAt: string | null;
  onlineWindowSeconds: number;
}

export interface SubmitCommandInput {
  programId: number;
  commandType: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
}

interface CommandPage {
  total: number;
  data: CommandSummary[];
}

/**
 * 运行记录只列用户发起过的动作。
 *
 * 会话页每几秒读一次快照，那些命令由服务端默认挡在列表之外；排查通道时传
 * includeReadOnly 才会连快照一起列出来。
 */
export function listCommands(programId?: number, includeReadOnly = false) {
  const query = new URLSearchParams({ pageSize: "40" });
  if (programId) query.set("programId", String(programId));
  if (includeReadOnly) query.set("includeReadOnly", "true");
  return request<CommandPage>(`/commands?${query.toString()}`);
}

/**
 * 执行电脑在不在线的短时缓存。
 *
 * 提交命令前都要问一次，而工作台上一次操作往往连着发好几条命令（读状态、读改动、
 * 发一轮），每条都真去问一遍纯属自找延迟。心跳一分钟一次、在线窗口五分钟，缓存
 * 十几秒既不会让判断过时，也不会把这条附属请求变成新的噪音。
 */
const WORKER_STATUS_TTL_MS = 15_000;
const workerStatusCache = new Map<number, { at: number; status: WorkerStatus }>();

/** 执行电脑是否还在听这个项目：提交命令前先问一次，别让用户等超时才发现插件没开。 */
export async function getWorkerStatus(programId: number) {
  const status = await request<WorkerStatus>(`/workers/status?${new URLSearchParams(programId ? { programId: String(programId) } : {}).toString()}`);
  workerStatusCache.set(programId, { at: Date.now(), status });
  return status;
}

async function cachedWorkerStatus(programId: number) {
  const cached = workerStatusCache.get(programId);
  if (cached && Date.now() - cached.at < WORKER_STATUS_TTL_MS) return cached.status;
  return getWorkerStatus(programId);
}

/** 离线时的说法要指名道姓：是这台电脑没开，还是这个项目压根没登记过。 */
function offlineMessage(status: WorkerStatus) {
  if (!status.workerId) return "这个项目还没有登记执行电脑，请先在项目所在的电脑上启动插件桥接。";
  const name = status.displayName ? `执行电脑「${status.displayName}」` : "执行电脑";
  return `${name}当前离线，请先在那台电脑上启动插件桥接后重试。`;
}

export function getCommand(commandId: string) {
  return request<CommandDetail>(`/commands/${encodeURIComponent(commandId)}`);
}

/**
 * 提交一条远程命令。
 *
 * 执行电脑不在线时当场拒绝，不往队列里放：排着等插件上线的命令看着像「已提交」，
 * 实际是把几分钟后才发生的写操作藏起来。服务端同样会挡一道 —— 这里挡是为了不让
 * 用户等一个来回才看到同一句话。
 */
export async function submitCommand(input: SubmitCommandInput) {
  // 状态读不到就按在线处理：这条附属请求不该把整个工作台卡住，服务端还会再挡一道。
  const status = await cachedWorkerStatus(input.programId).catch(() => null);
  if (status && !status.online) throw new ApiError(offlineMessage(status));
  return request<CommandDetail>("/commands", { method: "POST", body: input });
}

export function cancelCommand(commandId: string, message = "") {
  return request<CommandSummary>(`/commands/${encodeURIComponent(commandId)}/cancel`, {
    method: "POST",
    body: { message },
  });
}

export async function uploadCommandAttachments(programId: number, itemKey: string, files: File[]) {
  // 附件是为了紧接着发出去的那一轮：执行电脑不在线时先说清楚，别让人在手机网络上
  // 白传几十兆再看到同一句拒绝。
  const status = await cachedWorkerStatus(programId).catch(() => null);
  if (status && !status.online) throw new ApiError(offlineMessage(status));
  const form = new FormData();
  form.set("programId", String(programId));
  form.set("itemKey", itemKey);
  for (const file of files) form.append("files", file, file.name);
  const result = await upload<{ attachments: CommandAttachment[] }>("/commands/attachments", form);
  return result.attachments ?? [];
}

export async function streamCommandEvents(
  commandId: string,
  afterId: number,
  onEvent: (event: CommandEvent) => void,
  signal: AbortSignal,
) {
  const params = new URLSearchParams();
  if (afterId > 0) params.set("afterId", String(afterId));
  const headers = authenticatedApiHeaders({ Accept: "text/event-stream" });
  if (afterId > 0) headers.set("Last-Event-ID", String(afterId));
  let response: Response;
  try {
    response = await fetch(`${apiUrl(`/commands/${encodeURIComponent(commandId)}/events`)}?${params.toString()}`, {
      headers,
      signal,
      credentials: "omit",
    });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    throw new ApiError("活动流连接失败，请检查网络后重试。");
  }
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new ApiError(`活动流连接失败（${response.status}）`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventID = 0;
  let dataLines: string[] = [];
  const dispatch = () => {
    if (!dataLines.length) {
      eventID = 0;
      return;
    }
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as CommandEvent;
      if (parsed && typeof parsed.id === "number") {
        onEvent(eventID > 0 && eventID !== parsed.id ? { ...parsed, id: eventID } : parsed);
      }
    } catch {
      // A malformed activity record must not tear down snapshot recovery.
    }
    eventID = 0;
    dataLines = [];
  };
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
        buffer = buffer.slice(lineBreak + 1);
        if (!line) {
          dispatch();
        } else if (line.startsWith("id:")) {
          const value = Number(line.slice(3).trim());
          eventID = Number.isSafeInteger(value) && value > 0 ? value : 0;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        lineBreak = buffer.indexOf("\n");
      }
      if (done) break;
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

export function isTerminalCommand(state: CommandState) {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed_out";
}
