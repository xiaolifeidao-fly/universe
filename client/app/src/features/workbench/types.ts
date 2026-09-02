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
export type RequirementUsageGroupKey = "planning" | "prototype" | "review" | "testing" | "fineTuning";

/** 某一个入口（拆解 / 原型 / review / 测试 / 微调）花了多少。 */
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
  /** 只算需求侧的会话：拆解、微调、原型、review、需求测试。 */
  conversations: ProviderUsage;
  /** 上面那笔再按块拆开，加起来等于 conversations；老版本桥接不给这一段。 */
  conversationGroups?: RequirementUsageGroup[];
  tasks: RequirementTaskUsage[];
  updatedAt: string;
}

export interface ConversationTurn {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string;
  items: ConversationItem[];
  usage?: TokenUsage;
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
  /** 拆解会话本轮写进任务面板的结果；任务会话没有这一段。 */
  result?: { items?: { itemKey: string; title: string }[]; itemKeys?: string[] };
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
  name: string;
  workspace: string;
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
