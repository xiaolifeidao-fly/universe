"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  CirclePause,
  ListChecks,
  ListRestart,
  LoaderCircle,
  MessageSquareText,
  Play,
  RotateCw,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { getRequirementProgress, type DeliveryItem, type ItemPhase, type ItemStatus, type RequirementProgress } from "@/api/management.api";
import { executeTask, executeTasks, fetchRequirementUsage, findActiveExecutionCommands, stopAllExecutions } from "@/api/workbench.api";
import { cancelCommand } from "@/api/command.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { formatRunDuration, TaskRunDuration, useTotalRunDuration } from "@/components/workbench/run-duration";
import { TaskUsageLine } from "@/components/workbench/usage-sheet";
import type { ProviderUsage } from "@/features/workbench/types";

const phaseLabels: Record<ItemPhase, string> = { requirement: "梳理需求", development: "动作执行", testing: "成品测试" };
const statusLabels: Record<ItemStatus, string> = { todo: "待办", doing: "执行中", done: "已完成", blocked: "受阻", dropped: "已放弃" };
const phaseOrder: ItemPhase[] = ["requirement", "development", "testing"];
const batchStatusLabels: Record<string, string> = {
  pending: "排队中", running: "执行中", succeeded: "已完成", completed: "已完成", failed: "执行失败", cancelled: "已取消",
};

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
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 消耗单独拉：汇总要逐条任务问会话表，比进度慢，不能让它卡住任务列表。
  const [usageByTask, setUsageByTask] = useState<Record<string, ProviderUsage>>({});

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

  const grouped = useMemo(() => {
    const items = progress?.items ?? [];
    return phaseOrder
      .map((phase) => ({ phase, items: items.filter((item) => item.phase === phase) }))
      .filter((group) => group.items.length > 0);
  }, [progress]);

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

  const counts = progress?.statusCounts ?? {};
  // 全部任务加起来跑了多久；正在跑的那几轮实时走。
  const totalRunDuration = useTotalRunDuration(progress?.items ?? [], progress?.totalRunDurationMs ?? 0);

  return (
    <main className="screen progress-screen">
      <div className="screen-title-row">
        <div>
          <p className="eyebrow">任务进度</p>
          <h1>{progress?.requirementName || requirementKey}</h1>
        </div>
        <div className="stack-actions">
          <button className="icon-button" type="button" onClick={() => router.back()} aria-label="返回" title="返回"><ArrowLeft size={20} /></button>
          <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新进度" title="刷新进度" disabled={loading}>
            <RotateCw size={20} className={loading ? "spin-icon" : ""} />
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
            <button className={`chip-button${selecting ? " is-primary" : ""}`} type="button" onClick={() => { setSelecting((current) => !current); setSelected([]); }}>
              <ListChecks size={16} aria-hidden="true" />{selecting ? "退出多选" : "多选执行"}
            </button>
            <button className="chip-button" type="button" disabled={busy || !running} onClick={() => void submit("停止全部执行", stopAll)}>
              <CirclePause size={16} aria-hidden="true" />停止全部
            </button>
          </div>

          {grouped.map((group) => (
            <section className="progress-group" key={group.phase}>
              <div className="section-heading"><span>{phaseLabels[group.phase]}</span><span className="muted">{group.items.length}</span></div>
              {group.items.map((item) => (
                <TaskRow
                  key={item.itemKey}
                  item={item}
                  programId={programId}
                  selecting={selecting}
                  selected={selected.includes(item.itemKey)}
                  busy={busy}
                  onToggle={() => toggle(item.itemKey)}
                  onExecute={() => void submit(`执行 ${item.title}`, () => executeTask(programId, item.itemKey))}
                  usage={usageByTask[item.itemKey]}
                />
              ))}
            </section>
          ))}

          {!grouped.length && !loading ? (
            <EmptyState icon={<ListChecks size={22} />} title="这条需求还没有任务" description="先在需求对话里完成拆解，任务会写回任务面板。" />
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
          <span>已选 {selected.length}</span>
          <button className="button button-primary" type="button" disabled={busy || !selected.length} onClick={() => void submit("批量执行", () => executeTasks(programId, selected, false))}>
            <Play size={17} aria-hidden="true" />批量执行
          </button>
          <button className="button button-secondary" type="button" disabled={busy || !selected.length} onClick={() => void submit("按依赖执行", () => executeTasks(programId, selected, true))}>
            <ListRestart size={17} aria-hidden="true" />按依赖执行
          </button>
        </div>
      ) : null}
    </main>
  );
}

function TaskRow({
  item,
  programId,
  selecting,
  selected,
  busy,
  onToggle,
  onExecute,
  usage,
}: {
  item: DeliveryItem;
  programId: number;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onExecute: () => void;
  /** 这条任务的消耗，按执行器分开；还没跑过或还没读回来时为空。 */
  usage?: ProviderUsage;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`task-row${selected ? " is-selected" : ""}`} data-status={item.status}>
      <div className="task-row__head">
        {selecting ? (
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`选择 ${item.title}`} />
        ) : (
          <span className="task-row__icon" aria-hidden="true">{statusIcon(item.status)}</span>
        )}
        <button className="task-row__body" type="button" onClick={() => (selecting ? onToggle() : setOpen((current) => !current))} aria-expanded={selecting ? undefined : open}>
          <strong>{item.title}</strong>
          <small>{statusLabels[item.status]} · {item.progress}%{item.ownerName ? ` · ${item.ownerName}` : ""}</small>
        </button>
        {!selecting ? <ChevronDown size={17} className={`requirement-card__chevron${open ? " is-open" : ""}`} aria-hidden="true" /> : null}
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
              <MessageSquareText size={16} aria-hidden="true" />任务对话
            </Link>
            <button className="chip-button" type="button" disabled={busy} onClick={onExecute}><Play size={16} aria-hidden="true" />执行</button>
            <Link className="chip-button" href={`/projects/${programId}/tasks/${encodeURIComponent(item.itemKey)}`}>任务详情</Link>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function statusIcon(status: ItemStatus) {
  if (status === "done") return <CheckCircle2 size={17} />;
  if (status === "doing") return <LoaderCircle size={17} className="spin-icon" />;
  if (status === "blocked" || status === "dropped") return <CircleSlash size={17} />;
  return <ListChecks size={17} />;
}

function ProgressRing({ value }: { value: number }) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-ring" style={{ ["--ring-value" as string]: `${safe * 3.6}deg` }} role="img" aria-label={`完成度 ${safe}%`}>
      <span>{safe}%</span>
    </div>
  );
}
