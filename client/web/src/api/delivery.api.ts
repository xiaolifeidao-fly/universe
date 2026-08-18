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
import { getProjectWorkspace } from "@/project-workspaces/projectWorkspacePreferences";

/** 任务状态，与服务端 service/delivery 的常量一一对应。 */
export const DELIVERY_STATUSES = ["todo", "doing", "done", "blocked", "dropped"] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

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

  updatedBy = "";

  updatedAt?: string;
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

  /** 需求计划执行窗口；为空表示尚未安排。 */
  plannedStartAt?: string;

  plannedEndAt?: string;

  status: RequirementStatus = "open";

  mode: RequirementMode = "simple";

  /** 拆出的任务从哪个阶段起步；简易模式恒为 development。 */
  startPhase: DeliveryPhase = "development";

  /** 关掉时这条需求只落一条任务；默认按多任务拆解。 */
  splitTasks = true;

  /** 打开时拆解会话额外为每条任务写一份需求大纲；默认只留需求级大纲。 */
  generateTaskOutline = false;

  /** 仅专业模式可设置；任务确认写入后可再次确认生成需求 HTML 原型。 */
  generatePrototype = false;

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

/** 需求拆解沉淀下来的需求大纲。正文从项目工作区经本地桥接受控读取。 */
export class CodexRequirementOutline {
  requirementKey = "";

  path = "";

  exists = false;

  markdown = "";

  updatedAt = "";

  active = false;
}

/** 单条任务的需求大纲。文件落在需求资产目录 doc/requirements/<需求键>/<任务键>/ 下。 */
export class CodexTaskOutline {
  itemKey = "";

  requirementKey = "";

  path = "";

  exists = false;

  markdown = "";

  updatedAt = "";
}

/** 一份按功能模块拆分的需求 HTML 原型文件。 */
export class CodexRequirementPrototypeFile {
  path = "";

  name = "";

  html = "";
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

  attachments: CodexConversationAttachment[] = [];

  /** 文件变更条目的结构化清单，用来在回合末尾汇总「本次改动」。 */
  changes: CodexConversationChange[] = [];
}

export class CodexConversationChange {
  path = "";

  /** add / modify / delete / rename，桥接层已经把两个执行器的叫法归一。 */
  kind = "modify";
}

export class CodexConversationAttachment {
  id = "";

  name = "";

  contentType = "application/octet-stream";

  size = 0;

  isImage = false;

  url = "";
}

export class CodexConversationTurn {
  id = "";

  status = "";

  createdAt = "";

  completedAt = "";

  items: CodexConversationItem[] = [];
}

export class CodexConversationSummary {
  threadId = "";

  title = "";

  createdAt = "";

  updatedAt = "";

  status = "";

  active = false;

  phase: DeliveryPhase = "requirement";

  progress = 0;
}

export class CodexConversation {
  programId = 0;

  itemKey = "";

  threadId = "";

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
}

export class CodexConversationActionResult {
  accepted = false;

  programId = 0;

  itemKey = "";

  threadId = "";

  turnId = "";

  active = false;
}

/** 项目级需求拆解会话，与单条任务会话分开保存。 */
export class CodexPlanningSessionSummary {
  threadId = "";

  title = "";

  createdAt = "";

  updatedAt = "";

  status = "";

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

  turns: CodexConversationTurn[] = [];

  conversations: CodexPlanningSessionSummary[] = [];

  active = false;

  activeTurnId = "";

  selectedStageKey = "";

  selectedModuleKey = "";

  selectedKind = "";

  result: CodexPlanningResult = new CodexPlanningResult();
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

/** 任务级预先测试用例会话；与任务执行会话隔离，永远不领取或推进任务。 */
export class CodexTaskTestingCasesConversation {
  programId = 0;

  itemKey = "";

  threadId = "";

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

export async function migrateProgram(bizLine: BusinessLineId, payload: MigrateProgramPayload) {
	const response = await instance.post<ApiResponse<null>>("/delivery/program/migrate", payload, {
		params: withBizLine(bizLine),
	});
	return unwrapApiResponse(response.data);
}

export async function fetchProgramAssignment(programId: number) {
	return getData(ProgramAssignment, "/delivery/program/assignment", { programId });
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
  /** mine 只看和我有关的（我创建 / 我负责 / 我辅助），空值表示全部。 */
  scope?: "mine" | "";
  keyword?: string;
  status?: RequirementStatus | "";
  pageIndex?: number;
  pageSize?: number;
}

export interface SaveRequirementPayload {
  programId: number;
  /** 为空表示新建；带 key 表示更新，更新必须带上读到的 version。 */
  requirementKey?: string;
  name: string;
  detail?: string;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  status?: RequirementStatus;
  mode?: RequirementMode;
  startPhase?: DeliveryPhase;
  splitTasks?: boolean;
  generateTaskOutline?: boolean;
  generatePrototype?: boolean;
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
  });
  return page;
}

export async function fetchRequirement(programId: number, requirementKey: string) {
  const requirement = await getData(DeliveryRequirementRecord, "/delivery/requirement", { programId, requirementKey });
  requirement.owners = plainToInstance(RequirementMember, requirement.owners ?? []);
  requirement.assistants = plainToInstance(RequirementMember, requirement.assistants ?? []);
  return requirement;
}

export async function saveRequirement(payload: SaveRequirementPayload) {
  const response = await instance.post<ApiResponse<DeliveryRequirementRecord>>("/delivery/requirement/save", payload);
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
  board.overview = board.overview ?? new DeliveryOverview();
  board.overview.moduleProgress = Array.isArray(board.overview.moduleProgress)
    ? board.overview.moduleProgress
    : [];
  board.overview.stageProgress = Array.isArray(board.overview.stageProgress)
    ? board.overview.stageProgress
    : [];

  return board;
}

export async function fetchOverview(programId: number) {
  return getData(DeliveryOverview, "/delivery/overview", { programId });
}

export async function fetchItems(programId: number, requirementKey = "") {
  const page = await getPage(DeliveryItemRecord, "/delivery/items", {
    programId,
    requirementKey: requirementKey || undefined,
    pageIndex: 1,
    pageSize: 200,
  });
  page.data.forEach(normalizeItemPhase);
  return page;
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

const CODEX_BRIDGE_URL = "https://127.0.0.1:8765";

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

export async function fetchCodexBridgeHealth(programId: number, provider: AITool = "codex") {
  const response = await instance.get<CodexBridgeHealth>(`${CODEX_BRIDGE_URL}/v1/ai/health`, {
    params: bridgeWorkspaceParams(programId, { programId, provider }),
    timeout: 10000,
  });
  return response.data;
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

export async function fetchCodexTaskOutline(programId: number, itemKey: string) {
  const response = await instance.get<CodexTaskOutline>(
    `${CODEX_BRIDGE_URL}/v1/codex/task-outline`,
    { params: bridgeWorkspaceParams(programId, { programId, itemKey }), timeout: 20000 },
  );
  return plainToInstance(CodexTaskOutline, response.data);
}

export async function saveCodexTaskOutline(programId: number, itemKey: string, markdown: string) {
  const response = await instance.post<CodexTaskOutline>(
    `${CODEX_BRIDGE_URL}/v1/codex/task-outline`,
    bridgeWorkspaceParams(programId, { programId, itemKey, markdown }),
    { timeout: 20000 },
  );
  return plainToInstance(CodexTaskOutline, response.data);
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
) {
  const response = await instance.post<CodexExecutionResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/execute`,
    bridgeWorkspaceParams(programId, {
      programId,
      task,
      provider,
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
) {
  const response = await instance.post<CodexExecutionBatchResult>(
    `${CODEX_BRIDGE_URL}/v1/codex/execute-batch`,
    bridgeWorkspaceParams(programId, {
      programId,
      itemKeys,
      provider,
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
  /** 打开时拆解会话额外为每条任务写一份需求大纲；默认只写需求级大纲。 */
  requirementGenerateTaskOutline?: boolean;
  /** 专业模式下确认拆解写入后，可由面板再次确认生成需求 HTML 原型。 */
  requirementGeneratePrototype?: boolean;
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

export async function uploadCodexPlanningAttachments(
  programId: number,
  requirementKey: string,
  files: File[],
) {
  return uploadCodexConversationAttachments(programId, planningAttachmentItemKey(requirementKey), files);
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
