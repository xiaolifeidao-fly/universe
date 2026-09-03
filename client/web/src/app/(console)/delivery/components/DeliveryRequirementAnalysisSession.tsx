"use client";

import {
  FileTextOutlined,
  LeftOutlined,
  LoadingOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Select, Switch, Tabs, Tag, Tooltip, message } from "antd";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  fetchCodexRequirementAnalysisConversation,
  sendCodexRequirementAnalysisMessage,
  stopCodexRequirementAnalysisConversation,
  type CodexConversationItem,
  type CodexRequirementAnalysisConversation,
  type DeliveryConversationReference,
  type DeliveryItemRecord,
  type DeliveryRequirementRecord,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useDraftMemory } from "../hooks/useDraftMemory";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { DeliveryDocumentSetPanel } from "./DeliveryDocumentSet";
import { SessionContextMeter } from "./DeliverySessionContext";
import { DeliveryConversationMentionInput, type DeliveryConversationMentionCatalog, type DeliveryConversationMentionFile } from "./DeliveryConversationMentionInput";
import { SessionChangeSummary, SessionMessageContent, SessionProcessGroup, groupSessionItems } from "./DeliverySessionMessage";

interface DeliveryRequirementAnalysisSessionProps {
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  programName: string;
  codexBridgeReady: boolean;
  startNewConversationOnOpen?: boolean;
  initialThreadId?: string;
  contextCollapsed?: boolean;
  onToggleContext?: () => void;
  /** 把当前分析线程回报给上层，左侧历史据此点亮对应条目。 */
  onConversationStateChange?: (state: { threadId: string; isNew: boolean }) => void;
  /** 需求编辑里的 Git 悬浮框，分析时同样浮在会话区右侧。 */
  gitPanel?: ReactNode;
  /** @ 候选目录由需求窗口统一加载后传下来，分析不再自己拉一遍。 */
  mentionRequirements?: DeliveryRequirementRecord[];
  mentionItems?: DeliveryItemRecord[];
  mentionFiles?: DeliveryConversationMentionFile[];
  onSearchMentionCandidates?: (keyword: string) => Promise<DeliveryConversationMentionCatalog>;
  onChanged: () => Promise<void> | void;
}

function AnalysisTranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
  const { t } = useLocale();
  const isUser = item.type === "userMessage";
  return (
    <article className={`delivery-session-message${isUser ? " is-user" : ""}`}>
      <header>
        <span className="delivery-session-message__icon">{item.type === "agentMessage" ? <FileTextOutlined /> : <MessageOutlined />}</span>
        <b>{isUser ? t("delivery.session.you") : item.type === "agentMessage" || item.type === "plan" ? toolName : t(`delivery.session.item.${item.type}`)}</b>
        {item.status ? <small>{item.status}</small> : null}
      </header>
      <SessionMessageContent item={item} programId={programId} />
    </article>
  );
}

/**
 * 需求分析会话：排在需求拆解之前的一步。
 *
 * 默认每一轮都只在聊天里澄清，不落文件；用户点「确认生成需求分析文档」那一轮才写
 * doc/analysis/<需求键>/。这样文档反映的是已经聊清楚的口径，而不是模型第一轮的自我发挥。
 */
export function DeliveryRequirementAnalysisSession({
  requirement,
  programId,
  programName,
  codexBridgeReady,
  startNewConversationOnOpen = false,
  initialThreadId = "",
  contextCollapsed = false,
  onToggleContext,
  onConversationStateChange,
  gitPanel = null,
  mentionRequirements = [],
  mentionItems = [],
  mentionFiles,
  onSearchMentionCandidates,
  onChanged,
}: DeliveryRequirementAnalysisSessionProps) {
  const { t } = useLocale();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  // 需求分析和需求拆解是同一件事的前后两步，沿用拆解的执行器和模型偏好。
  const analysisPreference = configFor("taskPlanning");
  const [conversationExecutorType, setConversationExecutorType] = useState<AITool | "">("");
  const analysisConfig = useMemo<AIExecutionConfig>(
    () => ({ ...analysisPreference, tool: conversationExecutorType || analysisPreference.tool }),
    [analysisPreference, conversationExecutorType],
  );
  const provider = analysisConfig.tool;
  const toolName = toolDisplayName(provider);
  const requirementKey = requirement?.requirementKey ?? "";
  const [conversation, setConversation] = useState<CodexRequirementAnalysisConversation | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "document">("chat");
  // 原型是可选的附加产出：勾上之后本轮顺带画，默认不画，免得每次澄清都被拖去写 HTML。
  const [withPrototype, setWithPrototype] = useState(false);
  const [documentToken, setDocumentToken] = useState(0);
  const [chatReferences, setChatReferences] = useState<DeliveryConversationReference[]>([]);
  const wasActiveRef = useRef(false);
  const initializedRef = useRef(false);
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !requirementKey) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const next = await fetchCodexRequirementAnalysisConversation(programId, requirementKey, threadId, analysisPreference.tool);
      if (requestId !== loadRequestIdRef.current) return null;
      setConversation(next);
      if (!newConversationRef.current) {
        setConversationExecutorType(next.threadId ? next.executorType : "");
        if (!preserveSelected) setSelectedThreadId(next.threadId);
      }
      // 回合刚结束时文档多半刚被写过，让文档页签重新拉一次目录。
      if (wasActiveRef.current && !next.active) {
        setDocumentToken((token) => token + 1);
        await onChanged();
      }
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
  }, [analysisPreference.tool, onChanged, programId, requirementKey]);

  const startNewConversation = useCallback(() => {
    if (!requirementKey) return;
    newConversationRef.current = true;
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    setConversationExecutorType("");
    setSelectedThreadId("");
    setSwitchingThreadId("");
    setDraft("");
    setChatReferences([]);
    setActiveTab("chat");
  }, [requirementKey]);

  const selectConversation = useCallback((threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    newConversationRef.current = false;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setSwitchingThreadId(threadId);
    void load(threadId, true);
  }, [load, newConversation, selectedThreadId]);

  useEffect(() => {
    if (!requirementKey || initializedRef.current) return;
    initializedRef.current = true;
    newConversationRef.current = startNewConversationOnOpen;
    setNewConversation(startNewConversationOnOpen);
    setSelectedThreadId(initialThreadId);
    void load(initialThreadId, true);
  }, [initialThreadId, load, requirementKey, startNewConversationOnOpen]);

  // 选线程和新开聊天的指令都来自上层侧栏。
  useEffect(() => {
    if (!initializedRef.current) return;
    if (startNewConversationOnOpen) {
      if (!newConversationRef.current) startNewConversation();
      return;
    }
    if (initialThreadId && initialThreadId !== selectedThreadId) selectConversation(initialThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThreadId, startNewConversationOnOpen]);

  useEffect(() => {
    onConversationStateChange?.({ threadId: newConversation ? "" : switchingThreadId || conversation?.threadId || "", isNew: newConversation });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.threadId, newConversation, switchingThreadId]);

  const active = Boolean(conversation?.active && !newConversation);
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items),
    [conversation],
  );

  usePollingLoop(active, 4000, load);

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>(
    [active, flattenedItems.length],
    !switchingThreadId && conversation?.threadId
      ? `zb.delivery.scroll.requirement-analysis.${programId}.${requirementKey}.${conversation.threadId}`
      : "",
  );

  useDraftMemory(
    requirementKey
      ? `zb.delivery.draft.requirement-analysis.${programId}.${requirementKey}.${newConversation ? "new" : conversation?.threadId || "new"}`
      : "",
    draft,
    setDraft,
  );

  const documentCount = conversation?.documents?.length ?? 0;

  const send = async (generateDocument = false) => {
    // 「确认生成」不强制先写字：没补充就按会话里已经确认的口径直接出文档。
    const text = draft.trim()
      || (generateDocument ? t("delivery.analysis.generateInstruction") : "")
      || (chatReferences.length ? t("delivery.chatMention.referenceMessage") : "");
    if (!text || !codexBridgeReady || !requirementKey || switchingThreadId) return;
    setSending(true);
    try {
      const action = await sendCodexRequirementAnalysisMessage(programId, requirementKey, text, {
        threadId: newConversation ? undefined : selectedThreadId || conversation?.threadId || undefined,
        newConversation,
        provider,
        model: modelForConfig(analysisConfig),
        reasoningEffort: effortForConfig(analysisConfig),
        fastMode: provider === "claude" && analysisConfig.claudeFastMode,
        chatReferences,
        generateDocument,
        generatePrototype: withPrototype,
      });
      setDraft("");
      setChatReferences([]);
      newConversationRef.current = false;
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
      setSwitchingThreadId("");
      await onChanged();
      await load(action.threadId, true);
      if (generateDocument) setActiveTab("document");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!requirementKey) return;
    setStopping(true);
    try {
      await stopCodexRequirementAnalysisConversation(programId, requirementKey, conversation?.threadId || selectedThreadId, provider);
      message.success(t("delivery.session.stopRequested"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  return (
    <main className="delivery-session-main delivery-analysis-main">
      <header className="delivery-session-toolbar delivery-planning-session-toolbar">
        <div className="delivery-planning-session-toolbar__summary">
          <div className="delivery-session-title delivery-planning-session-title">
            <div className="delivery-planning-session-title__heading">
              <span>{t("delivery.analysis.title")}</span>
              <b>{requirement?.name || requirementKey}</b>
              <small>{programName || programId}</small>
            </div>
          </div>
          <Tag color={newConversation ? "default" : active ? "processing" : conversation?.threadId ? "success" : "default"}>
            {newConversation
              ? t("delivery.session.newConversation")
              : active
                ? t("delivery.analysis.running")
                : conversation?.threadId
                  ? conversation.conversations.find((entry) => entry.threadId === conversation.threadId)?.title || t("delivery.analysis.title")
                  : t("delivery.analysis.notStarted")}
          </Tag>
          <Tag>{t("delivery.analysis.documentCount").replace("{count}", String(documentCount))}</Tag>
        </div>
        <div className="delivery-session-toolbar__actions">
          {/* 上下文余量放在动作前面：决定「要不要另起一条会话」，属于发消息前要看的那一眼。 */}
          <SessionContextMeter context={conversation?.context} tool={provider} model={modelForConfig(analysisConfig)} />
          {/* 聊清楚了才点这个：平时的回合只在聊天里补信息，不落文件。 */}
          <Popconfirm
            title={t("delivery.analysis.generate")}
            description={t("delivery.analysis.generateHint")}
            okText={t("delivery.analysis.generate")}
            cancelText={t("common.cancel")}
            disabled={!codexBridgeReady || sending || active}
            onConfirm={() => void send(true)}
          >
            <Button type="primary" icon={<FileTextOutlined />} loading={sending} disabled={!codexBridgeReady || active}>
              {t("delivery.analysis.generate")}
            </Button>
          </Popconfirm>
          {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
          <Button icon={<ReloadOutlined />} loading={loading} disabled={!requirementKey} onClick={() => void load(selectedThreadId, true)} aria-label={t("delivery.session.refresh")} />
          {onToggleContext ? (
            <Tooltip title={t(contextCollapsed ? "delivery.planning.expandContext" : "delivery.planning.collapseContext")}>
              <Button
                className="delivery-planning-context-toggle"
                type="text"
                shape="circle"
                icon={contextCollapsed ? <RightOutlined /> : <LeftOutlined />}
                aria-label={t(contextCollapsed ? "delivery.planning.expandContext" : "delivery.planning.collapseContext")}
                onClick={onToggleContext}
              />
            </Tooltip>
          ) : null}
        </div>
      </header>

      {gitPanel}

      <Tabs
        className="delivery-session-document-tabs"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as "chat" | "document")}
        items={[
          {
            key: "chat",
            label: t("delivery.analysis.chat"),
            children: (
              <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
                {switchingThreadId || (loading && !conversation) ? (
                  <div className="delivery-session-transcript__loading"><LoadingOutlined spin /></div>
                ) : !newConversation && flattenedItems.length ? (
                  (conversation?.turns ?? []).map((turn) => (
                    <Fragment key={turn.id}>
                      {groupSessionItems(turn.items).map((group) => (group.kind === "process"
                        ? <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                        : <AnalysisTranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />))}
                      <SessionChangeSummary items={turn.items} programId={programId} />
                    </Fragment>
                  ))
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.analysis.empty").replace("{tool}", toolName)} />
                )}
                {active && !switchingThreadId ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
              </div>
            ),
          },
          {
            key: "document",
            label: t("delivery.analysis.document"),
            children: (
              <DeliveryDocumentSetPanel
                programId={programId}
                scope="requirement-analysis"
                subjectKey={requirementKey}
                codexBridgeReady={codexBridgeReady}
                emptyText={t("delivery.analysis.documentEmpty")}
                preferredPath={conversation?.documentPath}
                refreshToken={documentToken}
                uploadable
                scroll="fill"
              />
            ),
          },
        ]}
      />

      <footer className="delivery-session-composer is-stacked">
        <div className="delivery-session-composer__header">
          <Select
            className="delivery-session-composer__model"
            value={modelForConfig(analysisConfig)}
            disabled={!codexBridgeReady || sending}
            onChange={(value) => setSceneOverride("taskPlanning", { ...(preferences.scenes.taskPlanning ?? {}), ...(provider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }) })}
            options={(provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((item) => ({ value: item.value, label: item.label }))}
          />
          <Select
            className="delivery-session-composer__effort"
            value={effortForConfig(analysisConfig)}
            disabled={!codexBridgeReady || sending}
            onChange={(value) => setSceneOverride("taskPlanning", { ...(preferences.scenes.taskPlanning ?? {}), ...(provider === "codex" ? { codexReasoningEffort: value as CodexReasoningEffort } : { claudeEffort: value as ClaudeEffort }) })}
            options={(provider === "codex" ? Array.from(CODEX_REASONING_EFFORTS) : Array.from(CLAUDE_EFFORTS)).map((effort) => ({ value: effort, label: t(`aiPreferences.reasoning.${effort}`) }))}
          />
          {provider === "claude" ? (
            <Tooltip title={t("aiPreferences.fastMode")}>
              <Switch
                size="small"
                checked={analysisConfig.claudeFastMode}
                disabled={!codexBridgeReady || sending}
                aria-label={t("aiPreferences.fastMode")}
                onChange={(checked) => setSceneOverride("taskPlanning", { ...(preferences.scenes.taskPlanning ?? {}), claudeFastMode: checked })}
              />
            </Tooltip>
          ) : null}
          <Tooltip title={t("delivery.analysis.generatePrototypeHint")}>
            <label className="delivery-session-composer__toggle">
              <Switch size="small" checked={withPrototype} disabled={!codexBridgeReady || sending} onChange={setWithPrototype} />
              <span>{t("delivery.analysis.generatePrototype")}</span>
            </label>
          </Tooltip>
        </div>
        <div className="delivery-session-composer__input">
          <DeliveryConversationMentionInput
            value={draft}
            disabled={!codexBridgeReady || sending}
            placeholder={t("delivery.analysis.placeholder")}
            requirements={mentionRequirements}
            items={mentionItems}
            files={mentionFiles}
            references={chatReferences}
            onChange={setDraft}
            onReferencesChange={setChatReferences}
            onSearchCandidates={onSearchMentionCandidates}
            onPressEnter={(event) => {
              if (event.shiftKey) return;
              event.preventDefault();
              void send();
            }}
          />
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={(!draft.trim() && !chatReferences.length) || !codexBridgeReady || active} onClick={() => void send()}>
            {t("delivery.analysis.send")}
          </Button>
        </div>
      </footer>
    </main>
  );
}
