"use client";

import {
  DeleteOutlined,
  FileOutlined,
  FileTextOutlined,
  LeftOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  ReloadOutlined,
  RightOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Switch, Tabs, Tag, Tooltip, message } from "antd";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
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
  fetchCodexRequirementTestingConversation,
  sendCodexRequirementTestingMessage,
  stopCodexRequirementTestingConversation,
  uploadCodexRequirementTestingAttachments,
  type CodexConversationItem,
  type CodexPlanningSessionSummary,
  type DeliveryRequirementRecord,
  type RequirementTestingStatus,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { useImeCompositionGuard } from "@/utils/ime";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { SessionChangeSummary, SessionDocumentText, SessionMessageContent, SessionProcessGroup, groupSessionItems } from "./DeliverySessionMessage";
import { DeliverySessionHistoryTabs, type DeliveryHistoryTab } from "./DeliverySessionHistoryTabs";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  readableAttachmentSize,
} from "./DeliverySessionAttachments";

interface DeliveryRequirementTestingModalProps {
  open: boolean;
  /** 嵌入需求编辑工作区时不再创建第二个 Modal。 */
  embedded?: boolean;
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  programName: string;
  codexBridgeReady: boolean;
  startNewConversationOnOpen?: boolean;
  /** 从需求拆解历史进入测试会话时，直接定位到该测试聊天。 */
  initialThreadId?: string;
  /** 同一需求下的拆解聊天，显示在左侧「需求拆解」分栏里。 */
  planningConversations?: CodexPlanningSessionSummary[];
  /** 聊天历史分栏与需求编辑工作区共用，返回时还停在同一栏。 */
  historyTab?: DeliveryHistoryTab;
  onHistoryTabChange?: (tab: DeliveryHistoryTab) => void;
  /** 嵌进需求编辑的三栏骨架时只渲染中间会话区：左侧历史和右侧需求信息都由上层出。 */
  mainOnly?: boolean;
  contextCollapsed?: boolean;
  onToggleContext?: () => void;
  /** 把当前测试线程回报给上层，左侧历史据此点亮对应条目。 */
  onConversationStateChange?: (state: { threadId: string; isNew: boolean }) => void;
  onClose: () => void;
  onOpenPlanningConversation?: (threadId: string) => void;
  onChanged: () => Promise<void> | void;
}

const statusColor: Record<RequirementTestingStatus, "default" | "processing" | "success" | "error" | "warning"> = {
  todo: "default",
  doing: "processing",
  passed: "success",
  failed: "error",
  blocked: "warning",
};

function TestingTranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
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

export function DeliveryRequirementTestingModal({
  open,
  embedded = false,
  requirement,
  programId,
  programName,
  codexBridgeReady,
  startNewConversationOnOpen = false,
  initialThreadId = "",
  planningConversations = [],
  historyTab,
  onHistoryTabChange,
  mainOnly = false,
  contextCollapsed = false,
  onToggleContext,
  onConversationStateChange,
  onClose,
  onOpenPlanningConversation,
  onChanged,
}: DeliveryRequirementTestingModalProps) {
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
  const requirementKey = requirement?.requirementKey ?? "";
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof fetchCodexRequirementTestingConversation>> | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "cases" | "report">("chat");
  // 独立打开测试工作区时自己记分栏；嵌在需求编辑里则跟着上层走。
  const [ownHistoryTab, setOwnHistoryTab] = useState<DeliveryHistoryTab>("testing");
  const [testCaseOnly, setTestCaseOnly] = useState(true);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const wasActiveRef = useRef(false);
  const initializedRef = useRef(false);
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !requirementKey) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const next = await fetchCodexRequirementTestingConversation(programId, requirementKey, threadId, testingPreference.tool);
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
  }, [onChanged, programId, requirementKey, testingPreference.tool]);

  useEffect(() => {
    if (!open) {
      newConversationRef.current = false;
      loadRequestIdRef.current += 1;
      setConversation(null);
      setSelectedThreadId("");
      setSwitchingThreadId("");
      setNewConversation(false);
      setDraft("");
      setAttachments([]);
      setDraggingAttachments(false);
      setActiveTab("chat");
      setTestCaseOnly(true);
      wasActiveRef.current = false;
      initializedRef.current = false;
      return;
    }
    if (!requirementKey || initializedRef.current) return;
    initializedRef.current = true;
    newConversationRef.current = startNewConversationOnOpen;
    setNewConversation(startNewConversationOnOpen);
    setSelectedThreadId(initialThreadId);
    setDraft("");
    setTestCaseOnly(true);
    void load(initialThreadId, true);
  }, [initialThreadId, load, open, requirementKey, startNewConversationOnOpen]);

  // 只渲染会话区时，选线程和新开聊天的指令都来自上层侧栏，这里跟着 props 走。
  useEffect(() => {
    if (!mainOnly || !open || !initializedRef.current) return;
    if (startNewConversationOnOpen) {
      if (!newConversationRef.current) startNewConversation();
      return;
    }
    if (initialThreadId && initialThreadId !== selectedThreadId) selectConversation(initialThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThreadId, mainOnly, open, startNewConversationOnOpen]);

  // 线程变化回报给上层，左侧历史才能点亮当前这条测试聊天。
  useEffect(() => {
    if (!mainOnly) return;
    onConversationStateChange?.({ threadId: newConversation ? "" : switchingThreadId || conversation?.threadId || "", isNew: newConversation });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.threadId, mainOnly, newConversation, switchingThreadId]);

  const active = Boolean(conversation?.active && !newConversation);
  const report = conversation?.testingReport || requirement?.testingReport || "";
  const testingStatus = conversation?.testingStatus || requirement?.testingStatus || "todo";
  const testingCases = conversation?.testingCases || requirement?.testingCases || "";
  const testingCasesPath = conversation?.testingCasesPath || requirement?.testingCasesPath || "";
  const testingCasesStatus = conversation?.testingCasesStatus || requirement?.testingCasesStatus || "todo";
  const testingConversationTitle = `${requirement?.name || requirementKey} · ${t("delivery.testingCases.status")}`;
  const currentHistoryTab = historyTab ?? ownHistoryTab;
  const changeHistoryTab = (tab: DeliveryHistoryTab) => (onHistoryTabChange ? onHistoryTabChange(tab) : setOwnHistoryTab(tab));
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [conversation],
  );

  usePollingLoop(open && active, 4000, load);

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>(
    [active, flattenedItems.length],
    !switchingThreadId && conversation?.threadId
      ? `zb.delivery.scroll.requirement-testing.${programId}.${requirementKey}.${conversation.threadId}`
      : "",
  );

  const send = async (requestedText?: string, requestedTestCaseOnly = testCaseOnly) => {
    if (switchingThreadId) return;
    const text = (requestedText ?? draft).trim();
    if ((!text && !attachments.length) || !codexBridgeReady || !requirementKey) return;
    setSending(true);
    try {
      const uploaded = attachments.length
        ? await uploadCodexRequirementTestingAttachments(programId, requirementKey, attachments)
        : [];
      const action = await sendCodexRequirementTestingMessage(programId, requirementKey, text, {
        threadId: newConversation ? undefined : selectedThreadId || conversation?.threadId || undefined,
        newConversation,
        provider,
        model: modelForConfig(testingConfig),
        reasoningEffort: effortForConfig(testingConfig),
        fastMode: provider === "claude" && testingConfig.claudeFastMode,
        attachmentIds: uploaded.map((attachment) => attachment.id),
        testCaseOnly: requestedTestCaseOnly,
      });
      setDraft("");
      setAttachments([]);
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

  const executeExistingCases = () => {
    if (active || !testingCases.trim()) return;
    setTestCaseOnly(false);
    void send(t("delivery.requirement.testingExecuteInstruction"), false);
  };

  const stop = async () => {
    if (!requirementKey) return;
    setStopping(true);
    try {
      await stopCodexRequirementTestingConversation(programId, requirementKey, conversation?.threadId || selectedThreadId, provider);
      message.success(t("delivery.session.stopRequested"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const selectAttachments = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files);
    if (incoming.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      message.warning(t("delivery.session.attachmentTooLarge"));
      return;
    }
    setAttachments((current) => {
      const merged = [...current, ...incoming].filter(
        (file, index, values) => values.findIndex((candidate) => attachmentKey(candidate) === attachmentKey(file)) === index,
      );
      if (merged.length > MAX_ATTACHMENTS) {
        message.warning(t("delivery.session.attachmentLimit"));
        return merged.slice(0, MAX_ATTACHMENTS);
      }
      return merged;
    });
  };

  const removeAttachment = (file: File) => {
    setAttachments((current) => current.filter((candidate) => attachmentKey(candidate) !== attachmentKey(file)));
  };

  const isFileDrag = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");

  const handleAttachmentDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = codexBridgeReady && !sending ? "copy" : "none";
    if (codexBridgeReady && !sending) setDraggingAttachments(true);
  };

  const handleAttachmentDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingAttachments(false);
  };

  const handleAttachmentDrop = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDraggingAttachments(false);
    if (!codexBridgeReady || sending) return;
    selectAttachments(event.dataTransfer.files);
  };

  const startNewConversation = () => {
    if (active || !requirementKey) return;
    newConversationRef.current = true;
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    // 新开会话回到偏好里选的工具，不再沿用上一条线程的执行器。
    setConversationExecutorType("");
    setSelectedThreadId("");
    setSwitchingThreadId("");
    setDraft("");
    setAttachments([]);
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    newConversationRef.current = false;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setSwitchingThreadId(threadId);
    setAttachments([]);
    void load(threadId, true);
  };

  const history = (
        <DeliverySessionHistoryTabs
          activeTab={currentHistoryTab}
          onTabChange={changeHistoryTab}
          planningConversations={planningConversations}
          testingConversations={conversation?.conversations ?? []}
          selectedKind="testing"
          selectedThreadId={newConversation ? "" : switchingThreadId || conversation?.threadId || ""}
          draft={newConversation ? { kind: "testing", title: testingConversationTitle, subtitle: `${t("delivery.testingCases.status")} · ${t("delivery.requirement.testingDraft")}` } : null}
          onSelect={(kind, threadId) => (kind === "testing" ? selectConversation(threadId) : onOpenPlanningConversation?.(threadId))}
          onNew={(tab) => (tab === "testing" ? startNewConversation() : onOpenPlanningConversation?.(""))}
          newDisabled={active || !requirementKey}
          testingTitleFallback={testingConversationTitle}
        />
  );

  const sessionMain = (
        <main className="delivery-session-main">
          <header className="delivery-session-toolbar delivery-planning-session-toolbar">
            <div className="delivery-planning-session-toolbar__summary">
              <div className="delivery-session-title delivery-planning-session-title"><div className="delivery-planning-session-title__heading"><span>{t("delivery.requirement.testing")}</span><b>{requirement?.name || requirementKey}</b><small>{programName || programId}</small></div></div>
              <Tag color={statusColor[testingStatus]}>{t(`delivery.requirement.testingStatus.${testingStatus}`)}</Tag>
              <Tag color={testingCasesStatus === "ready" ? "success" : testingCasesStatus === "blocked" ? "warning" : testingCasesStatus === "doing" ? "processing" : "default"}>{t(`delivery.testingCases.status.${testingCasesStatus}`)}</Tag>
            </div>
            <div className="delivery-session-toolbar__actions">
              {testingCases.trim() && !active ? <Button onClick={executeExistingCases} disabled={!codexBridgeReady || sending}>{t("delivery.requirement.executeTesting")}</Button> : null}
              {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
              <Button icon={<ReloadOutlined />} loading={loading} disabled={!requirementKey} onClick={() => void load()} aria-label={t("delivery.session.refresh")} />
              {/* 右侧需求信息在测试工作区里同样可展开收起，位置和拆解会话保持一致。 */}
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
          <Tabs
            className="delivery-session-document-tabs"
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as "chat" | "cases" | "report")}
            items={[
              {
                key: "chat", label: t("delivery.requirement.testingChat"),
                children: <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
                  <Alert className="delivery-testing-cases-chat-hint" type="info" showIcon message={t("delivery.testingCases.chatHint.title")} description={t("delivery.testingCases.chatHint.description")} />
                  {switchingThreadId || (loading && !conversation) ? <div className="delivery-session-transcript__loading"><LoadingOutlined spin /></div> : !newConversation && flattenedItems.length ? (conversation?.turns ?? []).map((turn) => <Fragment key={turn.id}>{groupSessionItems(turn.items).map((group) => (group.kind === "process"
                    ? <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                    : <TestingTranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />))}<SessionChangeSummary items={turn.items} programId={programId} /></Fragment>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.testingEmpty").replace("{tool}", toolName)} />}
                  {active && !switchingThreadId ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
                </div>,
              },
              { key: "cases", label: t("delivery.requirement.testingCases"), children: <div className="delivery-session-document">{testingCasesPath ? <code className="delivery-session-document__path">{testingCasesPath}</code> : null}<SessionDocumentText value={testingCases} fallback={t("delivery.requirement.testingCasesEmpty")} /></div> },
              { key: "report", label: t("delivery.requirement.testingReport"), children: <div className="delivery-session-document"><SessionDocumentText value={report} fallback={t("delivery.requirement.testingReportEmpty")} /></div> },
            ]}
          />
          <footer
            className={`delivery-session-composer is-stacked${draggingAttachments ? " is-dragging" : ""}`}
            onDragOver={handleAttachmentDragOver}
            onDragLeave={handleAttachmentDragLeave}
            onDrop={handleAttachmentDrop}
          >
            <input className="delivery-session-file-input" ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => {
              selectAttachments(event.target.files);
              event.currentTarget.value = "";
            }} />
            <input className="delivery-session-file-input" ref={attachmentInputRef} type="file" multiple onChange={(event) => {
              selectAttachments(event.target.files);
              event.currentTarget.value = "";
            }} />
            <div className="delivery-session-composer__header">
              <Checkbox checked={testCaseOnly} disabled={active || sending || !codexBridgeReady} onChange={(event) => setTestCaseOnly(event.target.checked)}>
                {t("delivery.requirement.testCaseOnly")}
              </Checkbox>
              <Select
                className="delivery-session-composer__model"
                value={modelForConfig(testingConfig)}
                disabled={!codexBridgeReady || sending}
                onChange={(value) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), ...(provider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }) })}
                options={(provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS).map((item) => ({ value: item.value, label: item.label }))}
              />
              <Select
                className="delivery-session-composer__effort"
                value={effortForConfig(testingConfig)}
                disabled={!codexBridgeReady || sending}
                onChange={(value) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), ...(provider === "codex" ? { codexReasoningEffort: value as CodexReasoningEffort } : { claudeEffort: value as ClaudeEffort }) })}
                options={(provider === "codex" ? Array.from(CODEX_REASONING_EFFORTS) : Array.from(CLAUDE_EFFORTS)).map((effort) => ({ value: effort, label: t(`aiPreferences.reasoning.${effort}`) }))}
              />
              {provider === "claude" ? (
                <Tooltip title={t("aiPreferences.fastMode")}>
                  <Switch
                    size="small"
                    checked={testingConfig.claudeFastMode}
                    disabled={!codexBridgeReady || sending}
                    aria-label={t("aiPreferences.fastMode")}
                    onChange={(checked) => setSceneOverride("productTesting", { ...(preferences.scenes.productTesting ?? {}), claudeFastMode: checked })}
                  />
                </Tooltip>
              ) : null}
              <Tooltip title={t("delivery.session.addImage")}>
                <Button type="text" shape="circle" icon={<PictureOutlined />} aria-label={t("delivery.session.addImage")} disabled={!codexBridgeReady || sending} onClick={() => imageInputRef.current?.click()} />
              </Tooltip>
              <Tooltip title={t("delivery.session.addFile")}>
                <Button type="text" shape="circle" icon={<PaperClipOutlined />} aria-label={t("delivery.session.addFile")} disabled={!codexBridgeReady || sending} onClick={() => attachmentInputRef.current?.click()} />
              </Tooltip>
            </div>
            {attachments.length ? (
              <div className="delivery-session-composer__attachments">
                {attachments.map((file) => (
                  <div className={`delivery-session-composer__attachment${file.type.startsWith("image/") ? " is-image" : ""}`} key={attachmentKey(file)}>
                    {file.type.startsWith("image/") ? <PictureOutlined /> : <FileOutlined />}
                    <span title={file.name}>{file.name}</span><small>{readableAttachmentSize(file.size)}</small>
                    <Button type="text" shape="circle" size="small" icon={<DeleteOutlined />} onClick={() => removeAttachment(file)} aria-label={t("delivery.session.removeAttachment")} />
                  </div>
                ))}
              </div>
            ) : null}
            <div className="delivery-session-composer__input"><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={draft} disabled={!codexBridgeReady || sending} placeholder={t(testCaseOnly ? "delivery.requirement.testingCasesInput" : "delivery.requirement.testingInput")} onChange={(event) => setDraft(event.target.value)} {...compositionProps} onPressEnter={(event) => { if (event.shiftKey || isComposingEnter(event)) return; event.preventDefault(); void send(); }} /><Button type="primary" icon={<SendOutlined />} loading={sending} disabled={(!draft.trim() && !attachments.length) || !codexBridgeReady} onClick={() => void send()}>{t(testCaseOnly ? "delivery.requirement.generateTestCases" : "delivery.session.send")}</Button></div>
            {draggingAttachments ? <div className="delivery-session-composer__drop-target">{t("delivery.session.dropAttachments")}</div> : null}
          </footer>
        </main>
  );

  // 嵌进需求编辑的三栏骨架时只交出中间会话区，左右两栏由上层统一渲染。
  if (mainOnly) return sessionMain;

  const workspace = (
    <div className="delivery-planning-shell delivery-requirement-testing-shell">
      {history}
      {sessionMain}
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
