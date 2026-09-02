"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, CirclePause, RotateCw, Zap } from "lucide-react";
import { ApiError } from "@/api/client";
import { cancelCommand, getCommand, isTerminalCommand, listCommands, streamCommandEvents, type CommandEvent, type CommandState, type CommandSummary } from "@/api/command.api";
import { EmptyState } from "@/components/empty-state";
import { useSpace } from "@/components/space-provider";

const stateLabels: Record<CommandState, string> = {
  pending: "等待领取", leased: "已领取", running: "执行中", succeeded: "已完成",
  failed: "执行失败", cancelled: "已取消", timed_out: "已超时",
};

function stateClass(state: CommandState) {
  if (state === "failed" || state === "timed_out") return "is-danger";
  if (state === "running" || state === "succeeded") return "is-active";
  return "is-warning";
}

/**
 * 命令类型的中文名。
 *
 * 运行记录是给人看的：一屏 task.execute-sequence 只能靠猜，而「按依赖执行」谁都
 * 读得懂。表里没有的类型退回原文，新增命令时不至于显示成空白。
 */
const commandLabels: Record<string, string> = {
  "task.planning": "需求拆解",
  "task.planning-stop": "停止拆解",
  "task.conversation": "任务对话",
  "task.execute": "执行任务",
  "task.execute-batch": "批量执行",
  "task.execute-sequence": "按依赖执行",
  "task.stop": "停止任务",
  "task.stop-all": "停止全部执行",
  "git.prepare": "切换分支",
  "git.branch": "创建分支",
  "git.push": "提交并推送",
  "git.merge": "合并分支",
  "git.init": "初始化仓库",
  "git.submodules": "同步子模块",
  "business.conversation": "业务访谈",
  "documents.cloud-sync": "同步文档",
  // 快照类默认不进这个列表，打开 includeReadOnly 排查时才会看到。
  "task.session": "读取任务会话",
  "task.planning-session": "读取拆解会话",
  "requirement.usage": "读取用量",
  "git.status": "读取 Git 状态",
  "git.branches": "读取分支",
  "git.changes": "读取改动",
  "git.change": "读取单文件差异",
  "git.projects": "读取工程列表",
  "git.merge-preview": "预览合并",
  "git.workspace-check": "检查工作目录",
};

function commandLabel(commandType: string) {
  return commandLabels[commandType] ?? commandType;
}

/** 这条命令作用在谁身上：需求键、任务键，或一次批量里的任务数。 */
function commandTarget(input: Record<string, unknown>) {
  const requirementKey = typeof input?.requirementKey === "string" ? input.requirementKey.trim() : "";
  if (requirementKey) return `需求 ${requirementKey}`;
  const itemKey = typeof input?.itemKey === "string" ? input.itemKey.trim() : "";
  if (itemKey) return `任务 ${itemKey}`;
  const itemKeys = Array.isArray(input?.itemKeys) ? input.itemKeys : [];
  if (itemKeys.length) return `${itemKeys.length} 条任务`;
  const branch = typeof input?.branch === "string" ? input.branch.trim() : "";
  return branch ? `分支 ${branch}` : "";
}

function cursorKey(commandID: string) { return `delivery-mobile.command-cursor.${commandID}`; }

function readCursor(commandID: string) {
	const value = Number(window.sessionStorage.getItem(cursorKey(commandID)));
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function rememberCursor(commandID: string, eventID: number) {
	const current = readCursor(commandID);
	if (!Number.isSafeInteger(eventID) || eventID <= current) return false;
	window.sessionStorage.setItem(cursorKey(commandID), String(eventID));
	return true;
}

function reconnectDelay(attempt: number) {
	return Math.min(1_200 * 2 ** attempt, 10_000);
}

function formatResult(value: Record<string, unknown>) {
  return value && Object.keys(value).length ? JSON.stringify(value, null, 2) : "等待 Worker 回传结果。";
}

export function CommandScreen() {
  const searchParams = useSearchParams();
  const requestedCommandID = searchParams.get("commandId")?.trim() ?? "";
  // 命令按空间归集：换空间要重新拉这一份活动列表。
  const { bizLine } = useSpace();
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [focusCommandID, setFocusCommandID] = useState("");
  const [events, setEvents] = useState<CommandEvent[]>([]);
  const [streamError, setStreamError] = useState("");
  const [cancelling, setCancelling] = useState(false);

  const replaceCommand = useCallback((next: CommandSummary) => {
    setCommands((current) => {
      const index = current.findIndex((command) => command.commandId === next.commandId);
      if (index < 0) return [next, ...current];
      const updated = [...current];
      updated[index] = next;
      return updated;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await listCommands();
      const rows = page.data ?? [];
      if (requestedCommandID) {
        try {
          const selected = await getCommand(requestedCommandID);
          setCommands(rows.some((command) => command.commandId === selected.commandId) ? rows : [selected, ...rows]);
          setFocusCommandID(selected.commandId);
        } catch {
          setCommands(rows);
          setFocusCommandID(rows[0]?.commandId ?? "");
        }
      } else {
        setCommands(rows);
        setFocusCommandID((current) => current || rows[0]?.commandId || "");
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取命令状态。");
    } finally {
      setLoading(false);
    }
  }, [bizLine, requestedCommandID]);

  useEffect(() => { void load(); }, [load]);

  const focusCommand = useMemo(() => commands.find((command) => command.commandId === focusCommandID) ?? null, [commands, focusCommandID]);

  useEffect(() => {
    if (!focusCommandID) return;
    let active = true;
    setEvents([]);
    setStreamError("");
    const controller = new AbortController();
    const connect = async () => {
      let retryAttempt = 0;
      while (active) {
        try {
          const snapshot = await getCommand(focusCommandID);
          if (!active) return;
          replaceCommand(snapshot);
          setStreamError("");
          await streamCommandEvents(focusCommandID, readCursor(focusCommandID), (event) => {
            if (!active) return;
            if (!rememberCursor(focusCommandID, event.id)) return;
            setEvents((current) => current.some((candidate) => candidate.id === event.id) ? current : [...current, event].slice(-80));
            void getCommand(focusCommandID).then(replaceCommand).catch(() => undefined);
          }, controller.signal);
          const latest = await getCommand(focusCommandID);
          if (!active) return;
          replaceCommand(latest);
          if (isTerminalCommand(latest.state)) return;
          retryAttempt = 0;
        } catch (reason) {
          if (!active) return;
          setStreamError(reason instanceof ApiError ? reason.message : "活动流暂时断开。");
        }
        const delay = reconnectDelay(retryAttempt);
        retryAttempt += 1;
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      }
    };
    void connect();
    return () => { active = false; controller.abort(); };
  }, [focusCommandID, replaceCommand]);

  const requestCancel = async () => {
    if (!focusCommand || isTerminalCommand(focusCommand.state)) return;
    setCancelling(true);
    setStreamError("");
    try {
      replaceCommand(await cancelCommand(focusCommand.commandId));
    } catch (reason) {
      setStreamError(reason instanceof ApiError ? reason.message : "取消请求未提交。");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <main className="screen">
      <div className="screen-title-row">
        <div><p className="eyebrow">工作台</p><h1>运行记录</h1><p>工作台发出的每条远程操作都在这里跟进。</p></div>
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新活动" title="刷新活动" disabled={loading}><RotateCw size={20} className={loading ? "spin-icon" : ""} /></button>
      </div>

      <section className="activity-section" aria-labelledby="command-activity-title">
        <div className="section-heading"><span id="command-activity-title">最近操作</span><span className="muted">{commands.length}</span></div>
        {loading ? <EmptyState icon={<CircleDashed size={21} />} title="正在恢复命令状态" description="" /> : null}
        {!loading && error ? <EmptyState tone="error" icon={<AlertTriangle size={21} />} title="暂时无法读取活动" description={error} action={<button className="button button-primary" type="button" onClick={() => void load()}>重新连接</button>} /> : null}
        {!loading && !error && !commands.length ? <EmptyState icon={<Zap size={21} />} title="还没有远程操作" description="在工作台发起对话、执行或 Git 操作后，这里会列出进度。" /> : null}
        {!loading && !error && commands.length ? <section className="activity-list" aria-label="远程命令列表">{commands.map((command) => <CommandRow command={command} key={command.commandId} focused={command.commandId === focusCommandID} onFocus={() => setFocusCommandID(command.commandId)} />)}</section> : null}
      </section>

      {focusCommand ? <section className="card command-detail" aria-live="polite">
        <div className="command-detail__header"><div><span className="eyebrow">{commandTarget(focusCommand.input) || "执行进度"}</span><strong>{commandLabel(focusCommand.commandType)}</strong></div><span className={`status ${stateClass(focusCommand.state)}`}>{stateLabels[focusCommand.state]}</span></div>
        <div className="command-progress" aria-label={`执行进度 ${focusCommand.progress}%`}><span style={{ width: `${Math.max(0, Math.min(100, focusCommand.progress))}%` }} /></div>
        <div className="detail-list command-detail__meta"><div className="detail-row"><span>项目</span><strong>#{focusCommand.programId}</strong></div><div className="detail-row"><span>命令类型</span><strong>{focusCommand.commandType}</strong></div><div className="detail-row"><span>进度</span><strong>{focusCommand.progress}%</strong></div><div className="detail-row"><span>更新时间</span><strong>{formatDate(focusCommand.updatedAt)}</strong></div></div>
        {taskURLOf(focusCommand) ? <Link className="inline-link" href={taskURLOf(focusCommand)}><span>查看任务</span><ArrowRight size={14} aria-hidden="true" /></Link> : null}
        {focusCommand.errorMessage ? <p className="form-message is-error">{focusCommand.errorMessage}</p> : null}
        {streamError ? <p className="form-message is-error">{streamError}</p> : null}
        {!isTerminalCommand(focusCommand.state) ? <button className="button button-danger" type="button" disabled={cancelling} onClick={() => void requestCancel()}><CirclePause size={17} aria-hidden="true" />{cancelling ? "正在请求停止" : "请求停止"}</button> : null}
        {events.length ? <ol className="event-timeline">{events.map((event) => <li key={event.id}><span className={`event-timeline__dot ${stateClass(event.state)}`} /><div><strong>{event.message || event.kind}</strong><small>{stateLabels[event.state]} · {formatDate(event.createdAt)}</small></div></li>)}</ol> : null}
        {isTerminalCommand(focusCommand.state) ? <><div className="command-result-heading"><CheckCircle2 size={17} aria-hidden="true" />结果</div><pre className="command-result">{formatResult(focusCommand.result)}</pre></> : null}
      </section> : null}
    </main>
  );
}

function CommandRow({ command, focused, onFocus }: { command: CommandSummary; focused: boolean; onFocus: () => void }) {
  return <button className={`card activity-row command-row${focused ? " is-focused" : ""}`} type="button" onClick={onFocus}><span className="activity-icon" aria-hidden="true"><Activity size={17} /></span><span className="command-row__body"><span className="command-row__title"><strong>{commandLabel(command.commandType)}</strong><span className={`status ${stateClass(command.state)}`}>{stateLabels[command.state]}</span></span><span>{[commandTarget(command.input), `${command.progress}%`, formatDate(command.updatedAt)].filter(Boolean).join(" · ")}</span>{command.errorMessage ? <span className="form-message is-error">{command.errorMessage}</span> : null}</span></button>;
}

function formatDate(value: string) {
  if (!value) return "等待同步";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function taskURLOf(command: CommandSummary) {
  const itemKey = typeof command.input.itemKey === "string" ? command.input.itemKey.trim() : "";
  return itemKey ? `/projects/${command.programId}/tasks/${encodeURIComponent(itemKey)}` : "";
}
