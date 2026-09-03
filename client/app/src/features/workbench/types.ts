/** 工作台用到的会话与 Git 视图类型。字段与本机桥接回传的快照保持一致。 */

export type ConversationItemType =
  | "userMessage"
  | "agentMessage"
  | "reasoning"
  | "plan"
  | "commandExecution"
  | "mcpToolCall"
  | "dynamicToolCall"
  | "fileChange"
  | "fileEdit"
  | string;

export interface ConversationAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isImage: boolean;
  relativePath: string;
  url: string;
}

export interface ConversationChange {
  path: string;
  kind: string;
  added: number;
  removed: number;
}

export interface ConversationItem {
  id: string;
  type: ConversationItemType;
  text: string;
  action: string;
  target: string;
  status: string;
  exitCode?: number;
  phase: string;
  attachments: ConversationAttachment[];
  changes: ConversationChange[];
}

/** 一轮（或一条会话累计）烧掉的 token。执行器没报用量时整个字段都不下发。 */
export interface TokenUsage {
  /** 送进模型的全部输入，含命中缓存的部分。 */
  inputTokens: number;
  /** 输入里命中提示缓存的部分，计价通常只有一折。 */
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** 只有 Claude 会算钱，Codex 侧为 null。 */
  costUsd: number | null;
}

/** 同一份用量按执行器分开：面板要分别看到 Codex 和 Claude 花了多少。 */
export interface ProviderUsage {
  codex: TokenUsage;
  claude: TokenUsage;
  total: TokenUsage;
}

export interface RequirementTaskUsage {
  itemKey: string;
  title: string;
  phase: string;
  status: string;
  usage: ProviderUsage;
}

/** 需求窗口里的入口，桥接按这几个键给需求会话分账。 */
export type RequirementUsageGroupKey = "analysis" | "planning" | "prototype" | "review" | "testing" | "fineTuning";

/** 某一个入口（分析 / 拆解 / 原型 / review / 测试 / 微调）花了多少。 */
export interface RequirementUsageGroup {
  key: RequirementUsageGroupKey;
  /** 这一块开过几条会话；零条和「跑过但没报用量」是两回事。 */
  threads: number;
  usage: ProviderUsage;
}

/** 一条需求的消耗账：需求侧会话 + 每条任务，各自按执行器分开。 */
export interface RequirementUsage {
  programId: number;
  requirementKey: string;
  /** 总账 = 需求会话 + 全部任务。 */
  usage: ProviderUsage;
  /** 只算需求侧的会话：分析、拆解、原型、review、需求测试、微调。 */
  conversations: ProviderUsage;
  /** 上面那笔再按块拆开，加起来等于 conversations；老版本桥接不给这一段。 */
  conversationGroups?: RequirementUsageGroup[];
  tasks: RequirementTaskUsage[];
  updatedAt: string;
}

/**
 * 这条会话此刻占了多少上下文窗口。
 *
 * 和 `TokenUsage` 不是一回事：用量是整条会话累加的账，只增不减；上下文是这一刻
 * 送进模型的那份提示词有多长，压缩之后会掉回去。对话窗口顶上显示的是后者。
 */
export interface SessionContextWindow {
  /** 最近一次模型请求占住的上下文（输入含缓存命中那段 + 这次的输出）。 */
  usedTokens: number;
  /** 这个模型的上下文窗口，也就是「总共多少」；执行器没报时为 0，界面按执行器兜一个。 */
  windowTokens: number;
  remainingTokens: number;
  usedPercent: number;
  /** 这条读数是哪个执行器留下的，以及当时用的模型。 */
  provider: string;
  model: string;
}

export interface ConversationTurn {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string;
  items: ConversationItem[];
  usage?: TokenUsage;
}

/**
 * 回合跑着时顺着活动流回传的增量正文。
 *
 * Worker 只发新长出来的条目，界面把它们并进当前这一轮 —— 因此不必每隔几秒
 * 整份快照回读一次。回合结束后仍会以一次完整快照为准。
 */
export interface LiveTurnUpdate {
  threadId: string;
  turnId: string;
  status: string;
  createdAt: string;
  active: boolean;
  executorType: string;
  items: ConversationItem[];
  usage?: TokenUsage;
  context?: SessionContextWindow;
}

/** 聊天记录列表里的一条：需求拆解会话和任务会话共用这份摘要。 */
export interface ConversationSummary {
  threadId: string;
  title: string;
  status: string;
  executorType: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSnapshot {
  programId: number;
  requirementKey?: string;
  itemKey?: string;
  threadId: string;
  executorType: string;
  turns: ConversationTurn[];
  conversations: ConversationSummary[];
  active: boolean;
  activeTurnId: string;
  /** 本条会话所有回合的合计消耗。 */
  usage?: TokenUsage;
  /** 这条会话当前的上下文占用；老版本桥接不给这一段。 */
  context?: SessionContextWindow;
  /** 拆解会话本轮写进任务面板的结果；任务会话没有这一段。 */
  result?: { items?: { itemKey: string; title: string }[]; itemKeys?: string[] };
  /**
   * 这份快照超过了远程命令的结果上限，Worker 只回了这个标记。
   * 会话本身照常在执行电脑上，只是手机这一趟取不回来——别把它当成「没有会话」。
   */
  truncated?: boolean;
}

export interface GitChangeFile {
  path: string;
  kind: string;
  added: number;
  removed: number;
  staged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  workspace: string;
  isGitRepository: boolean;
  remoteName: string;
  remoteMatches: boolean;
  currentBranch: string;
  detached: boolean;
  dirty: boolean;
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface GitBranchCatalog {
  branches: string[];
  defaultBranch: string;
  currentBranch: string;
  fetchError: string;
}

export interface GitChangeList {
  branch: string;
  files: GitChangeFile[];
  total: number;
  truncated: boolean;
}

export interface GitChangeDetail extends GitChangeFile {
  oldText: string;
  newText: string;
  binary: boolean;
  truncated: boolean;
}

export interface GitProjectSnapshot {
  /** 相对根工作目录的路径；根目录本身是空串，建分支时按它指定子工程。 */
  path: string;
  name: string;
  workspace: string;
  isGitRepository?: boolean;
  error?: string;
  currentBranch?: string;
  dirty?: boolean;
  changed?: number;
  hasBranch?: boolean;
  message?: string;
}

export interface GitProjectList {
  workspace: string;
  projects: GitProjectSnapshot[];
}

/** 一个工程（根工作目录或某个子工程）在这次建分支里的结果。 */
export interface GitBranchTargetOutcome {
  path: string;
  name: string;
  branch: string;
  baseBranch: string;
  created: boolean;
  skipped?: boolean;
  error: string;
}

/** 建需求分支的结果：分支名以本机建成的为准，需求要按它落库。 */
export interface GitBranchCreation {
  /** 已经存在的分支只会被切过去，这时为 false，同样算关联成功。 */
  created: boolean;
  branch: string;
  baseBranch: string;
  results: GitBranchTargetOutcome[];
}

/** 一个工程（根工作目录或某个子工程）在这次提交/推送里的结果。 */
/** 合并预览里，某个工程对某条来源分支的差距。 */
export interface GitMergeSource {
  branch: string;
  exists: boolean;
  sourceRef: string;
  changedFiles: number;
  commits: number;
}

/** 合并预览按工程给：根工作目录和每个子工程各算各的。 */
export interface GitMergeProject {
  path: string;
  name: string;
  hasTarget: boolean;
  targetRef: string;
  dirty: boolean;
  currentBranch: string;
  changedFiles: number;
  sources: GitMergeSource[];
  error: string;
}

export interface GitMergePreview {
  target: string;
  sources: string[];
  projects: GitMergeProject[];
}

/** 一条来源分支在某个工程里的合并结果。冲突由执行电脑上的 AI 解开后 resolved 为真。 */
export interface GitMergeOutcome {
  branch: string;
  merged: boolean;
  upToDate: boolean;
  conflict: boolean;
  missing: boolean;
  resolved: boolean;
  conflictFiles: string[];
  output: string;
}

export interface GitMergeProjectResult {
  path: string;
  name: string;
  branch: string;
  merged: GitMergeOutcome[];
  pushed: boolean;
  /** 这个工程里没有目标分支，本轮不参与。 */
  skipped: boolean;
  error: string;
}

export interface GitMergeResult {
  target: string;
  sources: string[];
  remote: string;
  pushed: boolean;
  /** 整体成功不代表每个工程都合上了，这里列出没合上的工程。 */
  failed: string[];
  results: GitMergeProjectResult[];
}

/** 工作目录体检：这个目录在执行电脑上到底是不是一个能用的仓库。 */
export interface GitWorkspaceCheck {
  exists: boolean;
  isGitRepository: boolean;
  remoteName: string;
  remoteConfigured: boolean;
  empty: boolean;
  /** 还没初始化的子模块目录名。 */
  pendingSubmodules: string[];
}

export interface GitSubmoduleResult {
  submodules: string[];
  submoduleError: string;
}

export interface GitPushTargetOutcome {
  path: string;
  name: string;
  branch: string;
  pushed: boolean;
  committed: boolean;
  upToDate: boolean;
  /** 游离 HEAD 没有可推送的分支，只标出来跳过，不替用户猜该推到哪。 */
  skipped?: boolean;
  error: string;
}

/** 提交（或提交并推送）的结果：分支以本机实际所在的为准。 */
export interface GitPushResult {
  pushed: boolean;
  branch: string;
  remote: string;
  /** 工作区本来就干净时没有新提交，这时为 false，同样算这一轮做完了。 */
  committed: boolean;
  commitMessage: string;
  upToDate: boolean;
  /** 推送前并过远端最新：pulled 是快进，rebased 是把本地提交挪到远端之后。 */
  synced: string;
  results?: GitPushTargetOutcome[];
}
