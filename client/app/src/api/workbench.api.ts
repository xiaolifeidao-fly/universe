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
  GitMergePreview,
  GitWorkspaceCheck,
  GitBranchCreation,
  GitChangeDetail,
  GitChangeList,
  GitProjectList,
  GitPushResult,
  GitStatus,
  RequirementUsage,
  RequirementUsageGroupKey,
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

/** Worker 上报的一次进度：状态、百分比、它此刻在做什么，以及随活动带回的附加数据。 */
export interface CommandProgress {
  state: CommandState;
  progress: number;
  message: string;
  /** 活动自带的数据，回合正在跑时这里会带上这一轮的实时正文（`live`）。 */
  data: Record<string, unknown>;
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
      options.onProgress?.({ state: command.state, progress: command.progress, message: "", data: {} });
      if (Date.now() > deadline) {
        if (options.withdrawOnGiveUp) {
          void withdrawCommand(commandId, "手机端等待超时，已放弃这次读取");
          throw new ApiError("执行电脑暂时没有回应，已撤回这条指令，请确认 Worker 在线后重试。");
        }
        // 写命令等超时了也不能当成没发生：本机可能正跑到一半，运行记录里还看得到它。
        throw new ApiError("执行电脑还没有回结果；这条指令仍在继续，可在运行记录里跟进。");
      }
      const startedAt = Date.now();
      let finished = false;
      try {
        // 服务端把终态活动排干后就关掉连接，正常路径上这里等的就是那一刻。
        await streamCommandEvents(commandId, cursor, (event) => {
          cursor = Math.max(cursor, event.id);
          if (isTerminalCommand(event.state)) finished = true;
          options.onProgress?.({ state: event.state, progress: eventProgress(event.data), message: event.message, data: event.data ?? {} });
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

/**
 * 只读快照类命令，和服务端 service/delivery/consts.go 里的那份词表保持一致。
 *
 * 这个集合决定的是「界面不等了的时候，能不能顺手把命令撤掉」：快照没人接结果就该
 * 撤；写命令绝不能撤 —— 分支可能已经建好、提交可能已经推上去，Worker 对 git 类命令
 * 也没有真正的中止手段，撤销只会让界面报一个与事实相反的失败。
 */
const READ_ONLY_COMMAND_TYPES = new Set([
  "task.session", "task.planning-session", "requirement.usage", "requirement.session",
  "git.status", "git.branches", "git.changes", "git.change",
  "git.projects", "git.merge-preview", "git.workspace-check",
  "requirement.session",
]);

/** 等一条命令跑到终态并取回结果。取消、失败和超时都抛 ApiError，调用方按普通请求处理。 */
export async function awaitCommand<T>(commandId: string, options: RunCommandOptions = {}): Promise<T> {
  const command = await watchCommand(commandId, { timeoutMs: READ_TIMEOUT_MS, ...options });
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
  return awaitCommand<T>(command.commandId, {
    withdrawOnGiveUp: READ_ONLY_COMMAND_TYPES.has(commandType),
    ...options,
  });
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

/**
 * 需求窗口里某一块入口的会话正文：需求分析、原型、review、需求测试、微调。
 *
 * 手机上只读。这几块的下一轮要在电脑的需求窗口里发，这里回答的是「消耗面板上那笔
 * 钱买到了什么」，所以入口就开在消耗面板的那一行上。拆解不走这条：它在手机上是能
 * 接着聊的整屏会话，读正文用 `fetchRequirementSession`。
 */
export function fetchRequirementGroupSession(
  programId: number,
  requirementKey: string,
  group: RequirementUsageGroupKey,
  threadId = "",
  options: RunCommandOptions = {},
) {
  return runCommand<ConversationSnapshot>(
    programId, "requirement.session", { requirementKey, group, threadId }, options,
  );
}

export function stopRequirementSession(programId: number, requirementKey: string) {
  return submitWorkbenchCommand(programId, "task.planning-stop", { requirementKey });
}

export function uploadRequirementAttachments(programId: number, requirementKey: string, files: File[]) {
  return uploadCommandAttachments(programId, planningAttachmentItemKey(requirementKey), files);
}

// ---------- 需求窗口里的辅助会话 ----------

/**
 * 需求窗口的五条辅助会话。
 *
 * 分析、原型、评审、总体测试、微调 —— 它们在执行电脑上一直都有，只是从没接出远程
 * 命令，手机上因此走不完一条需求：拆解和执行做得了，其余必须回电脑。
 *
 * 读快照统一走 `requirement.session`，按 group 分块；发起和停止各有各的命令类型。
 */
export type RequirementChannel = "analysis" | "prototype" | "review" | "testing" | "fineTuning";

const requirementChannelCommands: Record<RequirementChannel, { send: string; stop: string }> = {
  analysis: { send: "requirement.analysis", stop: "requirement.analysis-stop" },
  // 原型只有「生成」和「继续聊」，没有单独的停止入口。
  prototype: { send: "requirement.prototype-message", stop: "" },
  review: { send: "requirement.review", stop: "requirement.review-stop" },
  testing: { send: "requirement.testing", stop: "requirement.testing-stop" },
  fineTuning: { send: "requirement.fine-tuning", stop: "requirement.fine-tuning-stop" },
};

export function requirementChannelSendCommand(channel: RequirementChannel) {
  return requirementChannelCommands[channel].send;
}

export function fetchRequirementChannelSession(
  programId: number,
  requirementKey: string,
  group: RequirementChannel,
  threadId = "",
  options: RunCommandOptions = {},
) {
  return runCommand<ConversationSnapshot>(programId, "requirement.session", { requirementKey, group, threadId }, options);
}

export interface SendChannelMessageInput {
  programId: number;
  targetKey: string;
  message: string;
  threadId?: string;
  newConversation?: boolean;
  /** 这一轮要不要顺带产出交付物（生成文档 / 生成报告 / 只设计用例），由通道自己定义。 */
  flags?: Record<string, boolean>;
}

export function sendRequirementChannelMessage(channel: RequirementChannel, input: SendChannelMessageInput) {
  return submitWorkbenchCommand(input.programId, requirementChannelCommands[channel].send, {
    requirementKey: input.targetKey,
    message: input.message,
    threadId: input.threadId ?? "",
    newConversation: Boolean(input.newConversation),
    ...(input.flags ?? {}),
  });
}

export function stopRequirementChannel(channel: RequirementChannel, programId: number, requirementKey: string) {
  const commandType = requirementChannelCommands[channel].stop;
  if (!commandType) return Promise.reject(new ApiError("这条会话没有停止入口。"));
  return submitWorkbenchCommand(programId, commandType, { requirementKey });
}

/** 生成原型：本机按需求正文画一份 HTML，产出随项目云同步落到文档面板。 */
export function generateRequirementPrototype(programId: number, requirementKey: string) {
  return submitWorkbenchCommand(programId, "requirement.prototype", { requirementKey });
}

// ---------- 任务窗口里的辅助会话 ----------

/** 任务窗口的两条辅助会话：测试用例与微调。各自带一条只读的会话读取。 */
export type TaskChannel = "testing" | "fineTuning";

const taskChannelCommands: Record<TaskChannel, { send: string; stop: string; session: string }> = {
  testing: { send: "task.testing", stop: "task.testing-stop", session: "task.testing-session" },
  fineTuning: { send: "task.fine-tuning", stop: "task.fine-tuning-stop", session: "task.fine-tuning-session" },
};

export function taskChannelSendCommand(channel: TaskChannel) {
  return taskChannelCommands[channel].send;
}

export function fetchTaskChannelSession(
  programId: number,
  itemKey: string,
  channel: TaskChannel,
  threadId = "",
  options: RunCommandOptions = {},
) {
  return runCommand<ConversationSnapshot>(programId, taskChannelCommands[channel].session, { itemKey, threadId }, options);
}

export function sendTaskChannelMessage(channel: TaskChannel, input: SendChannelMessageInput) {
  return submitWorkbenchCommand(input.programId, taskChannelCommands[channel].send, {
    itemKey: input.targetKey,
    message: input.message,
    threadId: input.threadId ?? "",
    newConversation: Boolean(input.newConversation),
    ...(input.flags ?? {}),
  });
}

export function stopTaskChannel(channel: TaskChannel, programId: number, itemKey: string) {
  return submitWorkbenchCommand(programId, taskChannelCommands[channel].stop, { itemKey });
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

/**
 * 建分支并等本机真的建完。
 *
 * 新建需求要按建成的分支名落库，所以这一条不能只提交了事：分支名可能被本机改写
 * （远端前缀去掉、已存在时切过去），需求得记下最终那一个。远端 fetch 慢的时候
 * 这一步能跑好几分钟，等待上限给得比普通只读命令宽。
 */
export function createGitBranchAndWait(input: PrepareBranchInput, options: RunCommandOptions = {}) {
  return runCommand<GitBranchCreation>(input.programId, "git.branch", {
    branch: input.branch,
    baseBranch: input.baseBranch ?? "",
    targets: input.targets ?? [],
  }, { timeoutMs: 240_000, ...options });
}

/**
 * 工作目录体检：这个项目在执行电脑上是不是一个能用的仓库。
 *
 * 建分支、提交、合并被挡住时，问题多半在这一层：目录不在了、还不是仓库、没配远端、
 * 或者子模块从来没初始化过。手机上看不到那台电脑的文件系统，这条命令就是那双眼睛。
 */
export function fetchGitWorkspaceCheck(programId: number, options: RunCommandOptions = {}) {
  return runCommand<GitWorkspaceCheck>(programId, "git.workspace-check", {}, options);
}

/**
 * 合并预览：目标分支 ← 若干来源分支，按工程列出各自会动多少文件。
 *
 * 预览会先 fetch 远端 —— 拿本机过时的引用算出来的文件数会误导勾选 —— 所以比普通
 * 只读命令慢一个量级，等待上限单独给到五分钟。
 */
export function fetchGitMergePreview(
  programId: number,
  target: string,
  sources: string[],
  remoteName = "origin",
  options: RunCommandOptions = {},
) {
  return runCommand<GitMergePreview>(programId, "git.merge-preview", { target, sources, remoteName }, {
    timeoutMs: 300_000,
    ...options,
  });
}

export interface MergeBranchesInput {
  programId: number;
  target: string;
  sources: string[];
  /** 勾选的子工程目录名；不传表示只合根工作目录。 */
  targets?: string[];
  /** 根工作目录没被勾选时置真，这一轮只处理子工程。 */
  skipRoot?: boolean;
  /** 关掉就只在本机合，不推送；默认合完就推。 */
  push?: boolean;
  remoteName?: string;
}

/**
 * 合并分支。
 *
 * 冲突交给执行电脑上的 AI 解开，一轮可能跑几十分钟，所以这里只提交、不等待：
 * 跑完了推送通知会响，过程和结果在运行记录里看。本机还有任务在跑时执行电脑会拒绝，
 * 那条理由会原样出现在命令的错误里。
 */
export function mergeGitBranches(input: MergeBranchesInput) {
  return submitWorkbenchCommand(input.programId, "git.merge", {
    target: input.target,
    sources: input.sources,
    targets: input.targets ?? [],
    remoteName: input.remoteName || "origin",
    ...(input.skipRoot ? { skipRoot: true } : {}),
    ...(input.push === false ? { push: false } : {}),
  });
}

export interface InitWorkspaceInput {
  programId: number;
  repositoryUrl: string;
  remoteName?: string;
  baseBranch?: string;
}

/**
 * 把执行电脑上那个还不是仓库的目录关联到项目登记的远端：init + remote + fetch + 检出。
 *
 * 目录里已有文件时不会覆盖，只把索引对齐到远端提交，本地文件留作未提交改动由用户
 * 自己处置。要拉一整个仓库，所以只提交不等待。
 */
export function initGitWorkspace(input: InitWorkspaceInput) {
  return submitWorkbenchCommand(input.programId, "git.init", {
    repositoryUrl: input.repositoryUrl,
    remoteName: input.remoteName || "origin",
    baseBranch: input.baseBranch ?? "",
  });
}

/** 拉起还没初始化的子模块。大仓库能拉上半小时，同样只提交不等待。 */
export function initGitSubmodules(programId: number) {
  return submitWorkbenchCommand(programId, "git.submodules", {});
}

export interface PushBranchInput {
  programId: number;
  branch: string;
  message: string;
  targets?: string[];
  /** 只在本机提交、不推远端：解开「工作目录有未提交改动」这类阻塞，本机落一个提交点就够了。 */
  commitOnly?: boolean;
}

function pushBranchPayload(input: PushBranchInput) {
  return {
    branch: input.branch,
    message: input.message,
    targets: input.targets ?? [],
    ...(input.commitOnly ? { commitOnly: true } : {}),
  };
}

export function pushGitBranch(input: PushBranchInput) {
  return submitWorkbenchCommand(input.programId, "git.push", pushBranchPayload(input));
}

/**
 * 提交（或提交并推送）并等本机真的做完。
 *
 * 用来解阻塞时不能只提交了事：改动落成提交之后才谈得上重试建分支，界面得先看到结果。
 * 推送要连远端，等待上限按建分支那一条给，不用只读命令的九十秒。
 */
export function pushGitBranchAndWait(input: PushBranchInput, options: RunCommandOptions = {}) {
  return runCommand<GitPushResult>(input.programId, "git.push", pushBranchPayload(input), {
    timeoutMs: 240_000,
    ...options,
  });
}
