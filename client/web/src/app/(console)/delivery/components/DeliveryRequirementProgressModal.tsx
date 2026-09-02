"use client";

import {
  ApartmentOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeploymentUnitOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RedoOutlined,
  RightOutlined,
  SyncOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Empty, Input, Modal, Popconfirm, Progress, Spin, Tooltip, message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DELIVERY_STATUSES,
  DeliveryBoardColumn,
  advanceDeliveryPhase,
  deleteItem,
  fetchCodexBridgeHealth,
  fetchCodexRequirementUsage,
  fetchItems,
  fetchModules,
  fetchProgramMembers,
  fetchRequirementProgress,
  fetchRequirements,
  fetchStages,
  patchItem,
  startCodexExecution,
  startCodexExecutionBatch,
  stopAllCodexExecutions,
  stopCodexConversation,
  type CodexProviderUsage,
  type DeliveryExecutionBatchRecord,
  type DeliveryItemRecord,
  type DeliveryModuleRecord,
  type DeliveryPlanningBatchRecord,
  type DeliveryRequirementProgressRecord,
  type DeliveryRequirementRecord,
  type DeliveryStageRecord,
  type DeliveryStatus,
  type PatchItemPayload,
} from "@/api/delivery.api";
import {
  effortForConfig,
  modelForConfig,
  sceneForPhase,
  useAIPreferences,
} from "@/ai-preferences/AIPreferencesProvider";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { notifyDeliveryTasksChanged } from "@/api/deliveryTaskEvents";
import { DeliveryDependencyLayer } from "./DeliveryDependencyLayer";
import { DeliveryRunDurationTotal, DeliveryTaskRunDuration } from "./DeliveryRunDuration";
import { DeliveryTaskUsageTags } from "./DeliveryRequirementUsageModal";
import { DeliveryItemDrawer } from "./DeliveryItemDrawer";
import { DeliveryTaskDocumentPanel } from "./DeliveryTaskDocument";
import { DeliveryTaskSessionModal } from "./DeliveryTaskSessionModal";

interface DeliveryRequirementProgressModalProps {
  open: boolean;
  programId: number;
  /** 会话与执行都要落到具体业务线；工作台是跨业务线的，按需求自己那条走。 */
  bizLine: BusinessLineId;
  requirement: DeliveryRequirementRecord | null;
  onClose: () => void;
  previewProgress?: DeliveryRequirementProgressRecord;
}

/** 已完成的任务也能勾选：「再做一次」不回滚状态，只是再开一轮执行实例。不执行的任务除外。 */
function selectable(item: DeliveryItemRecord) {
  return item.status !== "dropped";
}

/** 一行就是一个拆解批次；批次被删或任务写在批次上线之前时归到「未归批次」那一行。 */
interface PlanningGroup {
  key: string;
  title: string;
  hint: string;
  batch?: DeliveryPlanningBatchRecord;
  items: DeliveryItemRecord[];
}

interface ItemBatchContext {
  batch: DeliveryExecutionBatchRecord;
  itemStatus: string;
  message: string;
}

const STATUS_ICONS: Record<DeliveryStatus, ReactNode> = {
  todo: <ClockCircleOutlined />,
  doing: <SyncOutlined />,
  done: <CheckCircleOutlined />,
  blocked: <ExclamationCircleOutlined />,
  dropped: <CloseCircleOutlined />,
};

// 只有真的有任务在跑，进行中的图标才转 —— 计数为 0 时还转圈，看着像页面卡住。
function statusIcon(status: DeliveryStatus, running = false): ReactNode {
  if (status === "doing" && running) return <LoadingOutlined spin />;
  return STATUS_ICONS[status];
}

const DETAIL_STATUSES: DeliveryStatus[] = ["doing", "blocked", "todo", "dropped"];

function taskOrder(left: DeliveryItemRecord, right: DeliveryItemRecord) {
  return left.sortOrder - right.sortOrder || left.itemKey.localeCompare(right.itemKey);
}

function fill(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, String(value)),
    template,
  );
}

/** 把依赖图压成从左到右的拓扑层；同层节点代表可并行推进。 */
function buildFlowColumns(items: DeliveryItemRecord[], stepLabel: (index: number) => string): DeliveryBoardColumn[] {
  if (!items.length) return [];
  const byKey = new Map(items.map((item) => [item.itemKey, item]));
  const indegree = new Map(items.map((item) => [item.itemKey, 0]));
  const successors = new Map<string, string[]>();
  const depth = new Map(items.map((item) => [item.itemKey, 0]));

  items.forEach((item) => {
    (item.dependsOnItemKeys ?? []).forEach((predecessorKey) => {
      if (!byKey.has(predecessorKey)) return;
      indegree.set(item.itemKey, (indegree.get(item.itemKey) ?? 0) + 1);
      successors.set(predecessorKey, [...(successors.get(predecessorKey) ?? []), item.itemKey]);
    });
  });

  const queue = items.filter((item) => indegree.get(item.itemKey) === 0).sort(taskOrder);
  const visited = new Set<string>();
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    visited.add(item.itemKey);
    for (const successorKey of successors.get(item.itemKey) ?? []) {
      depth.set(successorKey, Math.max(depth.get(successorKey) ?? 0, (depth.get(item.itemKey) ?? 0) + 1));
      const nextIndegree = (indegree.get(successorKey) ?? 0) - 1;
      indegree.set(successorKey, nextIndegree);
      if (nextIndegree === 0) {
        const successor = byKey.get(successorKey);
        if (successor) queue.push(successor);
        queue.sort(taskOrder);
      }
    }
  }

  // 服务端禁止环形依赖；旧脏数据仍兜底放到最后一层，不能让任务从总览中消失。
  const maxDepth = Math.max(0, ...Array.from(depth.values()));
  items.filter((item) => !visited.has(item.itemKey)).forEach((item) => depth.set(item.itemKey, maxDepth + 1));
  const layerCount = Math.max(0, ...Array.from(depth.values())) + 1;
  return Array.from({ length: layerCount }, (_, index) => {
    const layerItems = items.filter((item) => depth.get(item.itemKey) === index).sort(taskOrder);
    return Object.assign(new DeliveryBoardColumn(), {
      key: `step-${index}`,
      name: stepLabel(index + 1),
      total: layerItems.length,
      doneCount: layerItems.filter((item) => item.status === "done").length,
      items: layerItems,
    });
  }).filter((column) => column.items.length > 0);
}

interface PlanningBatchRowProps {
  group: PlanningGroup;
  stepLabel: (index: number) => string;
  selectedCount: number;
  selectableCount: number;
  disabled: boolean;
  canRedo: boolean;
  redoing: boolean;
  redoHint: string;
  onToggleAll: (checked: boolean) => void;
  onRedo: () => void;
  renderNode: (item: DeliveryItemRecord) => ReactNode;
  t: (key: string) => string;
}

/** 一个拆解批次一行：行内仍按依赖分层，行本身是整批全选和「本批再做一次」的单位。 */
function PlanningBatchRow({
  group,
  stepLabel,
  selectedCount,
  selectableCount,
  disabled,
  canRedo,
  redoing,
  redoHint,
  onToggleAll,
  onRedo,
  renderNode,
  t,
}: PlanningBatchRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => buildFlowColumns(group.items, stepLabel), [group.items, stepLabel]);
  const allSelected = selectableCount > 0 && selectedCount === selectableCount;
  return (
    <article className="delivery-progress-plan-row">
      <header className="delivery-progress-plan-row__head">
        <Checkbox
          checked={allSelected}
          disabled={disabled || selectableCount === 0}
          indeterminate={selectedCount > 0 && !allSelected}
          onChange={(event) => onToggleAll(event.target.checked)}
        >
          {fill(t("delivery.progress.selectBatch"), { count: selectableCount })}
        </Checkbox>
        <span className="delivery-progress-plan-row__title">
          <b>{group.title}</b>
          {group.batch ? <code className="manager-mono" title={group.batch.batchKey}>{group.batch.batchKey}</code> : null}
          <small>{group.batch?.summary || group.hint}</small>
        </span>
        <em className="manager-mono">{fill(t("delivery.progress.planningBatchCount"), { count: group.items.length })}</em>
        <Tooltip title={canRedo ? redoHint : t("delivery.progress.bridgeOffline")}>
          <Button
            disabled={disabled || !canRedo || selectableCount === 0}
            icon={<RedoOutlined />}
            loading={redoing}
            size="small"
            onClick={onRedo}
          >
            {t("delivery.progress.redoBatch")}
          </Button>
        </Tooltip>
      </header>
      <div className="delivery-progress-flow-scroll">
        <div className="delivery-progress-flow" ref={rowRef}>
          <DeliveryDependencyLayer
            boardRef={rowRef}
            columns={columns}
            scale={1}
            onDeleteDependency={() => undefined}
          />
          {columns.map((column) => (
            <section className="delivery-progress-flow__column" key={column.key}>
              <header>
                <span>{column.name}</span>
                <b className="manager-mono">{column.items.length}</b>
              </header>
              <div>{column.items.map(renderNode)}</div>
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}

export function DeliveryRequirementProgressModal({
  open,
  programId,
  bizLine,
  requirement,
  onClose,
  previewProgress,
}: DeliveryRequirementProgressModalProps) {
  const { t } = useLocale();
  const { preferences, configFor } = useAIPreferences();
  const [progress, setProgress] = useState<DeliveryRequirementProgressRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 会话弹窗要的候选数据和桥接状态，进度窗自己取一份，不指望调用方准备。
  const [bridgeReady, setBridgeReady] = useState(false);
  const [itemCatalog, setItemCatalog] = useState<DeliveryItemRecord[]>([]);
  const [requirements, setRequirements] = useState<DeliveryRequirementRecord[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [startingKey, setStartingKey] = useState("");
  const [batchStarting, setBatchStarting] = useState(false);
  // 「本批再做一次」发起时先把整批勾上，再走和批量执行同一条路：先确认前置条件，再启动。
  const [redoingBatchKey, setRedoingBatchKey] = useState("");
  // 和任务面板一样，批量执行前先让用户写一次性的执行约束。
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [executionConstraints, setExecutionConstraints] = useState("");
  // 弹框确认前先冻结这次要跑哪些任务：勾选可能在等待输入期间被刷新改掉。
  const [pendingItems, setPendingItems] = useState<DeliveryItemRecord[]>([]);
  const [stoppingKey, setStoppingKey] = useState("");
  const [stoppingAll, setStoppingAll] = useState(false);
  const [chatItem, setChatItem] = useState<DeliveryItemRecord | null>(null);
  const [startTestingCases, setStartTestingCases] = useState(false);
  const [documentItem, setDocumentItem] = useState<DeliveryItemRecord | null>(null);
  // 点任务卡片就地开编辑抽屉：进度窗自己备齐编辑要用的阶段、模块和成员候选，不指望调用方准备。
  const [editItem, setEditItem] = useState<DeliveryItemRecord | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [stages, setStages] = useState<DeliveryStageRecord[]>([]);
  const [modules, setModules] = useState<DeliveryModuleRecord[]>([]);
  const [ownerOptions, setOwnerOptions] = useState<Array<{ value: string; label: string }>>([]);
  // 消耗单独拉：汇总要逐条任务问会话表，比进度慢，不能让它拖住任务列表。
  const [usageByItem, setUsageByItem] = useState<Record<string, CodexProviderUsage>>({});

  const load = useCallback(async (silent = false) => {
    if (!open || !programId || !requirement) return;
    if (!silent) setLoading(true);
    try {
      setProgress(await fetchRequirementProgress(programId, requirement.requirementKey));
      setError("");
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [open, programId, requirement]);

  const loadUsage = useCallback(async () => {
    if (!open || !programId || !requirement || previewProgress) return;
    try {
      const usage = await fetchCodexRequirementUsage(programId, requirement.requirementKey);
      setUsageByItem(Object.fromEntries(usage.tasks.map((task) => [task.itemKey, task.usage])));
    } catch {
      // 桥接没起或读不回来时不提示：进度本身照常看，消耗那一行留空就行。
      setUsageByItem({});
    }
  }, [open, previewProgress, programId, requirement]);

  const loadContext = useCallback(async () => {
    if (!open || !programId || !requirement || previewProgress) return;
    const [items, requirementPage, health, stageList, moduleList, memberList] = await Promise.all([
      fetchItems(programId, requirement.requirementKey).catch(() => null),
      fetchRequirements({ programId, pageIndex: 1 }).catch(() => null),
      fetchCodexBridgeHealth(programId, preferences.globalTool).catch(() => null),
      fetchStages(programId).catch(() => null),
      fetchModules(programId).catch(() => null),
      fetchProgramMembers(programId).catch(() => null),
    ]);
    setItemCatalog(items?.data ?? []);
    setRequirements(requirementPage?.data ?? []);
    setBridgeReady(Boolean(health?.ready));
    setStages(stageList ?? []);
    setModules(moduleList ?? []);
    setOwnerOptions((memberList ?? [])
      .filter((member) => Boolean(member.id))
      .map((member) => ({ value: member.id, label: member.displayName || member.username || member.id })));
  }, [open, preferences.globalTool, previewProgress, programId, requirement]);

  useEffect(() => {
    if (!open) {
      setProgress(null);
      setError("");
      setSelectedKeys([]);
      setChatItem(null);
      setStartTestingCases(false);
      setDocumentItem(null);
      setEditItem(null);
      setBridgeReady(false);
      setConstraintsOpen(false);
      setExecutionConstraints("");
      setPendingItems([]);
      setRedoingBatchKey("");
      setUsageByItem({});
      return;
    }
    if (previewProgress) {
      setProgress(previewProgress);
      setError("");
      return;
    }
    void load();
    void loadContext();
    void loadUsage();
    const timer = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(timer);
  }, [load, loadContext, loadUsage, open, previewProgress]);

  const stepLabel = useCallback((index: number) => fill(t("delivery.progress.step"), { index }), [t]);
  /** 一行一个拆解批次：按 seq 排，批次外的任务收在末尾的「未归批次」一行里。 */
  const planningGroups = useMemo<PlanningGroup[]>(() => {
    const itemsByBatch = new Map<string, DeliveryItemRecord[]>();
    for (const item of progress?.items ?? []) {
      const key = item.planningBatchKey || "";
      itemsByBatch.set(key, [...(itemsByBatch.get(key) ?? []), item]);
    }
    const groups: PlanningGroup[] = [];
    for (const batch of [...(progress?.planningBatches ?? [])].sort((left, right) => left.seq - right.seq)) {
      const items = itemsByBatch.get(batch.batchKey) ?? [];
      itemsByBatch.delete(batch.batchKey);
      if (!items.length) continue;
      groups.push({
        key: batch.batchKey,
        title: batch.title || fill(t("delivery.progress.planningBatchTitle"), { seq: batch.seq }),
        hint: batch.createdByName,
        batch,
        items: [...items].sort(taskOrder),
      });
    }
    // 空批次键、以及批次记录已被删掉的孤儿任务，都并到最后一行，不能让任务从总览里消失。
    const ungrouped = Array.from(itemsByBatch.values()).flat().sort(taskOrder);
    if (ungrouped.length) {
      groups.push({
        key: "",
        title: t("delivery.progress.planningBatchUngrouped"),
        hint: t("delivery.progress.planningBatchUngroupedHint"),
        items: ungrouped,
      });
    }
    return groups;
  }, [progress?.items, progress?.planningBatches, t]);
  const runningBatches = useMemo(
    () => (progress?.batches ?? []).filter((batch) => batch.status === "running"),
    [progress?.batches],
  );
  const batchByItem = useMemo(() => {
    const contexts = new Map<string, ItemBatchContext>();
    for (const batch of progress?.batches ?? []) {
      for (const item of batch.items ?? []) {
        if (!contexts.has(item.itemKey)) {
          contexts.set(item.itemKey, { batch, itemStatus: item.status, message: item.message });
        }
      }
    }
    return contexts;
  }, [progress?.batches]);

  /** 点任务卡片就在进度窗里就地开编辑抽屉，不再关窗跳走。 */
  const openItem = (item: DeliveryItemRecord) => {
    setEditItem(item);
  };

  const selectableItems = useMemo(
    () => (progress?.items ?? []).filter(selectable),
    [progress?.items],
  );
  const selectedItems = useMemo(
    () => selectableItems.filter((item) => selectedKeys.includes(item.itemKey)),
    [selectableItems, selectedKeys],
  );

  const allSelected = selectableItems.length > 0 && selectedItems.length === selectableItems.length;
  // 勾选里只要有已完成任务，这次批量就是「再做一次」。
  const selectedRedo = selectedItems.some((item) => item.status === "done");

  const toggleAll = (checked: boolean) => {
    setSelectedKeys(checked ? selectableItems.map((item) => item.itemKey) : []);
  };

  /** 按一行（一个拆解批次）整批勾选或取消。 */
  const toggleGroup = (items: DeliveryItemRecord[], checked: boolean) => {
    const keys = items.map((item) => item.itemKey);
    setSelectedKeys((current) => (checked
      ? Array.from(new Set([...current, ...keys]))
      : current.filter((key) => !keys.includes(key))));
  };

  const toggleSelected = (itemKey: string, checked: boolean) => {
    setSelectedKeys((current) => (checked
      ? Array.from(new Set([...current, itemKey]))
      : current.filter((key) => key !== itemKey)));
  };

  /** 单条任务直接发起：走任务自身阶段的模型偏好，和任务面板上点执行是同一条路。
   * 已完成的任务走「再做一次」：状态不回滚，只是再开一轮执行实例。 */
  const startItem = useCallback(async (item: DeliveryItemRecord) => {
    setStartingKey(item.itemKey);
    try {
      const config = configFor(sceneForPhase(item.phase));
      await startCodexExecution(
        programId,
        item,
        modelForConfig(config),
        config.tool,
        effortForConfig(config),
        config.tool === "claude" && config.claudeFastMode,
        item.status === "done",
      );
      message.success(t("delivery.progress.started"));
      window.setTimeout(() => void load(true), 500);
    } catch (nextError) {
      message.error((nextError as Error).message);
    } finally {
      setStartingKey("");
    }
  }, [configFor, load, programId, t]);

  /** 停这一条：中断它当前的回合，其它任务照跑。 */
  const stopItem = useCallback(async (item: DeliveryItemRecord) => {
    setStoppingKey(item.itemKey);
    try {
      const result = await stopCodexConversation(programId, item.itemKey, "", configFor(sceneForPhase(item.phase)).tool);
      if (result.alreadyFinished) message.info(t("delivery.progress.stopAlreadyFinished"));
      else message.success(t("delivery.progress.stopRequested"));
      window.setTimeout(() => void load(true), 500);
    } catch (nextError) {
      message.error((nextError as Error).message);
    } finally {
      setStoppingKey("");
    }
  }, [configFor, load, programId, t]);

  /** 全部停止：在跑的任务逐个中断，还在排队的批量 / 串行队列一并取消，服务端的执行批次一并收尾。 */
  const stopAll = useCallback(async () => {
    setStoppingAll(true);
    try {
      const result = await stopAllCodexExecutions(programId, preferences.globalTool);
      message.success(
        fill(t("delivery.progress.stopAllDone"), {
          count: result.itemKeys.length,
          batches: result.cancelledBatchIds.length,
        }),
      );
      window.setTimeout(() => void load(true), 500);
    } catch (nextError) {
      message.error((nextError as Error).message);
    } finally {
      setStoppingAll(false);
    }
  }, [load, preferences.globalTool, programId, t]);

  /**
   * 批量发起，流程与任务面板的批量执行一致：先确认前置条件，再由服务端建一条执行批次，
   * 本窗口的「当前执行批次」随后就能看到。已完成任务在列时按「再做一次」发起。
   */
  const startPending = useCallback(async () => {
    if (!pendingItems.length) return;
    setBatchStarting(true);
    try {
      const first = pendingItems[0];
      const config = configFor(sceneForPhase(first.phase));
      const result = await startCodexExecutionBatch(
        programId,
        pendingItems.map((item) => item.itemKey),
        modelForConfig(config),
        config.tool,
        executionConstraints.trim(),
        effortForConfig(config),
        config.tool === "claude" && config.claudeFastMode,
        pendingItems.some((item) => item.status === "done"),
      );
      message.success(fill(t("delivery.execution.batchStarted"), { count: result.itemKeys.length }));
      setSelectedKeys((current) => current.filter((itemKey) => !result.itemKeys.includes(itemKey)));
      setConstraintsOpen(false);
      setExecutionConstraints("");
      setPendingItems([]);
      setRedoingBatchKey("");
      window.setTimeout(() => void load(true), 500);
    } catch (nextError) {
      message.error((nextError as Error).message);
    } finally {
      setBatchStarting(false);
    }
  }, [configFor, executionConstraints, load, pendingItems, programId, t]);

  /** 打开前置条件弹框，并记下这次要跑的任务集合。 */
  const askConstraints = useCallback((items: DeliveryItemRecord[], batchKey = "") => {
    if (!items.length) return;
    setPendingItems(items);
    setRedoingBatchKey(batchKey);
    setExecutionConstraints("");
    setConstraintsOpen(true);
  }, []);

  /** 抽屉里改任务：改完就地刷新进度，抽屉本身留在当前任务上。 */
  const saveItem = useCallback(async (payload: Omit<PatchItemPayload, "programId">) => {
    setEditSaving(true);
    try {
      const saved = await patchItem({ ...payload, programId });
      setEditItem(saved);
      message.success(t("delivery.saved"));
      notifyDeliveryTasksChanged();
      await Promise.all([load(true), loadContext()]);
      return true;
    } catch (nextError) {
      message.error((nextError as Error).message);
      return false;
    } finally {
      setEditSaving(false);
    }
  }, [load, loadContext, programId, t]);

  const removeItem = useCallback(async (itemKey: string) => {
    try {
      await deleteItem(programId, itemKey);
      setEditItem(null);
      notifyDeliveryTasksChanged();
      await Promise.all([load(true), loadContext()]);
      return true;
    } catch (nextError) {
      message.error((nextError as Error).message);
      return false;
    }
  }, [load, loadContext, programId]);

  const advanceItemPhase = useCallback(async (phase: "requirement" | "development", item: DeliveryItemRecord) => {
    try {
      const [advanced] = await advanceDeliveryPhase({
        programId,
        phase,
        items: [{ itemKey: item.itemKey, version: item.version }],
      });
      if (advanced) setEditItem(advanced);
      message.success(t("delivery.phase.advanced"));
      await load(true);
      return true;
    } catch (nextError) {
      message.error((nextError as Error).message);
      return false;
    }
  }, [load, programId, t]);

  /** 「执行后续」：按进度窗当前的排序，从这条任务起往后的可执行任务整批发起。 */
  const executeFollowing = useCallback(async (item: DeliveryItemRecord) => {
    const ordered = (progress?.items ?? []).filter(selectable).sort(taskOrder);
    const from = ordered.findIndex((candidate) => candidate.itemKey === item.itemKey);
    if (from < 0) return false;
    setEditItem(null);
    askConstraints(ordered.slice(from));
    return false;
  }, [askConstraints, progress?.items]);

  const taskNode = (item: DeliveryItemRecord) => {
    const batch = batchByItem.get(item.itemKey);
    const canStart = selectable(item);
    const redo = item.status === "done";
    return (
      <div
        className={`delivery-progress-node is-${item.status}`}
        data-delivery-item-key={item.itemKey}
        key={item.itemKey}
      >
        <span className="delivery-progress-node__lead">
          {canStart ? (
            <Checkbox
              aria-label={t("delivery.progress.pick")}
              checked={selectedKeys.includes(item.itemKey)}
              disabled={Boolean(previewProgress)}
              onChange={(event) => toggleSelected(item.itemKey, event.target.checked)}
            />
          ) : null}
          <span className="delivery-progress-node__status">{statusIcon(item.status, item.status === "doing")}</span>
        </span>
        <button
          className="delivery-progress-node__body"
          type="button"
          onClick={() => openItem(item)}
        >
          <b title={item.title}>{item.title || item.itemKey}</b>
          <span className="delivery-progress-node__meta">
            <span className="delivery-progress-node__meta-line">
              <code className="manager-mono">{item.itemKey}</code>
              <em>{t(`delivery.phase.${item.phase}`)}</em>
            </span>
            <DeliveryTaskRunDuration item={item} />
            <DeliveryTaskUsageTags usage={usageByItem[item.itemKey]} />
          </span>
          {batch?.batch.status === "running" ? (
            <span className="delivery-progress-node__batch">
              <DeploymentUnitOutlined />
              {t("delivery.progress.inBatch")}
              <code className="manager-mono" title={batch.batch.batchId}>{batch.batch.batchId}</code>
            </span>
          ) : null}
        </button>
        <span className="delivery-progress-node__actions">
          {canStart ? (
            <Tooltip title={bridgeReady ? t(redo ? "delivery.progress.redoItem" : "delivery.progress.startItem") : t("delivery.progress.bridgeOffline")}>
              <Button
                aria-label={t(redo ? "delivery.progress.redoItem" : "delivery.progress.startItem")}
                disabled={!bridgeReady || Boolean(previewProgress)}
                icon={redo ? <RedoOutlined /> : <PlayCircleOutlined />}
                loading={startingKey === item.itemKey}
                size="small"
                type="text"
                onClick={() => void startItem(item)}
              />
            </Tooltip>
          ) : null}
          {item.status === "doing" ? (
            <Tooltip title={t("delivery.progress.stopItem")}>
              <Button
                aria-label={t("delivery.progress.stopItem")}
                danger
                disabled={Boolean(previewProgress)}
                icon={<PauseCircleOutlined />}
                loading={stoppingKey === item.itemKey}
                size="small"
                type="text"
                onClick={() => void stopItem(item)}
              />
            </Tooltip>
          ) : null}
          <Tooltip title={t("delivery.progress.chat")}>
            <Button
              aria-label={t("delivery.progress.chat")}
              disabled={Boolean(previewProgress)}
              icon={<MessageOutlined />}
              size="small"
              type="text"
              onClick={() => setChatItem(item)}
            />
          </Tooltip>
          <Tooltip title={t("delivery.progress.document")}>
            <Button
              aria-label={t("delivery.progress.document")}
              disabled={Boolean(previewProgress)}
              icon={<FileTextOutlined />}
              size="small"
              type="text"
              onClick={() => setDocumentItem(item)}
            />
          </Tooltip>
        </span>
      </div>
    );
  };

  return (
    <Modal
      className="delivery-progress-modal"
      destroyOnClose
      footer={null}
      open={open}
      width="min(1180px, calc(100vw - 32px))"
      onCancel={onClose}
      title={requirement ? (
        <div className="delivery-progress-title">
          <span>{t("delivery.progress.title")}</span>
          <b>{requirement.name || requirement.requirementKey}</b>
          <code className="manager-mono">{requirement.requirementKey}</code>
        </div>
      ) : null}
    >
      <div className="delivery-progress">
          {error ? <Alert type="error" showIcon message={error} /> : null}
          {progress ? (
            <>
              <header className="delivery-progress__summary">
                <div className="delivery-progress__meter">
                  <Progress type="circle" size={68} percent={Math.round(progress.progress)} />
                  <span>
                    <b>{t("delivery.progress.overall")}</b>
                    <small>{fill(t("delivery.progress.counted"), { counted: progress.countedCount, total: progress.totalCount })}</small>
                  </span>
                </div>
                <DeliveryRunDurationTotal
                  items={progress.items}
                  runCount={progress.runCount}
                  totalRunDurationMs={progress.totalRunDurationMs}
                />
                <div className="delivery-progress__stats">
                  {DELIVERY_STATUSES.map((status) => (
                    <div className={`delivery-progress-stat is-${status}`} key={status}>
                      <span>{statusIcon(status, (progress.statusCounts?.[status] ?? 0) > 0)}</span>
                      <b className="manager-mono">{progress.statusCounts?.[status] ?? 0}</b>
                      <small>{t(`delivery.progress.status.${status}`)}</small>
                    </div>
                  ))}
                </div>
                <Tooltip title={t("delivery.progress.refresh")}>
                  <Button
                    aria-label={t("delivery.progress.refresh")}
                    icon={<ReloadOutlined />}
                    loading={loading}
                    shape="circle"
                    type="text"
                    onClick={() => void load()}
                  />
                </Tooltip>
              </header>

              <section className="delivery-progress__section">
                <div className="delivery-progress__section-head">
                  <span><ApartmentOutlined /></span>
                  <div>
                    <b>{t("delivery.progress.planningBatches")}</b>
                    <small>{t("delivery.progress.planningBatchHint")}</small>
                  </div>
                </div>
                {previewProgress ? null : (
                  <div className="delivery-progress__toolbar">
                    <Checkbox
                      checked={allSelected}
                      disabled={selectableItems.length === 0}
                      indeterminate={selectedItems.length > 0 && !allSelected}
                      onChange={(event) => toggleAll(event.target.checked)}
                    >
                      {fill(t("delivery.progress.selectAll"), { count: selectableItems.length })}
                    </Checkbox>
                    <span className="delivery-progress__toolbar-actions">
                      <Popconfirm
                        cancelText={t("common.cancel")}
                        okText={t("delivery.progress.stopAll")}
                        title={t("delivery.progress.stopAllConfirm")}
                        onConfirm={() => void stopAll()}
                      >
                        <Button danger disabled={!bridgeReady} icon={<PoweroffOutlined />} loading={stoppingAll} size="small">
                          {t("delivery.progress.stopAll")}
                        </Button>
                      </Popconfirm>
                      <Tooltip title={bridgeReady ? t(selectedRedo ? "delivery.progress.redoHint" : "delivery.execution.batchHint") : t("delivery.progress.bridgeOffline")}>
                        <Button
                          disabled={!bridgeReady || selectedItems.length === 0}
                          icon={selectedRedo ? <RedoOutlined /> : <PlayCircleOutlined />}
                          loading={batchStarting && !redoingBatchKey}
                          size="small"
                          type="primary"
                          onClick={() => askConstraints(selectedItems)}
                        >
                          {fill(
                            t(selectedRedo ? "delivery.progress.redoSelected" : "delivery.execution.batchSelected"),
                            { count: selectedItems.length },
                          )}
                        </Button>
                      </Tooltip>
                    </span>
                  </div>
                )}
                {planningGroups.length ? (
                  <div className="delivery-progress-plan-rows">
                    {planningGroups.map((group) => {
                      const groupSelectable = group.items.filter(selectable);
                      const groupSelected = groupSelectable.filter((item) => selectedKeys.includes(item.itemKey));
                      return (
                        <PlanningBatchRow
                          canRedo={bridgeReady}
                          disabled={Boolean(previewProgress)}
                          group={group}
                          key={group.key || "ungrouped"}
                          redoHint={t("delivery.progress.redoHint")}
                          redoing={batchStarting && redoingBatchKey === (group.key || "ungrouped")}
                          renderNode={taskNode}
                          selectableCount={groupSelectable.length}
                          selectedCount={groupSelected.length}
                          stepLabel={stepLabel}
                          t={t}
                          onRedo={() => {
                            setSelectedKeys((current) => Array.from(new Set([
                              ...current,
                              ...groupSelectable.map((item) => item.itemKey),
                            ])));
                            askConstraints(groupSelectable, group.key || "ungrouped");
                          }}
                          onToggleAll={(checked) => toggleGroup(groupSelectable, checked)}
                        />
                      );
                    })}
                  </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.progress.empty")} />}
              </section>

              <section className="delivery-progress__section">
                <div className="delivery-progress__section-head">
                  <span><DeploymentUnitOutlined /></span>
                  <div>
                    <b>{t("delivery.progress.activeBatches")}</b>
                    <small>{fill(t("delivery.progress.activeBatchCount"), { count: runningBatches.length })}</small>
                  </div>
                </div>
                {runningBatches.length ? (
                  <div className="delivery-progress-batches">
                    {runningBatches.map((batch) => {
                      const completed = batch.items.filter((item) => item.status === "completed").length;
                      const running = batch.items.filter((item) => item.status === "running").length;
                      return (
                        <article className="delivery-progress-batch" key={batch.batchId}>
                          <header>
                            <span className="manager-dot-live" />
                            <code className="manager-mono" title={batch.batchId}>{batch.batchId}</code>
                            <em>{t(`delivery.notificationCenter.batchMode.${batch.mode}`)}</em>
                          </header>
                          <b>{fill(t("delivery.progress.batchSummary"), { completed, running, total: batch.items.length })}</b>
                          <Progress percent={batch.items.length ? Math.round(completed / batch.items.length * 100) : 0} showInfo={false} size="small" />
                        </article>
                      );
                    })}
                  </div>
                ) : <p className="delivery-progress__quiet">{t("delivery.progress.noActiveBatch")}</p>}
              </section>

              <section className="delivery-progress__groups">
                {DETAIL_STATUSES.map((status) => {
                  const items = progress.items.filter((item) => item.status === status).sort(taskOrder);
                  return (
                    <article className={`delivery-progress-group is-${status}`} key={status}>
                      <header>
                        <span>{statusIcon(status, items.length > 0)}</span>
                        <b>{t(`delivery.progress.status.${status}`)}</b>
                        <em className="manager-mono">{items.length}</em>
                      </header>
                      {items.length ? (
                        <div className="delivery-progress-group__items">
                          {items.map((item) => {
                            const context = batchByItem.get(item.itemKey);
                            const reason = context?.message || item.note;
                            return (
                              <button key={item.itemKey} type="button" onClick={() => openItem(item)}>
                                <span>
                                  <b>{item.title || item.itemKey}</b>
                                  <code className="manager-mono">{item.itemKey}</code>
                                </span>
                                {reason ? <small title={reason}>{reason}</small> : (
                                  <small><UserOutlined /> {item.ownerName || t("delivery.requirement.unassigned")}</small>
                                )}
                                <RightOutlined />
                              </button>
                            );
                          })}
                        </div>
                      ) : <p>{t("delivery.progress.groupEmpty")}</p>}
                    </article>
                  );
                })}
              </section>
            </>
          ) : loading ? (
            <div className="delivery-progress__loading" role="status">
              <Spin size="large" />
              <span>{t("delivery.progress.loading")}</span>
            </div>
          ) : <Empty description={t("delivery.progress.empty")} />}
      </div>

      <Modal
        open={constraintsOpen}
        title={t("delivery.execution.constraintsTitle")}
        okText={t("delivery.execution.confirmStart")}
        confirmLoading={batchStarting}
        onCancel={() => {
          setConstraintsOpen(false);
          setExecutionConstraints("");
          setPendingItems([]);
          setRedoingBatchKey("");
        }}
        onOk={() => void startPending()}
      >
        <div className="delivery-drawer">
          <label>
            {t("delivery.execution.constraintsLabel")}
            <Input.TextArea
              autoFocus
              rows={5}
              maxLength={32768}
              showCount
              value={executionConstraints}
              placeholder={t("delivery.execution.constraintsPlaceholder")}
              onChange={(event) => setExecutionConstraints(event.target.value)}
            />
            <small className="delivery-field-hint">{t("delivery.execution.constraintsHint")}</small>
          </label>
        </div>
      </Modal>

      <DeliveryTaskSessionModal
        open={Boolean(chatItem)}
        item={chatItem}
        programId={programId}
        bizLine={bizLine}
        requirements={requirements}
        itemCatalog={itemCatalog}
        codexBridgeReady={bridgeReady}
        startTestingCasesOnOpen={startTestingCases}
        onClose={() => {
          setChatItem(null);
          setStartTestingCases(false);
        }}
        onOpenEditor={(item) => {
          setChatItem(null);
          setStartTestingCases(false);
          openItem(item);
        }}
        onChanged={() => load(true)}
      />

      <Modal
        className="delivery-progress-document-modal"
        destroyOnClose
        footer={null}
        open={Boolean(documentItem)}
        title={documentItem ? fill(t("delivery.progress.documentTitle"), { title: documentItem.title || documentItem.itemKey }) : null}
        width="min(1080px, calc(100vw - 48px))"
        onCancel={() => setDocumentItem(null)}
      >
        <DeliveryTaskDocumentPanel
          codexBridgeReady={bridgeReady}
          item={documentItem}
          programId={programId}
          scroll="cap"
        />
      </Modal>

      <DeliveryItemDrawer
        open={Boolean(editItem)}
        item={editItem}
        bizLine={bizLine}
        programId={programId}
        stages={stages}
        modules={modules}
        items={itemCatalog.length ? itemCatalog : progress?.items ?? []}
        ownerOptions={ownerOptions}
        submitting={editSaving}
        codexBridgeReady={bridgeReady}
        executing={startingKey === editItem?.itemKey}
        onClose={() => setEditItem(null)}
        onSave={saveItem}
        onExecute={async (item) => {
          await startItem(item);
          return true;
        }}
        onOpenTestingCasesChat={(item, startNewConversation = false) => {
          setEditItem(null);
          setStartTestingCases(startNewConversation);
          setChatItem(item);
        }}
        onExecuteFollowing={executeFollowing}
        onDelete={removeItem}
        onAdvancePhase={advanceItemPhase}
      />
    </Modal>
  );
}
