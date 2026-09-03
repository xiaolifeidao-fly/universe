/**
 * 消息中心的数据来源，语义和 PC 控制台的消息中心保持一致，分三类：
 *
 *   1. 批次完成 —— 一次批量/串行执行跑完的提醒，只发给启动这批的人，有已读态
 *   2. 需求完成 —— 需求被标记完成后按负责人/协助者逐人下发，每人已读态独立
 *   3. 待关注   —— 「受阻 / 不做」的任务，没有已读态，靠任务状态本身消解
 *
 * 三类的未读语义不同，服务端也不放在同一个接口里，前端同样不合并。
 *
 * 服务端的交付数据按项目授权，跨项目只能逐个项目取；项目数是个位数量级，
 * 并发发出即可。单个项目取不到（无权限或服务端异常）不该让整个消息中心变空，
 * 所以每个项目单独兜错，失败的那个当空处理。
 */

import { request } from "@/api/client";
import { listPrograms, type DeliveryItem, type ItemPage, type ProgramSummary, type RequirementPage } from "@/api/management.api";

/** 一次执行批次的完成提醒。字段对齐服务端 ExecutionBatchView，只留手机上用得到的。 */
export interface ExecutionBatchMessage {
  batchId: string;
  programId: number;
  programName: string;
  requirementKey: string;
  requirementName: string;
  requirementGitBranch: string;
  mode: string;
  status: string;
  itemCount: number;
  completedCount: number;
  blockedCount: number;
  summary: string;
  notificationReadAt: string | null;
  finishedAt: string | null;
}

/** 需求完成提醒：服务端只返回当前登录用户作为收件人的那些。 */
export interface RequirementCompletionMessage {
  programId: number;
  programName: string;
  requirementKey: string;
  requirementName: string;
  recipientId: string;
  recipientName: string;
  notificationReadAt: string | null;
  completedAt: string | null;
}

/** 一条需要关注的任务：受阻或不做，连同它所属的项目和需求。 */
export interface AttentionTaskMessage {
  programId: number;
  programName: string;
  requirementKey: string;
  requirementName: string;
  itemKey: string;
  title: string;
  status: DeliveryItem["status"];
  phase: DeliveryItem["phase"];
  ownerName: string;
  updatedAt: string | null;
}

function programName(program: ProgramSummary) {
  return program.name || program.programCode || String(program.programId);
}

/** 逐项目并发拉取并摊平；单个项目失败按空处理，不影响其余项目的消息。 */
async function acrossPrograms<T>(load: (program: ProgramSummary) => Promise<T[]>): Promise<T[]> {
  const programs = await listPrograms();
  const groups = await Promise.all(programs.map(async (program) => {
    try {
      return await load(program);
    } catch {
      return [];
    }
  }));
  return groups.flat();
}

export async function listExecutionBatchMessages(): Promise<ExecutionBatchMessage[]> {
  return acrossPrograms(async (program) => {
    const batches = await request<ExecutionBatchMessage[] | null>(
      `/delivery/execution-batch/notifications?programId=${program.programId}`,
    );
    return (batches ?? []).map((batch) => ({ ...batch, programName: programName(program) }));
  });
}

export async function listRequirementCompletionMessages(): Promise<RequirementCompletionMessage[]> {
  return acrossPrograms(async (program) => {
    const notifications = await request<RequirementCompletionMessage[] | null>(
      `/delivery/requirement/completion-notifications?programId=${program.programId}`,
    );
    return (notifications ?? []).map((notification) => ({ ...notification, programName: programName(program) }));
  });
}

/**
 * 受阻和不做的任务由任务列表按状态筛出来，服务端没有单独的提醒表 ——
 * 它们靠状态本身表达「还需要人管」，被改回其它状态就自然从列表里消失。
 * 需求名要另取一次需求列表来补：任务上只有 requirementKey。
 */
export async function listAttentionTaskMessages(): Promise<AttentionTaskMessage[]> {
  return acrossPrograms(async (program) => {
    const [items, requirements] = await Promise.all([
      request<ItemPage>(`/delivery/items?programId=${program.programId}&status=blocked,dropped&pageSize=100`),
      request<RequirementPage>(`/delivery/requirements?programId=${program.programId}&pageSize=100`),
    ]);
    const nameByKey = new Map(requirements.data.map((requirement) => [requirement.requirementKey, requirement.name]));
    return items.data.map<AttentionTaskMessage>((item) => ({
      programId: program.programId,
      programName: programName(program),
      requirementKey: item.requirementKey,
      requirementName: nameByKey.get(item.requirementKey) || item.requirementKey,
      itemKey: item.itemKey,
      title: item.title || item.itemKey,
      status: item.status,
      phase: item.phase,
      ownerName: item.ownerName,
      updatedAt: item.updatedAt,
    }));
  });
}

export function markExecutionBatchMessageRead(programId: number, batchId: string) {
  return request<ExecutionBatchMessage>("/delivery/execution-batch/notification/read", {
    method: "POST",
    body: { programId, batchId },
  });
}

export function markRequirementCompletionMessageRead(programId: number, requirementKey: string) {
  return request<RequirementCompletionMessage>("/delivery/requirement/completion-notification/read", {
    method: "POST",
    body: { programId, requirementKey },
  });
}

export interface MessageCenterSnapshot {
  batches: ExecutionBatchMessage[];
  completions: RequirementCompletionMessage[];
  attention: AttentionTaskMessage[];
}

/** 三类一起拉：任何一类失败都不该让另外两类空着，各自兜错后合成一份快照。 */
export async function loadMessageCenter(): Promise<MessageCenterSnapshot> {
  const [batches, completions, attention] = await Promise.all([
    listExecutionBatchMessages().catch(() => []),
    listRequirementCompletionMessages().catch(() => []),
    listAttentionTaskMessages().catch(() => []),
  ]);
  return { batches, completions, attention };
}

/** 底部导航的角标数：两类未读提醒 + 所有待关注任务，和 PC 的口径一致。 */
export function unreadCount(snapshot: MessageCenterSnapshot) {
  return snapshot.batches.filter((batch) => !batch.notificationReadAt).length
    + snapshot.completions.filter((completion) => !completion.notificationReadAt).length
    + snapshot.attention.length;
}
