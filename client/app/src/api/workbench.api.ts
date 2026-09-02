/**
 * 工作台的远程命令封装。
 *
 * 移动端不直接连本机桥接：会话、Git 和文档都以命令形式交给已登记的 Worker 执行，
 * 这里把「提交命令 — 等待终态 — 取回结果」收成一次调用，让页面像调普通接口一样用。
 */

import { ApiError } from "@/api/client";
import {
  cancelCommand,
  getCommand,
  isTerminalCommand,
  listCommands,
  streamCommandEvents,
  submitCommand,
  uploadCommandAttachments,
  type CommandState,
  type CommandSummary,
} from "@/api/command.api";
import type {
  ConversationSnapshot,
  GitBranchCatalog,
  GitChangeDetail,
  GitChangeList,
  GitProjectList,
  GitStatus,
  RequirementUsage,
} from "@/features/workbench/types";

/** 只读命令走 Worker 的只读通道，长任务占着执行通道时也能返回。 */
const READ_TIMEOUT_MS = 90_000;
/** 活动流断开后的重连节奏；正常路径上一条命令只连一次。 */
const RECONNECT_BASE_MS = 900;
const RECONNECT_MAX_MS = 4_000;

export const MAX_CONVERSATION_ATTACHMENTS = 5;

function commandKey(commandType: string) {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `mobile-${commandType}-${suffix}`.slice(0, 128);
}

/** 需求拆解会话的附件伪任务键，和本机桥接的归档命名保持一致。 */
export function planningAttachmentItemKey(requirementKey: string) {
  return requirementKey ? `__project_planning__:${requirementKey}` : "__project_planning__";
}

/** Worker 上报的一次进度：状态、百分比，以及它此刻在做什么。 */
export interface CommandProgress {
  state: CommandState;
  progress: number;
  message: string;
}

export interface WatchCommandOptions {
  signal?: AbortSignal;
  /** 只读命令给上限；会话回合可以跑很久，不设上限。 */
  timeoutMs?: number;
  /** 命令还在跑时的进度回调，用来在界面上说明 Worker 正在做什么。 */
  onProgress?: (progress: CommandProgress) => void;
  /**
   * 不再等这条命令时，是否把它一并撤掉。
   *
   * 只读命令没人接结果就该撤；而会话回合是用户按下去的动作，离开界面只是不看了，
   * 不代表要停 —— 停止有专门的按钮。
   */
  withdrawOnGiveUp?: boolean;
}

export type RunCommandOptions = WatchCommandOptions;

export function submitWorkbenchCommand(programId: number, commandType: string, input: Record<string, unknown>) {
  return submitCommand({ programId, commandType, input, idempotencyKey: commandKey(commandType) });
}

/**
 * 客户端不再等这条命令了，就把它从队列里撤掉。
 *
 * 不撤的话它还会在队列里躺上几分钟，等 Worker 上线后照跑不误：手机上早就没人
 * 接这份结果，它却排在下一次刷新前面。撤销失败不改变调用方看到的结果。
 */
async function withdrawCommand(commandId: string, reason: string) {
  try {
    await cancelCommand(commandId, reason);
  } catch {
    // 命令可能刚好跑完或已被取消，这里没有需要告诉用户的新信息。
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function eventProgress(data: Record<string, unknown>) {
  const value = Number(data?.progress ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.min(100, Math.round(value)) : 0;
}

/**
 * 盯着一条命令直到终态。
 *
 * 走服务端的活动流：一条命令一个连接，而不是每 900 毫秒问一次「好了没」。一轮十
 * 分钟的回合原先要发几百个请求，手机的电和流量都花在握手上；活动流顺带把 Worker
 * 上报的进度说明带回来，界面能说清它此刻在做什么。
 *
 * 流断了（切后台、换网络、代理不认 SSE）就退回去读一次状态再重连，所以调用方拿到
 * 的语义和轮询时代完全一样：只在终态、超时或取消时返回。
 */
export async function watchCommand(commandId: string, options: WatchCommandOptions = {}): Promise<CommandSummary> {
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  const stopStream = () => controller.abort();
  options.signal?.addEventListener("abort", stopStream);
  const deadlineTimer = Number.isFinite(deadline)
    ? window.setTimeout(stopStream, Math.max(0, deadline - Date.now()))
    : 0;
  let cursor = 0;
  let attempt = 0;
  try {
    for (;;) {
      if (options.signal?.aborted) {
        if (options.withdrawOnGiveUp) void withdrawCommand(commandId, "手机端已离开这个界面，不再需要这次读取");
        throw new ApiError("已取消该操作。");
      }
      const command = await getCommand(commandId);
      if (isTerminalCommand(command.state)) return command;
      options.onProgress?.({ state: command.state, progress: command.progress, message: "" });
      if (Date.now() > deadline) {
        if (options.withdrawOnGiveUp) {
          void withdrawCommand(commandId, "手机端等待超时，已放弃这次读取");
          throw new ApiError("执行电脑暂时没有回应，已撤回这条指令，请确认 Worker 在线后重试。");
        }
        throw new ApiError("执行电脑暂时没有回应，请确认 Worker 在线后重试。");
      }
      const startedAt = Date.now();
      let finished = false;
      try {
        // 服务端把终态活动排干后就关掉连接，正常路径上这里等的就是那一刻。
        await streamCommandEvents(commandId, cursor, (event) => {
          cursor = Math.max(cursor, event.id);
          if (isTerminalCommand(event.state)) finished = true;
          options.onProgress?.({ state: event.state, progress: eventProgress(event.data), message: event.message });
        }, controller.signal);
        attempt = 0;
      } catch {
        // 连不上活动流不代表命令出了问题，回到上面重新读一次状态即可。
        attempt += 1;
      }
      // 命令已经跑完就立刻回上面取结果；只有流意外中断时才留一拍再重连，
      // 免得一条几百毫秒就结束的读取白等一个退避周期。
      if (finished) continue;
      const waited = Date.now() - startedAt;
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      if (waited < backoff) await delay(backoff - waited);
    }
  } finally {
    options.signal?.removeEventListener("abort", stopStream);
    if (deadlineTimer) window.clearTimeout(deadlineTimer);
    controller.abort();
  }
}

/** 等一条命令跑到终态并取回结果。取消、失败和超时都抛 ApiError，调用方按普通请求处理。 */
export async function awaitCommand<T>(commandId: string, options: RunCommandOptions = {}): Promise<T> {
  const command = await watchCommand(commandId, {
    ...options,
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    withdrawOnGiveUp: true,
  });
  if (command.state === "succeeded") return (command.result ?? {}) as T;
  throw new ApiError(command.errorMessage || terminalMessage(command.state));
}

export async function runCommand<T>(
  programId: number,
  commandType: string,
  input: Record<string, unknown>,
  options: RunCommandOptions = {},
): Promise<T> {
  const command = await submitWorkbenchCommand(programId, commandType, input);
  return awaitCommand<T>(command.commandId, options);
}

function terminalMessage(state: CommandSummary["state"]) {
  if (state === "cancelled") return "该操作已被取消。";
  if (state === "timed_out") return "执行电脑处理超时。";
  return "操作未完成，请稍后重试。";
}

/**
 * 找出这个目标上还在飞的那条命令。
 *
 * 「停止」要停的是那条命令本身：它还没被领取时撤掉就等于没发生过，已经在跑时
 * Worker 会在下一次活动上报里看到取消请求，然后停掉本机回合。而再发一条 task.stop
 * 只会排在这条长回合后面——执行通道正被它占着，等它跑完了停止请求才轮到自己。
 *
 * 界面自己发出的那条命令一般在手里，但应用被系统回收后重开就没有了，所以这里从
 * 运行记录里按目标键认回来。
 */
export async function findActiveTurnCommand(programId: number, commandTypes: string[], inputKey: string, targetKey: string) {
  if (!programId || !targetKey) return null;
  const page = await listCommands(programId);
  return (page.data ?? []).find((command) => (
    !isTerminalCommand(command.state)
    && commandTypes.includes(command.commandType)
    && String(command.input?.[inputKey] ?? "") === targetKey
  )) ?? null;
}

/** 这个项目下还在飞的执行类命令：停止全部之前要先把它们撤掉，否则通道一直被占着。 */
export async function findActiveExecutionCommands(programId: number) {
  if (!programId) return [];
  const page = await listCommands(programId);
  const executionTypes = ["task.execute", "task.execute-batch", "task.execute-sequence"];
  return (page.data ?? []).filter((command) => !isTerminalCommand(command.state) && executionTypes.includes(command.commandType));
}

// ---------- 需求拆解会话 ----------

export function fetchRequirementSession(
  programId: number,
  requirementKey: string,
  threadId = "",
  options: RunCommandOptions = {},
) {
  return runCommand<ConversationSnapshot>(programId, "task.planning-session", { requirementKey, threadId }, options);
}

export interface SendRequirementMessageInput {
  programId: number;
  requirementKey: string;
  message: string;
  threadId?: string;
  newConversation?: boolean;
  attachmentIds?: string[];
}

/** 发出一轮需求对话。回合可能跑很久，这里只回命令，界面自己盯进度。 */
export function sendRequirementMessage(input: SendRequirementMessageInput) {
  return submitWorkbenchCommand(input.programId, "task.planning", {
    requirementKey: input.requirementKey,
    message: input.message,
    threadId: input.threadId ?? "",
    newConversation: Boolean(input.newConversation),
    attachmentIds: input.attachmentIds ?? [],
  });
}

/**
 * 一条需求到目前为止烧了多少 token。
 *
 * 桥接按需求整体算一遍，顺带把每条任务的分账也算好，所以进度页和「消耗」按钮
 * 用的是同一个命令，不必为每条任务各问一次。
 */
export function fetchRequirementUsage(programId: number, requirementKey: string, options: RunCommandOptions = {}) {
  return runCommand<RequirementUsage>(programId, "requirement.usage", { requirementKey }, options);
}

export function stopRequirementSession(programId: number, requirementKey: string) {
  return submitWorkbenchCommand(programId, "task.planning-stop", { requirementKey });
}

export function uploadRequirementAttachments(programId: number, requirementKey: string, files: File[]) {
  return uploadCommandAttachments(programId, planningAttachmentItemKey(requirementKey), files);
}

// ---------- 任务会话 ----------

export function fetchTaskSession(programId: number, itemKey: string, threadId = "", options: RunCommandOptions = {}) {
  return runCommand<ConversationSnapshot>(programId, "task.session", { itemKey, threadId }, options);
}

export interface SendTaskMessageInput {
  programId: number;
  itemKey: string;
  message: string;
  threadId?: string;
  newConversation?: boolean;
  attachmentIds?: string[];
}

export function sendTaskMessage(input: SendTaskMessageInput) {
  return submitWorkbenchCommand(input.programId, "task.conversation", {
    itemKey: input.itemKey,
    message: input.message,
    threadId: input.threadId ?? "",
    newConversation: Boolean(input.newConversation),
    attachmentIds: input.attachmentIds ?? [],
  });
}

export function stopTaskSession(programId: number, itemKey: string) {
  return submitWorkbenchCommand(programId, "task.stop", { itemKey });
}

export function executeTask(programId: number, itemKey: string) {
  return submitWorkbenchCommand(programId, "task.execute", { itemKey });
}

export function executeTasks(programId: number, itemKeys: string[], sequence: boolean) {
  return submitWorkbenchCommand(programId, sequence ? "task.execute-sequence" : "task.execute-batch", { itemKeys });
}

export function stopAllExecutions(programId: number) {
  return submitWorkbenchCommand(programId, "task.stop-all", {});
}

export function uploadTaskAttachments(programId: number, itemKey: string, files: File[]) {
  return uploadCommandAttachments(programId, itemKey, files);
}

// ---------- Git ----------

export function fetchGitStatus(programId: number, remoteName = "origin", options: RunCommandOptions = {}) {
  return runCommand<GitStatus>(programId, "git.status", { remoteName }, options);
}

export function fetchGitBranches(programId: number, options: RunCommandOptions = {}) {
  return runCommand<GitBranchCatalog>(programId, "git.branches", {}, options);
}

export function fetchGitChanges(programId: number, options: RunCommandOptions = {}) {
  return runCommand<GitChangeList>(programId, "git.changes", {}, options);
}

export function fetchGitChangeDetail(programId: number, path: string, options: RunCommandOptions = {}) {
  return runCommand<GitChangeDetail>(programId, "git.change", { path }, options);
}

export function fetchGitProjects(programId: number, branch = "", remoteName = "origin", options: RunCommandOptions = {}) {
  return runCommand<GitProjectList>(programId, "git.projects", { branch, remoteName }, options);
}

export interface PrepareBranchInput {
  programId: number;
  branch: string;
  baseBranch?: string;
  targets?: string[];
  remoteName?: string;
}

export function prepareGitBranch(input: PrepareBranchInput) {
  return submitWorkbenchCommand(input.programId, "git.prepare", {
    branch: input.branch,
    strategy: "switch",
    targets: input.targets ?? [],
    remoteName: input.remoteName || "origin",
  });
}

export function createGitBranch(input: PrepareBranchInput) {
  return submitWorkbenchCommand(input.programId, "git.branch", {
    branch: input.branch,
    baseBranch: input.baseBranch ?? "",
    targets: input.targets ?? [],
  });
}

export interface PushBranchInput {
  programId: number;
  branch: string;
  message: string;
  targets?: string[];
}

export function pushGitBranch(input: PushBranchInput) {
  return submitWorkbenchCommand(input.programId, "git.push", {
    branch: input.branch,
    message: input.message,
    targets: input.targets ?? [],
  });
}
