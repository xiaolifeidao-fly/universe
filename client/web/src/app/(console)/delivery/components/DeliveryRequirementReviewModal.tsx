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
import { Alert, Button, Checkbox, Empty, Input, Popconfirm, Select, Switch, Tabs, Tag, Tooltip, message } from "antd";
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
  fetchCodexGitProjects,
  fetchCodexRequirementReviewConversation,
  sendCodexRequirementReviewMessage,
  stopCodexRequirementReviewConversation,
  type CodexConversationItem,
  type CodexReviewScopeProject,
  type DeliveryRequirementRecord,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { useImeCompositionGuard } from "@/utils/ime";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { SessionChangeSummary, SessionDocumentText, SessionMessageContent, SessionProcessGroup, groupSessionItems } from "./DeliverySessionMessage";

interface DeliveryRequirementReviewModalProps {
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  programName: string;
  codexBridgeReady: boolean;
  startNewConversationOnOpen?: boolean;
  initialThreadId?: string;
  contextCollapsed?: boolean;
  onToggleContext?: () => void;
  /** 把当前 review 线程回报给上层，左侧历史据此点亮对应条目。 */
  onConversationStateChange?: (state: { threadId: string; isNew: boolean }) => void;
  /** 需求编辑里的 Git 悬浮框，review 时同样浮在会话区右侧。 */
  gitPanel?: ReactNode;
  onChanged: () => Promise<void> | void;
}

/** 范围面板里的一个 Git 工程：只关心它改了几个文件、这一轮要不要看。 */
interface ReviewScopeEntry {
  path: string;
  name: string;
  changed: number;
}

function ReviewTranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
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

export function DeliveryRequirementReviewModal({
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
  onChanged,
}: DeliveryRequirementReviewModalProps) {
  const { t } = useLocale();
  const { compositionProps, isComposingEnter } = useImeCompositionGuard();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  const reviewPreference = configFor("productTesting");
  const [conversationExecutorType, setConversationExecutorType] = useState<AITool | "">("");
  const reviewConfig = useMemo<AIExecutionConfig>(
    () => ({ ...reviewPreference, tool: conversationExecutorType || reviewPreference.tool }),
    [conversationExecutorType, reviewPreference],
  );
  const provider = reviewConfig.tool;
  const toolName = toolDisplayName(provider);
  const requirementKey = requirement?.requirementKey ?? "";
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof fetchCodexRequirementReviewConversation>> | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "report">("chat");
  const [scopeEntries, setScopeEntries] = useState<ReviewScopeEntry[]>([]);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeError, setScopeError] = useState("");
  // 取消勾选的工程单独记：靠 selectedFiles 为空判断，会和「整包 review」的空数组混淆。
  const [unselectedProjects, setUnselectedProjects] = useState<string[]>([]);
  const wasActiveRef = useRef(false);
  const initializedRef = useRef(false);
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !requirementKey) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const next = await fetchCodexRequirementReviewConversation(programId, requirementKey, threadId, reviewPreference.tool);
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
  }, [onChanged, programId, requirementKey, reviewPreference.tool]);

  // 变更范围只到工程这一层：列出子工程和各自的变更文件数，默认全选。
  const loadScope = useCallback(async () => {
    if (!programId || !codexBridgeReady) {
      setScopeEntries([]);
      return;
    }
    setScopeLoading(true);
    setScopeError("");
    try {
      const catalog = await fetchCodexGitProjects(programId);
      setScopeEntries((catalog.projects ?? [])
        .filter((project) => project.isGitRepository && !project.error)
        .map((project) => ({
          path: project.path || "",
          name: project.name || project.path || t("delivery.review.rootProject"),
          changed: project.changed || 0,
        })));
    } catch (error) {
      setScopeError((error as Error).message);
      setScopeEntries([]);
    } finally {
      setScopeLoading(false);
    }
  }, [codexBridgeReady, programId, t]);

  useEffect(() => {
    if (!requirementKey || initializedRef.current) return;
    initializedRef.current = true;
    newConversationRef.current = startNewConversationOnOpen;
    setNewConversation(startNewConversationOnOpen);
    setSelectedThreadId(initialThreadId);
    void load(initialThreadId, true);
    void loadScope();
  }, [initialThreadId, load, loadScope, requirementKey, startNewConversationOnOpen]);

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
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [conversation],
  );

  usePollingLoop(active, 4000, load);

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>(
    [active, flattenedItems.length],
    !switchingThreadId && conversation?.threadId
      ? `zb.delivery.scroll.requirement-review.${programId}.${requirementKey}.${conversation.threadId}`
      : "",
  );

  const startNewConversation = () => {
    if (active || !requirementKey) return;
    newConversationRef.current = true;
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    setConversationExecutorType("");
    setSelectedThreadId("");
    setSwitchingThreadId("");
    setDraft("");
    void loadScope();
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    newConversationRef.current = false;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setSwitchingThreadId(threadId);
    void load(threadId, true);
  };

  const toggleProject = (path: string, checked: boolean) => {
    setUnselectedProjects((current) => (checked ? current.filter((value) => value !== path) : current.concat(path)));
  };

  const selectedScope = useMemo<CodexReviewScopeProject[]>(() => scopeEntries
    .filter((entry) => !unselectedProjects.includes(entry.path))
    // files 留空表示这个工程的未提交改动整包都在范围内。
    .map((entry) => ({ path: entry.path, name: entry.name, changed: entry.changed, files: [] })),
    [scopeEntries, unselectedProjects]);

  // 单工程没有可选项，面板只报变更数量；多工程才逐个勾。
  const singleProject = scopeEntries.length <= 1;

  const scopeFileCount = scopeEntries.reduce(
    (total, entry) => total + (unselectedProjects.includes(entry.path) ? 0 : entry.changed),
    0,
  );

  const send = async (generateReport = false) => {
    // 「确认生成」不强制先写字：没补充要求就按已确认的范围和规则直接出报告。
    const text = draft.trim() || (generateReport ? t("delivery.review.generateInstruction") : "");
    if (!text || !codexBridgeReady || !requirementKey || switchingThreadId) return;
    setSending(true);
    try {
      const action = await sendCodexRequirementReviewMessage(programId, requirementKey, text, {
        threadId: newConversation ? undefined : selectedThreadId || conversation?.threadId || undefined,
        newConversation,
        provider,
        model: modelForConfig(reviewConfig),
        reasoningEffort: effortForConfig(reviewConfig),
        fastMode: provider === "claude" && reviewConfig.claudeFastMode,
        scope: selectedScope,
        generateReport,
      });
      setDraft("");
      newConversationRef.current = false;
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
      setSwitchingThreadId("");
      await onChanged();
      await load(action.threadId, true);
      if (generateReport) setActiveTab("report");
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
      await stopCodexRequirementReviewConversation(programId, requirementKey, conversation?.threadId || selectedThreadId, provider);
      message.success(t("delivery.session.stopRequested"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  return (
    <main className="delivery-session-main delivery-review-main">
      <header className="delivery-session-toolbar delivery-planning-session-toolbar">
        <div className="delivery-planning-session-toolbar__summary">
          <div className="delivery-session-title delivery-planning-session-title">
            <div className="delivery-planning-session-title__heading">
              <span>{t("delivery.review.title")}</span>
              <b>{requirement?.name || requirementKey}</b>
              <small>{programName || programId}</small>
            </div>
          </div>
          <Tag color={newConversation ? "default" : active ? "processing" : conversation?.threadId ? "success" : "default"}>
            {newConversation
              ? t("delivery.session.newConversation")
              : active
                ? t("delivery.review.running")
                : conversation?.threadId
                  ? conversation.conversations.find((entry) => entry.threadId === conversation.threadId)?.title || t("delivery.review.title")
                  : t("delivery.review.notStarted")}
          </Tag>
          <Tag>{t("delivery.review.scopeCount").replace("{count}", String(scopeFileCount))}</Tag>
        </div>
        <div className="delivery-session-toolbar__actions">
          {/* 讨论完点这个才写报告：平时的回合只在聊天里给意见，不落文件。 */}
          <Popconfirm
            title={t("delivery.review.generate")}
            description={t("delivery.review.generateHint")}
            okText={t("delivery.review.generate")}
            cancelText={t("common.cancel")}
            disabled={!codexBridgeReady || sending || active}
            onConfirm={() => void send(true)}
          >
            <Button type="primary" icon={<FileTextOutlined />} loading={sending} disabled={!codexBridgeReady || active}>
              {t("delivery.review.generate")}
            </Button>
          </Popconfirm>
          {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
          <Button icon={<ReloadOutlined />} loading={loading || scopeLoading} disabled={!requirementKey} onClick={() => { void load(); void loadScope(); }} aria-label={t("delivery.session.refresh")} />
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

      {/* 变更范围面板：单工程直接列文件，多工程先列工程和各自的变更数，默认全选。 */}
      <section className="delivery-review-scope" aria-label={t("delivery.review.scope")}>
        <header>
          <b>{t("delivery.review.scope")}</b>
          <span>{singleProject ? t("delivery.review.scopeSingleHint") : t("delivery.review.scopeMultiHint")}</span>
          {scopeLoading ? <LoadingOutlined spin /> : null}
        </header>
        {scopeError ? <Alert type="warning" showIcon message={scopeError} /> : null}
        {!scopeLoading && !scopeEntries.length && !scopeError ? <span className="delivery-review-scope__empty">{t("delivery.review.scopeEmpty")}</span> : null}
        {/* 只有一个 Git 工程时没什么可挑的，直接报变更数量；多工程才给勾选。 */}
        {singleProject ? (
          scopeEntries.length ? (
            <span className="delivery-review-scope__count">{t("delivery.review.changedFiles").replace("{count}", String(scopeEntries[0].changed))}</span>
          ) : null
        ) : (
          <ul>
            {scopeEntries.map((entry) => (
              <li key={entry.path || "__root__"}>
                <div className="delivery-review-scope__project">
                  <Checkbox
                    checked={!unselectedProjects.includes(entry.path)}
                    onChange={(event) => toggleProject(entry.path, event.target.checked)}
                  >
                    <b>{entry.name}</b>
                    <small>{entry.path || t("delivery.review.rootProject")}</small>
                  </Checkbox>
                  <span className="delivery-review-scope__count">{t("delivery.review.changedFiles").replace("{count}", String(entry.changed))}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Tabs
        className="delivery-session-document-tabs"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as "chat" | "report")}
        items={[
          {
            key: "chat",
            label: t("delivery.review.chat"),
            children: (
              <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
                {switchingThreadId || (loading && !conversation) ? (
                  <div className="delivery-session-transcript__loading"><LoadingOutlined spin /></div>
                ) : !newConversation && flattenedItems.length ? (
                  (conversation?.turns ?? []).map((turn) => (
                    <Fragment key={turn.id}>
                      {groupSessionItems(turn.items).map((group) => (group.kind === "process"
                        ? <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                        : <ReviewTranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />))}
                      <SessionChangeSummary items={turn.items} programId={programId} />
                    </Fragment>
                  ))
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.review.empty").replace("{tool}", toolName)} />
                )}
                {active && !switchingThreadId ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
              </div>
            ),
          },
          {
            key: "report",
            label: t("delivery.review.report"),
            children: (
              <div className="delivery-session-document">
                {conversation?.reviewReport ? <code className="delivery-session-document__path">{conversation.reviewReportPath}</code> : null}
                <SessionDocumentText value={conversation?.reviewReport ?? ""} fallback={t("delivery.review.reportEmpty")} />
              </div>
            ),
          },
        ]}
      />

      <footer className="delivery-session-composer is-stacked">
        <div className="delivery-session-composer__header">
          <Select
            className="delivery-session-composer__model"
            value={modelForConfig(reviewConfig)}
            disabled={!codexBridgeReady || sending}
            onChange={(value) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), ...(provider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }) })}
            options={(provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((item) => ({ value: item.value, label: item.label }))}
          />
          <Select
            className="delivery-session-composer__effort"
            value={effortForConfig(reviewConfig)}
            disabled={!codexBridgeReady || sending}
            onChange={(value) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), ...(provider === "codex" ? { codexReasoningEffort: value as CodexReasoningEffort } : { claudeEffort: value as ClaudeEffort }) })}
            options={(provider === "codex" ? Array.from(CODEX_REASONING_EFFORTS) : Array.from(CLAUDE_EFFORTS)).map((effort) => ({ value: effort, label: t(`aiPreferences.reasoning.${effort}`) }))}
          />
          {provider === "claude" ? (
            <Tooltip title={t("aiPreferences.fastMode")}>
              <Switch
                size="small"
                checked={reviewConfig.claudeFastMode}
                disabled={!codexBridgeReady || sending}
                aria-label={t("aiPreferences.fastMode")}
                onChange={(checked) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), claudeFastMode: checked })}
              />
            </Tooltip>
          ) : null}
        </div>
        <div className="delivery-session-composer__input">
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 7 }}
            value={draft}
            disabled={!codexBridgeReady || sending}
            placeholder={t("delivery.review.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            {...compositionProps}
            onPressEnter={(event) => {
              if (event.shiftKey || isComposingEnter(event)) return;
              event.preventDefault();
              void send();
            }}
          />
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!draft.trim() || !codexBridgeReady || active} onClick={() => void send()}>
            {t("delivery.review.send")}
          </Button>
        </div>
      </footer>
    </main>
  );
}
