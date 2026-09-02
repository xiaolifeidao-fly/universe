import { request } from "@/api/client";

export type ProgramStatus = "active" | "attention" | "paused" | "done" | string;
export type RequirementStatus = "open" | "done" | "dropped";
export type RequirementMode = "simple" | "professional";
export type ItemStatus = "todo" | "doing" | "done" | "blocked" | "dropped";
export type ItemPhase = "requirement" | "development" | "testing";
export type ItemKind = "gap" | "capability" | "asset";

export interface ProgramSummary {
  programId: number;
  programCode: string;
  name: string;
  summary: string;
  status: ProgramStatus;
  cloudSyncEnabled: boolean;
  gitEnabled: boolean;
  gitRemoteName: string;
  gitBaseBranch: string;
  updatedAt: string | null;
  canWrite: boolean;
  canAdminister: boolean;
}

export interface RequirementMember {
  id: string;
  name: string;
}

export interface RequirementSummary {
  requirementKey: string;
  programId: number;
  name: string;
  detail: string;
  status: RequirementStatus;
  mode: RequirementMode;
  startPhase: ItemPhase;
  splitTasks: boolean;
  preGenerateTaskDocuments: boolean;
  generatePrototype: boolean;
  stageKey: string;
  moduleKey: string;
  kind: ItemKind;
  gitEnabled: boolean | null;
  gitBaseBranch: string;
  gitBranch: string;
  owners: RequirementMember[];
  assistants: RequirementMember[];
  itemCount: number;
  version: number;
  createdBy: string;
  createdByName: string;
  createdAt: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  updatedAt: string | null;
}

export interface DeliveryItem {
  itemKey: string;
  programId: number;
  requirementKey: string;
  planningBatchKey: string;
  kind: ItemKind;
  title: string;
  description: string;
  benefitTags: string[];
  phase: ItemPhase;
  status: ItemStatus;
  progress: number;
  /**
   * 执行耗时：最近一轮的起止时刻与耗时，外加历次累计（毫秒）。
   * 还在跑时 lastRunFinishedAt 为空，界面从 lastRunStartedAt 现算这一轮跑了多久。
   */
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunDurationMs: number;
  totalRunDurationMs: number;
  runCount: number;
  ownerId: string;
  ownerName: string;
  dueDate: string | null;
  note: string;
  dependsOnItemKeys: string[];
  dependencySourceSides: Record<string, string>;
  dependencyTargetSides: Record<string, string>;
  version: number;
  updatedAt: string | null;
}

export interface RequirementPage {
  total: number;
  data: RequirementSummary[];
}

export interface ItemPage {
  total: number;
  data: DeliveryItem[];
}

export interface SaveRequirementInput {
  programId: number;
  requirementKey?: string;
  name: string;
  detail: string;
  status: RequirementStatus;
  mode: RequirementMode;
  startPhase: ItemPhase;
  splitTasks: boolean;
  preGenerateTaskDocuments: boolean;
  generatePrototype: boolean;
  owners: RequirementMember[];
  assistants: RequirementMember[];
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  version?: number;
}

export interface PatchItemInput {
  programId: number;
  itemKey: string;
  version: number;
  requirementKey?: string;
  kind?: ItemKind;
  title?: string;
  description?: string;
  benefitTags?: string[];
  status?: ItemStatus;
  progress?: number;
  ownerId?: string;
  ownerName?: string;
  dueDate?: string;
  note?: string;
  dependsOnItemKeys?: string[];
  dependencySourceSides?: Record<string, string>;
  dependencyTargetSides?: Record<string, string>;
}

export interface PlanningBatch {
  batchKey: string;
  programId: number;
  requirementKey: string;
  title: string;
  summary: string;
  itemCount: number;
  seq: number;
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function listPrograms() {
  return request<ProgramSummary[]>("/delivery/programs");
}

export function getProgram(programId: number) {
  return request<ProgramSummary>(`/delivery/program${query({ programId })}`);
}

export function listRequirements(programId: number) {
  return request<RequirementPage>(`/delivery/requirements${query({ programId, pageSize: 100 })}`);
}

export function getRequirement(programId: number, requirementKey: string) {
  return request<RequirementSummary>(`/delivery/requirement${query({ programId, requirementKey })}`);
}

export function saveRequirement(input: SaveRequirementInput) {
  return request<RequirementSummary>("/delivery/requirement/save", { method: "POST", body: input });
}

export function listItems(programId: number, requirementKey?: string) {
  return request<ItemPage>(`/delivery/items${query({ programId, requirementKey, pageSize: 100 })}`);
}

export function getItem(programId: number, itemKey: string) {
  return request<DeliveryItem>(`/delivery/item${query({ programId, itemKey })}`);
}

export function patchItem(input: PatchItemInput) {
  return request<DeliveryItem>("/delivery/item/patch", { method: "POST", body: input });
}

export function createPlanningBatch(programId: number, requirementKey: string, title: string, summary: string) {
  return request<PlanningBatch>("/delivery/requirement/planning-batch/create", {
    method: "POST",
    body: { programId, requirementKey, title, summary, source: "planner", itemCount: 0 },
  });
}

// ---------- 工作台只读视图 ----------

export interface ExecutionBatchItem {
  itemKey: string;
  sequence: number;
  status: string;
  message: string;
  updatedAt: string | null;
}

export interface ExecutionBatch {
  batchId: string;
  requirementKey: string;
  requirementName: string;
  requirementGitBranch: string;
  mode: string;
  executorType: string;
  status: string;
  itemCount: number;
  completedCount: number;
  blockedCount: number;
  summary: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdByName: string;
  items: ExecutionBatchItem[] | null;
}

export interface PlanningBatchSummary {
  batchKey: string;
  requirementKey: string;
  seq: number;
  title: string;
  source: string;
  summary: string;
  itemCount: number;
  createdByName: string;
  createdAt: string | null;
}

/** 一条需求当前的完整任务图：任务是计划，批次说明这次运行的上下文。 */
export interface RequirementProgress {
  requirementKey: string;
  requirementName: string;
  totalCount: number;
  countedCount: number;
  progress: number;
  statusCounts: Record<string, number>;
  /** 这条需求下全部任务的执行耗时之和（毫秒）与已结束的执行轮次总数。 */
  totalRunDurationMs: number;
  runCount: number;
  items: DeliveryItem[];
  batches: ExecutionBatch[] | null;
  planningBatches: PlanningBatchSummary[] | null;
}

export interface PlanningSessionSummary {
  requirementKey: string;
  executorType: string;
  threadId: string;
  title: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function getRequirementProgress(programId: number, requirementKey: string) {
  return request<RequirementProgress>(`/delivery/requirement/progress${query({ programId, requirementKey })}`);
}

/** 聊天记录目录：Worker 还没回话时先用它把会话列表铺出来。 */
export function listPlanningSessions(programId: number, requirementKey: string) {
  return request<PlanningSessionSummary[] | null>(`/delivery/requirement/planning-sessions${query({ programId, requirementKey })}`);
}
