import type { FoundationProject } from "@/features/foundation/types";

export const previewProjects: FoundationProject[] = [
  {
    id: "pwa-rollout",
    name: "移动端交付工作台",
    description: "建立独立 PWA、远程命令与云端文档查看能力。",
    status: "active",
    updatedAt: "刚刚更新",
    owner: "产品研发",
    activeTasks: 4,
    blockedTasks: 0,
    cloudSync: true,
  },
  {
    id: "release-governance",
    name: "发布治理优化",
    description: "整理发布前校验、评审与可追溯的执行记录。",
    status: "attention",
    updatedAt: "18 分钟前",
    owner: "交付团队",
    activeTasks: 3,
    blockedTasks: 1,
    cloudSync: false,
  },
  {
    id: "service-observability",
    name: "服务可观测性",
    description: "统一核心服务的巡检、告警和处理闭环。",
    status: "paused",
    updatedAt: "昨天",
    owner: "平台团队",
    activeTasks: 0,
    blockedTasks: 0,
    cloudSync: true,
  },
];

export function previewProjectById(projectId: string) {
  return previewProjects.find((project) => project.id === projectId) ?? null;
}
