"use client";

import { plainToInstance } from "class-transformer";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";
import type { AITool, ClaudeEffort, CodexReasoningEffort } from "@/ai-preferences/AIPreferencesProvider";

type AIReasoningEffort = CodexReasoningEffort | ClaudeEffort;
import {
  getData,
  getDataList,
  getPage,
  instance,
  unwrapApiResponse,
  type ApiResponse,
} from "@/utils/axios";
import { withBizLine } from "@/utils/bizLine";
import { DELIVERY_TASK_PLANNER_BRIDGE_URL } from "@/project-workspaces/deliveryTaskPlanner";
import { getProjectWorkspace } from "@/project-workspaces/projectWorkspacePreferences";

/** 任务状态，与服务端 service/delivery 的常量一一对应。 */
export const DELIVERY_STATUSES = ["todo", "doing", "done", "blocked", "dropped"] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type DeliveryExecutionBatchMode = "parallel" | "sequence";
export type DeliveryExecutionBatchStatus = "running" | "completed" | "blocked";

/** 一条交付任务依次经过需求、开发、测试三个可独立流转的阶段。 */
export const DELIVERY_PHASES = ["requirement", "development", "testing"] as const;

export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

/** 任务类型：坑点 / 能力 / 已具备（原型里的 pit / cap / have）。 */
export const DELIVERY_KINDS = ["gap", "capability", "asset"] as const;

export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export type BoardGroupBy = "stage" | "status" | "module";

/** 状态色板。看板卡片、三维全景、进度条共用这一份，避免两处调色调不一致。 */
export const STATUS_COLORS: Record<DeliveryStatus, string> = {
  todo: "#5d6f95",
  doing: "#0e8ba8",
  done: "#12a150",
  blocked: "#dc2626",
  dropped: "#98a2b3",
};

export class DeliveryProgramRecord {
  programId = 0;

  programCode = "";

  bizLine = "";

  name = "";

  summary = "";

  status = "active";

  /** 项目是否允许为需求创建、关联和切换 Git 分支。 */
  gitEnabled = false;

  /** 可选记录的仓库地址，不参与本机远端校验。 */
  gitRepositoryUrl = "";

  gitRemoteName = "origin";

  /** 新需求创建分支时优先采用的基准分支。 */
  gitBaseBranch = "";

  /** 已结束的需求、任务聊天是否归档到项目工作目录 chat/。 */
  gitChatSyncEnabled = false;

  /** 项目管理员选择后，本机桥接才会把对应类别上传到服务端云端文件库。 */
  cloudSyncEnabled = false;

  cloudSyncScopes: CloudSyncScope[] = [];

  updatedBy = "";

  updatedAt?: string;

  /** 当前登录用户对这个项目的权限，由服务端按调用者身份返回。 */
  canAdminister = false;

  canWrite = false;
}

export class ProgramAssignment {
	userIds: number[] = [];

	managerIds: number[] = [];
}

export class DeliveryStageRecord {
  stageKey = "";

  seq = 0;

  tag = "";

  timeWindow = "";

  maturityLevel = "";

  title = "";
}

export class DeliveryModuleRecord {
  moduleKey = "";

  seq = 0;

  name = "";

  weight = 0;

  kind = "";

  itemCount = 0;
}

/** 需求状态：需求层只回答「要不要做、做完没有」，细粒度进度由它下面的任务表达。 */
export const REQUIREMENT_STATUSES = ["open", "done", "dropped"] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** 需求总体测试与任务阶段测试分开记录，避免一条任务通过就误判整条需求通过。 */
export const REQUIREMENT_TESTING_STATUSES = ["todo", "doing", "passed", "failed", "blocked"] as const;

export type RequirementTestingStatus = (typeof REQUIREMENT_TESTING_STATUSES)[number];

/** 测试用例设计状态独立于真实验收，避免研发并行阶段被误标成“测试中”。 */
export const TESTING_CASES_STATUSES = ["todo", "doing", "ready", "blocked"] as const;

export type TestingCasesStatus = (typeof TESTING_CASES_STATUSES)[number];

/**
 * 拆解模式。
 *
 * simple 简易：拆出来的任务直接落在动作执行，跳过梳理需求那一轮；
 * professional 专业：保留三段流程，起始阶段由用户选，默认梳理需求。
 */
export const REQUIREMENT_MODES = ["simple", "professional"] as const;

export type RequirementMode = (typeof REQUIREMENT_MODES)[number];

export class RequirementMember {
  id = "";

  name = "";
}

export class DeliveryRequirementRecord {
  requirementKey = "";

  bizLine = "";

  programId = 0;

  name = "";

  detail = "";

  /** 需求详情里 @ 引用的历史需求键；拆解会话据此把它们的大纲产物地址交给插件。 */
  referenceRequirementKeys: string[] = [];

  /** 需求详情里 @ 引用的既有任务键；拆解会话据此读取对应任务需求文档。 */
  referenceItemKeys: string[] = [];

  /** 需求计划执行窗口；为空表示尚未安排。 */
  plannedStartAt?: string;

  plannedEndAt?: string;

  status: RequirementStatus = "open";

  mode: RequirementMode = "simple";

  /** 拆出的任务从哪个阶段起步；简易模式恒为 development。 */
  startPhase: DeliveryPhase = "development";

  /** 关掉时这条需求只落一条任务；默认按多任务拆解。 */
  splitTasks = true;

  /** 打开时确认拆解会为每条任务预生成需求文档；后续梳理阶段在同一文件上补全。 */
  preGenerateTaskDocuments = false;

  /** 仅专业模式可设置；任务确认写入后可再次确认生成需求 HTML 原型。 */
  generatePrototype = false;

  /** 关联的时间计划键；空串表示这条需求还没排进任何时间计划。 */
  timePlanKey = "";

  /**
   * 本条需求是否需要一个专属 Git 分支；分支由本机桥接在项目工作目录中创建。
   * undefined 表示这条需求没单独设置过，调用方回落到偏好设置里的默认值。
   */
  gitEnabled?: boolean;

  gitBaseBranch = "";

  gitBranch = "";

  gitBranchCreatedAt?: string;

  /** 原型权威副本位于项目工作区 doc/ 下，任务面板仅保存相对路径和生成时间。 */
  prototypeHtmlPath = "";

  prototypeGeneratedAt?: string;

  testingStatus: RequirementTestingStatus = "todo";

  /** 需求总体测试报告；单条任务的 testingReport 不会写到这里。 */
  testingReport = "";

  testingReportPath = "";

  testingReportedAt?: string;

  testingCasesStatus: TestingCasesStatus = "todo";

  testingCases = "";

  testingCasesPath = "";

  stageKey = "";

  moduleKey = "";

  kind: DeliveryKind | "" = "";

  owners: RequirementMember[] = [];

  assistants: RequirementMember[] = [];

  itemCount = 0;

  /** 乐观锁版本，编辑需求时必须原样带回服务端。 */
  version = 0;

  createdBy = "";

  createdByName = "";

  createdAt?: string;

  updatedBy = "";

  updatedAt?: string;
}

export class MemberRecord {
  id = "";

  username = "";

  displayName = "";
}

export class DeliveryItemRecord {
  itemKey = "";

  bizLine = "";

  programId = 0;

  stageKey = "";

  moduleKey = "";

  /** 所属需求；空串是需求层落地之前建的存量任务。 */
  requirementKey = "";

  /** 来源拆解批次；非必填，手工新建和存量任务为空串。 */
  planningBatchKey = "";

  kind: DeliveryKind = "gap";

  title = "";

  description = "";

  /** 任务完成后能带来的收益或作用；服务端保证新任务至少有一个。 */
  benefitTags: string[] = [];

  /** 旧任务正文兼容字段；需求文档的权威来源是 requirementDocumentPath。 */
  requirementDocument = "";

  /** 需求文档在项目工作区内的固定相对路径。 */
  requirementDocumentPath = "";

  /** 动作执行和成品测试阶段各自沉淀的可审阅结果。 */
  actionOutput = "";

  testingReport = "";

  testingCasesStatus: TestingCasesStatus = "todo";

  testingCases = "";

  testingCasesPath = "";

  /** 旧执行记录兼容字段，等同于 actionOutput。 */
  executionOutput = "";

  /**
   * 一条任务只拥有一个当前阶段和一个当前状态。
   *
   * 空值只会出现在旧服务响应经过 class-transformer 反序列化的瞬间；
   * normalizeItemPhase 会立即用旧的三个状态字段推导出唯一阶段。
   */
  phase: DeliveryPhase = "" as DeliveryPhase;

  /** 旧服务响应兼容字段，仅用于推导尚未迁移记录的唯一当前阶段。 */
  requirementStatus?: DeliveryStatus;

  developmentStatus?: DeliveryStatus;

  testingStatus?: DeliveryStatus;

  status: DeliveryStatus = "todo";

  progress = 0;

  /**
   * 执行耗时。一条任务会被反复执行（再做一次、追问、批量重跑），
   * 所以最近一轮和历次累计分开给：还在跑时 lastRunFinishedAt 为空，
   * 前端从 lastRunStartedAt 现算这一轮已经跑了多久。
   */
  lastRunStartedAt?: string;

  lastRunFinishedAt?: string;

  lastRunDurationMs = 0;

  totalRunDurationMs = 0;

  /** 已结束的执行轮次数。 */
  runCount = 0;

  ownerId = "";

  ownerName = "";

  dueDate?: string;

  note = "";

  sortOrder = 0;

  dependsOnItemKeys: string[] = [];

	dependencySourceSides: Record<string, "top" | "right" | "bottom" | "left" | ""> = {};

  dependencyTargetSides: Record<string, "top" | "right" | "bottom" | "left" | ""> = {};

  /** 乐观锁版本，改这条时必须原样带回服务端。 */
  version = 0;

  createdAt?: string;

  updatedBy = "";

  updatedAt?: string;
}

export class DeliveryModuleProgress {
  moduleKey = "";

  name = "";

  weight = 0;

  kind = "";

  total = 0;

  doneCount = 0;

  progress = 0;
}

export class DeliveryStageProgress {
  stageKey = "";

  tag = "";

  maturityLevel = "";

  total = 0;

  doneCount = 0;

  progress = 0;
}

export class DeliveryOverview {
  programId = 0;

  name = "";

  totalCount = 0;

  statusCounts: Record<string, number> = {};

  /** 加权成熟度：Σ(模块权重 × 模块进度)/Σ权重，对外汇报以它为准。 */
  maturityScore = 0;

  /** 未加权的任务平均进度，即原型页面显示的那个数，保留用于对照。 */
  plainProgress = 0;

  moduleProgress: DeliveryModuleProgress[] = [];

  stageProgress: DeliveryStageProgress[] = [];
}

export class DeliveryBoardColumn {
  key = "";

  name = "";

  subtitle = "";

  total = 0;

  doneCount = 0;

  progress = 0;

  items: DeliveryItemRecord[] = [];
}

export class DeliveryBoard {
  programId = 0;

  groupBy: BoardGroupBy = "stage";

  columns: DeliveryBoardColumn[] = [];

  overview: DeliveryOverview = new DeliveryOverview();

  /** 按需求查看任务时返回的全量汇总，不受看板临时筛选影响。 */
  requirementOverview?: DeliveryOverview;
}

function normalizeItemPhase(item: DeliveryItemRecord) {
	item.benefitTags = Array.isArray(item.benefitTags) ? item.benefitTags : [];
  if (DELIVERY_PHASES.includes(item.phase)) return item;

  const phase: DeliveryPhase = item.requirementStatus !== "done"
    ? "requirement"
    : item.developmentStatus !== "done"
      ? "development"
      : "testing";
  item.phase = phase;
  item.status = item[`${phase}Status` as "requirementStatus" | "developmentStatus" | "testingStatus"] ?? item.status ?? "todo";
  return item;
}

export class DeliveryEventRecord {
  itemKey = "";

  kind = "";

  field = "";

  fromValue = "";

  toValue = "";

  comment = "";

  actorId = "";

  actorName = "";

  createdAt = "";
}

/** 需求时间线同时含需求本身和关联任务的事件，source 用于界面区分两类变更。 */
export class DeliveryRequirementTimelineEventRecord {
  source: "requirement" | "item" = "requirement";

  itemKey = "";

  kind = "";

  field = "";

  fromValue = "";

  toValue = "";

  comment = "";

  actorId = "";

  actorName = "";

  createdAt = "";
}

export class DeliverySnapshotRecord {
  statDate = "";

  moduleKey = "";

  progress = 0;

  maturityScore = 0;

  totalCount = 0;

  doneCount = 0;

  doingCount = 0;

  blockedCount = 0;
}

export class CodexBridgeHealth {
  ready = false;

  bridge = false;

  codex = false;

  claude = false;

  configured = false;

  apiReachable = false;

  executorType = "";

  workspace = "";

  message = "";

  checkedAt = 0;
}

export class DeliveryTaskPlannerUpdateStatus {
  localVersion = "";

  localUpdatedAt = "";

  remoteVersion = "";

  remoteCommit = "";

  updateAvailable = false;

  checkedAt = 0;

  message = "";

  installation?: DeliveryTaskPlannerUpdateInstallation;
}

export class DeliveryTaskPlannerRuntimeInfo {
  installed = false;

  version = "";
}

export type DeliveryTaskPlannerUpdateState =
  | "resolving"
  | "downloading"
  | "validating"
  | "installing"
  | "restart_required"
  | "restarting"
  | "completed"
  | "failed";

export class DeliveryTaskPlannerUpdateLog {
  at = "";

  level = "info";

  message = "";
}

export class DeliveryTaskPlannerUpdateInstallation {
  jobId = "";

  status: DeliveryTaskPlannerUpdateState = "resolving";

  progress = 0;

  localVersion = "";

  targetVersion = "";

  commit = "";

  startedAt = "";

  finishedAt = "";

  message = "";

  restartRequired = false;

  activeRuns = 0;

  components: string[] = [];

  logs: DeliveryTaskPlannerUpdateLog[] = [];
}

export class CodexLocalProjectRecord {
  id = "";

  name = "";

  rootPaths: string[] = [];
}

export class CodexLocalProjectCatalog {
  projects: CodexLocalProjectRecord[] = [];
}

export class CodexWorkspaceValidation {
  valid = false;

  workspace = "";

  name = "";
}

export class CodexGitBranchCatalog {
  branches: string[] = [];

  defaultBranch = "";

  /** 工作目录此刻所处的分支；游离 HEAD 时为空串。 */
  currentBranch = "";

  /** 列分支前同步远端失败的原因；非空表示列表可能不含别人刚推的分支。 */
  fetchError = "";
}

/** 本机桥接读取的工作目录 Git 快照；不含远端地址或差异内容。 */
export class CodexGitWorkspaceStatus {
  workspace = "";

  isGitRepository = false;

  remoteName = "origin";

  remoteMatches = true;

  currentBranch = "";

  detached = false;

  dirty = false;

  changed = 0;

  staged = 0;

  unstaged = 0;

  untracked = 0;

  checkedAt = 0;
}

/** 工作目录下的一个 Git 工程：根目录自己一条（path 为空串），一级子项目各一条。 */
export class CodexGitProjectStatus extends CodexGitWorkspaceStatus {
  /** 相对根工作目录的路径；根目录为空串。 */
  path = "";

  name = "";

  /** 这个工程里本机或远端已经有需求分支；请求时带上 branch 才有意义。 */
  hasBranch = false;

  /** 这个工程读不动时的原因；非空表示同一行的状态字段都不可信。 */
  error = "";
}

export class CodexGitProjectCatalog {
  workspace = "";

  projects: CodexGitProjectStatus[] = [];
}

/** 建分支 / 切分支 / 推送在单个工程上的结果，根目录也占一条。 */
export class CodexGitTargetOutcome {
  path = "";

  name = "";

  branch = "";

  baseBranch = "";

  created = false;

  switched = false;

  pushed = false;

  committed = false;

  upToDate = false;

  /** 这个工程本轮没动：子项目里没有这条分支，或补建时跳过了根工作目录。 */
  skipped = false;

  error = "";
}

/** 工作区里的一条文件改动，用于「变更」面板列清单。 */
export class CodexGitChangeFile {
  path = "";

  /** add / modify / delete / rename，与会话里的改动条目同一套叫法。 */
  kind = "modify";

  added = 0;

  removed = 0;

  staged = false;

  untracked = false;
}

export class CodexGitChangeList {
  workspace = "";

  branch = "";

  files: CodexGitChangeFile[] = [];

  total = 0;

  /** 文件太多时只回前一批，面板要提示还有更多。 */
  truncated = false;
}

/** 单个文件改动前后的正文；二进制或超大文件不回正文，只回标记。 */
export class CodexGitChangeDetail extends CodexGitChangeFile {
  oldText = "";

  newText = "";

  binary = false;

  truncated = false;
}

/** 工作目录的 Git 归属快照：用于判断项目偏好设置里要不要显示「初始化并关联」。 */
export class CodexGitWorkspaceCheck {
  workspace = "";

  exists = false;

  isGitRepository = false;

  repositoryRoot = "";

  remoteName = "origin";

  remoteConfigured = false;

  empty = false;

  /** .gitmodules 里登记了、但本机还没检出内容的子模块路径。 */
  pendingSubmodules: string[] = [];
}

export class CodexGitInitResult {
  workspace = "";

  initialized = false;

  branch = "";

  remoteName = "origin";

  /** true 表示目录里原有文件，改用索引对齐远端，本地文件留成未提交改动。 */
  adopted = false;

  status = new CodexGitWorkspaceStatus();

  /** 本轮一并初始化好的子模块路径。 */
  submodules: string[] = [];

  /** 子模块没能全部初始化时的原因；主仓库仍然可用。 */
  submoduleError = "";
}

/** 补初始化子模块的结果：主仓库早就建好，只是子模块目录还是空的。 */
export class CodexGitSubmoduleResult {
  workspace = "";

  submodules: string[] = [];

  submoduleError = "";
}

export const CLOUD_SYNC_SCOPES = ["chat", "requirement", "design"] as const;

export type CloudSyncScope = (typeof CLOUD_SYNC_SCOPES)[number];

export class CodexCloudSyncResult {
  enabled = false;

  scopes: CloudSyncScope[] = [];

  uploaded = 0;

  skipped = 0;

  files: string[] = [];
}

export class CodexGitPrepareResult {
  branch = "";

  previousBranch = "";

  /** 切换前是否真的从远端拉到了新提交。 */
  pulled = false;

  committed = false;

  stashed = false;

  status = new CodexGitWorkspaceStatus();

  /** 根目录加各子项目的切换结果；根目录固定是第一条。 */
  results: CodexGitTargetOutcome[] = [];
}

export class CodexGitBranchResult {
  created = false;

  baseBranch = "";

  branch = "";

  /** 根目录加各子项目的创建结果；根目录固定是第一条。 */
  results: CodexGitTargetOutcome[] = [];
}

export class CodexGitPushResult {
  pushed = false;

  branch = "";

  remote = "";

  /** 本次推送前是否有工作区改动被提交上去。 */
  committed = false;

  commitMessage = "";

  upToDate = false;

  /** 推送前并远端最新的方式："pulled" 快进、"rebased" 变基、"repaired" 由 AI 处理、空串没动过。 */
  synced = "";

  /** 直接推送失败后交给 AI 处理过一轮；处理说明放在 repairSummary 里。 */
  repaired = false;

  repairStatus = "";

  repairSummary = "";

  /** 根目录加各子项目的推送结果；根目录固定是第一条。 */
  results: CodexGitTargetOutcome[] = [];
}

export class CodexExecutionResult {
  accepted = false;

  programId = 0;

  itemKey = "";

  threadId = "";
}

export class CodexModelRecord {
  model = "";

  displayName = "";

  description = "";
}

export class CodexModelCatalog {
  defaultModel = "";

  models: CodexModelRecord[] = [];
}

export class CodexRequirementDocument {
  path = "";

  exists = false;

  content = "";

  size = 0;

  modifiedAt = "";
}

/** 文档栏目：需求大纲、任务文档、设计文档、测试用例都各自对应工作区里的一个目录。 */
export type DeliveryDocumentScope =
  | "requirement-outline"
  | "requirement-testing"
  | "requirement-review"
  | "task-document"
  | "task-design"
  | "task-testing";

/** 一个栏目目录里的一份文档。 */
export class DeliveryDocumentFile {
  /** 工作区相对路径，读写文档都以它为准。 */
  path = "";

  /** 相对栏目目录的展示名，下拉框和文件列表显示这个。 */
  name = "";

  size = 0;

  updatedAt = "";

  /** 文本类文档才能在面板里直接预览编辑；上传进来的 PDF、Word、图片走附件预览与下载。 */
  previewable = true;

  contentType = "";
}

/** 一个栏目下的全部文档，primaryPath 是面板默认选中的那份。 */
export class DeliveryDocumentSet {
  scope = "";

  key = "";

  directory = "";

  primaryPath = "";

  files: DeliveryDocumentFile[] = [];

  /** 本次上传落盘的文档路径，仅上传接口返回。 */
  uploaded: string[] = [];
}

/** HTML 预览用的同目录附属文件，name 是 HTML 里原样写的相对引用串。 */
export class DeliveryHtmlAsset {
  name = "";

  content = "";
}

/** 栏目里一份文档的正文。 */
export class DeliveryDocumentContent {
  path = "";

  exists = false;

  content = "";

  size = 0;

  modifiedAt = "";

  /** HTML 文档引用的同目录样式与脚本，预览时内联，编辑仍只改正文。 */
  assets: DeliveryHtmlAsset[] = [];
}

/** 需求拆解沉淀下来的需求大纲。正文从项目工作区经本地桥接受控读取。 */
export class CodexRequirementOutline {
  requirementKey = "";

  path = "";

  exists = false;

  markdown = "";

  updatedAt = "";

  active = false;
}

/** 一份按功能模块拆分的需求 HTML 原型文件。 */
export class CodexRequirementPrototypeFile {
  path = "";

  name = "";

  html = "";

  /** 原型页引用的同目录样式与脚本，预览时内联。 */
  assets: DeliveryHtmlAsset[] = [];
}

/** 需求级 HTML 原型目录。正文从项目工作区经本地桥接受控读取。 */
export class CodexRequirementPrototype {
  requirementKey = "";

  path = "";

  exists = false;

  files: CodexRequirementPrototypeFile[] = [];

  generatedAt?: string;

  active = false;
}

export class CodexRequirementPrototypeActionResult {
  accepted = false;

  programId = 0;

  requirementKey = "";

  threadId = "";

  turnId = "";

  active = false;
}

/** 与需求拆解、任务执行隔离的既有 HTML 原型编辑会话。 */
export class CodexRequirementPrototypeConversation {
  programId = 0;

  requirementKey = "";

  threadId = "";

  /** 当前选中的这条会话属于哪个 AI 工具：读写都跟着它走，面板据此对齐模型下拉。 */
  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  active = false;

  activeTurnId = "";
}

export class CodexRequirementPrototypeConversationActionResult {
  accepted = false;

  programId = 0;

  requirementKey = "";

  threadId = "";

  turnId = "";

  active = false;
}

export class CodexExecutionSequenceResult {
  accepted = false;

  sequenceId = "";

  programId = 0;

  itemKeys: string[] = [];

  model = "";
}

export class CodexExecutionBatchResult {
  accepted = false;

  batchId = "";

  programId = 0;

  itemKeys: string[] = [];

  model = "";
}

export class ExecutionProgressEvent {
  id = "";

  timestamp = "";

  kind = "status";

  title = "";

  body = "";

  status = "running";
}

export class CodexConversationItem {
  id = "";

  type = "";

  text = "";

  status = "";

  exitCode?: number;

  phase = "";

  /**
   * 工具调用的语义：read / search，Claude 用的是具名工具（Read、Grep），
   * 命令行里没有可解析的字面量，只能由桥接层标出来。Codex 的命令条目为空。
   */
  action = "";

  /** action 对应的对象：读的文件、检索的目录。 */
  target = "";

  attachments: CodexConversationAttachment[] = [];

  /** 文件变更条目的结构化清单，用来在回合末尾汇总「本次改动」。 */
  changes: CodexConversationChange[] = [];
}

export class CodexConversationChange {
  path = "";

  /** add / modify / delete / rename，桥接层已经把两个执行器的叫法归一。 */
  kind = "modify";

  /** 该文件这次改了多少行，桥接层从 unified diff 数出来；拿不到 diff 时是 0。 */
  added = 0;

  removed = 0;
}

export class CodexConversationAttachment {
  id = "";

  name = "";

  contentType = "application/octet-stream";

  size = 0;

  isImage = false;

  /** 工作区产物的相对路径，用来让最终回复里的 Markdown 链接命中同一份附件。 */
  relativePath = "";

  url = "";
}

/** 一轮（或一条会话、一条任务、一条需求）烧掉的 token。 */
export class CodexTokenUsage {
  /** 送进模型的全部输入，含命中缓存的部分。 */
  inputTokens = 0;

  /** 输入里命中提示缓存的部分，计价通常只有一折。 */
  cachedInputTokens = 0;

  outputTokens = 0;

  reasoningOutputTokens = 0;

  totalTokens = 0;

  /** 只有 Claude 会算钱，Codex 侧为 null。 */
  costUsd: number | null = null;
}

/** 同一份用量按执行器分开：两家的计价和额度是分开的，合成一个数就没法分账。 */
export class CodexProviderUsage {
  codex: CodexTokenUsage = new CodexTokenUsage();

  claude: CodexTokenUsage = new CodexTokenUsage();

  total: CodexTokenUsage = new CodexTokenUsage();
}

export class CodexConversationTurn {
  id = "";

  status = "";

  createdAt = "";

  completedAt = "";

  items: CodexConversationItem[] = [];

  /** 本轮消耗。执行器没报用量的老会话没有这个字段。 */
  usage?: CodexTokenUsage;
}

export class CodexConversationSummary {
  threadId = "";

  title = "";

  createdAt = "";

  updatedAt = "";

  status = "";

  /** 这条会话是哪个 AI 工具留下的：切换工具后旧会话仍然列出，读写都跟着它自己的执行器。 */
  executorType: AITool = "codex";

  active = false;

  phase: DeliveryPhase = "requirement";

  progress = 0;
}

export class CodexConversation {
  programId = 0;

  itemKey = "";

  threadId = "";

  /** 当前选中的这条会话属于哪个 AI 工具：读写都跟着它走，面板据此对齐模型下拉。 */
  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexConversationSummary[] = [];

  active = false;

  taskHasActiveConversation = false;

  activeTurnId = "";

  taskStatus = "todo";

  taskPhase: DeliveryPhase = "requirement";

  taskProgress = 0;

  sessionPhase: DeliveryPhase = "requirement";

  sessionProgress = 0;

  /** 本条会话所有回合的合计消耗。 */
  usage: CodexTokenUsage = new CodexTokenUsage();
}

export class CodexConversationActionResult {
  accepted = false;

  programId = 0;

  itemKey = "";

  threadId = "";

  turnId = "";

  active = false;

  /** 停止请求到得比回合结束还晚：不是失败，只是没什么可中断的了。 */
  alreadyFinished = false;
}

/** 需求聊天里可引用的当前需求文件栏目；原型文件由独立的原型接口提供。 */
export type DeliveryConversationFileScope =
  | "requirement-outline"
  | "requirement-testing"
  | "requirement-review"
  | "requirement-prototype";

/** 聊天输入中通过 @ 选中的交付对象；桥接层会按键或受控路径重新读取权威详情。 */
export interface DeliveryConversationReference {
  kind: "requirement" | "task" | "file";
  key: string;
  scope?: DeliveryConversationFileScope;
}

/** 项目级需求拆解会话，与单条任务会话分开保存。 */
export class CodexPlanningSessionSummary {
  threadId = "";

  title = "";

  createdAt = "";

  updatedAt = "";

  status = "";

  /** 这条会话是哪个 AI 工具留下的：切换工具后旧会话仍然列出，读写都跟着它自己的执行器。 */
  executorType: AITool = "codex";

  active = false;
}

export class CodexPlanningResult {
  items: DeliveryItemRecord[] = [];

  stages: DeliveryStageRecord[] = [];

  modules: DeliveryModuleRecord[] = [];

  itemKeys: string[] = [];

  stageKeys: string[] = [];

  moduleKeys: string[] = [];

  updatedAt = "";
}

export class CodexPlanningConversation {
  programId = 0;

  requirementKey = "";

  threadId = "";

  /** 当前选中的这条会话属于哪个 AI 工具：读写都跟着它走，面板据此对齐模型下拉。 */
  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexPlanningSessionSummary[] = [];

  active = false;

  activeTurnId = "";

  selectedStageKey = "";

  selectedModuleKey = "";

  selectedKind = "";

  result: CodexPlanningResult = new CodexPlanningResult();

  /** 本条会话所有回合的合计消耗。 */
  usage: CodexTokenUsage = new CodexTokenUsage();
}

export class CodexPlanningActionResult {
  accepted = false;

  programId = 0;

  threadId = "";

  turnId = "";

  active = false;
}

/** 需求总体测试会话，与任务执行和需求拆解会话各自隔离。 */
export class CodexRequirementTestingConversation {
  programId = 0;

  requirementKey = "";

  threadId = "";

  /** 当前选中的这条会话属于哪个 AI 工具：读写都跟着它走，面板据此对齐模型下拉。 */
  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexPlanningSessionSummary[] = [];

  active = false;

  activeTurnId = "";

  testingStatus: RequirementTestingStatus = "todo";

  testingReport = "";

  testingReportPath = "";

  testingCasesStatus: TestingCasesStatus = "todo";

  testingCases = "";

  testingCasesPath = "";
}

export class CodexRequirementTestingActionResult {
  accepted = false;

  programId = 0;

  requirementKey = "";

  threadId = "";

  turnId = "";

  active = false;
}

/** 需求级代码 review 会话；与测试会话共用会话表，只读代码给意见，不改实现。 */
export class CodexRequirementReviewConversation {
  programId = 0;

  requirementKey = "";

  threadId = "";

  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexPlanningSessionSummary[] = [];

  active = false;

  activeTurnId = "";

  /** review 报告只落在工作区文件里；没生成过就是空串。 */
  reviewReport = "";

  reviewReportPath = "";
}

export class CodexRequirementReviewActionResult {
  accepted = false;

  programId = 0;

  requirementKey = "";

  threadId = "";

  turnId = "";

  active = false;
}

/** 已交付需求的自由微调会话；和 review、测试会话完全隔离。 */
export class CodexRequirementFineTuningConversation {
  programId = 0;

  requirementKey = "";

  threadId = "";

  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexPlanningSessionSummary[] = [];

  active = false;

  activeTurnId = "";
}

/** 单个任务的自由微调会话；不领取任务、不改变任务阶段。 */
export class CodexTaskFineTuningConversation {
  programId = 0;

  itemKey = "";

  threadId = "";

  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexConversationSummary[] = [];

  active = false;

  activeTurnId = "";
}

/** 任务级预先测试用例会话；与任务执行会话隔离，永远不领取或推进任务。 */
export class CodexTaskTestingCasesConversation {
  programId = 0;

  itemKey = "";

  threadId = "";

  /** 当前选中的这条会话属于哪个 AI 工具：读写都跟着它走，面板据此对齐模型下拉。 */
  executorType: AITool = "codex";

  turns: CodexConversationTurn[] = [];

  conversations: CodexConversationSummary[] = [];

  active = false;

  activeTurnId = "";

  testingCasesStatus: TestingCasesStatus = "todo";

  testingCases = "";

  testingCasesPath = "";
}

export interface BoardQuery {
  programId: number;
  groupBy?: BoardGroupBy;
  stageKey?: string;
  moduleKey?: string;
  requirementKey?: string;
  status?: string;
	phase?: DeliveryPhase;
  kind?: string;
  ownerName?: string;
  keyword?: string;
}

export interface SaveProgramPayload {
	programId: number;
	programCode?: string;
	name: string;
	summary?: string;
	status?: string;
	actorName?: string;
}

export interface SaveProgramGitConfigPayload {
  programId: number;
  gitEnabled: boolean;
  gitRepositoryUrl?: string;
  gitRemoteName?: string;
  gitBaseBranch?: string;
  gitChatSyncEnabled: boolean;
}

export interface SaveProgramCloudSyncConfigPayload {
  programId: number;
  cloudSyncEnabled: boolean;
  cloudSyncScopes: CloudSyncScope[];
}

export interface MigrateProgramPayload extends SaveProgramPayload {
	targetBizLine: BusinessLineId;
}

export interface ModulePageQuery {
	programId: number;
	pageIndex?: number;
	pageSize?: number;
}

export interface SaveModulePayload {
	programId: number;
	moduleKey: string;
	seq: number;
	name: string;
	weight: number;
	kind: string;
}

export interface DeleteModulePayload {
	programId: number;
	moduleKey: string;
	targetModuleKey?: string;
}

export interface SaveStagePayload {
	programId: number;
	stageKey: string;
	seq: number;
	tag: string;
	timeWindow: string;
	maturityLevel: string;
	title: string;
}

export interface CreateItemPayload {
  programId: number;
  itemKey?: string;
  stageKey?: string;
  moduleKey?: string;
  requirementKey?: string;
  kind?: DeliveryKind;
  title: string;
  description?: string;
	benefitTags?: string[];
  phase?: DeliveryPhase;
  requirementDocumentPath?: string;
  actionOutput?: string;
  testingReport?: string;
  status?: DeliveryStatus;
  progress?: number;
  ownerId?: string;
  ownerName?: string;
  dueDate?: string;
  note?: string;
  dependsOnItemKeys?: string[];
	dependencySourceSides?: Record<string, "top" | "right" | "bottom" | "left" | "">;
  dependencyTargetSides?: Record<string, "top" | "right" | "bottom" | "left" | "">;
  actorName?: string;
}

/**
 * 局部更新：只带真正改了的字段 + version。
 *
 * 原型是整份 tasks.json 覆盖写，多人同开必然互相吃掉改动；这里改成按字段 patch，
 * 服务端 version 不匹配会直接报错，前端提示刷新而不是静默合并。
 */
export interface PatchItemPayload {
  programId: number;
  itemKey: string;
  version: number;
  stageKey?: string;
  moduleKey?: string;
  requirementKey?: string;
  kind?: DeliveryKind;
  title?: string;
  description?: string;
	benefitTags?: string[];
  requirementDocument?: string;
  requirementDocumentPath?: string;
  actionOutput?: string;
  testingReport?: string;
  phase?: DeliveryPhase;
  executionOutput?: string;
  status?: DeliveryStatus;
  progress?: number;
  ownerId?: string;
  ownerName?: string;
  dueDate?: string;
  note?: string;
  sortOrder?: number;
  dependsOnItemKeys?: string[];
	dependencySourceSides?: Record<string, "top" | "right" | "bottom" | "left" | "">;
  dependencyTargetSides?: Record<string, "top" | "right" | "bottom" | "left" | "">;
  comment?: string;
  actorName?: string;
}

export interface AdvanceDeliveryPhasePayload {
	programId: number;
	phase: Exclude<DeliveryPhase, "testing">;
	items: Array<{ itemKey: string; version: number }>;
	actorName?: string;
}

export async function fetchPrograms(bizLine: BusinessLineId) {
  return getDataList(DeliveryProgramRecord, "/delivery/programs", withBizLine(bizLine));
}

export async function saveProgram(bizLine: BusinessLineId, payload: SaveProgramPayload) {
	const response = await instance.post<ApiResponse<null>>("/delivery/program/save", payload, {
		params: withBizLine(bizLine),
	});
	return unwrapApiResponse(response.data);
}

export async function saveProgramGitConfig(payload: SaveProgramGitConfigPayload) {
  const response = await instance.post<ApiResponse<DeliveryProgramRecord>>("/delivery/program/git-config", payload);
  return plainToInstance(DeliveryProgramRecord, unwrapApiResponse(response.data));
}

export async function saveProgramCloudSyncConfig(payload: SaveProgramCloudSyncConfigPayload) {
  const response = await instance.post<ApiResponse<DeliveryProgramRecord>>("/delivery/program/cloud-sync-config", payload);
  return plainToInstance(DeliveryProgramRecord, unwrapApiResponse(response.data));
}

export async function migrateProgram(bizLine: BusinessLineId, payload: MigrateProgramPayload) {
	const response = await instance.post<ApiResponse<null>>("/delivery/program/migrate", payload, {
		params: withBizLine(bizLine),
	});
	return unwrapApiResponse(response.data);
}

export async function fetchProgramAssignment(programId: number) {
	return getData(ProgramAssignment, "/delivery/program/assignment", { programId });
}

/**
 * 负责人、协助人等人员指派只能选所属项目已分配的在职成员。
 * 不能再用全站成员接口作为候选，否则会把不在项目里的账号暴露在下拉框里。
 */
export async function fetchProgramMembers(programId: number) {
	return getDataList(MemberRecord, "/delivery/program/members", { programId });
}

export async function saveProgramAssignment(programId: number, assignment: ProgramAssignment) {
	const response = await instance.post<ApiResponse<null>>("/delivery/program/assignment", { programId, ...assignment });
	return unwrapApiResponse(response.data);
}

export async function fetchStages(programId: number) {
  return getDataList(DeliveryStageRecord, "/delivery/stages", { programId });
}

export async function saveStage(payload: SaveStagePayload) {
	const response = await instance.post<ApiResponse<null>>("/delivery/stage/save", payload);
	return unwrapApiResponse(response.data);
}

export async function deleteStage(programId: number, stageKey: string) {
	const response = await instance.post<ApiResponse<null>>("/delivery/stage/delete", { programId, stageKey });
	return unwrapApiResponse(response.data);
}

export interface RequirementPageQuery {
  programId: number;
  /** mine 包含创建人；assigned 只取主负责人或协助人，空值表示全部。 */
  scope?: "mine" | "assigned" | "";
  keyword?: string;
  status?: RequirementStatus | "";
  /** 传 none 只看未排期的需求；传计划键只看该计划下的需求；留空不限定。 */
  timePlanKey?: string;
  pageIndex?: number;
  pageSize?: number;
}

interface ItemPageQuery {
  programId: number;
  requirementKey?: string;
  /** 支持逗号分隔的多状态，例如消息中心要的 "blocked,dropped"。 */
  status?: string;
  keyword?: string;
  pageIndex?: number;
  pageSize?: number;
  /** recent 仅供 @ 候选按创建时间倒序加载，普通任务列表仍按看板手工顺序。 */
  sort?: "recent" | "";
}

export interface DeliveryConversationMentionCatalog {
  requirements: DeliveryRequirementRecord[];
  items: DeliveryItemRecord[];
}

export interface SaveRequirementPayload {
  programId: number;
  /** 为空表示新建；带 key 表示更新，更新必须带上读到的 version。 */
  requirementKey?: string;
  name: string;
  detail?: string;
  /** 详情里 @ 引用的历史需求键；不传表示本次请求不改动已保存的引用。 */
  referenceRequirementKeys?: string[];
  /** 详情里 @ 引用的既有任务键；不传表示本次请求不改动已保存的关联。 */
  referenceItemKeys?: string[];
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  status?: RequirementStatus;
  mode?: RequirementMode;
  startPhase?: DeliveryPhase;
  splitTasks?: boolean;
  preGenerateTaskDocuments?: boolean;
  generatePrototype?: boolean;
  gitEnabled?: boolean;
  gitBaseBranch?: string;
  gitBranch?: string;
  stageKey?: string;
  moduleKey?: string;
  kind?: DeliveryKind | "";
  owners?: RequirementMember[];
  assistants?: RequirementMember[];
  version?: number;
  actorName?: string;
}

export async function fetchRequirements(query: RequirementPageQuery) {
  const page = await getPage(DeliveryRequirementRecord, "/delivery/requirements", {
    pageIndex: 1,
    pageSize: 200,
    ...query,
  });
  // Go 把空切片编码成 null，选人控件不能拿 null 当数组用。
  page.data.forEach((requirement) => {
    requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
    requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
    requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
    requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  });
  return page;
}

export async function fetchRequirement(programId: number, requirementKey: string) {
  const requirement = await getData(DeliveryRequirementRecord, "/delivery/requirement", { programId, requirementKey });
  requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
  requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
  requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
  requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  return requirement;
}

export async function saveRequirement(payload: SaveRequirementPayload) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/save", payload);
  const requirement = plainToInstance(DeliveryRequirementRecord, unwrapApiResponse(response.data));
  requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
  requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  return requirement;
}

/**
 * 条件更新需求名称。replaceName 是允许被替换的旧名称，避免后台自动命名覆盖用户手工编辑。
 */
export async function updateRequirementName(
  programId: number,
  requirementKey: string,
  name: string,
  replaceName: string,
) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/name/update", {
    programId,
    requirementKey,
    name,
    replaceName,
  });
  const requirement = plainToInstance(DeliveryRequirementRecord, unwrapApiResponse(response.data));
  requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
  requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
  requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
  requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  return requirement;
}

export interface AssignRequirementMembersPayload {
  programId: number;
  requirementKey: string;
  owners: RequirementMember[];
  assistants: RequirementMember[];
  /** 指派同样受乐观锁保护，必须带上读到的 version。 */
  version: number;
}

/** 快速指派只改主负责人与协助人；不要用 saveRequirement 代替，那是整条覆盖。 */
export async function assignRequirementMembers(payload: AssignRequirementMembersPayload) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/members/assign", payload);
  const requirement = plainToInstance(DeliveryRequirementRecord, unwrapApiResponse(response.data));
  requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
  requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
  requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
  requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  return requirement;
}

/** 快速改状态只提交状态字段；同样受乐观锁保护。 */
export async function updateRequirementStatus(programId: number, requirementKey: string, status: RequirementStatus, version: number) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/status/update", {
    programId,
    requirementKey,
    status,
    version,
  });
  const requirement = plainToInstance(DeliveryRequirementRecord, unwrapApiResponse(response.data));
  requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
  requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
  requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
  requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  return requirement;
}

export async function bindRequirementGitBranch(programId: number, requirementKey: string, gitBaseBranch: string, gitBranch: string) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/git-branch/bind", {
    programId,
    requirementKey,
    gitBaseBranch,
    gitBranch,
  });
  return plainToInstance(DeliveryRequirementRecord, unwrapApiResponse(response.data));
}

export async function deleteRequirement(programId: number, requirementKey: string) {
  const response = await instance.post<ApiResponse<null>>("/delivery/requirement/delete", { programId, requirementKey });
  return unwrapApiResponse(response.data);
}

/** 选人控件的数据源：任何登录用户都能列出在职同事的标识和显示名。 */
export async function fetchMembers(keyword = "") {
  return getDataList(MemberRecord, "/auth/members", keyword ? { keyword } : undefined);
}

export async function fetchModules(programId: number) {
  return getDataList(DeliveryModuleRecord, "/delivery/modules", { programId });
}

export async function fetchModulesPage(query: ModulePageQuery) {
	return getPage(DeliveryModuleRecord, "/delivery/modules/page", { ...query });
}

export async function saveModule(payload: SaveModulePayload) {
	const response = await instance.post<ApiResponse<null>>("/delivery/module/save", payload);
	return unwrapApiResponse(response.data);
}

export async function deleteModule(payload: DeleteModulePayload) {
	const response = await instance.post<ApiResponse<null>>("/delivery/module/delete", payload);
	return unwrapApiResponse(response.data);
}

export async function fetchBoard(query: BoardQuery) {
  const board = await getData(DeliveryBoard, "/delivery/board", { ...query });

  // Go 会把 nil slice 编码为 null；空项目没有阶段或模块时，确保看板始终拿到数组。
  board.columns = Array.isArray(board.columns) ? board.columns : [];
  for (const column of board.columns) {
    column.items = Array.isArray(column.items) ? column.items : [];
    column.items.forEach(normalizeItemPhase);
  }
  const normalizeOverview = (overview?: DeliveryOverview) => {
    const value = overview ?? new DeliveryOverview();
    value.moduleProgress = Array.isArray(value.moduleProgress) ? value.moduleProgress : [];
    value.stageProgress = Array.isArray(value.stageProgress) ? value.stageProgress : [];
    return value;
  };
  board.overview = normalizeOverview(board.overview);
  if (board.requirementOverview) board.requirementOverview = normalizeOverview(board.requirementOverview);

  return board;
}

export async function fetchOverview(programId: number) {
  return getData(DeliveryOverview, "/delivery/overview", { programId });
}

async function fetchItemsPage(query: ItemPageQuery) {
  const page = await getPage(DeliveryItemRecord, "/delivery/items", {
    pageIndex: 1,
    pageSize: 200,
    ...query,
  });
  page.data.forEach(normalizeItemPhase);
  return page;
}

export async function fetchItems(programId: number, requirementKey = "") {
  return fetchItemsPage({ programId, requirementKey: requirementKey || undefined });
}

/** 消息中心的一行：一条需要关注的任务，连同它所属的项目和需求。 */
export interface DeliveryAttentionTask {
  programId: number;
  programName: string;
  requirementKey: string;
  requirementName: string;
  /** 需求负责人（含辅助人）姓名，消息中心直接展示，不用再点进需求才看得到。 */
  requirementOwners: string[];
  itemKey: string;
  title: string;
  status: DeliveryStatus;
  phase: DeliveryPhase;
  updatedAt?: string;
}

/** 一次批量或串行执行的服务端记录；完成后用于消息中心提醒。 */
export class DeliveryExecutionBatchRecord {
  batchId = "";

  programId = 0;

  requirementKey = "";

  requirementName = "";

  /** 运行发起时冻结的需求分支，便于回溯本次执行对应的 RB。 */
  requirementGitBranch = "";

  mode: DeliveryExecutionBatchMode = "parallel";

  executorType = "codex";

  status: DeliveryExecutionBatchStatus = "running";

  itemCount = 0;

  completedCount = 0;

  blockedCount = 0;

  summary = "";

  notificationReadAt?: string;

  startedAt?: string;

  finishedAt?: string;

  items: DeliveryExecutionBatchItemRecord[] = [];
}

export class DeliveryExecutionBatchItemRecord {
  itemKey = "";

  sequence = 0;

  status = "pending";

  message = "";

  updatedAt?: string;
}

/** 一次「拆解并写入任务」的批次。任务用 planningBatchKey 归到某一批。 */
export class DeliveryPlanningBatchRecord {
  batchKey = "";

  bizLine = "";

  programId = 0;

  requirementKey = "";

  /** 需求内的第几次拆解，从 1 开始。 */
  seq = 0;

  title = "";

  source = "planner";

  executorType = "";

  threadId = "";

  summary = "";

  /** 写入时登记的任务数；任务可能被删，实际归属以任务表为准。 */
  itemCount = 0;

  createdBy = "";

  createdByName = "";

  createdAt?: string;

  updatedAt?: string;
}

export class DeliveryRequirementProgressRecord {
  requirementKey = "";

  requirementName = "";

  totalCount = 0;

  countedCount = 0;

  progress = 0;

  statusCounts: Record<DeliveryStatus, number> = {
    todo: 0,
    doing: 0,
    done: 0,
    blocked: 0,
    dropped: 0,
  };

  /** 这条需求下全部任务的执行耗时之和（毫秒）与它们已结束的执行轮次总数。 */
  totalRunDurationMs = 0;

  runCount = 0;

  items: DeliveryItemRecord[] = [];

  batches: DeliveryExecutionBatchRecord[] = [];

  /** 这条需求拆过几批任务；进度窗按批次成行展示。 */
  planningBatches: DeliveryPlanningBatchRecord[] = [];
}

export interface DeliveryExecutionBatchNotification extends DeliveryExecutionBatchRecord {
  programName: string;
}

/** 需求被标记完成后，服务端按负责人/协助者逐人维护的一条提醒。 */
export class DeliveryRequirementCompletionNotificationRecord {
  programId = 0;

  requirementKey = "";

  requirementName = "";

  recipientId = "";

  recipientName = "";

  notificationReadAt?: string;

  completedAt?: string;
}

export interface DeliveryRequirementCompletionNotification extends DeliveryRequirementCompletionNotificationRecord {
  programName: string;
}

/**
 * 拉取当前业务线下所有项目里「受阻」和「不做」的任务。
 * 服务端的任务查询按项目授权，跨项目只能逐个项目取；项目数是个位数量级，并发发出即可。
 */
export async function fetchDeliveryAttentionTasks(bizLine: BusinessLineId): Promise<DeliveryAttentionTask[]> {
  const programs = await fetchPrograms(bizLine);
  const groups = await Promise.all(programs.map(async (program) => {
    try {
      const [items, requirements] = await Promise.all([
        fetchItemsPage({ programId: program.programId, status: "blocked,dropped" }),
        fetchRequirements({ programId: program.programId, scope: "" }),
      ]);
      const requirementByKey = new Map(requirements.data.map((requirement) => [requirement.requirementKey, requirement]));
      return items.data.map<DeliveryAttentionTask>((item) => ({
        programId: program.programId,
        programName: program.name || String(program.programId),
        requirementKey: item.requirementKey,
        requirementName: requirementByKey.get(item.requirementKey)?.name || item.requirementKey,
        requirementOwners: (requirementByKey.get(item.requirementKey)?.owners ?? [])
          .map((owner) => owner.name)
          .filter(Boolean),
        itemKey: item.itemKey,
        title: item.title,
        status: item.status,
        phase: item.phase,
        updatedAt: item.updatedAt,
      }));
    } catch {
      // 单个项目取不到（无权限或服务端异常）不该让整个消息中心变空。
      return [];
    }
  }));
  return groups.flat();
}

/**
 * 完成批次的提醒由服务端按启动者维护已读态；跨项目仍按项目权限逐个拉取。
 * 不与受阻/不做任务混在同一接口，二者的未读语义不同。
 */
export async function fetchDeliveryExecutionBatchNotifications(
  bizLine: BusinessLineId,
): Promise<DeliveryExecutionBatchNotification[]> {
  const programs = await fetchPrograms(bizLine);
  const groups = await Promise.all(programs.map(async (program) => {
    try {
      const batches = await getDataList(
        DeliveryExecutionBatchRecord,
        "/delivery/execution-batch/notifications",
        { programId: program.programId },
      );
      return batches.map<DeliveryExecutionBatchNotification>((batch) => ({
        ...batch,
        programName: program.name || String(program.programId),
      }));
    } catch {
      return [];
    }
  }));
  return groups.flat();
}

/** 用户进入对应需求时确认完成批次提醒；受阻/不做任务不会走这个已读机制。 */
export async function markDeliveryExecutionBatchNotificationRead(programId: number, batchId: string) {
  const response = await instance.post<ApiResponse<DeliveryExecutionBatchRecord>>(
    "/delivery/execution-batch/notification/read",
    { programId, batchId },
  );
  return plainToInstance(DeliveryExecutionBatchRecord, unwrapApiResponse(response.data));
}

/**
 * 需求完成消息只由服务端返回给当前登录用户（负责人或协助者）；每人的已读状态互不影响。
 */
export async function fetchDeliveryRequirementCompletionNotifications(
  bizLine: BusinessLineId,
): Promise<DeliveryRequirementCompletionNotification[]> {
  const programs = await fetchPrograms(bizLine);
  const groups = await Promise.all(programs.map(async (program) => {
    try {
      const notifications = await getDataList(
        DeliveryRequirementCompletionNotificationRecord,
        "/delivery/requirement/completion-notifications",
        { programId: program.programId },
      );
      return notifications.map<DeliveryRequirementCompletionNotification>((notification) => ({
        ...notification,
        programName: program.name || String(program.programId),
      }));
    } catch {
      return [];
    }
  }));
  return groups.flat();
}

/** 当前接收者打开需求时确认自己收到的完成提醒。 */
export async function markDeliveryRequirementCompletionNotificationRead(programId: number, requirementKey: string) {
  const response = await instance.post<ApiResponse<DeliveryRequirementCompletionNotificationRecord>>(
    "/delivery/requirement/completion-notification/read",
    { programId, requirementKey },
  );
  return plainToInstance(DeliveryRequirementCompletionNotificationRecord, unwrapApiResponse(response.data));
}

/**
 * 聊天 @ 的首屏目录固定各取最近 20 条；带关键词时用于本地候选无命中后的服务端补查。
 * 需求和任务各自分页，不能混成一页而让其中一种实体挤占候选名额。
 */
export async function fetchDeliveryConversationMentionCatalog(programId: number, keyword = ""): Promise<DeliveryConversationMentionCatalog> {
  const search = keyword.trim();
  const [requirements, items] = await Promise.all([
    fetchRequirements({
      programId,
      scope: "",
      keyword: search || undefined,
      pageIndex: 1,
      pageSize: 20,
    }),
    fetchItemsPage({
      programId,
      keyword: search || undefined,
      pageIndex: 1,
      pageSize: 20,
      sort: "recent",
    }),
  ]);
  return { requirements: requirements.data, items: items.data };
}

/** 大文本仅在用户打开详情时请求，避免任务看板重复拉取执行日志。 */
export async function fetchItemDetail(programId: number, itemKey: string) {
  return normalizeItemPhase(await getData(DeliveryItemRecord, "/delivery/item", { programId, itemKey }));
}

export async function fetchItemEvents(
  programId: number,
  itemKey: string,
  pageSize = 50,
) {
  return getPage(
    DeliveryEventRecord,
    "/delivery/item/events",
    { programId, itemKey, pageIndex: 1, pageSize },
  );
}

export async function fetchRequirementTimeline(
  programId: number,
  requirementKey: string,
  pageSize = 100,
) {
  return getPage(
    DeliveryRequirementTimelineEventRecord,
    "/delivery/requirement/timeline",
    { programId, requirementKey, pageIndex: 1, pageSize },
  );
}

export async function fetchRequirementProgress(programId: number, requirementKey: string) {
  const progress = await getData(
    DeliveryRequirementProgressRecord,
    "/delivery/requirement/progress",
    { programId, requirementKey },
  );
  progress.items = (progress.items ?? []).map((item) => normalizeItemPhase(Object.assign(new DeliveryItemRecord(), item)));
  progress.batches = (progress.batches ?? []).map((batch) => Object.assign(new DeliveryExecutionBatchRecord(), batch, {
    items: (batch.items ?? []).map((item) => Object.assign(new DeliveryExecutionBatchItemRecord(), item)),
  }));
  progress.planningBatches = (progress.planningBatches ?? []).map((batch) => Object.assign(new DeliveryPlanningBatchRecord(), batch));
  return progress;
}

export async function fetchSnapshots(programId: number, moduleKey = "") {
  return getDataList(
    DeliverySnapshotRecord,
    "/delivery/snapshots",
    { programId, moduleKey },
  );
}

export async function createItem(payload: CreateItemPayload) {
  const response = await instance.post<ApiResponse<DeliveryItemRecord>>("/delivery/item/create", payload);
  return unwrapApiResponse(response.data);
}

export async function patchItem(payload: PatchItemPayload) {
  const response = await instance.post<ApiResponse<DeliveryItemRecord>>("/delivery/item/patch", payload);
  return unwrapApiResponse(response.data);
}

export async function advanceDeliveryPhase(payload: AdvanceDeliveryPhasePayload) {
  const response = await instance.post<ApiResponse<DeliveryItemRecord[]>>("/delivery/item/phase/advance", payload);
  return unwrapApiResponse(response.data);
}

export async function deleteItem(programId: number, itemKey: string) {
  const response = await instance.post<ApiResponse<null>>("/delivery/item/delete", { programId, itemKey });
  return unwrapApiResponse(response.data);
}

export async function commentItem(
  programId: number,
  itemKey: string,
  comment: string,
  actorName?: string,
) {
  const response = await instance.post<ApiResponse<null>>("/delivery/item/comment", { programId, itemKey, comment, actorName });
  return unwrapApiResponse(response.data);
}

export async function rebuildSnapshot(programId: number, statDate?: string) {
  const response = await instance.post<ApiResponse<DeliverySnapshotRecord[]>>(
    "/delivery/snapshot/rebuild",
    { programId, statDate },
  );
  return unwrapApiResponse(response.data);
}

const CODEX_BRIDGE_URL = DELIVERY_TASK_PLANNER_BRIDGE_URL;

function requiredProjectWorkspace(programId: number) {
  const workspace = getProjectWorkspace(programId);
  if (!workspace) {
    throw new Error("未提供 Codex 工作目录，请先在项目管理中确认当前项目的工作目录");
  }
  return workspace;
}

function bridgeWorkspaceParams(programId: number, values: Record<string, unknown> = {}) {
  return { ...values, workspace: requiredProjectWorkspace(programId) };
}

export async function fetchCodexLocalProjects(programId: number) {
  const response = await instance.get<CodexLocalProjectCatalog>(`${CODEX_BRIDGE_URL}/v1/codex/workspaces`, {
    params: { programId },
    timeout: 10000,
  });
  const catalog = plainToInstance(CodexLocalProjectCatalog, response.data);
  catalog.projects = plainToInstance(CodexLocalProjectRecord, response.data.projects ?? []);
  return catalog;
}

export async function validateCodexWorkspace(programId: number, workspace: string) {
  const response = await instance.get<CodexWorkspaceValidation>(`${CODEX_BRIDGE_URL}/v1/codex/workspace/validate`, {
    params: { programId, workspace },
    timeout: 10000,
  });
  return plainToInstance(CodexWorkspaceValidation, response.data);
}

/**
 * workspace 传值时使用该目录读取分支，用于工作目录尚未保存到浏览器的场景。
 * 桥接层会先同步远端引用，别人刚推的分支才能选到，超时按一次 fetch 的量级给。
 */
export async function fetchCodexGitBranches(programId: number, workspace = "") {
  const params = workspace.trim()
    ? { programId, workspace: workspace.trim() }
    : bridgeWorkspaceParams(programId, { programId });
  const response = await instance.get<CodexGitBranchCatalog>(`${CODEX_BRIDGE_URL}/v1/codex/git/branches`, {
    params,
    timeout: 200000,
  });
  const catalog = plainToInstance(CodexGitBranchCatalog, response.data);
  catalog.branches = (response.data.branches ?? []).map((branch) => String(branch || "")).filter(Boolean);
  return catalog;
}

/**
 * 工作目录本身加它下面一级的独立 Git 子项目。
 * 传 branch 时顺带判断每个工程里有没有这条需求分支，用于建分支勾选和面板标注。
 */
export async function fetchCodexGitProjects(programId: number, branch = "") {
  const response = await instance.get<CodexGitProjectCatalog>(`${CODEX_BRIDGE_URL}/v1/codex/git/projects`, {
    params: bridgeWorkspaceParams(programId, { programId, ...(branch ? { branch } : {}) }),
    timeout: 30000,
  });
  const catalog = plainToInstance(CodexGitProjectCatalog, response.data);
  catalog.projects = plainToInstance(CodexGitProjectStatus, response.data.projects ?? []);
  return catalog;
}

export async function fetchCodexGitWorkspaceStatus(programId: number) {
  const response = await instance.get<CodexGitWorkspaceStatus>(`${CODEX_BRIDGE_URL}/v1/codex/git/status`, {
    params: bridgeWorkspaceParams(programId, { programId }),
    timeout: 15000,
  });
  return plainToInstance(CodexGitWorkspaceStatus, response.data);
}

/**
 * 「变更」面板展开时读文件清单；只读本机工作区，不碰远端。
 * workspace 传子项目目录时读的是那个子项目的改动，不传就是项目根工作目录。
 */
export async function fetchCodexGitChanges(programId: number, workspace = "") {
  const response = await instance.get<CodexGitChangeList>(`${CODEX_BRIDGE_URL}/v1/codex/git/changes`, {
    params: workspace.trim()
      ? { programId, workspace: workspace.trim() }
      : bridgeWorkspaceParams(programId, { programId }),
    timeout: 30000,
  });
  return plainToInstance(CodexGitChangeList, response.data);
}

export async function fetchCodexGitChangeDetail(programId: number, path: string, workspace = "") {
  const response = await instance.get<CodexGitChangeDetail>(`${CODEX_BRIDGE_URL}/v1/codex/git/change`, {
    params: workspace.trim()
      ? { programId, workspace: workspace.trim(), path }
      : bridgeWorkspaceParams(programId, { programId, path }),
    timeout: 30000,
  });
  return plainToInstance(CodexGitChangeDetail, response.data);
}

export async function prepareCodexGitBranch(
  programId: number,
  branch: string,
  // 暂存后切换已经下线：脏工作区只能先提交再切，避免 stash 不自动恢复留下的隐性丢改动。
  strategy: "switch" | "commit" = "switch",
  commitMessage = "",
  options: {
    // 不传就交给桥接自己挑：所有已经有这条分支的子项目都会跟着切。
    targets?: string[];
    // 传子项目目录时这一轮只切那个工程，根工作目录不动。
    workspace?: string;
  } = {},
) {
  const response = await instance.post<CodexGitPrepareResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/git/prepare`,
    {
      ...(options.workspace?.trim()
        ? { workspace: options.workspace.trim() }
        : bridgeWorkspaceParams(programId)),
      programId,
      branch,
      strategy,
      commitMessage,
      ...(options.targets ? { targets: options.targets } : {}),
    },
    { timeout: 600000 },
  );
  const result = plainToInstance(CodexGitPrepareResult, response.data);
  result.status = plainToInstance(CodexGitWorkspaceStatus, response.data.status ?? response.data);
  result.results = plainToInstance(CodexGitTargetOutcome, response.data.results ?? []);
  return result;
}

/** workspace 由调用方传入：这一步的目录还没保存进偏好设置，也可能还不是 Git 仓库。 */
export async function checkCodexGitWorkspace(programId: number, workspace: string) {
  const response = await instance.get<CodexGitWorkspaceCheck>(`${CODEX_BRIDGE_URL}/v1/codex/git/workspace-check`, {
    params: { programId, workspace: workspace.trim() },
    timeout: 30000,
  });
  const check = plainToInstance(CodexGitWorkspaceCheck, response.data);
  check.pendingSubmodules = (response.data.pendingSubmodules ?? []).map((path) => String(path || "")).filter(Boolean);
  return check;
}

/**
 * 项目开了 Git，但本机这份工作目录还用不了：目录不是仓库、仓库没关联远端都算。
 * 工作目录压根没设的情况由「请先设置工作目录」单独提示，这里不重复报。
 * 只有桥接连不上这种「判定不了」的情况回 false，避免给出一个误导性的初始化提示。
 */
export async function isCodexGitWorkspaceUninitialized(programId: number) {
  const workspace = getProjectWorkspace(programId);
  if (!workspace) return false;
  try {
    const check = await checkCodexGitWorkspace(programId, workspace);
    return !check.isGitRepository || !check.remoteConfigured;
  } catch {
    return false;
  }
}

/** 首次关联要把整个仓库拉下来，超时按克隆的量级给，不按普通接口给。 */
export async function initializeCodexGitWorkspace(payload: {
  programId: number;
  workspace: string;
  repositoryUrl: string;
  remoteName?: string;
  baseBranch?: string;
}) {
  const response = await instance.post<CodexGitInitResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/git/init`,
    {
      programId: payload.programId,
      workspace: payload.workspace.trim(),
      repositoryUrl: payload.repositoryUrl.trim(),
      remoteName: payload.remoteName?.trim() || "origin",
      baseBranch: payload.baseBranch?.trim() || "",
    },
    { timeout: 20 * 60 * 1000 },
  );
  const result = plainToInstance(CodexGitInitResult, response.data);
  result.status = plainToInstance(CodexGitWorkspaceStatus, response.data.status ?? {});
  result.submodules = (response.data.submodules ?? []).map((path) => String(path || "")).filter(Boolean);
  return result;
}

/** 目录早就是仓库、只是子模块还没拉下来时补这一步；克隆量级的超时，不按普通接口给。 */
export async function initializeCodexGitSubmodules(programId: number, workspace: string) {
  const response = await instance.post<CodexGitSubmoduleResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/git/submodules`,
    { programId, workspace: workspace.trim() },
    { timeout: 30 * 60 * 1000 },
  );
  const result = plainToInstance(CodexGitSubmoduleResult, response.data);
  result.submodules = (response.data.submodules ?? []).map((path) => String(path || "")).filter(Boolean);
  return result;
}

/** 按项目管理员已保存的云端同步范围，立即把当前工作目录的选中内容上传到服务端。 */
export async function syncCodexCloudWorkspace(programId: number) {
  const response = await instance.post<CodexCloudSyncResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/cloud-sync`,
    bridgeWorkspaceParams(programId, { programId }),
    { timeout: 5 * 60 * 1000 },
  );
  const result = plainToInstance(CodexCloudSyncResult, response.data);
  result.scopes = (response.data.scopes ?? []).filter((scope): scope is CloudSyncScope =>
    CLOUD_SYNC_SCOPES.includes(scope as CloudSyncScope),
  );
  result.files = (response.data.files ?? []).map((path) => String(path || "")).filter(Boolean);
  return result;
}

/** 建分支要先把基准分支拉到最新，超时按一次 fetch 的量级给，不按普通接口给。 */
export async function createCodexGitBranch(
  programId: number,
  baseBranch: string,
  branch: string,
  // 勾选的子项目会用同一个分支名各建一条；子项目没有同名基准分支时退回它自己的默认分支。
  targets: string[] = [],
  // 给已有需求补建子项目分支时置真：根工作目录早就在这条分支上，这一轮不切它也不拉它。
  skipRoot = false,
) {
  const response = await instance.post<CodexGitBranchResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/git/branch`,
    bridgeWorkspaceParams(programId, { programId, baseBranch, branch, targets, ...(skipRoot ? { skipRoot: true } : {}) }),
    { timeout: 600000 },
  );
  const result = plainToInstance(CodexGitBranchResult, response.data);
  result.results = plainToInstance(CodexGitTargetOutcome, response.data.results ?? []);
  return result;
}

/** 推送可能要等 AI 处理冲突，超时按一轮会话的量级给，不按普通接口给。 */
export async function pushCodexGitBranch(
  programId: number,
  branch: string,
  message: string,
  options: {
    provider?: AITool;
    model?: string;
    reasoningEffort?: AIReasoningEffort;
    fastMode?: boolean;
    commitOnly?: boolean;
    // 不传就交给桥接自己挑：所有已经有这条分支的子项目都会一起提交推送。
    targets?: string[];
    // 传子项目目录时这一轮只推那个工程，根工作目录不动。
    workspace?: string;
  } = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexGitPushResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/git/push`,
    {
      ...(options.workspace?.trim()
        ? { workspace: options.workspace.trim() }
        : bridgeWorkspaceParams(programId)),
      programId,
      branch,
      message,
      provider,
      // 仅提交只在本机落一个提交点，桥接层不会再起 AI 去修推送。
      ...(options.commitOnly ? { commitOnly: true } : {}),
      ...(options.targets ? { targets: options.targets } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    },
    { timeout: 20 * 60 * 1000 },
  );
  const result = plainToInstance(CodexGitPushResult, response.data);
  result.results = plainToInstance(CodexGitTargetOutcome, response.data.results ?? []);
  return result;
}

export function codexConversationAttachmentUrl(path: string) {
  return path ? `${CODEX_BRIDGE_URL}${path}` : "";
}

export async function fetchCodexConversationAttachment(programId: number, path: string) {
  const response = await instance.get<Blob>(codexConversationAttachmentUrl(path), {
    params: bridgeWorkspaceParams(programId, { programId }),
    responseType: "blob",
    timeout: 30000,
  });
  return response.data;
}

/** 工作区文件在本机的位置：绝对路径按工作区根目录拼，桥接跑在同一台机器上。 */
export function workspaceFileAbsolutePath(programId: number, relativePath: string) {
  const workspace = getProjectWorkspace(programId).trim();
  const relative = String(relativePath || "").trim();
  if (!workspace || !relative) return relative;
  // Windows 工作区用反斜杠，路径拼接跟着工作区的写法走，复制出去才能直接用。
  const separator = workspace.includes("\\") && !workspace.includes("/") ? "\\" : "/";
  const normalized = separator === "\\" ? relative.replace(/\//g, "\\") : relative;
  return `${workspace.replace(/[\\/]+$/, "")}${separator}${normalized}`;
}

/** 在本机文件管理器里打开该文件所在目录并选中它。桥接只唤起文件管理器，不读文件内容。 */
export async function revealCodexWorkspaceFile(programId: number, path: string) {
  const response = await instance.post<{ path: string; directory: string; relativePath: string }>(
    `${CODEX_BRIDGE_URL}/v1/codex/workspace-file/reveal`,
    bridgeWorkspaceParams(programId, { programId, path }),
    { timeout: 15000 },
  );
  return response.data;
}

export async function fetchCodexBridgeHealth(programId: number, provider: AITool = "codex") {
  const response = await instance.get<CodexBridgeHealth>(`${CODEX_BRIDGE_URL}/v1/ai/health`, {
    params: bridgeWorkspaceParams(programId, { programId, provider }),
    timeout: 10000,
  });
  return response.data;
}

/**
 * This check deliberately does not require a project workspace. It answers the
 * only question needed when entering the board: is the local plugin bridge up?
 */
export async function fetchDeliveryTaskPlannerHealth() {
  const response = await instance.get<CodexBridgeHealth>(`${CODEX_BRIDGE_URL}/healthz`, {
    timeout: 3000,
  });
  return plainToInstance(CodexBridgeHealth, response.data);
}

export async function fetchDeliveryTaskPlannerRuntimeInfo() {
  const response = await instance.get<DeliveryTaskPlannerRuntimeInfo>(`${CODEX_BRIDGE_URL}/v1/plugin/info`, {
    timeout: 3000,
  });
  return plainToInstance(DeliveryTaskPlannerRuntimeInfo, response.data);
}

export async function fetchDeliveryTaskPlannerUpdate(force = false) {
  const response = await instance.get<DeliveryTaskPlannerUpdateStatus>(`${CODEX_BRIDGE_URL}/v1/plugin/update`, {
    params: force ? { force: true } : undefined,
    timeout: 8000,
  });
  return plainToInstance(DeliveryTaskPlannerUpdateStatus, response.data);
}

export async function installDeliveryTaskPlannerUpdate(expectedVersion: string) {
  const response = await instance.post<DeliveryTaskPlannerUpdateInstallation>(
    `${CODEX_BRIDGE_URL}/v1/plugin/update/install`,
    { expectedVersion },
    { timeout: 10000 },
  );
  return plainToInstance(DeliveryTaskPlannerUpdateInstallation, response.data);
}

export async function restartDeliveryTaskPlannerUpdate(jobId: string) {
  const response = await instance.post<DeliveryTaskPlannerUpdateInstallation>(
    `${CODEX_BRIDGE_URL}/v1/plugin/update/restart`,
    { jobId },
    { timeout: 10000 },
  );
  return plainToInstance(DeliveryTaskPlannerUpdateInstallation, response.data);
}

export async function fetchCodexModels(programId: number, provider: AITool = "codex") {
  const response = await instance.get<CodexModelCatalog>(`${CODEX_BRIDGE_URL}/v1/ai/models`, {
    params: bridgeWorkspaceParams(programId, { programId, provider }),
    timeout: 10000,
  });
  const catalog = plainToInstance(CodexModelCatalog, response.data);
  catalog.models = plainToInstance(CodexModelRecord, response.data.models ?? []);
  return catalog;
}

export async function fetchCodexRequirementDocument(programId: number, itemKey: string) {
  const response = await instance.get<CodexRequirementDocument>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-document`,
    { params: bridgeWorkspaceParams(programId, { programId, itemKey }), timeout: 20000 },
  );
  return plainToInstance(CodexRequirementDocument, response.data);
}

export async function saveCodexRequirementDocument(programId: number, itemKey: string, content: string) {
  const response = await instance.post<CodexRequirementDocument>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-document`,
    bridgeWorkspaceParams(programId, { programId, itemKey, content }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexRequirementDocument, response.data);
}

export async function fetchDeliveryDocumentSet(programId: number, scope: DeliveryDocumentScope, key: string) {
  const response = await instance.get<DeliveryDocumentSet>(
    `${CODEX_BRIDGE_URL}/v1/codex/document-set`,
    { params: bridgeWorkspaceParams(programId, { programId, scope, key }), timeout: 20000 },
  );
  const documentSet = plainToInstance(DeliveryDocumentSet, response.data);
  documentSet.files = plainToInstance(DeliveryDocumentFile, response.data.files ?? []);
  return documentSet;
}

export async function fetchDeliveryDocumentFile(
  programId: number,
  scope: DeliveryDocumentScope,
  key: string,
  path: string,
) {
  const response = await instance.get<DeliveryDocumentContent>(
    `${CODEX_BRIDGE_URL}/v1/codex/document-file`,
    { params: bridgeWorkspaceParams(programId, { programId, scope, key, path }), timeout: 20000 },
  );
  return plainToInstance(DeliveryDocumentContent, response.data);
}

export async function saveDeliveryDocumentFile(
  programId: number,
  scope: DeliveryDocumentScope,
  key: string,
  path: string,
  content: string,
) {
  const response = await instance.post<DeliveryDocumentContent>(
    `${CODEX_BRIDGE_URL}/v1/codex/document-file`,
    bridgeWorkspaceParams(programId, { programId, scope, key, path, content }),
    { timeout: 20000 },
  );
  return plainToInstance(DeliveryDocumentContent, response.data);
}

/** 一次最多往栏目目录里放几份文档，与本地桥接的上限保持一致。 */
export const MAX_DOCUMENT_UPLOADS = 10;

export const MAX_DOCUMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * 往栏目目录里直接放文档：本地选的文件原样上传，粘贴的正文由调用方先包成一个文本文件。
 * 重名不会覆盖已有文档，桥接层会顺延成「名字-2.后缀」，最终落盘路径以 uploaded 为准。
 */
export async function uploadDeliveryDocuments(
  programId: number,
  scope: DeliveryDocumentScope,
  key: string,
  files: File[],
) {
  const form = new FormData();
  form.append("programId", String(programId));
  form.append("scope", scope);
  form.append("key", key);
  form.append("workspace", requiredProjectWorkspace(programId));
  files.forEach((file) => form.append("files", file, file.name));
  const response = await instance.post<DeliveryDocumentSet>(
    `${CODEX_BRIDGE_URL}/v1/codex/document-upload`,
    form,
    { timeout: 120000 },
  );
  const documentSet = plainToInstance(DeliveryDocumentSet, response.data);
  documentSet.files = plainToInstance(DeliveryDocumentFile, response.data.files ?? []);
  return documentSet;
}

/** 把栏目里一份不能当文本读的文档登记成产物，交给附件预览弹窗打开或下载。 */
export async function fetchDeliveryDocumentAttachment(
  programId: number,
  scope: DeliveryDocumentScope,
  key: string,
  path: string,
) {
  const response = await instance.post<CodexConversationAttachment>(
    `${CODEX_BRIDGE_URL}/v1/codex/document-attachment`,
    bridgeWorkspaceParams(programId, { programId, scope, key, path }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexConversationAttachment, response.data);
}

export async function fetchCodexRequirementOutline(programId: number, requirementKey: string) {
  const response = await instance.get<CodexRequirementOutline>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-outline`,
    { params: bridgeWorkspaceParams(programId, { programId, requirementKey }), timeout: 20000 },
  );
  return plainToInstance(CodexRequirementOutline, response.data);
}

export async function saveCodexRequirementOutline(programId: number, requirementKey: string, markdown: string) {
  const response = await instance.post<CodexRequirementOutline>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-outline`,
    bridgeWorkspaceParams(programId, { programId, requirementKey, markdown }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexRequirementOutline, response.data);
}

export async function fetchCodexRequirementPrototype(programId: number, requirementKey: string) {
  const response = await instance.get<CodexRequirementPrototype>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-prototype`,
    { params: bridgeWorkspaceParams(programId, { programId, requirementKey }), timeout: 20000 },
  );
  const prototype = plainToInstance(CodexRequirementPrototype, response.data);
  prototype.files = plainToInstance(CodexRequirementPrototypeFile, response.data.files ?? []);
  return prototype;
}

export interface GenerateCodexRequirementPrototypeOptions {
  provider?: AITool;
  model?: string;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
}

export async function generateCodexRequirementPrototype(
  programId: number,
  requirementKey: string,
  options: GenerateCodexRequirementPrototypeOptions = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexRequirementPrototypeActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-prototype/generate`,
    bridgeWorkspaceParams(programId, {
      programId,
      requirementKey,
      provider,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexRequirementPrototypeActionResult, response.data);
}

export interface SendCodexRequirementPrototypeMessageOptions {
  threadId?: string;
  model?: string;
  provider?: AITool;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
}

function hydrateCodexRequirementPrototypeConversation(data: CodexRequirementPrototypeConversation) {
  const conversation = plainToInstance(CodexRequirementPrototypeConversation, data);
  conversation.turns = plainToInstance(CodexConversationTurn, data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  return conversation;
}

export async function fetchCodexRequirementPrototypeConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexRequirementPrototypeConversation>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-prototype/conversation`,
    {
      params: bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
      timeout: 20000,
    },
  );
  return hydrateCodexRequirementPrototypeConversation(response.data);
}

export async function sendCodexRequirementPrototypeMessage(
  programId: number,
  requirementKey: string,
  message: string,
  options: SendCodexRequirementPrototypeMessageOptions = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexRequirementPrototypeConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-prototype/conversation`,
    bridgeWorkspaceParams(programId, {
      programId,
      requirementKey,
      message,
      provider,
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexRequirementPrototypeConversationActionResult, response.data);
}

export async function startCodexExecution(
  programId: number,
  task: DeliveryItemRecord,
  model = "",
  provider: AITool = "codex",
  reasoningEffort?: AIReasoningEffort,
  fastMode = false,
  /** 再做一次：已完成的任务也能重新起一轮执行实例，任务状态不回滚。 */
  redo = false,
) {
  const response = await instance.post<CodexExecutionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/execute`,
    bridgeWorkspaceParams(programId, {
      programId,
      task,
      provider,
      ...(redo ? { redo: true } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(provider === "claude" && fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return response.data;
}

function hydrateCodexTaskTestingCasesConversation(data: CodexTaskTestingCasesConversation) {
  const conversation = plainToInstance(CodexTaskTestingCasesConversation, data);
  conversation.turns = plainToInstance(CodexConversationTurn, data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  conversation.conversations = plainToInstance(CodexConversationSummary, data.conversations ?? []);
  return conversation;
}

export async function fetchCodexTaskTestingCasesConversation(
  programId: number,
  itemKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexTaskTestingCasesConversation>(`${CODEX_BRIDGE_URL}/v1/codex/task-testing-cases`, {
    params: bridgeWorkspaceParams(programId, { programId, itemKey, provider, ...(threadId ? { threadId } : {}) }),
    timeout: 20000,
  });
  return hydrateCodexTaskTestingCasesConversation(response.data);
}

export interface SendCodexTaskTestingCasesMessageOptions {
  threadId?: string;
  newConversation?: boolean;
  model?: string;
  provider?: AITool;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
}

/** 只设计、补充或归档任务测试用例，不领取任务、不改变其当前阶段和状态。 */
export async function sendCodexTaskTestingCasesMessage(
  programId: number,
  itemKey: string,
  message: string,
  options: SendCodexTaskTestingCasesMessageOptions = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/task-testing-cases`,
    bridgeWorkspaceParams(programId, {
      programId,
      itemKey,
      provider,
      message: message.trim(),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.newConversation ? { newConversation: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexConversationActionResult, response.data);
}

export async function stopCodexTaskTestingCasesConversation(
  programId: number,
  itemKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.post<CodexConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/task-testing-cases/stop`,
    bridgeWorkspaceParams(programId, { programId, itemKey, provider, ...(threadId ? { threadId } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexConversationActionResult, response.data);
}

/** 表单提交永远创建一条新的、可持续追问的任务测试用例聊天。 */
export async function startCodexTaskTestingCases(
  programId: number,
  itemKey: string,
  options: Omit<SendCodexTaskTestingCasesMessageOptions, "newConversation"> & { message?: string } = {},
) {
  return sendCodexTaskTestingCasesMessage(programId, itemKey, options.message ?? "", {
    ...options,
    newConversation: true,
  });
}

export async function startCodexExecutionSequence(
  programId: number,
  options: {
    itemKeys?: string[];
    startItemKey?: string;
    model?: string;
    provider?: AITool;
    executionConstraints?: string;
    reasoningEffort?: AIReasoningEffort;
    fastMode?: boolean;
  },
) {
  const {
    executionConstraints: rawExecutionConstraints,
    reasoningEffort,
    ...executionOptions
  } = options;
  const executionConstraints = rawExecutionConstraints?.trim();
  const response = await instance.post<CodexExecutionSequenceResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/execute-sequence`,
    bridgeWorkspaceParams(programId, {
      programId,
      ...executionOptions,
      ...(executionConstraints ? { executionConstraints } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexExecutionSequenceResult, response.data);
}

export async function startCodexExecutionBatch(
  programId: number,
  itemKeys: string[],
  model = "",
  provider: AITool = "codex",
  executionConstraints = "",
  reasoningEffort?: AIReasoningEffort,
  fastMode = false,
  /** 再做一次：允许把已完成任务重新拉起，任务状态不回滚，只是再开一轮执行实例。 */
  redo = false,
) {
  const response = await instance.post<CodexExecutionBatchResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/execute-batch`,
    bridgeWorkspaceParams(programId, {
      programId,
      itemKeys,
      provider,
      ...(redo ? { redo: true } : {}),
      ...(model ? { model } : {}),
      ...(executionConstraints.trim() ? { executionConstraints: executionConstraints.trim() } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(provider === "claude" && fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexExecutionBatchResult, response.data);
}

export async function fetchCodexConversation(programId: number, itemKey: string, threadId = "", provider: AITool = "codex") {
  const response = await instance.get<CodexConversation>(`${CODEX_BRIDGE_URL}/v1/codex/conversation`, {
    params: bridgeWorkspaceParams(programId, { programId, itemKey, provider, ...(threadId ? { threadId } : {}) }),
    timeout: 20000,
  });
  const conversation = plainToInstance(CodexConversation, response.data);
  conversation.turns = plainToInstance(CodexConversationTurn, response.data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  conversation.conversations = plainToInstance(CodexConversationSummary, response.data.conversations ?? []);
  return conversation;
}

export interface SendCodexConversationMessageOptions {
  threadId?: string;
  newConversation?: boolean;
  attachmentIds?: string[];
  references?: DeliveryConversationReference[];
  model?: string;
  provider?: AITool;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
}

export async function uploadCodexConversationAttachments(programId: number, itemKey: string, files: File[]) {
  const form = new FormData();
  form.append("programId", String(programId));
  form.append("itemKey", itemKey);
  form.append("workspace", requiredProjectWorkspace(programId));
  files.forEach((file) => form.append("files", file, file.name));
  const response = await instance.post<{ attachments: CodexConversationAttachment[] }>(
    `${CODEX_BRIDGE_URL}/v1/codex/attachments`,
    form,
    { timeout: 60000 },
  );
  return plainToInstance(CodexConversationAttachment, response.data.attachments ?? []);
}

export async function sendCodexConversationMessage(
  programId: number,
  itemKey: string,
  message: string,
  options: SendCodexConversationMessageOptions = {},
) {
  const response = await instance.post<CodexConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/conversation`,
    bridgeWorkspaceParams(programId, { programId, itemKey, message, ...options }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexConversationActionResult, response.data);
}

export async function stopCodexConversation(programId: number, itemKey: string, threadId = "", provider: AITool = "codex") {
  const response = await instance.post<CodexConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/stop`,
    bridgeWorkspaceParams(programId, { programId, itemKey, provider, ...(threadId ? { threadId } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexConversationActionResult, response.data);
}

export class CodexStopAllResult {
  accepted = false;

  programId = 0;

  /** 真正被中断的任务；排队中的任务只是被取消，不会出现在这里。 */
  itemKeys: string[] = [];

  /** 点下去时回合已经跑完的任务。 */
  finishedItemKeys: string[] = [];

  /** 被取消的批量 / 串行队列。 */
  queueIds: string[] = [];

  /** 被服务端强制收尾的执行批次；本地已经没有队列时，这里才是真正解锁任务的动作。 */
  cancelledBatchIds: string[] = [];
}

/** 停掉一个项目下所有任务执行：在跑的中断，排队的取消。 */
export async function stopAllCodexExecutions(programId: number, provider: AITool = "codex") {
  const response = await instance.post<CodexStopAllResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/stop-all`,
    bridgeWorkspaceParams(programId, { programId, provider }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexStopAllResult, response.data);
}

export interface SendCodexPlanningMessageOptions {
  threadId?: string;
  newConversation?: boolean;
  stageKey?: string;
  moduleKey?: string;
  kind?: DeliveryKind;
  model?: string;
  provider?: AITool;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
  /** 拆解会话按需求分组：新会话会把该需求已建的任务列表一并交给执行器。 */
  requirementKey?: string;
  requirementName?: string;
  requirementDetail?: string;
  requirementOwners?: string;
  requirementAssistants?: string;
  /** 拆出的任务落在哪个阶段；简易模式下是 development。 */
  requirementStartPhase?: DeliveryPhase;
  /** 关掉时这一轮只允许拆出一条覆盖整条需求的任务。 */
  requirementSplitTasks?: boolean;
  /** 打开时确认拆解会预生成每条任务的需求文档初稿。 */
  requirementPreGenerateTaskDocuments?: boolean;
  /** 专业模式下确认拆解写入后，可由面板再次确认生成需求 HTML 原型。 */
  requirementGeneratePrototype?: boolean;
  /**
   * 需求详情里 @ 引用的历史需求。只传键和名字：插件拿到的是这些需求的大纲产物地址，
   * 由它按需读取正文，面板不把大纲内容塞进提示词。
   */
  requirementReferences?: Array<{ requirementKey: string; name: string }>;
  /** 需求详情里 @ 引用的既有任务；插件按任务键读取对应需求文档。 */
  requirementItemReferences?: Array<{ itemKey: string; title: string }>;
  /** 本轮聊天中 @ 选中的需求或任务；与需求详情的持久化引用分开处理。 */
  chatReferences?: DeliveryConversationReference[];
  /** 已上传附件的标识，与任务会话用的是同一套附件仓库。 */
  attachmentIds?: string[];
  /**
   * 只有用户点「确认并写入」的那一轮才为 true：其余轮次桥接层会把规划插件降级成只读，
   * 拆解结果先以预览形式回到聊天里，确认之后才落库。
   */
  confirmWrite?: boolean;
}

/**
 * 拆解会话的附件挂在需求的伪任务键下（与桥接层 `__project_planning__:<需求键>` 对应），
 * 这样一条需求的图片和文件不会串到别的需求里。
 */
export function planningAttachmentItemKey(requirementKey: string) {
  return requirementKey ? `__project_planning__:${requirementKey}` : "__project_planning__";
}

export function requirementTestingAttachmentItemKey(requirementKey: string) {
  return `__requirement_testing__:${requirementKey}`;
}

export async function uploadCodexRequirementTestingAttachments(programId: number, requirementKey: string, files: File[]) {
  return uploadCodexConversationAttachments(programId, requirementTestingAttachmentItemKey(requirementKey), files);
}

function hydrateRequirementTestingConversation(data: CodexRequirementTestingConversation) {
  const conversation = plainToInstance(CodexRequirementTestingConversation, data);
  conversation.turns = plainToInstance(CodexConversationTurn, data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  conversation.conversations = plainToInstance(CodexPlanningSessionSummary, data.conversations ?? []);
  return conversation;
}

export interface SendCodexRequirementTestingMessageOptions {
  threadId?: string;
  newConversation?: boolean;
  provider?: AITool;
  model?: string;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
  attachmentIds?: string[];
  /** true 时仅设计并归档用例，不发起真实接口、UI 或脚本测试。 */
  testCaseOnly?: boolean;
  /** 本轮 @ 的需求、任务和需求文档；桥接层据此补上下文，和拆解聊天走同一套。 */
  chatReferences?: DeliveryConversationReference[];
}

export async function fetchCodexRequirementTestingConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexRequirementTestingConversation>(`${CODEX_BRIDGE_URL}/v1/codex/requirement-testing`, {
    params: bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
    timeout: 20000,
  });
  return hydrateRequirementTestingConversation(response.data);
}

export async function sendCodexRequirementTestingMessage(
  programId: number,
  requirementKey: string,
  message: string,
  options: SendCodexRequirementTestingMessageOptions = {},
) {
  const response = await instance.post<CodexRequirementTestingActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-testing`,
    bridgeWorkspaceParams(programId, { programId, requirementKey, message, ...options }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexRequirementTestingActionResult, response.data);
}

export async function stopCodexRequirementTestingConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.post<CodexRequirementTestingActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-testing/stop`,
    bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexRequirementTestingActionResult, response.data);
}

/** 用户在面板上勾选的 review 范围：一个 Git 工程一条，files 为空表示整个工程都看。 */
export interface CodexReviewScopeProject {
  path: string;
  name: string;
  changed: number;
  files: string[];
}

export interface SendCodexRequirementReviewMessageOptions {
  threadId?: string;
  newConversation?: boolean;
  provider?: AITool;
  model?: string;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
  scope?: CodexReviewScopeProject[];
  /** 本轮 @ 的需求、任务和需求文档；桥接层据此补上下文，和拆解聊天走同一套。 */
  chatReferences?: DeliveryConversationReference[];
  /** true 表示这一轮是「确认生成 review 报告」，会把结论写进工作区的报告文件。 */
  generateReport?: boolean;
}

function hydrateRequirementReviewConversation(data: CodexRequirementReviewConversation) {
  const conversation = plainToInstance(CodexRequirementReviewConversation, data);
  conversation.turns = plainToInstance(CodexConversationTurn, data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  conversation.conversations = plainToInstance(CodexPlanningSessionSummary, data.conversations ?? []);
  return conversation;
}

export async function fetchCodexRequirementReviewConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexRequirementReviewConversation>(`${CODEX_BRIDGE_URL}/v1/codex/requirement-review`, {
    params: bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
    timeout: 20000,
  });
  return hydrateRequirementReviewConversation(response.data);
}

export async function sendCodexRequirementReviewMessage(
  programId: number,
  requirementKey: string,
  message: string,
  options: SendCodexRequirementReviewMessageOptions = {},
) {
  const response = await instance.post<CodexRequirementReviewActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-review`,
    bridgeWorkspaceParams(programId, { programId, requirementKey, message, ...options }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexRequirementReviewActionResult, response.data);
}

export async function stopCodexRequirementReviewConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.post<CodexRequirementReviewActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-review/stop`,
    bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexRequirementReviewActionResult, response.data);
}

function hydrateFineTuningConversation<T extends CodexRequirementFineTuningConversation | CodexTaskFineTuningConversation>(
  Conversation: new () => T,
  data: T,
) {
  const conversation = plainToInstance(Conversation, data);
  conversation.turns = plainToInstance(CodexConversationTurn, data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  return conversation;
}

export interface SendCodexFineTuningMessageOptions {
  threadId?: string;
  newConversation?: boolean;
  provider?: AITool;
  model?: string;
  reasoningEffort?: AIReasoningEffort;
  fastMode?: boolean;
}

export async function fetchCodexRequirementFineTuningConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexRequirementFineTuningConversation>(`${CODEX_BRIDGE_URL}/v1/codex/requirement-fine-tuning`, {
    params: bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
    timeout: 20000,
  });
  const conversation = hydrateFineTuningConversation(CodexRequirementFineTuningConversation, response.data);
  conversation.conversations = plainToInstance(CodexPlanningSessionSummary, response.data.conversations ?? []);
  return conversation;
}

export async function sendCodexRequirementFineTuningMessage(
  programId: number,
  requirementKey: string,
  message: string,
  options: SendCodexFineTuningMessageOptions = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexRequirementReviewActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-fine-tuning`,
    bridgeWorkspaceParams(programId, {
      programId, requirementKey, provider, message: message.trim(),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.newConversation ? { newConversation: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexRequirementReviewActionResult, response.data);
}

export async function stopCodexRequirementFineTuningConversation(
  programId: number,
  requirementKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.post<CodexRequirementReviewActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/requirement-fine-tuning/stop`,
    bridgeWorkspaceParams(programId, { programId, requirementKey, provider, ...(threadId ? { threadId } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexRequirementReviewActionResult, response.data);
}

export async function fetchCodexTaskFineTuningConversation(
  programId: number,
  itemKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexTaskFineTuningConversation>(`${CODEX_BRIDGE_URL}/v1/codex/task-fine-tuning`, {
    params: bridgeWorkspaceParams(programId, { programId, itemKey, provider, ...(threadId ? { threadId } : {}) }),
    timeout: 20000,
  });
  const conversation = hydrateFineTuningConversation(CodexTaskFineTuningConversation, response.data);
  conversation.conversations = plainToInstance(CodexConversationSummary, response.data.conversations ?? []);
  return conversation;
}

export async function sendCodexTaskFineTuningMessage(
  programId: number,
  itemKey: string,
  message: string,
  options: SendCodexFineTuningMessageOptions = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/task-fine-tuning`,
    bridgeWorkspaceParams(programId, {
      programId, itemKey, provider, message: message.trim(),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.newConversation ? { newConversation: true } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexConversationActionResult, response.data);
}

export async function stopCodexTaskFineTuningConversation(
  programId: number,
  itemKey: string,
  threadId = "",
  provider: AITool = "codex",
) {
  const response = await instance.post<CodexConversationActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/task-fine-tuning/stop`,
    bridgeWorkspaceParams(programId, { programId, itemKey, provider, ...(threadId ? { threadId } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexConversationActionResult, response.data);
}

export async function uploadCodexPlanningAttachments(
  programId: number,
  requirementKey: string,
  files: File[],
) {
  return uploadCodexConversationAttachments(programId, planningAttachmentItemKey(requirementKey), files);
}

export class CodexRequirementTaskUsage {
  itemKey = "";

  title = "";

  phase: DeliveryPhase = "requirement";

  status = "todo";

  usage: CodexProviderUsage = new CodexProviderUsage();
}

/** 需求侧会话的分块，键跟桥接约定，面板拿它查文案。 */
export type CodexRequirementUsageGroupKey = "planning" | "prototype" | "review" | "testing" | "fineTuning";

/** 需求窗口里某一个入口（拆解 / 原型 / 评审 / 测试 / 微调）花了多少。 */
export class CodexRequirementUsageGroup {
  key: CodexRequirementUsageGroupKey = "planning";

  /** 这一块开过几条会话；零条和「跑过但没报用量」在面板上是两回事。 */
  threads = 0;

  usage: CodexProviderUsage = new CodexProviderUsage();
}

/** 一条需求的消耗账：需求侧会话 + 每条任务，各自按执行器分开。 */
export class CodexRequirementUsage {
  programId = 0;

  requirementKey = "";

  /** 总账 = 需求会话 + 全部任务。 */
  usage: CodexProviderUsage = new CodexProviderUsage();

  /** 只算需求侧会话：拆解、微调、原型、评审、需求测试。 */
  conversations: CodexProviderUsage = new CodexProviderUsage();

  /** 上面那笔需求会话再按块拆开，加起来等于 conversations。 */
  conversationGroups: CodexRequirementUsageGroup[] = [];

  tasks: CodexRequirementTaskUsage[] = [];

  updatedAt = "";
}

/**
 * 一条需求到目前为止烧了多少 token。
 *
 * 桥接按需求整体算一遍，顺带把每条任务的分账也算好，所以「消耗」弹窗和任务进度
 * 用的是同一个接口，不必为每条任务各问一次。
 */
export async function fetchCodexRequirementUsage(programId: number, requirementKey: string) {
  const response = await instance.get<CodexRequirementUsage>(`${CODEX_BRIDGE_URL}/v1/codex/requirement-usage`, {
    params: bridgeWorkspaceParams(programId, { programId, requirementKey }),
    timeout: 30000,
  });
  const usage = plainToInstance(CodexRequirementUsage, response.data);
  usage.tasks = plainToInstance(CodexRequirementTaskUsage, response.data.tasks ?? []);
  usage.conversationGroups = plainToInstance(CodexRequirementUsageGroup, response.data.conversationGroups ?? []);
  return usage;
}

export async function fetchCodexPlanningConversation(
  programId: number,
  threadId = "",
  requirementKey = "",
  provider: AITool = "codex",
) {
  const response = await instance.get<CodexPlanningConversation>(`${CODEX_BRIDGE_URL}/v1/codex/planning`, {
    params: bridgeWorkspaceParams(programId, { programId, provider, ...(threadId ? { threadId } : {}), ...(requirementKey ? { requirementKey } : {}) }),
    timeout: 20000,
  });
  const conversation = plainToInstance(CodexPlanningConversation, response.data);
  conversation.turns = plainToInstance(CodexConversationTurn, response.data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  conversation.conversations = plainToInstance(CodexPlanningSessionSummary, response.data.conversations ?? []);
  conversation.result = plainToInstance(CodexPlanningResult, response.data.result ?? {});
  conversation.result.items = plainToInstance(DeliveryItemRecord, response.data.result?.items ?? []);
  conversation.result.stages = plainToInstance(DeliveryStageRecord, response.data.result?.stages ?? []);
  conversation.result.modules = plainToInstance(DeliveryModuleRecord, response.data.result?.modules ?? []);
  return conversation;
}

export async function sendCodexPlanningMessage(
  programId: number,
  message: string,
  options: SendCodexPlanningMessageOptions = {},
) {
  const response = await instance.post<CodexPlanningActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/planning`,
    bridgeWorkspaceParams(programId, { programId, message, ...options }),
    { timeout: 30000 },
  );
  return plainToInstance(CodexPlanningActionResult, response.data);
}

export async function stopCodexPlanningConversation(
  programId: number,
  threadId = "",
  requirementKey = "",
  provider: AITool = "codex",
) {
  const response = await instance.post<CodexPlanningActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/planning/stop`,
    bridgeWorkspaceParams(programId, { programId, provider, ...(threadId ? { threadId } : {}), ...(requirementKey ? { requirementKey } : {}) }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexPlanningActionResult, response.data);
}

/** 预设环境会话：装的是本机全局环境，会话按执行器落在插件的运行时目录里。 */
export class CodexEnvironmentSetupConversation {
  programId = 0;

  threadId = "";

  turns: CodexConversationTurn[] = [];

  conversations: CodexPlanningSessionSummary[] = [];

  active = false;

  activeTurnId = "";

  environmentStatuses: CodexEnvironmentStatus[] = [];
}

export class CodexEnvironmentStatus {
  id = "";

  installed = false;

  version = "";

  githubSshConfigured = false;

  githubSshPublicKey = "";

  githubSshError = "";
}

export class CodexEnvironmentSetupActionResult {
  accepted = false;

  programId = 0;

  threadId = "";

  turnId = "";

  active = false;
}

export interface StartCodexEnvironmentSetupOptions {
  useGit: boolean;
  environments: string[];
  message?: string;
  threadId?: string;
  newConversation?: boolean;
  provider?: AITool;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export async function fetchCodexEnvironmentSetupConversation(
  threadId = "",
  provider: AITool = "codex",
  selection: { useGit: boolean; environments: string[] } = { useGit: false, environments: [] },
) {
  const response = await instance.get<CodexEnvironmentSetupConversation>(`${CODEX_BRIDGE_URL}/v1/codex/environment-setup`, {
    params: {
      provider,
      useGit: selection.useGit,
      environments: JSON.stringify(selection.environments),
      ...(threadId ? { threadId } : {}),
    },
    timeout: 20000,
  });
  const conversation = plainToInstance(CodexEnvironmentSetupConversation, response.data);
  conversation.turns = plainToInstance(CodexConversationTurn, response.data.turns ?? []).map((turn) => {
    turn.items = plainToInstance(CodexConversationItem, turn.items ?? []).map((item) => {
      item.attachments = plainToInstance(CodexConversationAttachment, item.attachments ?? []);
      item.changes = plainToInstance(CodexConversationChange, item.changes ?? []);
      return item;
    });
    return turn;
  });
  conversation.conversations = plainToInstance(CodexPlanningSessionSummary, response.data.conversations ?? []);
  conversation.environmentStatuses = plainToInstance(CodexEnvironmentStatus, response.data.environmentStatuses ?? []);
  return conversation;
}

export async function startCodexEnvironmentSetup(options: StartCodexEnvironmentSetupOptions) {
  const response = await instance.post<CodexEnvironmentSetupActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/environment-setup`,
    options,
    { timeout: 30000 },
  );
  return plainToInstance(CodexEnvironmentSetupActionResult, response.data);
}

export async function stopCodexEnvironmentSetup(threadId = "", provider: AITool = "codex") {
  const response = await instance.post<CodexEnvironmentSetupActionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/environment-setup/stop`,
    { provider, ...(threadId ? { threadId } : {}) },
    { timeout: 20000 },
  );
  return plainToInstance(CodexEnvironmentSetupActionResult, response.data);
}

// ---------------------------------------------------------------------------
// 时间计划
//
// 时间计划是项目的交付时间窗口，在 Git 上对应一条从基准分支切出的发布分支
// （默认 release/{截止日期}）。服务端只存计划元数据与分支关联；建分支和三个方向的
// 合并都发生在本机桥接的项目工作目录里，成功后再由浏览器把事实回写服务端。
// ---------------------------------------------------------------------------

export const TIME_PLAN_STATUSES = ["active", "done", "archived"] as const;

export type TimePlanStatus = (typeof TIME_PLAN_STATUSES)[number];

/** 三个合并方向：基线→计划、需求分支→计划、计划→基线。 */
export const TIME_PLAN_MERGE_KINDS = ["base", "requirement", "publish"] as const;

export type TimePlanMergeKind = (typeof TIME_PLAN_MERGE_KINDS)[number];

export class DeliveryTimePlanRecord {
  planKey = "";

  programId = 0;

  name = "";

  startAt?: string;

  /** 截止时间同时决定默认分支名 release/{YYYYMMDD}，服务端要求必填。 */
  endAt?: string;

  status: TimePlanStatus = "active";

  baseBranch = "";

  branch = "";

  branchCreatedAt?: string;

  /** 三个方向各记各的最近一次成功时间，互不覆盖。 */
  baseSyncedAt?: string;

  requirementMergedAt?: string;

  basePublishedAt?: string;

  requirementCount = 0;

  /** 乐观锁版本，编辑计划时必须原样带回服务端。 */
  version = 0;

  createdBy = "";

  createdByName = "";

  createdAt?: string;

  updatedBy = "";

  updatedAt?: string;
}

/** 合并需求分支弹窗的数据源：只带分支相关字段，不含需求正文。 */
export class TimePlanRequirementRecord {
  requirementKey = "";

  name = "";

  status: RequirementStatus = "open";

  gitBranch = "";

  gitBaseBranch = "";

  gitEnabled = false;
}

export interface TimePlanPageQuery {
  programId: number;
  status?: TimePlanStatus | "";
  keyword?: string;
  pageIndex?: number;
  pageSize?: number;
}

export async function fetchTimePlans(query: TimePlanPageQuery) {
  return getPage(DeliveryTimePlanRecord, "/delivery/time-plans", {
    pageIndex: 1,
    pageSize: 200,
    ...query,
  });
}

export async function fetchTimePlan(programId: number, planKey: string) {
  return getData(DeliveryTimePlanRecord, "/delivery/time-plan", { programId, planKey });
}

export async function fetchTimePlanRequirements(programId: number, planKey: string) {
  return getDataList(TimePlanRequirementRecord, "/delivery/time-plan/requirements", { programId, planKey });
}

export interface SaveTimePlanPayload {
  programId: number;
  /** 留空表示新建；带 planKey 表示更新，更新必须带上读到的 version。 */
  planKey?: string;
  name: string;
  startAt?: string;
  endAt: string;
  status?: TimePlanStatus;
  baseBranch?: string;
  /** 留空时由服务端按截止日期生成 release/{YYYYMMDD}。 */
  branch?: string;
  version?: number;
}

export async function saveTimePlan(payload: SaveTimePlanPayload) {
  const response = await instance.post<ApiResponse<DeliveryTimePlanRecord>>("/delivery/time-plan/save", payload);
  return plainToInstance(DeliveryTimePlanRecord, unwrapApiResponse(response.data));
}

/** 本机建出计划分支后回写关联；不复用编辑版号，避免和用户编辑计划抢乐观锁。 */
export async function bindTimePlanBranch(programId: number, planKey: string, baseBranch: string, branch: string) {
  const response = await instance.post<ApiResponse<DeliveryTimePlanRecord>>("/delivery/time-plan/branch/bind", {
    programId,
    planKey,
    baseBranch,
    branch,
  });
  return plainToInstance(DeliveryTimePlanRecord, unwrapApiResponse(response.data));
}

/** 本机合并成功后记录一次事实；服务端不复核合并结果，只留「最近什么时候合过」。 */
export async function recordTimePlanMerge(programId: number, planKey: string, kind: TimePlanMergeKind) {
  const response = await instance.post<ApiResponse<DeliveryTimePlanRecord>>("/delivery/time-plan/merge/record", {
    programId,
    planKey,
    kind,
  });
  return plainToInstance(DeliveryTimePlanRecord, unwrapApiResponse(response.data));
}

export async function deleteTimePlan(programId: number, planKey: string) {
  const response = await instance.post<ApiResponse<null>>("/delivery/time-plan/delete", { programId, planKey });
  return unwrapApiResponse(response.data);
}

/** 工作台与任务面板需求列表上的「关联时间计划」；planKey 传空串表示解除关联。 */
export async function bindRequirementTimePlan(programId: number, requirementKey: string, planKey: string) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/time-plan/bind", {
    programId,
    requirementKey,
    planKey,
  });
  const requirement = plainToInstance(DeliveryRequirementRecord, unwrapApiResponse(response.data));
  requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
  requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
  requirement.referenceRequirementKeys = requirement.referenceRequirementKeys ?? [];
  requirement.referenceItemKeys = requirement.referenceItemKeys ?? [];
  return requirement;
}

// ---------- 本机桥接：分支合并 ----------

/** 一条来源分支在某个工程里的合并预览。 */
export class CodexGitMergeSource {
  branch = "";

  /** 这个工程里没有这条分支时为 false：不是每个工程都参与每条需求。 */
  exists = false;

  sourceRef = "";

  /** 相对合并基准改动的文件数，不含目标分支上别人的提交。 */
  changedFiles = 0;

  commits = 0;
}

export class CodexGitMergeProject {
  /** 空串表示根工作目录，其余是一级子项目的目录名。 */
  path = "";

  name = "";

  workspace = "";

  hasTarget = false;

  targetRef = "";

  dirty = false;

  currentBranch = "";

  /** 该工程内所有来源分支合起来会动到的文件数，已去重。 */
  changedFiles = 0;

  sources: CodexGitMergeSource[] = [];

  error = "";
}

export class CodexGitMergePreview {
  workspace = "";

  target = "";

  sources: string[] = [];

  projects: CodexGitMergeProject[] = [];
}

export class CodexGitMergeOutcome {
  branch = "";

  merged = false;

  upToDate = false;

  conflict = false;

  /** 这个工程里没有这条来源分支，本轮跳过。 */
  missing = false;

  /** 冲突由 AI 解决后完成的合并。 */
  resolved = false;

  conflictFiles: string[] = [];

  output = "";
}

/** AI 解决冲突的说明：面板要把「解决了什么」原样展示给用户。 */
export class CodexGitMergeResolution {
  project = "";

  branch = "";

  files: string[] = [];

  status = "";

  summary = "";
}

export class CodexGitMergeProjectResult {
  path = "";

  name = "";

  branch = "";

  merged: CodexGitMergeOutcome[] = [];

  resolutions: CodexGitMergeResolution[] = [];

  pushed = false;

  /** 这个工程里没有目标分支，本轮不参与。 */
  skipped = false;

  error = "";
}

export class CodexGitMergeResult {
  target = "";

  sources: string[] = [];

  remote = "";

  pushed = false;

  /** 合并失败的工程名；整体 200 不代表每个工程都合上了。 */
  failed: string[] = [];

  results: CodexGitMergeProjectResult[] = [];
}

/**
 * 合并预览：目标分支 ← 若干来源分支，按工程列出各自会动多少文件。
 * 预览会先 fetch 远端，比普通接口慢一个量级，超时按 fetch 的量级给。
 */
export async function fetchCodexGitMergePreview(programId: number, target: string, sources: string[]) {
  const response = await instance.get<CodexGitMergePreview>(`${CODEX_BRIDGE_URL}/v1/codex/git/merge-preview`, {
    // sources 用重复参数传，不拼逗号串：Git 分支名本身允许带逗号。
    params: bridgeWorkspaceParams(programId, { programId, target, sources }),
    paramsSerializer: { indexes: null },
    timeout: 300000,
  });
  const preview = plainToInstance(CodexGitMergePreview, response.data);
  preview.projects = (response.data.projects ?? []).map((project) => {
    const record = plainToInstance(CodexGitMergeProject, project);
    record.sources = plainToInstance(CodexGitMergeSource, project.sources ?? []);
    return record;
  });
  preview.sources = (response.data.sources ?? []).map((branch) => String(branch || "")).filter(Boolean);
  return preview;
}

/**
 * 执行合并：目标分支 ← 若干来源分支，冲突交给 AI 解决后再推送。
 * 可能要等 AI 处理多个工程的冲突，超时按多轮会话的量级给，不按普通接口给。
 */
export async function mergeCodexGitBranches(
  programId: number,
  target: string,
  sources: string[],
  options: {
    /** 勾选的子项目目录名；不传表示只合根工作目录。 */
    targets?: string[];
    /** 根工作目录没被勾选时置真，这一轮只处理子项目。 */
    skipRoot?: boolean;
    /** 关掉只在本机合，不推送；默认合完就推。 */
    push?: boolean;
    provider?: AITool;
    model?: string;
    reasoningEffort?: AIReasoningEffort;
    fastMode?: boolean;
  } = {},
) {
  const provider = options.provider ?? "codex";
  const response = await instance.post<CodexGitMergeResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/git/merge`,
    bridgeWorkspaceParams(programId, {
      programId,
      target,
      sources,
      targets: options.targets ?? [],
      provider,
      ...(options.skipRoot ? { skipRoot: true } : {}),
      ...(options.push === false ? { push: false } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(provider === "claude" && options.fastMode ? { fastMode: true } : {}),
    }),
    { timeout: 40 * 60 * 1000 },
  );
  const result = plainToInstance(CodexGitMergeResult, response.data);
  result.sources = (response.data.sources ?? []).map((branch) => String(branch || "")).filter(Boolean);
  result.failed = (response.data.failed ?? []).map((name) => String(name || "")).filter(Boolean);
  result.results = (response.data.results ?? []).map((project) => {
    const record = plainToInstance(CodexGitMergeProjectResult, project);
    record.merged = plainToInstance(CodexGitMergeOutcome, project.merged ?? []);
    record.resolutions = plainToInstance(CodexGitMergeResolution, project.resolutions ?? []);
    return record;
  });
  return result;
}
