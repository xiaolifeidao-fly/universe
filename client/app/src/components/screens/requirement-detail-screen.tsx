"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, ClipboardCheck, SquarePen, ListTree, RotateCw, Send, Lightbulb } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import { getCommand, submitCommand, type CommandDetail } from "@/api/command.api";
import { getProgram, getRequirement, listItems, type DeliveryItem, type RequirementSummary } from "@/api/management.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { dateTimeLabel } from "@/lib/date";

type PlanningMessage = { type?: string; text?: string; phase?: string };
type PlanningTurn = { items?: PlanningMessage[] };
type PlanningResult = { threadId?: string; planning?: { result?: { items?: DeliveryItem[] }; turns?: PlanningTurn[] } };

function planningCommandInput(requirement: RequirementSummary, message: string, confirmWrite: boolean, threadId = "") {
  return {
    programId: requirement.programId,
    requirementKey: requirement.requirementKey,
    requirementName: requirement.name,
    requirementDetail: requirement.detail,
    requirementOwners: requirement.owners.map((owner) => owner.id).join(","),
    requirementAssistants: requirement.assistants.map((assistant) => assistant.id).join(","),
    requirementStartPhase: requirement.startPhase,
    requirementSplitTasks: requirement.splitTasks,
    requirementPreGenerateTaskDocuments: requirement.preGenerateTaskDocuments,
    requirementGeneratePrototype: requirement.generatePrototype,
    message,
    newConversation: !threadId,
    threadId,
    confirmWrite,
  };
}

function valueAsPlanningResult(command: CommandDetail | null): PlanningResult {
  if (!command || !command.result || typeof command.result !== "object") return {};
  return command.result as PlanningResult;
}

export function RequirementDetailScreen() {
  const params = useParams<{ projectId: string; requirementKey: string }>();
  const programId = Number(params.projectId);
  const requirementKey = params.requirementKey;
  const [requirement, setRequirement] = useState<RequirementSummary | null>(null);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [planningMessage, setPlanningMessage] = useState("");
  const [planningCommandId, setPlanningCommandId] = useState("");
  const [planningCommand, setPlanningCommand] = useState<CommandDetail | null>(null);
  const [planningBusy, setPlanningBusy] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(programId) || programId <= 0) {
      setError("项目标识无效。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [nextRequirement, page, program] = await Promise.all([
        getRequirement(programId, requirementKey),
        listItems(programId, requirementKey),
        getProgram(programId),
      ]);
      setRequirement(nextRequirement);
      setItems(page.data ?? []);
      setCanWrite(program.canWrite);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取需求详情。");
    } finally {
      setLoading(false);
    }
  }, [programId, requirementKey]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!planningCommandId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const command = await getCommand(planningCommandId);
        if (cancelled) return;
        setPlanningCommand(command);
        const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(command.state);
        setPlanningBusy(!terminal);
        if (terminal && command.state === "succeeded" && valueAsPlanningResult(command).threadId) void load();
      } catch (reason) {
        if (!cancelled) setError(reason instanceof ApiError ? reason.message : "无法恢复拆解状态。");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [load, planningCommandId]);

  const planning = valueAsPlanningResult(planningCommand);
  const threadId = planning.threadId ?? "";
  const previewItems = planning.planning?.result?.items ?? [];
  const previewText = planningPreviewText(planning);
  const actionLabel = useMemo(() => {
    if (!planningCommand) return "尚未发起";
    if (planningCommand.state === "succeeded" && threadId) return "拆解预览已就绪";
    if (planningCommand.state === "failed" || planningCommand.state === "timed_out") return "拆解未完成";
    return "正在等待远程 Worker";
  }, [planningCommand, threadId]);

  const startPlanning = async () => {
    if (!requirement) return;
    setPlanningBusy(true);
    setError("");
    try {
      const command = await submitCommand({
        programId,
        commandType: "task.planning",
        input: planningCommandInput(requirement, planningMessage.trim() || "请依据需求生成可评审的任务拆解预览。", false),
        idempotencyKey: `planning-preview-${requirement.requirementKey}-${requirement.version}-${hash(planningMessage)}`,
      });
      setPlanningCommandId(command.commandId);
      setPlanningCommand(command);
    } catch (reason) {
      setPlanningBusy(false);
      setError(reason instanceof ApiError ? reason.message : "无法提交拆解请求。");
    }
  };

  const confirmPlanning = async () => {
    if (!requirement || !threadId) return;
    setPlanningBusy(true);
    setError("");
    try {
      const command = await submitCommand({
        programId,
        commandType: "task.planning",
        input: planningCommandInput(requirement, "确认按本次拆解预览写入任务。", true, threadId),
        idempotencyKey: `planning-confirm-${requirement.requirementKey}-${requirement.version}-${threadId}`,
      });
      setPlanningCommandId(command.commandId);
      setPlanningCommand(command);
    } catch (reason) {
      setPlanningBusy(false);
      setError(reason instanceof ApiError ? reason.message : "无法确认拆解。");
    }
  };

  if (loading) return <main className="screen"><LoadingState title="正在读取需求" /></main>;
  if (!requirement) return <main className="screen"><EmptyState icon={<ClipboardCheck size={21} />} title="找不到此需求" description={error || "需求可能已被删除或你没有访问权限。"} action={<Link className="button button-primary" href={`/projects/${programId}`}>返回项目</Link>} /></main>;

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div><p className="eyebrow">需求详情</p><h1>{requirement.name || "未命名需求"}</h1><p>{requirement.itemCount} 条关联任务 · {dateTimeLabel(requirement.updatedAt)}</p></div>
        <Link className="icon-button" href={`/projects/${programId}`} aria-label="返回项目" title="返回项目"><ArrowLeft size={20} /></Link>
      </div>
      <section className="detail-hero"><span className={`status ${requirement.status === "done" ? "is-success" : requirement.status === "dropped" ? "is-danger" : "is-active"}`}>{requirement.status === "done" ? "已完成" : requirement.status === "dropped" ? "不做" : "进行中"}</span><p>{requirement.detail || "尚未补充需求说明。"}</p><div className="detail-meta"><span className="tag">{requirement.mode === "simple" ? "简易模式" : "专业模式"}</span><span className="tag">起始：{phaseLabel(requirement.startPhase)}</span>{requirement.owners.map((owner) => <span className="tag" key={owner.id}>{owner.name || owner.id}</span>)}</div></section>
      <section className="section card">
        <div className="section-heading"><span>任务</span><Link className="icon-button small-icon-button" href={`/projects/${programId}`} aria-label="查看项目任务" title="查看项目任务"><ListTree size={18} /></Link></div>
        {items.length ? <div className="compact-list">{items.map((item) => <Link className="compact-row" href={`/projects/${programId}/tasks/${item.itemKey}`} key={item.itemKey}><div><strong>{item.title}</strong><p>{phaseLabel(item.phase)} · {statusLabel(item.status)} · {item.progress}%</p></div><span className="status is-active">{item.progress}%</span></Link>)}</div> : <p className="muted">拆解确认后，任务会显示在这里。</p>}
      </section>
      {canWrite ? <section className="section card planning-panel">
        <div className="section-heading"><span>任务拆解</span><Lightbulb size={19} aria-hidden="true" /></div>
        <p className="muted">先由已登记的 Worker 生成可评审预览，确认后才会写入任务和依赖。</p>
        {!threadId ? <div className="field"><label htmlFor="planning-message">本轮拆解重点</label><textarea id="planning-message" value={planningMessage} onChange={(event) => setPlanningMessage(event.target.value)} maxLength={32768} placeholder="可补充优先级、依赖或验收关注点。" /></div> : null}
        <div className="planning-status"><span className={`status ${planningCommand?.state === "failed" || planningCommand?.state === "timed_out" ? "is-danger" : "is-active"}`}>{actionLabel}</span>{planningCommand?.errorMessage ? <p className="form-message is-error">{planningCommand.errorMessage}</p> : null}</div>
        {previewText ? <section className="planning-preview" aria-label="拆解预览"><h3>本轮预览</h3><pre>{previewText}</pre></section> : null}
        {previewItems.length ? <div className="compact-list" aria-label="已写入任务">{previewItems.map((item) => <span className="compact-row" key={item.itemKey}><strong>{item.title}</strong><span className="status is-active">已创建</span></span>)}</div> : null}
        <div className="stack-actions" style={{ marginTop: 14 }}>
          {!threadId ? <button className="button button-primary" type="button" onClick={() => void startPlanning()} disabled={planningBusy}><Send size={17} aria-hidden="true" />{planningBusy ? "正在生成" : "生成拆解预览"}</button> : <button className="button button-primary" type="button" onClick={() => void confirmPlanning()} disabled={planningBusy || planningCommand?.state !== "succeeded"}><CheckCircle2 size={17} aria-hidden="true" />{planningBusy ? "正在写入" : "确认并写入任务"}</button>}
          <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新需求" title="刷新需求"><RotateCw size={19} /></button>
        </div>
      </section> : null}
      <div className="screen-actions"><Link className="button button-secondary" href={`/projects/${programId}/requirements/${requirement.requirementKey}/edit`}><SquarePen size={17} aria-hidden="true" />编辑需求</Link></div>
      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
    </main>
  );
}

function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) | 0;
  return Math.abs(result).toString(36);
}

function planningPreviewText(value: PlanningResult) {
  const turns = value.planning?.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const messages = turns[turnIndex].items ?? [];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex];
      if (message.type === "agentMessage" && message.text?.trim()) return message.text.trim();
    }
  }
  return "";
}

function phaseLabel(value: string) {
  return ({ requirement: "梳理需求", development: "动作执行", testing: "成品测试" } as Record<string, string>)[value] ?? value;
}

function statusLabel(value: string) {
  return ({ todo: "未开始", doing: "进行中", done: "已完成", blocked: "受阻", dropped: "不做" } as Record<string, string>)[value] ?? value;
}
