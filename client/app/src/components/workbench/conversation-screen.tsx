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
  fetchRequirementChannelSession,
  fetchRequirementSession,
  fetchTaskChannelSession,
  findActiveTurnCommand,
  generateRequirementPrototype,
  requirementChannelSendCommand,
  sendRequirementChannelMessage,
  sendTaskChannelMessage,
  stopRequirementChannel,
  stopTaskChannel,
  taskChannelSendCommand,
  type RequirementChannel,
  type TaskChannel,
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
import { ContextMeter } from "@/components/workbench/context-meter";
import { ConversationTurns, UsageLine } from "@/components/workbench/conversation-turns";
import { liveTurnOf, mergeLiveTurn } from "@/features/workbench/live-turn";
import { VoiceInputButton } from "@/components/workbench/voice-input-button";
import { WorkerOfflineNotice, useWorkerStatus } from "@/components/workbench/worker-status";
import type { ConversationSnapshot, ConversationSummary } from "@/features/workbench/types";

/** 会话跑着时的快照刷新间隔：只读通道单独领取，不会被长任务挡住。 */
const LIVE_REFRESH_MS = 4_000;
/**
 * 实时正文还在从活动流里来时，就不必再整份回读一遍。
 *
 * 留出比刷新间隔宽的一段：执行电脑思考时可以几十秒没有新内容，那不代表这条通道断了。
 * 旧版本的执行电脑不发实时正文，这个时间窗永远不成立，界面自动回到原来的整份回读。
 */
const LIVE_FEED_GRACE_MS = 20_000;
/** 回合跑着时标题的回读间隔：拆解会给需求改名，但一轮里最多改两次。 */
const TITLE_REFRESH_MS = 8_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type ConversationScope = "requirement" | "task";

/**
 * 一条需求或一条任务下的各个会话通道。
 *
 * 主通道是拆解（需求）和任务对话（任务），其余是需求窗口和任务窗口里的辅助会话。
 * 它们的形状完全一样 —— 读快照、发一轮、停一轮 —— 只是命令类型不同，所以做成一张
 * 描述表：界面只认这张表，新增一条通道不必再改一遍屏幕逻辑。
 */
interface ChannelSpec {
  key: string;
  label: string;
  /** 这一轮在跑时，从运行记录里认回命令用的类型。 */
  turnTypes: string[];
  attachments: boolean;
  placeholder: string;
  /** 这一轮要不要顺带产出交付物；勾上才落文档或报告。 */
  flag?: { key: string; label: string };
  /** 通道自己的额外动作，比如原型的「重新生成」。 */
  action?: { label: string; run: (programId: number, targetKey: string) => Promise<unknown> };
}

const requirementChannels: ChannelSpec[] = [
  { key: "", label: "拆解", turnTypes: ["task.planning"], attachments: true, placeholder: "说清这一轮要做什么" },
  {
    key: "analysis", label: "分析", turnTypes: [requirementChannelSendCommand("analysis")], attachments: false,
    placeholder: "补充需求信息或确认口径",
    flag: { key: "generateDocument", label: "本轮确认生成需求分析文档" },
  },
  {
    key: "prototype", label: "原型", turnTypes: [requirementChannelSendCommand("prototype"), "requirement.prototype"], attachments: false,
    placeholder: "说清原型要改哪儿",
    action: { label: "按需求正文重新生成", run: (programId, targetKey) => generateRequirementPrototype(programId, targetKey) },
  },
  {
    key: "review", label: "评审", turnTypes: [requirementChannelSendCommand("review")], attachments: false,
    placeholder: "这一轮 review 的重点或规则",
    flag: { key: "generateReport", label: "本轮生成评审报告" },
  },
  {
    key: "testing", label: "测试", turnTypes: [requirementChannelSendCommand("testing")], attachments: false,
    placeholder: "说明测试范围、环境与账号",
    flag: { key: "testCaseOnly", label: "只设计用例，不执行" },
  },
  {
    key: "fineTuning", label: "微调", turnTypes: [requirementChannelSendCommand("fineTuning")], attachments: false,
    placeholder: "说清要微调什么",
  },
];

const taskChannels: ChannelSpec[] = [
  { key: "", label: "对话", turnTypes: ["task.conversation", "task.execute"], attachments: true, placeholder: "说清这一轮要做什么" },
  { key: "testing", label: "测试用例", turnTypes: [taskChannelSendCommand("testing")], attachments: false, placeholder: "说明这条任务要怎么验收" },
  { key: "fineTuning", label: "微调", turnTypes: [taskChannelSendCommand("fineTuning")], attachments: false, placeholder: "说清要微调什么" },
];

export function ConversationScreen({ scope, targetKey, title }: { scope: ConversationScope; targetKey: string; title: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const programId = Number(searchParams.get("programId") ?? 0);
  const channels = scope === "requirement" ? requirementChannels : taskChannels;
  const channelKey = searchParams.get("channel") ?? "";
  const channel = useMemo(
    () => channels.find((item) => item.key === channelKey) ?? channels[0],
    [channelKey, channels],
  );
  const [displayTitle, setDisplayTitle] = useState(title);
  const [flagOn, setFlagOn] = useState(false);

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
  const liveFeedAt = useRef(0);
  const reattachedTurn = useRef("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);

  const running = Boolean(runningCommand) || Boolean(snapshot?.active);
  const { status: workerStatus } = useWorkerStatus(programId);

  const readSnapshot = useCallback(
    (nextThreadId: string) => {
      if (scope === "requirement") {
        return channel.key
          ? fetchRequirementChannelSession(programId, targetKey, channel.key as RequirementChannel, nextThreadId)
          : fetchRequirementSession(programId, targetKey, nextThreadId);
      }
      return channel.key
        ? fetchTaskChannelSession(programId, targetKey, channel.key as TaskChannel, nextThreadId)
        : fetchTaskSession(programId, targetKey, nextThreadId);
    },
    [channel.key, programId, scope, targetKey],
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
  //
  // 新需求进来时名字还是需求编号：标题由拆解会话按聊天内容生成，一轮里会变两次
  // （占位名 → AI 标题），所以回合跑着的时候多取几次，回合结束再补取一次，
  // 用户才觉得标题是「聊着聊着自己定下来的」。
  useEffect(() => {
    if (!programId || !targetKey) return;
    let active = true;
    const pullTitle = () => {
      const request = scope === "requirement" ? getRequirement(programId, targetKey) : getItem(programId, targetKey);
      void request.then((view) => {
        if (!active) return;
        const name = "name" in view ? view.name : view.title;
        if (name) setDisplayTitle(name);
      }).catch(() => undefined);
    };
    pullTitle();
    // 回合结束时这个 effect 会重跑，末尾那次 pullTitle 会把最终标题补上，
    // 所以跑着的时候不必贴着三秒问：慢一档只是让中途那次改名晚几秒出现。
    if (!running) return () => { active = false; };
    const timer = window.setInterval(pullTitle, TITLE_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [programId, running, scope, targetKey]);

  // 目录先从服务端读一份：Worker 还没回话时聊天记录也能立刻列出来。
  useEffect(() => {
    if (scope !== "requirement" || channel.key || !programId || !targetKey) return;
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
  }, [channel.key, programId, scope, targetKey]);

  // 回合从别处起的（PC 控制台），或应用被系统回收后重开：界面手里没有命令句柄，
  // 实时正文、进度说明和停止按钮都接不上。从运行记录里把那条命令认回来重新接上。
  useEffect(() => {
    if (!programId || !targetKey || runningCommand || !snapshot?.active) return;
    const key = `${programId}:${targetKey}:${snapshot.activeTurnId || ""}`;
    if (reattachedTurn.current === key) return;
    reattachedTurn.current = key;
    let active = true;
    const inputKey = scope === "requirement" ? "requirementKey" : "itemKey";
    void findActiveTurnCommand(programId, channel.turnTypes, inputKey, targetKey).then((command) => {
      if (active && command) setRunningCommand(command);
    }).catch(() => {
      // 认不回来也不影响这一屏：正文仍按原来的节奏整份回读。
    });
    return () => { active = false; };
  }, [channel.turnTypes, programId, runningCommand, scope, snapshot?.active, snapshot?.activeTurnId, targetKey]);

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
        // 执行电脑把这一轮新长出来的正文随活动带了回来，直接并进当前快照。
        const live = liveTurnOf(progress.data);
        if (!live) return;
        if (live.threadId && live.threadId !== threadId) {
          // 这一轮开在另一条会话里（刚点过「新对话」就是这样）：先把那条会话整份读进来，
          // 否则增量会落进用户正看着的旧会话里。
          void load(live.threadId, true);
          return;
        }
        liveFeedAt.current = Date.now();
        setSnapshot((current) => mergeLiveTurn(current, live));
      },
    }).then((finished) => {
      if (!active) return;
      setRunningCommand(null);
      setProgressNote("");
      liveFeedAt.current = 0;
      if (finished.state !== "succeeded" && finished.errorMessage) setError(finished.errorMessage);
      void load(threadId, true);
    }).catch(() => {
      // 离开界面或流彻底断掉都不该打断会话：正文仍在按节奏刷新。
    });
    return () => { active = false; controller.abort(); };
  }, [load, runningCommand, threadId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      if (Date.now() - liveFeedAt.current < LIVE_FEED_GRACE_MS) return;
      void load(threadId, true);
    }, LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, running, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [snapshot?.turns.length, running]);

  // 输入框跟着内容长高。语音听写是程序化写入，不会触发 onInput，所以统一放在这里做。
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 148)}px`;
  }, [message]);

  const turns = useMemo(() => snapshot?.turns ?? [], [snapshot]);

  const selectChannel = (nextKey: string) => {
    if (nextKey === channel.key) return;
    const params = new URLSearchParams(searchParams.toString());
    if (nextKey) params.set("channel", nextKey);
    else params.delete("channel");
    // 每条通道有自己的会话和历史，切换等于换一屏：把上一条的内容清干净再读。
    setSnapshot(null);
    setThreads([]);
    setThreadId("");
    setRunningCommand(null);
    setProgressNote("");
    setNotice("");
    setError("");
    setStartNewThread(false);
    setFlagOn(false);
    liveFeedAt.current = 0;
    reattachedTurn.current = "";
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const runChannelAction = async () => {
    if (!channel.action) return;
    setError("");
    setNotice("");
    try {
      await channel.action.run(programId, targetKey);
      setNotice(`${channel.action.label}已提交，执行电脑处理完会刷新这一屏。`);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : `${channel.action.label}未提交。`);
    }
  };

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
      const attachments = files.length && channel.attachments
        ? scope === "requirement"
          ? await uploadRequirementAttachments(programId, targetKey, files)
          : await uploadTaskAttachments(programId, targetKey, files)
        : [];
      const attachmentIds = attachments.map((attachment) => attachment.attachmentId);
      const turn = {
        programId,
        targetKey,
        message: message.trim(),
        threadId: startNewThread ? "" : threadId,
        newConversation: startNewThread,
        flags: channel.flag && flagOn ? { [channel.flag.key]: true } : undefined,
      };
      const command = channel.key
        ? scope === "requirement"
          ? await sendRequirementChannelMessage(channel.key as RequirementChannel, turn)
          : await sendTaskChannelMessage(channel.key as TaskChannel, turn)
        : scope === "requirement"
          ? await sendRequirementMessage({ programId, requirementKey: targetKey, message: turn.message, threadId: turn.threadId, newConversation: startNewThread, attachmentIds })
          : await sendTaskMessage({ programId, itemKey: targetKey, message: turn.message, threadId: turn.threadId, newConversation: startNewThread, attachmentIds });
      setMessage("");
      setFiles([]);
      setStartNewThread(false);
      setFlagOn(false);
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
      const inputKey = scope === "requirement" ? "requirementKey" : "itemKey";
      const inFlight = runningCommand && !isTerminalCommand(runningCommand.state)
        ? runningCommand
        : await findActiveTurnCommand(programId, channel.turnTypes, inputKey, targetKey);
      if (inFlight) {
        const cancelled = await cancelCommand(inFlight.commandId, "用户在手机上停止了这一轮");
        setRunningCommand(cancelled);
        setNotice(cancelled.state === "cancelled" ? "已撤回，这一轮没有发到执行电脑。" : "已请求停止，执行电脑正在收尾。");
        return;
      }
      if (!channel.key) {
        if (scope === "requirement") await stopRequirementSession(programId, targetKey);
        else await stopTaskSession(programId, targetKey);
      } else if (scope === "requirement") {
        await stopRequirementChannel(channel.key as RequirementChannel, programId, targetKey);
      } else {
        await stopTaskChannel(channel.key as TaskChannel, programId, targetKey);
      }
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
        <button className="icon-button" type="button" onClick={() => router.back()} aria-label="返回" title="返回"><ArrowLeft size={22} /></button>
        <div className="chat-header__title">
          <small>{scope === "requirement" ? "需求" : "任务"}{channel.key ? ` · ${channel.label}` : "对话"}</small>
          <strong>{displayTitle || targetKey}</strong>
        </div>
        <div className="chat-header__actions">
          <button className="icon-button" type="button" onClick={() => void load(threadId)} aria-label="刷新会话" title="刷新会话" disabled={loading}>
            <RotateCw size={21} className={loading ? "spin-icon" : ""} />
          </button>
          <button className={`icon-button${historyOpen ? " is-active" : ""}`} type="button" onClick={() => setHistoryOpen(true)} aria-label="聊天记录" title="聊天记录" aria-expanded={historyOpen} aria-controls="conversation-drawer">
            <History size={21} />
          </button>
        </div>
      </header>

      {/* 上下文余量固定在标题下面：这一刻还能聊多久，比翻到底部去看累计消耗更该随手看见。 */}
      <ContextMeter context={snapshot?.context} executorType={snapshot?.executorType} />

      {channels.length > 1 ? (
        <div className="chat-channels" role="tablist" aria-label="会话通道">
          {channels.map((item) => (
            <button
              key={item.key || "main"}
              type="button"
              role="tab"
              aria-selected={item.key === channel.key}
              className={item.key === channel.key ? "is-active" : ""}
              onClick={() => selectChannel(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

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
              <button className="icon-button" type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭聊天记录" title="关闭"><X size={21} /></button>
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
                <MessageSquarePlus size={20} aria-hidden="true" />
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
        {loading && !turns.length ? <EmptyState icon={<LoaderCircle size={24} className="spin-icon" />} title="正在读取会话" description="执行电脑正在返回这条会话的内容。" /> : null}
        {!loading && error && !turns.length ? (
          <EmptyState tone="error" icon={<X size={24} />} title="无法读取会话" description={error} action={<button className="button button-primary" type="button" onClick={() => void load(threadId)}>重新读取</button>} />
        ) : null}
        {!loading && !error && !turns.length ? (
          <EmptyState icon={<MessageSquarePlus size={24} />} title={startNewThread ? "新的对话" : "还没有对话"} description="说清这轮要做什么，执行电脑会在项目工作目录里处理。" />
        ) : null}
        {turns.length ? <ConversationTurns turns={turns} /> : null}
        {snapshot?.usage?.totalTokens ? <UsageLine usage={snapshot.usage} label="本会话累计" /> : null}
        {running ? (
          <p className="chat-running" role="status">
            <LoaderCircle size={17} className="spin-icon" aria-hidden="true" />
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
        {channel.action ? (
          <button className="chip-button" type="button" disabled={sending || running} onClick={() => void runChannelAction()}>
            {channel.action.label}
          </button>
        ) : null}
        {channel.flag ? (
          <label className="chat-composer__flag">
            <input type="checkbox" checked={flagOn} onChange={(event) => setFlagOn(event.target.checked)} />
            <span>{channel.flag.label}</span>
          </label>
        ) : null}
        {startNewThread ? <p className="chat-composer__hint">下一条消息会开一条新的对话。</p> : null}
        {/* 附件、语音、发送三颗按钮和输入框挤在一行，输入框只剩不到一半宽度，
            占位文案都要被截断。和业务会话一致：输入框独占一行，动作排在下面。 */}
        <div className="chat-composer__row chat-composer__row--stacked">
          <textarea
            ref={composerRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={1}
            placeholder={channel.placeholder}
            aria-label="消息内容"
            enterKeyHint="send"
          />
          <div className="chat-composer__tools">
            {channel.attachments ? (
              <label className="icon-button" title="添加附件">
                <Paperclip size={21} aria-hidden="true" />
                <input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx" onChange={(event) => selectFiles(event.target.files)} />
                <span className="visually-hidden">添加附件</span>
              </label>
            ) : null}
            <VoiceInputButton value={message} onChange={setMessage} onNotice={setNotice} disabled={running || sending} />
            {running ? (
              <button className="chat-send is-stop" type="button" onClick={() => void stop()} aria-label="停止本轮"><CirclePause size={21} /></button>
            ) : (
              <button className="chat-send" type="submit" disabled={sending || (!message.trim() && !files.length)} aria-label="发送">
                {sending ? <LoaderCircle size={21} className="spin-icon" /> : <SendHorizontal size={21} />}
              </button>
            )}
          </div>
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
