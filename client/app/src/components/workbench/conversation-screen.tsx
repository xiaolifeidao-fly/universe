"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CirclePause,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  RotateCw,
  SendHorizontal,
  X,
} from "lucide-react";
import { ApiError } from "@/api/client";
import { cancelCommand, isTerminalCommand, type CommandSummary } from "@/api/command.api";
import { getItem, getRequirement, listPlanningSessions } from "@/api/management.api";
import {
  MAX_CONVERSATION_ATTACHMENTS,
  fetchRequirementSession,
  findActiveTurnCommand,
  fetchTaskSession,
  sendRequirementMessage,
  sendTaskMessage,
  watchCommand,
  stopRequirementSession,
  stopTaskSession,
  uploadRequirementAttachments,
  uploadTaskAttachments,
} from "@/api/workbench.api";
import { EmptyState } from "@/components/empty-state";
import { ConversationTurns, UsageLine } from "@/components/workbench/conversation-turns";
import { WorkerOfflineNotice, useWorkerStatus } from "@/components/workbench/worker-status";
import type { ConversationSnapshot, ConversationSummary } from "@/features/workbench/types";

/** 会话跑着时的快照刷新间隔：只读通道单独领取，不会被长任务挡住。 */
const LIVE_REFRESH_MS = 4_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type ConversationScope = "requirement" | "task";

export function ConversationScreen({ scope, targetKey, title }: { scope: ConversationScope; targetKey: string; title: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const programId = Number(searchParams.get("programId") ?? 0);
  const [displayTitle, setDisplayTitle] = useState(title);

  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [threadId, setThreadId] = useState("");
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [runningCommand, setRunningCommand] = useState<CommandSummary | null>(null);
  const [progressNote, setProgressNote] = useState("");
  // 停止的结果要留在界面上：命令被当场撤掉时，「执行中」那行会立刻消失，
  // 没有这句话用户就只看到一片安静，不知道自己那一轮到底停没停。
  const [notice, setNotice] = useState("");
  const [startNewThread, setStartNewThread] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);

  const running = Boolean(runningCommand) || Boolean(snapshot?.active);
  const { status: workerStatus } = useWorkerStatus(programId);

  const readSnapshot = useCallback(
    (nextThreadId: string) => (scope === "requirement"
      ? fetchRequirementSession(programId, targetKey, nextThreadId)
      : fetchTaskSession(programId, targetKey, nextThreadId)),
    [programId, scope, targetKey],
  );

  const load = useCallback(async (nextThreadId = "", quiet = false) => {
    if (!programId || !targetKey) {
      setError("缺少项目或会话标识。");
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const next = await readSnapshot(nextThreadId);
      setSnapshot(next);
      setThreadId(next.threadId ?? "");
      if (next.conversations?.length) setThreads(next.conversations);
      setError("");
    } catch (reason) {
      if (!quiet) setError(reason instanceof ApiError ? reason.message : "无法读取会话。");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [programId, readSnapshot, targetKey]);

  useEffect(() => { void load(""); }, [load]);

  useEffect(() => setPortalReady(true), []);

  useEffect(() => {
    if (!historyOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => drawerRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [historyOpen]);

  // 标题读任务面板：会话快照来自执行电脑，可能要等几秒才回来。
  useEffect(() => {
    if (!programId || !targetKey) return;
    let active = true;
    const request = scope === "requirement" ? getRequirement(programId, targetKey) : getItem(programId, targetKey);
    void request.then((view) => {
      if (!active) return;
      const name = "name" in view ? view.name : view.title;
      if (name) setDisplayTitle(name);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [programId, scope, targetKey]);

  // 目录先从服务端读一份：Worker 还没回话时聊天记录也能立刻列出来。
  useEffect(() => {
    if (scope !== "requirement" || !programId || !targetKey) return;
    let active = true;
    void listPlanningSessions(programId, targetKey).then((rows) => {
      if (!active || !rows?.length) return;
      setThreads((current) => (current.length ? current : rows.map((row) => ({
        threadId: row.threadId,
        title: row.title,
        status: row.status,
        executorType: row.executorType,
        active: false,
        createdAt: row.createdAt ?? "",
        updatedAt: row.updatedAt ?? "",
      }))));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [programId, scope, targetKey]);

  // 回合在跑：接服务端的活动流拿进度说明，同时按节奏刷新会话正文。一轮十分钟的
  // 回合原先要问几百次「好了没」，现在是一条连接，Worker 说到哪就显示到哪。
  useEffect(() => {
    if (!runningCommand || isTerminalCommand(runningCommand.state)) return;
    const commandId = runningCommand.commandId;
    let active = true;
    const controller = new AbortController();
    void watchCommand(commandId, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!active) return;
        setProgressNote(progress.message || (progress.progress ? `执行电脑处理中 ${progress.progress}%` : "执行电脑处理中"));
      },
    }).then((finished) => {
      if (!active) return;
      setRunningCommand(null);
      setProgressNote("");
      if (finished.state !== "succeeded" && finished.errorMessage) setError(finished.errorMessage);
      void load(threadId, true);
    }).catch(() => {
      // 离开界面或流彻底断掉都不该打断会话：正文仍在按节奏刷新。
    });
    return () => { active = false; controller.abort(); };
  }, [load, runningCommand, threadId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void load(threadId, true); }, LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, running, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [snapshot?.turns.length, running]);

  const turns = useMemo(() => snapshot?.turns ?? [], [snapshot]);

  const selectThread = async (nextThreadId: string) => {
    setHistoryOpen(false);
    setStartNewThread(false);
    setNotice("");
    await load(nextThreadId);
  };

  const send = async () => {
    if (!message.trim() && !files.length) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const attachments = files.length
        ? scope === "requirement"
          ? await uploadRequirementAttachments(programId, targetKey, files)
          : await uploadTaskAttachments(programId, targetKey, files)
        : [];
      const attachmentIds = attachments.map((attachment) => attachment.attachmentId);
      const command = scope === "requirement"
        ? await sendRequirementMessage({ programId, requirementKey: targetKey, message: message.trim(), threadId: startNewThread ? "" : threadId, newConversation: startNewThread, attachmentIds })
        : await sendTaskMessage({ programId, itemKey: targetKey, message: message.trim(), threadId: startNewThread ? "" : threadId, newConversation: startNewThread, attachmentIds });
      setMessage("");
      setFiles([]);
      setStartNewThread(false);
      setRunningCommand(command);
      setProgressNote("已提交，等待执行电脑响应");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "发送失败，请稍后重试。");
    } finally {
      setSending(false);
    }
  };

  /**
   * 停止这一轮。
   *
   * 先撤在飞的那条命令：还没被领取时撤掉就等于没发生过，已经在跑时 Worker 会在
   * 下一次活动上报里看到取消请求并停掉本机回合。只有连命令都找不到（回合是从别处
   * 起的）才补一条停止命令 —— 执行通道空着，它才领得走。
   */
  const stop = async () => {
    setError("");
    setNotice("");
    try {
      const turnTypes = scope === "requirement" ? ["task.planning"] : ["task.conversation", "task.execute"];
      const inputKey = scope === "requirement" ? "requirementKey" : "itemKey";
      const inFlight = runningCommand && !isTerminalCommand(runningCommand.state)
        ? runningCommand
        : await findActiveTurnCommand(programId, turnTypes, inputKey, targetKey);
      if (inFlight) {
        const cancelled = await cancelCommand(inFlight.commandId, "用户在手机上停止了这一轮");
        setRunningCommand(cancelled);
        setNotice(cancelled.state === "cancelled" ? "已撤回，这一轮没有发到执行电脑。" : "已请求停止，执行电脑正在收尾。");
        return;
      }
      if (scope === "requirement") await stopRequirementSession(programId, targetKey);
      else await stopTaskSession(programId, targetKey);
      setNotice("已请求停止本轮。");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "停止请求未提交。");
    }
  };

  const selectFiles = (selected: FileList | null) => {
    const next = [...files, ...Array.from(selected ?? [])];
    if (next.length > MAX_CONVERSATION_ATTACHMENTS) {
      setError(`一条消息最多携带 ${MAX_CONVERSATION_ATTACHMENTS} 个附件。`);
      return;
    }
    const oversized = next.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setError(`附件 ${oversized.name} 超过 20 MB。`);
      return;
    }
    setError("");
    setFiles(next);
  };

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <button className="icon-button" type="button" onClick={() => router.back()} aria-label="返回" title="返回"><ArrowLeft size={20} /></button>
        <div className="chat-header__title">
          <small>{scope === "requirement" ? "需求对话" : "任务对话"}</small>
          <strong>{displayTitle || targetKey}</strong>
        </div>
        <div className="chat-header__actions">
          <button className="icon-button" type="button" onClick={() => void load(threadId)} aria-label="刷新会话" title="刷新会话" disabled={loading}>
            <RotateCw size={19} className={loading ? "spin-icon" : ""} />
          </button>
          <button className={`icon-button${historyOpen ? " is-active" : ""}`} type="button" onClick={() => setHistoryOpen(true)} aria-label="聊天记录" title="聊天记录" aria-expanded={historyOpen} aria-controls="conversation-drawer">
            <History size={19} />
          </button>
        </div>
      </header>

      {portalReady && historyOpen ? createPortal(
        <div className="chat-drawer-layer" role="dialog" aria-modal="true" aria-labelledby="conversation-drawer-title">
          <button className="chat-drawer-scrim" type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭聊天记录" />
          <aside className="chat-drawer" id="conversation-drawer" ref={drawerRef} tabIndex={-1}>
            <header className="chat-drawer__header">
              <div>
                <span>会话</span>
                <strong id="conversation-drawer-title">对话记录</strong>
                <small>{displayTitle || targetKey}</small>
              </div>
              <button className="icon-button" type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭聊天记录" title="关闭"><X size={19} /></button>
            </header>
            <div className="chat-drawer__body">
              <button
                className="chat-drawer__new"
                type="button"
                onClick={() => {
                  setStartNewThread(true);
                  setSnapshot((current) => (current ? { ...current, turns: [] } : current));
                  setThreadId("");
                  setHistoryOpen(false);
                }}
              >
                <MessageSquarePlus size={18} aria-hidden="true" />
                <span><strong>新建对话</strong><small>开启一个独立的工作上下文</small></span>
              </button>
              {threads.length ? (
                <ul className="chat-drawer__list">
                  {threads.map((thread) => {
                    const active = thread.threadId === threadId && !startNewThread;
                    return (
                      <li key={thread.threadId}>
                        <button
                          className={`chat-drawer__row${active ? " is-active" : ""}`}
                          type="button"
                          onClick={() => void selectThread(thread.threadId)}
                          aria-current={active ? "true" : undefined}
                        >
                          <span className="chat-drawer__label">{thread.title || "未命名对话"}</span>
                          <small>{thread.status === "running" ? "执行中" : displayTime(thread.updatedAt)}</small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="chat-drawer__empty">还没有历史对话。</p>}
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}

      <div className="chat-body">
        {loading && !turns.length ? <EmptyState icon={<LoaderCircle size={22} className="spin-icon" />} title="正在读取会话" description="执行电脑正在返回这条会话的内容。" /> : null}
        {!loading && error && !turns.length ? (
          <EmptyState tone="error" icon={<X size={22} />} title="无法读取会话" description={error} action={<button className="button button-primary" type="button" onClick={() => void load(threadId)}>重新读取</button>} />
        ) : null}
        {!loading && !error && !turns.length ? (
          <EmptyState icon={<MessageSquarePlus size={22} />} title={startNewThread ? "新的对话" : "还没有对话"} description="说清这轮要做什么，执行电脑会在项目工作目录里处理。" />
        ) : null}
        {turns.length ? <ConversationTurns turns={turns} /> : null}
        {snapshot?.usage?.totalTokens ? <UsageLine usage={snapshot.usage} label="本会话累计" /> : null}
        {running ? (
          <p className="chat-running" role="status">
            <LoaderCircle size={15} className="spin-icon" aria-hidden="true" />
            {progressNote || "执行电脑正在处理这一轮"}
          </p>
        ) : null}
        {error && turns.length ? <p className="form-message is-error">{error}</p> : null}
        <div ref={bottomRef} />
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {files.length ? (
          <ul className="chat-composer__files">
            {files.map((file) => (
              <li key={`${file.name}-${file.lastModified}`}>
                {file.name}
                <button type="button" onClick={() => setFiles((current) => current.filter((item) => item !== file))} aria-label={`移除 ${file.name}`}>×</button>
              </li>
            ))}
          </ul>
        ) : null}
        <WorkerOfflineNotice status={workerStatus} />
        {notice ? <p className="chat-composer__hint">{notice}</p> : null}
        {startNewThread ? <p className="chat-composer__hint">下一条消息会开一条新的对话。</p> : null}
        <div className="chat-composer__row">
          <label className="icon-button" title="添加附件">
            <Paperclip size={19} aria-hidden="true" />
            <input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx" onChange={(event) => selectFiles(event.target.files)} />
            <span className="visually-hidden">添加附件</span>
          </label>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={1}
            placeholder="说清这一轮要做什么"
            aria-label="消息内容"
            enterKeyHint="send"
            onInput={(event) => {
              const target = event.currentTarget;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 148)}px`;
            }}
          />
          {running ? (
            <button className="chat-send is-stop" type="button" onClick={() => void stop()} aria-label="停止本轮"><CirclePause size={19} /></button>
          ) : (
            <button className="chat-send" type="submit" disabled={sending || (!message.trim() && !files.length)} aria-label="发送">
              {sending ? <LoaderCircle size={19} className="spin-icon" /> : <SendHorizontal size={19} />}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function displayTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
