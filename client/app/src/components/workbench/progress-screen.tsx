"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  CirclePause,
  FileText,
  Layers,
  ListChecks,
  ListRestart,
  LoaderCircle,
  MessageSquareText,
  Play,
  RotateCw,
  Square,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { getRequirementProgress, type DeliveryItem, type ItemPhase, type ItemStatus, type RequirementProgress } from "@/api/management.api";
import { executeTask, executeTasks, fetchRequirementUsage, findActiveExecutionCommands, stopAllExecutions } from "@/api/workbench.api";
import { cancelCommand } from "@/api/command.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { DocumentSheet } from "@/components/workbench/document-sheet";
import { formatRunDuration, TaskRunDuration, useTotalRunDuration } from "@/components/workbench/run-duration";
import { TaskUsageLine } from "@/components/workbench/usage-sheet";
import type { ProviderUsage } from "@/features/workbench/types";

const phaseLabels: Record<ItemPhase, string> = { requirement: "梳理需求", development: "动作执行", testing: "成品测试" };
const statusLabels: Record<ItemStatus, string> = { todo: "待办", doing: "执行中", done: "已完成", blocked: "受阻", dropped: "已放弃" };
const phaseOrder: ItemPhase[] = ["requirement", "development", "testing"];
const batchStatusLabels: Record<string, string> = {
  pending: "排队中", running: "执行中", succeeded: "已完成", completed: "已完成", failed: "执行失败", cancelled: "已取消",
};

/** 任务铺开的两种口径：按交付阶段看推进，按拆解批次看「这批拆出来的活干完没有」。 */
type GroupBy = "phase" | "batch";

interface TaskGroup {
  key: string;
  title: string;
  hint: string;
  items: DeliveryItem[];
}

/** 已放弃的任务不参与勾选和整批执行：它本来就不打算做，跟着批次再跑一遍没有意义。 */
function selectable(item: DeliveryItem) {
  return item.status !== "dropped";
}

/** 任务进度页：上半屏是需求整体推进，下半屏按阶段铺任务，选中后可直接发起执行。 */
export function ProgressScreen({ requirementKey }: { requirementKey: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const programId = Number(searchParams.get("programId") ?? 0);

  const [progress, setProgress] = useState<RequirementProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("phase");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 消耗单独拉：汇总要逐条任务问会话表，比进度慢，不能让它卡住任务列表。
  const [usageByTask, setUsageByTask] = useState<Record<string, ProviderUsage>>({});
  // 任务文档面板整页只有一个：任务行多，不能每行都挂一份面板。
  const [documentTask, setDocumentTask] = useState<DeliveryItem | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!programId || !requirementKey) {
      setError("缺少项目或需求标识。");
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      setProgress(await getRequirementProgress(programId, requirementKey));
      setError("");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取任务进度。");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [programId, requirementKey]);

  const loadUsage = useCallback(async () => {
    if (!programId || !requirementKey) return;
    try {
      const result = await fetchRequirementUsage(programId, requirementKey);
      setUsageByTask(Object.fromEntries(result.tasks.map((task) => [task.itemKey, task.usage])));
    } catch {
      // 消耗读不回来不影响看进度：这一段留空就行，不要把整页推进错误提示。
      setUsageByTask({});
    }
  }, [programId, requirementKey]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { void loadUsage(); }, [loadUsage]);

  const running = useMemo(() => (progress?.items ?? []).some((item) => item.status === "doing"), [progress]);

  // 有任务在跑时自动回读，手机放着不动也能看到推进。
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void load(true); }, 15_000);
    return () => window.clearInterval(timer);
  }, [load, running]);

  /**
   * 任务分组。
   *
   * 按阶段是原来的口径；按批次一行一个拆解批次，按 seq 排，批次记录被删掉或批次上线
   * 前写入的任务收在末尾的「未归批次」里 —— 任何情况下都不能让任务从总览里消失。
   */
  const groups = useMemo<TaskGroup[]>(() => {
    const items = progress?.items ?? [];
    if (groupBy === "phase") {
      return phaseOrder
        .map((phase) => ({ key: phase, title: phaseLabels[phase], hint: "", items: items.filter((item) => item.phase === phase) }))
        .filter((group) => group.items.length > 0);
    }
    const itemsByBatch = new Map<string, DeliveryItem[]>();
    for (const item of items) {
      const key = item.planningBatchKey || "";
      itemsByBatch.set(key, [...(itemsByBatch.get(key) ?? []), item]);
    }
    const result: TaskGroup[] = [];
    for (const batch of [...(progress?.planningBatches ?? [])].sort((left, right) => left.seq - right.seq)) {
      const batchItems = itemsByBatch.get(batch.batchKey) ?? [];
      itemsByBatch.delete(batch.batchKey);
      if (!batchItems.length) continue;
      result.push({
        key: batch.batchKey,
        title: batch.title || `第 ${batch.seq} 次拆解`,
        hint: batch.summary || batch.createdByName,
        items: batchItems,
      });
    }
    const ungrouped = Array.from(itemsByBatch.values()).flat();
    if (ungrouped.length) {
      result.push({ key: "", title: "未归批次", hint: "拆解批次上线前写入或手工新建的任务", items: ungrouped });
    }
    return result;
  }, [groupBy, progress]);

  // 全选只认当前铺出来、且还打算做的任务：勾中的必须是列表上看得见的那几条。
  const allItemKeys = useMemo(
    () => groups.flatMap((group) => group.items.filter(selectable).map((item) => item.itemKey)),
    [groups],
  );
  const allSelected = allItemKeys.length > 0 && selected.length >= allItemKeys.length;

  /**
   * 停止全部执行。
   *
   * 先把还在飞的执行命令逐条撤掉：排在队列里的当场作废，正在跑的由 Worker 在下一次
   * 活动上报里收到取消。执行通道空出来之后，再补一条 task.stop-all 收尾本机残留的
   * 回合 —— 反过来先发停止命令的话，它只会排在正跑着的那条后面干等。
   */
  const stopAll = async () => {
    for (const command of await findActiveExecutionCommands(programId)) {
      await cancelCommand(command.commandId, "用户在手机上停止了全部执行");
    }
    await stopAllExecutions(programId);
  };

  const submit = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(`${label}已提交，可在运行记录里跟进。`);
      setSelected([]);
      setSelecting(false);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : `${label}未提交。`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (itemKey: string) => {
    setSelected((current) => current.includes(itemKey) ? current.filter((value) => value !== itemKey) : [...current, itemKey]);
  };

  const toggleAll = () => { setSelected(allSelected ? [] : allItemKeys); };

  /** 整组勾选／取消：多选态下按批次运营，一次点完这一批。 */
  const toggleGroup = (keys: string[], checked: boolean) => {
    setSelected((current) => (checked
      ? Array.from(new Set([...current, ...keys]))
      : current.filter((key) => !keys.includes(key))));
  };

  const counts = progress?.statusCounts ?? {};
  // 全部任务加起来跑了多久；正在跑的那几轮实时走。
  const totalRunDuration = useTotalRunDuration(progress?.items ?? [], progress?.totalRunDurationMs ?? 0);

  return (
    <main className="screen progress-screen">
      <div className="screen-title-row is-detail">
        <div>
          <p className="eyebrow">任务进度</p>
          <h1>{progress?.requirementName || requirementKey}</h1>
        </div>
        <div className="stack-actions">
          <button className="icon-button" type="button" onClick={() => router.back()} aria-label="返回" title="返回"><ArrowLeft size={22} /></button>
          <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新进度" title="刷新进度" disabled={loading}>
            <RotateCw size={22} className={loading ? "spin-icon" : ""} />
          </button>
        </div>
      </div>

      {loading && !progress ? <LoadingState title="正在读取任务进度" /> : null}
      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-message is-success" role="status">{notice}</p> : null}

      {progress ? (
        <>
          <section className="card progress-hero">
            <ProgressRing value={Math.round(progress.progress)} />
            <div className="progress-hero__meta">
              <div><strong>{progress.countedCount}</strong><span>计入任务</span></div>
              <div><strong>{counts.done ?? 0}</strong><span>已完成</span></div>
              <div><strong>{counts.doing ?? 0}</strong><span>执行中</span></div>
              <div><strong>{counts.blocked ?? 0}</strong><span>受阻</span></div>
              <div><strong>{totalRunDuration ? formatRunDuration(totalRunDuration) : "—"}</strong><span>累计耗时</span></div>
            </div>
          </section>

          <div className="progress-toolbar">
            <button
              className={`chip-button${groupBy === "batch" ? " is-primary" : ""}`}
              type="button"
              onClick={() => setGroupBy((current) => (current === "phase" ? "batch" : "phase"))}
            >
              <Layers size={18} aria-hidden="true" />分组：{groupBy === "phase" ? "按阶段" : "按批次"}
            </button>
            <button className={`chip-button${selecting ? " is-primary" : ""}`} type="button" onClick={() => { setSelecting((current) => !current); setSelected([]); }}>
              <ListChecks size={18} aria-hidden="true" />{selecting ? "退出多选" : "多选执行"}
            </button>
            {selecting ? (
              <button className="chip-button" type="button" disabled={busy || !allItemKeys.length} onClick={toggleAll}>
                {allSelected ? <Square size={18} aria-hidden="true" /> : <CheckCheck size={18} aria-hidden="true" />}
                {allSelected ? "全不选" : "全选"}
              </button>
            ) : null}
            <button className="chip-button" type="button" disabled={busy || !running} onClick={() => void submit("停止全部执行", stopAll)}>
              <CirclePause size={18} aria-hidden="true" />停止全部
            </button>
          </div>

          {groups.map((group) => {
            const groupKeys = group.items.filter(selectable).map((item) => item.itemKey);
            const groupSelected = groupKeys.filter((key) => selected.includes(key)).length;
            const groupAllSelected = groupKeys.length > 0 && groupSelected === groupKeys.length;
            const groupDone = group.items.filter((item) => item.status === "done").length;
            return (
              <section className="progress-group" key={group.key || "ungrouped"}>
                {groupBy === "batch" ? (
                  <div className="progress-group__head">
                    <div className="progress-group__title">
                      <strong>{group.title}</strong>
                      <small>{groupDone}/{group.items.length} 完成{group.hint ? ` · ${group.hint}` : ""}</small>
                    </div>
                    <div className="progress-group__meter" aria-hidden="true">
                      <span style={{ width: `${group.items.length ? Math.round((groupDone / group.items.length) * 100) : 0}%` }} />
                    </div>
                    <div className="progress-group__actions">
                      {selecting ? (
                        <button className="chip-button" type="button" disabled={busy || !groupKeys.length} onClick={() => toggleGroup(groupKeys, !groupAllSelected)}>
                          {groupAllSelected ? <Square size={18} aria-hidden="true" /> : <CheckCheck size={18} aria-hidden="true" />}
                          {groupAllSelected ? "取消本批" : "全选本批"}
                        </button>
                      ) : null}
                      {/* 整批发起走依赖顺序：同一批拆出来的任务多半前后咬着，平铺并发会撞在一起。 */}
                      <button
                        className="chip-button"
                        type="button"
                        disabled={busy || !groupKeys.length}
                        onClick={() => void submit(`执行 ${group.title}`, () => executeTasks(programId, groupKeys, true))}
                      >
                        <ListRestart size={18} aria-hidden="true" />本批按依赖执行
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="section-heading"><span>{group.title}</span><span className="muted">{group.items.length}</span></div>
                )}
                {group.items.map((item) => (
                  <TaskRow
                    key={item.itemKey}
                    item={item}
                    programId={programId}
                    selecting={selecting}
                    selected={selected.includes(item.itemKey)}
                    busy={busy}
                    phaseLabel={groupBy === "batch" ? phaseLabels[item.phase] : ""}
                    onToggle={() => toggle(item.itemKey)}
                    onExecute={() => void submit(`执行 ${item.title}`, () => executeTask(programId, item.itemKey))}
                    onOpenDocuments={() => setDocumentTask(item)}
                    usage={usageByTask[item.itemKey]}
                  />
                ))}
              </section>
            );
          })}

          {!groups.length && !loading ? (
            <EmptyState icon={<ListChecks size={24} />} title="这条需求还没有任务" description="先在需求对话里完成拆解，任务会写回任务面板。" />
          ) : null}

          {progress.batches?.length ? (
            <section className="progress-group">
              <div className="section-heading"><span>执行批次</span><span className="muted">{progress.batches.length}</span></div>
              {progress.batches.slice(0, 5).map((batch) => (
                <div className="batch-row" key={batch.batchId}>
                  <div className="batch-row__head">
                    <strong>{batch.mode === "sequence" ? "顺序执行" : "批量执行"}</strong>
                    <span className={`status ${batch.status === "running" ? "is-active" : batch.status === "failed" ? "is-danger" : "is-warning"}`}>{batchStatusLabels[batch.status] ?? batch.status}</span>
                  </div>
                  <small>{batch.completedCount}/{batch.itemCount} 完成{batch.blockedCount ? ` · ${batch.blockedCount} 受阻` : ""} · {batch.createdByName || "未知发起人"}</small>
                  {batch.summary ? <small className="muted">{batch.summary}</small> : null}
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}

      {selecting ? (
        <div className="progress-selection-bar">
          <span>已选 {selected.length}/{allItemKeys.length}</span>
          <button className="button button-primary" type="button" disabled={busy || !selected.length} onClick={() => void submit("批量执行", () => executeTasks(programId, selected, false))}>
            <Play size={19} aria-hidden="true" />批量执行
          </button>
          <button className="button button-secondary" type="button" disabled={busy || !selected.length} onClick={() => void submit("按依赖执行", () => executeTasks(programId, selected, true))}>
            <ListRestart size={19} aria-hidden="true" />按依赖执行
          </button>
        </div>
      ) : null}

      <DocumentSheet
        open={Boolean(documentTask)}
        programId={programId}
        ownerKind="task"
        ownerKey={documentTask?.itemKey ?? ""}
        ownerName={documentTask?.title}
        onClose={() => setDocumentTask(null)}
      />
    </main>
  );
}

function TaskRow({
  item,
  programId,
  selecting,
  selected,
  busy,
  phaseLabel,
  onToggle,
  onExecute,
  onOpenDocuments,
  usage,
}: {
  item: DeliveryItem;
  programId: number;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
  /** 按批次铺任务时分组标题不再是阶段，阶段改挂在任务行上，留空表示不显示。 */
  phaseLabel: string;
  onToggle: () => void;
  onExecute: () => void;
  onOpenDocuments: () => void;
  /** 这条任务的消耗，按执行器分开；还没跑过或还没读回来时为空。 */
  usage?: ProviderUsage;
}) {
  const [open, setOpen] = useState(false);
  // 已放弃的任务在多选态里只展示不勾选，跟全选、整批执行的口径保持一致。
  const canSelect = selectable(item);
  return (
    <article className={`task-row${selected ? " is-selected" : ""}`} data-status={item.status}>
      <div className="task-row__head">
        {selecting ? (
          <input type="checkbox" checked={selected} disabled={!canSelect} onChange={onToggle} aria-label={`选择 ${item.title}`} />
        ) : (
          <span className="task-row__icon" aria-hidden="true">{statusIcon(item.status)}</span>
        )}
        <button className="task-row__body" type="button" onClick={() => (selecting ? (canSelect ? onToggle() : undefined) : setOpen((current) => !current))} aria-expanded={selecting ? undefined : open}>
          <strong>{item.title}</strong>
          <small>{phaseLabel ? `${phaseLabel} · ` : ""}{statusLabels[item.status]} · {item.progress}%{item.ownerName ? ` · ${item.ownerName}` : ""}</small>
        </button>
        {!selecting ? <ChevronDown size={19} className={`requirement-card__chevron${open ? " is-open" : ""}`} aria-hidden="true" /> : null}
      </div>
      <TaskRunDuration item={item} />
      {usage ? <div className="task-row__usage"><TaskUsageLine usage={usage} /></div> : null}
      <div className="task-row__meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, item.status === "done" ? 100 : item.progress))}%` }} /></div>
      {open && !selecting ? (
        <div className="task-row__detail">
          {item.description ? <p>{item.description}</p> : null}
          {item.dependsOnItemKeys.length ? <p className="field-help">依赖 {item.dependsOnItemKeys.length} 个前置任务</p> : null}
          <div className="stack-actions">
            <Link className="chip-button is-primary" href={`/workbench/tasks/${encodeURIComponent(item.itemKey)}/chat?programId=${programId}`}>
              <MessageSquareText size={18} aria-hidden="true" />任务对话
            </Link>
            <button className="chip-button" type="button" disabled={busy} onClick={onExecute}><Play size={18} aria-hidden="true" />执行</button>
            <button className="chip-button" type="button" onClick={onOpenDocuments}><FileText size={18} aria-hidden="true" />文档</button>
            <Link className="chip-button" href={`/projects/${programId}/tasks/${encodeURIComponent(item.itemKey)}`}>任务详情</Link>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function statusIcon(status: ItemStatus) {
  if (status === "done") return <CheckCircle2 size={19} />;
  if (status === "doing") return <LoaderCircle size={19} className="spin-icon" />;
  if (status === "blocked" || status === "dropped") return <CircleSlash size={19} />;
  return <ListChecks size={19} />;
}

function ProgressRing({ value }: { value: number }) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-ring" style={{ ["--ring-value" as string]: `${safe * 3.6}deg` }} role="img" aria-label={`完成度 ${safe}%`}>
      <span>{safe}%</span>
    </div>
  );
}
