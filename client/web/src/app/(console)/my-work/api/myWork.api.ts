"use client";

import type { BusinessLine } from "@/business-lines/BusinessLineProvider";
import {
  CodexGitWorkspaceStatus,
  DeliveryItemRecord,
  DeliveryModuleRecord,
  type DeliveryProgramRecord,
  DeliveryRequirementRecord,
  DeliveryStageRecord,
  fetchCodexBridgeHealth,
  fetchCodexGitWorkspaceStatus,
  isCodexGitWorkspaceUninitialized,
  fetchItems,
  fetchModules,
  fetchPrograms,
  fetchRequirements,
  fetchStages,
} from "@/api/delivery.api";
import type { AITool } from "@/ai-preferences/AIPreferencesProvider";

/** 工作台卡片：需求实体加上项目与当前空间的展示上下文。 */
export class MyWorkRequirement extends DeliveryRequirementRecord {
  programName = "";

  programCode = "";

  /** 业务线的稳定编码，例如 whatsapp。 */
  businessCode = "";

  /** 业务线在空间管理中配置的可读名称。 */
  spaceName = "";

  /** 当前用户在所属项目是否具有编辑权限；服务端仍是最终裁决。 */
  canWrite = false;

  /** 项目级 Git 总开关；关闭时这条需求的分支信息一律不展示。 */
  programGitEnabled = false;

  /** 项目级默认基准分支，编辑需求时透传给需求弹窗。 */
  programGitBaseBranch = "";
}

/** 工作台就地打开需求弹窗所需的项目上下文，按需拉取，不在列表阶段预取。 */
export interface MyWorkProgramContext {
  stages: DeliveryStageRecord[];
  modules: DeliveryModuleRecord[];
  itemCatalog: DeliveryItemRecord[];
  requirements: DeliveryRequirementRecord[];
  codexBridgeReady: boolean;
}

/** 一个项目的工作区 Git 现状：与需求列表同源，取不到时保留错误文案。 */
export interface MyWorkGitWorkspace {
  status: CodexGitWorkspaceStatus | null;
  error: string;
  /** 工作目录还不是 Git 仓库：与「桥接连不上」区分开，卡片据此提示先初始化。 */
  uninitialized: boolean;
}

/** 工作台发起新需求时，只允许选择当前空间内可写的进行中项目。 */
export async function fetchMyWorkPrograms(businessLine: BusinessLine): Promise<DeliveryProgramRecord[]> {
  const programs = await fetchPrograms(businessLine.id);
  return programs.filter((program) => program.status === "active" && program.canWrite);
}

async function fetchAllRelatedOpenRequirements(programId: number) {
  const first = await fetchRequirements({
    programId,
    scope: "mine",
    status: "open",
    pageIndex: 1,
  });
  const requirements = [...first.data];
  const pageSize = Math.max(first.data.length, 200);
  const pageCount = Math.ceil(first.total / pageSize);
  for (let pageIndex = 2; pageIndex <= pageCount; pageIndex += 1) {
    const page = await fetchRequirements({
      programId,
      scope: "mine",
      status: "open",
      pageIndex,
    });
    requirements.push(...page.data);
  }
  return requirements;
}

/**
 * 汇总当前选中空间中，进行中且与当前用户有关的需求（我提出 / 我负责 / 我协助）。
 * 空间切换由 BusinessLineProvider 统一管理；这里只读取当前空间下的项目，
 * 保留既有项目级权限校验，不由浏览器猜测项目归属。
 */
export async function fetchMyWorkRequirements(businessLine: BusinessLine): Promise<MyWorkRequirement[]> {
  const programs = await fetchPrograms(businessLine.id);
  const rows = await Promise.all(
    programs
      .filter((program) => program.status === "active")
      .map(async (program) => {
        const requirements = await fetchAllRelatedOpenRequirements(program.programId);
        return requirements.map((requirement) => Object.assign(new MyWorkRequirement(), requirement, {
          programName: program.name,
          programCode: program.programCode,
          businessCode: program.bizLine || businessLine.id,
          spaceName: businessLine.label,
          canWrite: program.canWrite,
          programGitEnabled: program.gitEnabled,
          programGitBaseBranch: program.gitBaseBranch,
        }));
      }),
  );

  return rows
    .flat()
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

/**
 * 拉取一条需求就地编辑所需的项目上下文。
 * 任务目录只取该需求名下的任务，需求清单用于详情里的 @ 引用候选。
 */
export async function fetchMyWorkProgramContext(
  programId: number,
  requirementKey: string,
  tool: AITool,
): Promise<MyWorkProgramContext> {
  const [stages, modules, items, requirements, health] = await Promise.all([
    fetchStages(programId),
    fetchModules(programId),
    fetchItems(programId, requirementKey),
    fetchRequirements({ programId, pageIndex: 1 }),
    fetchCodexBridgeHealth(programId, tool).catch(() => null),
  ]);
  return {
    stages,
    modules,
    itemCatalog: items.data,
    requirements: requirements.data,
    codexBridgeReady: Boolean(health?.ready),
  };
}

/** 批量读取各项目的 Git 工作区状态；单个项目失败不影响其他卡片。 */
export async function fetchMyWorkGitWorkspaces(programIds: number[]) {
  const entries = await Promise.all(programIds.map(async (programId) => {
    // 状态读得到不代表 Git 已就绪：仓库没关联远端时状态照样能读，所以这件事单独问一次。
    const uninitialized = await isCodexGitWorkspaceUninitialized(programId);
    try {
      return [programId, { status: await fetchCodexGitWorkspaceStatus(programId), error: "", uninitialized }] as const;
    } catch (error) {
      return [programId, { status: null, error: (error as Error).message, uninitialized }] as const;
    }
  }));
  return new Map<number, MyWorkGitWorkspace>(entries);
}
