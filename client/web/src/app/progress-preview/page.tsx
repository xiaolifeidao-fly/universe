"use client";

import {
  DeliveryExecutionBatchRecord,
  DeliveryItemRecord,
  DeliveryRequirementProgressRecord,
  DeliveryRequirementRecord,
  type DeliveryPhase,
  type DeliveryStatus,
} from "@/api/delivery.api";
import { DeliveryRequirementProgressModal } from "../(console)/delivery/components/DeliveryRequirementProgressModal";

function task(itemKey: string, title: string, status: DeliveryStatus, phase: DeliveryPhase, dependsOnItemKeys: string[], sortOrder: number, note = "") {
  return Object.assign(new DeliveryItemRecord(), {
    itemKey, title, status, phase, dependsOnItemKeys, sortOrder, note,
    ownerName: status === "todo" ? "" : "陈洁",
    progress: status === "done" ? 100 : status === "doing" ? 50 : status === "blocked" ? 20 : 0,
  });
}

const requirement = Object.assign(new DeliveryRequirementRecord(), {
  requirementKey: "REQ-20260825-07",
  name: "需求任务进度可视化",
});

const items = [
  task("TASK-01", "梳理任务进度数据口径", "done", "requirement", [], 1),
  task("TASK-02", "实现需求级进度聚合接口", "doing", "development", ["TASK-01"], 2),
  task("TASK-03", "搭建任务流程图与状态节点", "doing", "development", ["TASK-01"], 3),
  task("TASK-04", "核对受阻任务原因回显", "blocked", "testing", ["TASK-02"], 4, "等待测试环境权限开通"),
  task("TASK-05", "接入工作台与需求列表入口", "todo", "development", ["TASK-02", "TASK-03"], 5),
  task("TASK-06", "旧版独立进度页面", "dropped", "development", ["TASK-03"], 6, "已合并到统一弹框，不再单独建设"),
  task("TASK-07", "完成桌面和移动端验收", "todo", "testing", ["TASK-04", "TASK-05"], 7),
];

const batches = [
  Object.assign(new DeliveryExecutionBatchRecord(), {
    batchId: "batch-a1c8f024fe",
    mode: "parallel",
    status: "running",
    items: [
      { itemKey: "TASK-02", sequence: 1, status: "running", message: "", updatedAt: new Date().toISOString() },
      { itemKey: "TASK-04", sequence: 2, status: "blocked", message: "等待测试环境权限开通", updatedAt: new Date().toISOString() },
    ],
  }),
  Object.assign(new DeliveryExecutionBatchRecord(), {
    batchId: "batch-4e72dd83c1",
    mode: "sequence",
    status: "running",
    items: [
      { itemKey: "TASK-03", sequence: 1, status: "running", message: "", updatedAt: new Date().toISOString() },
      { itemKey: "TASK-05", sequence: 2, status: "pending", message: "", updatedAt: new Date().toISOString() },
    ],
  }),
];

const progress = Object.assign(new DeliveryRequirementProgressRecord(), {
  requirementKey: requirement.requirementKey,
  requirementName: requirement.name,
  totalCount: 7,
  countedCount: 6,
  progress: 37,
  statusCounts: { todo: 2, doing: 2, done: 1, blocked: 1, dropped: 1 },
  items,
  batches,
});

export default function ProgressPreviewPage() {
  return (
    <DeliveryRequirementProgressModal
      open
      programId={1}
      bizLine=""
      requirement={requirement}
      previewProgress={progress}
      onClose={() => undefined}
    />
  );
}
