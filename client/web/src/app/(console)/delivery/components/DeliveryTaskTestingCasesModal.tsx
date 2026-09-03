"use client";

import {
  ArrowLeftOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Modal, Select, Switch, Tabs, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
  type AIExecutionConfig,
  type AITool,
  type ClaudeEffort,
  type ClaudeModel,
  type CodexModel,
  type CodexReasoningEffort,
  effortForConfig,
  modelForConfig,
  toolDisplayName,
  useAIPreferences,
} from "@/ai-preferences/AIPreferencesProvider";
import {
  fetchCodexTaskTestingCasesConversation,
  sendCodexTaskTestingCasesMessage,
  stopCodexTaskTestingCasesConversation,
  type CodexConversationItem,
  type CodexConversationSummary,
  type DeliveryItemRecord,
  type TestingCasesStatus,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { useImeCompositionGuard } from "@/utils/ime";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useDraftMemory } from "../hooks/useDraftMemory";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { SessionDocumentText, SessionMessageContent, SessionProcessGroup, groupSessionItems, SessionChangeSummary } from "./DeliverySessionMessage";
import { SessionContextMeter } from "./DeliverySessionContext";

interface DeliveryTaskTestingCasesModalProps {
  open: boolean;
  /** 嵌入任务详情工作区时复用外层 Modal。 */
  embedded?: boolean;
  item: DeliveryItemRecord | null;
  programId: number;
  codexBridgeReady: boolean;
  startNewConversationOnOpen?: boolean;
  initialThreadId?: string;
  /** 同一任务下的梳理、行动和成品测试聊天。 */
  taskConversations?: CodexConversationSummary[];
  onClose: () => void;
  onOpenTaskConversation?: (threadId: string) => void;
  onChanged: () => Promise<void> | void;
}

function TranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
  const { t } = useLocale();
  const isUser = item.type === "userMessage";
  return (
    <article className={`delivery-session-message${isUser ? " is-user" : ""}`}>
      <header>
        <span className="delivery-session-message__icon">{isUser ? <MessageOutlined /> : <FileTextOutlined />}</span>
        <b>{isUser ? t("delivery.session.you") : item.type === "agentMessage" || item.type === "plan" ? toolName : t(`delivery.session.item.${item.type}`)}</b>
        {item.status ? <small>{item.status}</small> : null}
      </header>
      <SessionMessageContent item={item} programId={programId} />
    </article>
  );
}

export function DeliveryTaskTestingCasesModal({
  open,
  embedded = false,
  item,
  programId,
  codexBridgeReady,
  startNewConversationOnOpen = false,
  initialThreadId = "",
  taskConversations = [],
  onClose,
  onOpenTaskConversation,
  onChanged,
}: DeliveryTaskTestingCasesModalProps) {
  const { t } = useLocale();
  const { compositionProps, isComposingEnter } = useImeCompositionGuard();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  const testingPreference = configFor("productTesting");
  const [conversationExecutorType, setConversationExecutorType] = useState<AITool | "">("");
  // 续已有会话时跟着这条线程自己的工具走：正文在那个执行器的缓存里，模型选项也要对齐。
  const testingConfig = useMemo<AIExecutionConfig>(
    () => ({ ...testingPreference, tool: conversationExecutorType || testingPreference.tool }),
    [conversationExecutorType, testingPreference],
  );
  const provider = testingConfig.tool;
  const toolName = toolDisplayName(provider);
  const itemKey = item?.itemKey ?? "";
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof fetchCodexTaskTestingCasesConversation>> | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "cases">("chat");
  const wasActiveRef = useRef(false);
  const initializedRef = useRef(false);
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !itemKey) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const next = await fetchCodexTaskTestingCasesConversation(programId, itemKey, threadId, testingPreference.tool);
      if (requestId !== loadRequestIdRef.current) return null;
      setConversation(next);
      if (!newConversationRef.current) {
        setConversationExecutorType(next.threadId ? next.executorType : "");
        if (!preserveSelected) setSelectedThreadId(next.threadId);
      }
      if (wasActiveRef.current && !next.active) await onChanged();
      wasActiveRef.current = Boolean(next.active);
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
  }, [itemKey, onChanged, programId, testingPreference.tool]);

  useEffect(() => {
    if (!open) {
      newConversationRef.current = false;
      loadRequestIdRef.current += 1;
      setConversation(null);
      setSelectedThreadId("");
      setSwitchingThreadId("");
      setNewConversation(false);
      setDraft("");
      setActiveTab("chat");
      wasActiveRef.current = false;
      initializedRef.current = false;
      return;
    }
    if (!itemKey || initializedRef.current) return;
    initializedRef.current = true;
    newConversationRef.current = startNewConversationOnOpen;
    setNewConversation(startNewConversationOnOpen);
    setSelectedThreadId(initialThreadId);
    setDraft("");
    void load(initialThreadId, true);
  }, [initialThreadId, itemKey, load, open, startNewConversationOnOpen]);

  const active = Boolean(conversation?.active && !newConversation);
  const testingCases = conversation?.testingCases || item?.testingCases || "";
  const testingCasesPath = conversation?.testingCasesPath || item?.testingCasesPath || "";
  const testingCasesStatus: TestingCasesStatus = conversation?.testingCasesStatus || item?.testingCasesStatus || "todo";
  const testingConversationTitle = `${item?.title || itemKey} · ${t("delivery.testingCases.status")}`;
  const historyEntries = useMemo(() => [
    ...taskConversations.map((entry) => ({ kind: "task" as const, entry })),
    ...(conversation?.conversations ?? []).map((entry) => ({ kind: "testing" as const, entry })),
  ].sort((left, right) => (right.entry.updatedAt || "").localeCompare(left.entry.updatedAt || "")), [conversation?.conversations, taskConversations]);
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((entry) => ({ ...entry, turnId: turn.id }))),
    [conversation],
  );

  usePollingLoop(open && active, 4000, load);

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>(
    [active, flattenedItems.length],
    !switchingThreadId && conversation?.threadId
      ? `zb.delivery.scroll.task-testing.${programId}.${itemKey}.${conversation.threadId}`
      : "",
  );

  useDraftMemory(
    itemKey
      ? `zb.delivery.draft.task-testing.${programId}.${itemKey}.${newConversation ? "new" : conversation?.threadId || "new"}`
      : "",
    draft,
    setDraft,
  );

  const send = async () => {
    if (switchingThreadId) return;
    const text = draft.trim();
    if (!text || !codexBridgeReady || !itemKey) return;
    setSending(true);
    try {
      const action = await sendCodexTaskTestingCasesMessage(programId, itemKey, text, {
        threadId: newConversation ? undefined : selectedThreadId || conversation?.threadId || undefined,
        newConversation,
        provider,
        model: modelForConfig(testingConfig),
        reasoningEffort: effortForConfig(testingConfig),
        fastMode: provider === "claude" && testingConfig.claudeFastMode,
      });
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
    if (!itemKey) return;
    setStopping(true);
    try {
      await stopCodexTaskTestingCasesConversation(programId, itemKey, conversation?.threadId || selectedThreadId, provider);
      message.success(t("delivery.session.stopRequested"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const startNewConversation = () => {
    if (active || !itemKey) return;
    newConversationRef.current = true;
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    // 新开会话回到偏好里选的工具，不再沿用上一条线程的执行器。
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
    void load(threadId, true);
  };

  const statusColor: Record<TestingCasesStatus, "default" | "processing" | "success" | "warning"> = {
    todo: "default",
    doing: "processing",
    ready: "success",
    blocked: "warning",
  };

  const workspace = (
      <div className="delivery-planning-shell delivery-task-testing-shell">
        <aside className="delivery-planning-history" aria-label={t("delivery.session.history")}>
          <header className="delivery-session-history__header">
            <h3>{t("delivery.session.history")}</h3>
            <Tooltip title={t("delivery.session.new")}>
              <Button type="text" shape="circle" icon={<PlusOutlined />} disabled={active || !itemKey} onClick={startNewConversation} aria-label={t("delivery.session.new")} />
            </Tooltip>
          </header>
          <div className="delivery-session-history__list">
            {newConversation ? <div className="delivery-session-history__item is-selected is-draft"><MessageOutlined /><div><b>{testingConversationTitle}</b><span>{t("delivery.testingCases.status")} · {t("delivery.taskTestingCases.draft")}</span></div></div> : null}
            {historyEntries.map(({ kind, entry }) => (
              <button className={`delivery-session-history__item${kind === "testing" && entry.threadId === (switchingThreadId || conversation?.threadId) && !newConversation ? " is-selected" : ""}`} key={`${kind}-${entry.threadId}`} type="button" onClick={() => kind === "testing" ? selectConversation(entry.threadId) : onOpenTaskConversation?.(entry.threadId)}>
                <MessageOutlined /><div><b>{entry.title || (kind === "testing" ? testingConversationTitle : t("delivery.session.untitled"))}</b><span>{[kind === "testing" ? t("delivery.testingCases.status") : t(`delivery.phase.${entry.phase}`), toolDisplayName(entry.executorType), entry.updatedAt ? dayjs(entry.updatedAt).format("MM-DD HH:mm") : ""].filter(Boolean).join(" · ")}</span></div>{entry.active ? <i /> : null}
              </button>
            ))}
            {!newConversation && !historyEntries.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.session.historyEmpty")} /> : null}
          </div>
        </aside>
        <main className="delivery-session-main">
          <header className="delivery-session-toolbar delivery-planning-session-toolbar">
            <div className="delivery-planning-session-toolbar__summary">
              <div className="delivery-session-title delivery-planning-session-title"><div className="delivery-planning-session-title__heading"><span>{t("delivery.taskTestingCases.title")}</span><b>{item?.title || itemKey}</b><small>{itemKey}</small></div></div>
              <Tag color={statusColor[testingCasesStatus]}>{t(`delivery.testingCases.status.${testingCasesStatus}`)}</Tag>
            </div>
            <div className="delivery-session-toolbar__actions">
              {/* 上下文余量放在动作前面：决定「要不要另起一条会话」，属于发消息前要看的那一眼。 */}
              <SessionContextMeter context={conversation?.context} tool={provider} model={modelForConfig(testingConfig)} />
              {embedded ? <Button icon={<ArrowLeftOutlined />} onClick={onClose}>{t("delivery.session.backToTask")}</Button> : null}
              {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
              <Button icon={<ReloadOutlined />} loading={loading} disabled={!itemKey} onClick={() => void load(selectedThreadId, true)} aria-label={t("delivery.session.refresh")} />
            </div>
          </header>
          <Tabs
            className="delivery-session-document-tabs"
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as "chat" | "cases")}
            items={[
              {
                key: "chat", label: t("delivery.taskTestingCases.chat"),
                children: <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
                  <Alert className="delivery-testing-cases-chat-hint" type="info" showIcon message={t("delivery.testingCases.chatHint.title")} description={t("delivery.testingCases.chatHint.description")} />
                  {switchingThreadId || (loading && !conversation) ? <div className="delivery-session-transcript__loading"><LoadingOutlined spin /></div> : !newConversation && flattenedItems.length ? (conversation?.turns ?? []).map((turn) => <Fragment key={turn.id}>{groupSessionItems(turn.items).map((group) => (group.kind === "process"
                    ? <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                    : <TranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />))}<SessionChangeSummary items={turn.items} programId={programId} /></Fragment>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.taskTestingCases.empty").replace("{tool}", toolName)} />}
                  {active && !switchingThreadId ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
                </div>,
              },
              { key: "cases", label: t("delivery.taskTestingCases.cases"), children: <div className="delivery-session-document">{testingCasesPath ? <code className="delivery-session-document__path">{testingCasesPath}</code> : null}<SessionDocumentText value={testingCases} fallback={t("delivery.taskTestingCases.casesEmpty")} /></div> },
            ]}
          />
          <footer className="delivery-session-composer is-stacked">
            <div className="delivery-session-composer__header">
              <Select
                className="delivery-session-composer__model"
                value={modelForConfig(testingConfig)}
                disabled={!codexBridgeReady || sending}
                onChange={(value) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), ...(provider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }) })}
                options={(provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((entry) => ({ value: entry.value, label: entry.label }))}
              />
              <Select
                className="delivery-session-composer__effort"
                value={effortForConfig(testingConfig)}
                disabled={!codexBridgeReady || sending}
                onChange={(value) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), ...(provider === "codex" ? { codexReasoningEffort: value as CodexReasoningEffort } : { claudeEffort: value as ClaudeEffort }) })}
                options={(provider === "codex" ? Array.from(CODEX_REASONING_EFFORTS) : Array.from(CLAUDE_EFFORTS)).map((effort) => ({ value: effort, label: t(`aiPreferences.reasoning.${effort}`) }))}
              />
              {provider === "claude" ? <Tooltip title={t("aiPreferences.fastMode")}><Switch size="small" checked={testingConfig.claudeFastMode} disabled={!codexBridgeReady || sending} aria-label={t("aiPreferences.fastMode")} onChange={(checked) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), claudeFastMode: checked })} /></Tooltip> : null}
            </div>
            <div className="delivery-session-composer__input"><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={draft} disabled={!codexBridgeReady || sending} placeholder={t("delivery.taskTestingCases.input")} onChange={(event) => setDraft(event.target.value)} {...compositionProps} onPressEnter={(event) => { if (event.shiftKey || isComposingEnter(event)) return; event.preventDefault(); void send(); }} /><Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!draft.trim() || !codexBridgeReady} onClick={() => void send()}>{t("delivery.session.send")}</Button></div>
          </footer>
        </main>
      </div>
  );

  if (embedded) return workspace;

  return (
    <Modal
      className="delivery-task-session-modal delivery-planning-session-modal"
      open={open}
      footer={null}
      onCancel={onClose}
      width="100%"
      style={{ top: 0, maxWidth: "none", margin: 0, paddingBottom: 0 }}
      styles={{ content: { padding: 0 }, body: { padding: 0 } }}
      title={null}
    >
      {workspace}
    </Modal>
  );
}
