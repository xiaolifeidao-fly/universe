"use client";

import {
  LoadingOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { Button, Empty, Input, Select, Spin, Switch, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
  effortForConfig,
  modelForConfig,
  toolDisplayName,
  type AIExecutionConfig,
  type AITool,
  type ClaudeEffort,
  type ClaudeModel,
  type CodexModel,
  type CodexReasoningEffort,
  useAIPreferences,
} from "@/ai-preferences/AIPreferencesProvider";
import {
  fetchCodexRequirementFineTuningConversation,
  fetchCodexTaskFineTuningConversation,
  sendCodexRequirementFineTuningMessage,
  sendCodexTaskFineTuningMessage,
  stopCodexRequirementFineTuningConversation,
  stopCodexTaskFineTuningConversation,
  type CodexConversationItem,
  type CodexConversationSummary,
  type CodexRequirementFineTuningConversation,
  type CodexPlanningSessionSummary,
  type CodexTaskFineTuningConversation,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { useDraftMemory } from "../hooks/useDraftMemory";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { SessionChangeSummary, SessionMessageContent, SessionProcessGroup, groupSessionItems } from "./DeliverySessionMessage";
import { SessionContextMeter } from "./DeliverySessionContext";

type FineTuningScope = "requirement" | "task";
type FineTuningConversation = CodexRequirementFineTuningConversation | CodexTaskFineTuningConversation;
type FineTuningSummary = CodexPlanningSessionSummary | CodexConversationSummary;

interface DeliveryFineTuningSessionProps {
  scope: FineTuningScope;
  resourceKey: string;
  resourceName: string;
  programId: number;
  codexBridgeReady: boolean;
  /** 需求编辑已有左侧会话列表，嵌入时只渲染中间聊天区。 */
  mainOnly?: boolean;
  startNewConversationOnOpen?: boolean;
  initialThreadId?: string;
  onConversationStateChange?: (state: { threadId: string; isNew: boolean }) => void;
  onChanged: () => Promise<void> | void;
}

function FineTuningTranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
  const { t } = useLocale();
  const isUser = item.type === "userMessage";
  return (
    <article className={`delivery-session-message${isUser ? " is-user" : ""}`}>
      <header>
        <span className="delivery-session-message__icon"><MessageOutlined /></span>
        <b>{isUser ? t("delivery.session.you") : item.type === "agentMessage" ? toolName : t(`delivery.session.item.${item.type}`)}</b>
        {item.status ? <small>{item.status}</small> : null}
      </header>
      <SessionMessageContent item={item} programId={programId} fallback={t("delivery.session.fileChanged")} />
    </article>
  );
}

export function DeliveryFineTuningSession({
  scope,
  resourceKey,
  resourceName,
  programId,
  codexBridgeReady,
  mainOnly = false,
  startNewConversationOnOpen = false,
  initialThreadId = "",
  onConversationStateChange,
  onChanged,
}: DeliveryFineTuningSessionProps) {
  const { t } = useLocale();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  // 微调的结果通常是直接改项目产物，沿用动作执行的执行器和模型偏好。
  const fineTuningPreference = configFor("actionExecution");
  const [conversationExecutorType, setConversationExecutorType] = useState<AITool | "">("");
  const fineTuningConfig = useMemo<AIExecutionConfig>(
    () => ({ ...fineTuningPreference, tool: conversationExecutorType || fineTuningPreference.tool }),
    [conversationExecutorType, fineTuningPreference],
  );
  const provider = fineTuningConfig.tool;
  const toolName = toolDisplayName(provider);
  const [conversation, setConversation] = useState<FineTuningConversation | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const initializedRef = useRef(false);
  const initializedKeyRef = useRef("");
  const syncedRef = useRef(false);
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const conversationStateChangeRef = useRef(onConversationStateChange);
  conversationStateChangeRef.current = onConversationStateChange;

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !resourceKey || !codexBridgeReady) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const next = scope === "requirement"
        ? await fetchCodexRequirementFineTuningConversation(programId, resourceKey, threadId, fineTuningPreference.tool)
        : await fetchCodexTaskFineTuningConversation(programId, resourceKey, threadId, fineTuningPreference.tool);
      if (requestId !== loadRequestIdRef.current) return null;
      setConversation(next);
      if (!newConversationRef.current) {
        setConversationExecutorType(next.threadId ? next.executorType : "");
        if (!preserveSelected) setSelectedThreadId(next.threadId);
      }
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
        setSwitchingThreadId("");
      }
    }
  }, [codexBridgeReady, fineTuningPreference.tool, programId, resourceKey, scope]);

  // 初始化只认 resourceKey：initialThreadId / startNewConversationOnOpen 是本组件
  // 通过 onConversationStateChange 回传给上层的，再拿它们当依赖会和上层来回打架
  // （上层改 prop -> 这里重置 conversation -> 回传空 threadId -> 上层再改 prop），
  // 表现就是会话一直在刷。上层的切换指令统一走下面那个同步 effect。
  useEffect(() => {
    if (!resourceKey || initializedKeyRef.current === resourceKey) return;
    initializedKeyRef.current = resourceKey;
    initializedRef.current = true;
    newConversationRef.current = startNewConversationOnOpen;
    loadRequestIdRef.current += 1;
    setConversation(null);
    setNewConversation(startNewConversationOnOpen);
    setSelectedThreadId(initialThreadId);
    setSwitchingThreadId("");
    setDraft("");
    void load(initialThreadId, true);
  }, [initialThreadId, load, resourceKey, startNewConversationOnOpen]);

  useEffect(() => () => {
    initializedKeyRef.current = "";
    initializedRef.current = false;
    newConversationRef.current = false;
    loadRequestIdRef.current += 1;
  }, []);

  useEffect(() => {
    if (!mainOnly || !initializedRef.current) return;
    // 挂载那一次的 props 已经由上面的初始化 effect 处理过了，这里只管后续切换。
    if (!syncedRef.current) {
      syncedRef.current = true;
      return;
    }
    if (startNewConversationOnOpen) {
      if (!newConversationRef.current) startNewConversation();
      return;
    }
    if (initialThreadId && initialThreadId !== selectedThreadId) selectConversation(initialThreadId);
    // 只在上层切换会话时同步；函数本身会随本地状态变化，不能把它们加入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThreadId, mainOnly, startNewConversationOnOpen]);

  useEffect(() => {
    if (!mainOnly || initializedKeyRef.current !== resourceKey) return;
    // 回调是上层的内联箭头函数，每次渲染都是新的，不能进依赖；isNew 读 ref，
    // 因为初始化 effect 是同步写 ref、异步落 state，首个 commit 里 state 还是旧值。
    conversationStateChangeRef.current?.({
      threadId: newConversationRef.current ? "" : switchingThreadId || conversation?.threadId || "",
      isNew: newConversationRef.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.threadId, mainOnly, newConversation, resourceKey, switchingThreadId]);

  const active = Boolean(conversation?.active && !newConversation);
  const summaries = (conversation?.conversations ?? []) as FineTuningSummary[];
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [conversation],
  );

  usePollingLoop(Boolean(resourceKey) && active, 4000, load);

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>(
    [active, flattenedItems.length],
    !switchingThreadId && conversation?.threadId
      ? `zb.delivery.scroll.fine-tuning.${scope}.${programId}.${resourceKey}.${conversation.threadId}`
      : "",
  );

  useDraftMemory(
    resourceKey
      ? `zb.delivery.draft.fine-tuning.${scope}.${programId}.${resourceKey}.${newConversation ? "new" : conversation?.threadId || "new"}`
      : "",
    draft,
    setDraft,
  );

  const send = async () => {
    if (switchingThreadId || !draft.trim() || !codexBridgeReady || !resourceKey) return;
    setSending(true);
    try {
      const options = {
        threadId: newConversation ? undefined : selectedThreadId || conversation?.threadId || undefined,
        newConversation,
        provider,
        model: modelForConfig(fineTuningConfig),
        reasoningEffort: effortForConfig(fineTuningConfig),
        fastMode: provider === "claude" && fineTuningConfig.claudeFastMode,
      };
      const action = scope === "requirement"
        ? await sendCodexRequirementFineTuningMessage(programId, resourceKey, draft, options)
        : await sendCodexTaskFineTuningMessage(programId, resourceKey, draft, options);
      setDraft("");
      newConversationRef.current = false;
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
      setSwitchingThreadId("");
      await onChanged();
      await load(action.threadId, true);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!resourceKey) return;
    setStopping(true);
    try {
      if (scope === "requirement") {
        await stopCodexRequirementFineTuningConversation(programId, resourceKey, conversation?.threadId || selectedThreadId, provider);
      } else {
        await stopCodexTaskFineTuningConversation(programId, resourceKey, conversation?.threadId || selectedThreadId, provider);
      }
      message.success(t("delivery.session.stopRequested"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const startNewConversation = () => {
    if (active) return;
    newConversationRef.current = true;
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    setConversationExecutorType("");
    setSelectedThreadId("");
    setSwitchingThreadId("");
    setDraft("");
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    newConversationRef.current = false;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setSwitchingThreadId(threadId);
    setDraft("");
    void load(threadId, true);
  };

  const main = (
    <main className="delivery-session-main delivery-fine-tuning-main">
      <header className="delivery-session-toolbar">
        <span>{newConversation
          ? t("delivery.session.newConversation")
          : conversation?.threadId ? <><i /> {t("delivery.session.connected").replace("{tool}", toolName)}</> : t("delivery.session.notStarted")}</span>
        <div className="delivery-session-toolbar__actions">
          {/* 上下文余量放在动作前面：决定「要不要另起一条会话」，属于发消息前要看的那一眼。 */}
          <SessionContextMeter context={conversation?.context} tool={provider} model={modelForConfig(fineTuningConfig)} />
          {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
          <Tooltip title={t("delivery.session.refresh")}>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} aria-label={t("delivery.session.refresh")} />
          </Tooltip>
        </div>
      </header>
      <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
        {switchingThreadId ? <div className="delivery-session-transcript__loading"><Spin /></div> : (
          <Spin spinning={loading && !conversation}>
            {!newConversation && flattenedItems.length ? (conversation?.turns ?? []).map((turn) => (
              <Fragment key={turn.id}>
                {groupSessionItems(turn.items).map((group) => (group.kind === "process" ? (
                  <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                ) : (
                  <FineTuningTranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />
                )))}
                <SessionChangeSummary items={turn.items} programId={programId} />
              </Fragment>
            )) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(newConversation ? "delivery.fineTuning.newEmpty" : "delivery.fineTuning.empty").replace("{tool}", toolName)} />
            )}
            {active ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
          </Spin>
        )}
      </div>
      <footer className="delivery-session-composer">
        <Input.TextArea
          value={draft}
          disabled={!codexBridgeReady || sending}
          placeholder={t("delivery.fineTuning.input").replace("{tool}", toolName)}
          autoSize={{ minRows: 2, maxRows: 6 }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="delivery-session-composer__tools">
          <Select
            className="delivery-session-composer__model"
            value={modelForConfig(fineTuningConfig)}
            disabled={!codexBridgeReady || sending}
            aria-label={t("delivery.execution.model")}
            options={(provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS) as Array<{ value: string; label: string }>}
            onChange={(value) => setSceneOverride("actionExecution", {
              ...(preferences.scenes.actionExecution ?? {}),
              ...(provider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }),
            })}
          />
          <Select
            className="delivery-session-composer__effort"
            value={effortForConfig(fineTuningConfig)}
            disabled={!codexBridgeReady || sending}
            aria-label={t(provider === "codex" ? "aiPreferences.reasoningEffort" : "aiPreferences.claudeEffort")}
            options={(provider === "codex" ? CODEX_REASONING_EFFORTS : CLAUDE_EFFORTS).map((value) => ({ value, label: t(`aiPreferences.reasoning.${value}`) }))}
            onChange={(value) => setSceneOverride("actionExecution", {
              ...(preferences.scenes.actionExecution ?? {}),
              ...(provider === "codex" ? { codexReasoningEffort: value as CodexReasoningEffort } : { claudeEffort: value as ClaudeEffort }),
            })}
          />
          {provider === "claude" ? (
            <Tooltip title={t("aiPreferences.fastMode")}>
              <Switch
                size="small"
                checked={fineTuningConfig.claudeFastMode}
                disabled={!codexBridgeReady || sending}
                aria-label={t("aiPreferences.fastMode")}
                onChange={(checked) => setSceneOverride("actionExecution", { ...(preferences.scenes.actionExecution ?? {}), claudeFastMode: checked })}
              />
            </Tooltip>
          ) : null}
        </div>
        <Tooltip title={t("delivery.session.send")}>
          <Button type="primary" shape="circle" icon={<SendOutlined />} loading={sending} disabled={!draft.trim() || !codexBridgeReady} onClick={() => void send()} />
        </Tooltip>
      </footer>
    </main>
  );

  if (mainOnly) return main;

  return (
    <div className="delivery-session-shell delivery-fine-tuning-shell">
      <aside className="delivery-session-history" aria-label={t("delivery.session.history")}>
        <header className="delivery-session-history__header">
          <h3>{t("delivery.fineTuning.title")}</h3>
          <Tooltip title={active ? t("delivery.session.newDisabled") : t("delivery.session.new")}>
            <Button type="text" shape="circle" icon={<PlusOutlined />} disabled={active} onClick={startNewConversation} aria-label={t("delivery.session.new")} />
          </Tooltip>
        </header>
        <div className="delivery-session-history__list">
          {newConversation ? (
            <div className="delivery-session-history__item is-selected is-draft">
              <MessageOutlined />
              <div><b>{t("delivery.session.newConversation")}</b><span>{t("delivery.fineTuning.title")} · {toolName}</span></div>
            </div>
          ) : null}
          {summaries.map((entry) => (
            <button
              className={`delivery-session-history__item${!newConversation && entry.threadId === (switchingThreadId || conversation?.threadId) ? " is-selected" : ""}`}
              key={entry.threadId}
              type="button"
              onClick={() => selectConversation(entry.threadId)}
            >
              <MessageOutlined />
              <div>
                <Tooltip title={entry.title || resourceName} placement="topLeft" mouseEnterDelay={0.3}><b>{entry.title || resourceName}</b></Tooltip>
                <span>{t("delivery.fineTuning.title")} · {toolDisplayName(entry.executorType)}</span>
                {entry.updatedAt ? <span className="delivery-session-history__item-time">{dayjs(entry.updatedAt).format("MM-DD HH:mm")}</span> : null}
              </div>
              {entry.active ? <i aria-label={t("delivery.session.running")} /> : null}
            </button>
          ))}
          {!newConversation && !summaries.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.fineTuning.historyEmpty")} /> : null}
        </div>
      </aside>
      {main}
    </div>
  );
}
