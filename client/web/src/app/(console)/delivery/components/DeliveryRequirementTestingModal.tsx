"use client";

import {
  ArrowLeftOutlined,
  DeleteOutlined,
  FileOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
} from "@ant-design/icons";
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Switch, Tabs, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
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
import { SessionChangeSummary, SessionDocumentText, SessionMarkdown, changesOfTurn } from "./DeliverySessionMessage";
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
  /** 同一需求下的拆解聊天，和测试聊天一起显示在左侧。 */
  planningConversations?: CodexPlanningSessionSummary[];
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
  const isAgentText = item.type === "agentMessage" || item.type === "plan";
  return (
    <article className={`delivery-session-message${isUser ? " is-user" : ""}`}>
      <header>
        <span className="delivery-session-message__icon">{item.type === "agentMessage" ? <FileTextOutlined /> : <MessageOutlined />}</span>
        <b>{isUser ? t("delivery.session.you") : isAgentText ? toolName : t(`delivery.session.item.${item.type}`)}</b>
        {item.status ? <small>{item.status}</small> : null}
      </header>
      {isAgentText ? <SessionMarkdown text={item.text} /> : <div className="delivery-session-message__body">{item.text}</div>}
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
  onClose,
  onOpenPlanningConversation,
  onChanged,
}: DeliveryRequirementTestingModalProps) {
  const { t } = useLocale();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  const testingConfig = configFor("productTesting");
  const provider = testingConfig.tool;
  const toolName = toolDisplayName(provider);
  const requirementKey = requirement?.requirementKey ?? "";
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof fetchCodexRequirementTestingConversation>> | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "cases" | "report">("chat");
  const [testCaseOnly, setTestCaseOnly] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const wasActiveRef = useRef(false);
  const initializedRef = useRef(false);

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !requirementKey) return null;
    setLoading(true);
    try {
      const next = await fetchCodexRequirementTestingConversation(programId, requirementKey, threadId, provider);
      setConversation(next);
      if (!newConversation && !preserveSelected) setSelectedThreadId(next.threadId);
      if (wasActiveRef.current && !next.active) await onChanged();
      wasActiveRef.current = Boolean(next.active);
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [newConversation, onChanged, programId, provider, requirementKey]);

  useEffect(() => {
    if (!open) {
      setConversation(null);
      setSelectedThreadId("");
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
    setNewConversation(startNewConversationOnOpen);
    setSelectedThreadId(initialThreadId);
    setDraft("");
    setTestCaseOnly(true);
    void load(initialThreadId, true);
  }, [initialThreadId, load, open, requirementKey, startNewConversationOnOpen]);

  const active = Boolean(conversation?.active && !newConversation);
  const report = conversation?.testingReport || requirement?.testingReport || "";
  const testingStatus = conversation?.testingStatus || requirement?.testingStatus || "todo";
  const testingCases = conversation?.testingCases || requirement?.testingCases || "";
  const testingCasesPath = conversation?.testingCasesPath || requirement?.testingCasesPath || "";
  const testingCasesStatus = conversation?.testingCasesStatus || requirement?.testingCasesStatus || "todo";
  const testingConversationTitle = `${requirement?.name || requirementKey} · ${t("delivery.testingCases.status")}`;
  const historyEntries = useMemo(() => [
    ...planningConversations.map((entry) => ({ kind: "planning" as const, entry })),
    ...(conversation?.conversations ?? []).map((entry) => ({ kind: "testing" as const, entry })),
  ].sort((left, right) => (right.entry.updatedAt || "").localeCompare(left.entry.updatedAt || "")), [conversation?.conversations, planningConversations]);
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [conversation],
  );

  useEffect(() => {
    if (!open || !active) return undefined;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [active, load, open]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [active, flattenedItems.length]);

  const send = async (requestedText?: string, requestedTestCaseOnly = testCaseOnly) => {
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
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
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
    setNewConversation(true);
    setSelectedThreadId("");
    setDraft("");
    setAttachments([]);
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setAttachments([]);
    void load(threadId, true);
  };

  const workspace = (
      <div className="delivery-planning-shell delivery-requirement-testing-shell">
        <aside className="delivery-planning-history">
          <header className="delivery-session-history__header">
            <h3>{t("delivery.session.history")}</h3>
            <Tooltip title={t("delivery.session.new")}>
              <Button type="text" shape="circle" icon={<PlusOutlined />} disabled={active || !requirementKey} onClick={startNewConversation} />
            </Tooltip>
          </header>
          <div className="delivery-session-history__list">
            {newConversation ? <div className="delivery-session-history__item is-selected is-draft"><MessageOutlined /><div><b>{testingConversationTitle}</b><span>{t("delivery.testingCases.status")} · {t("delivery.requirement.testingDraft")}</span></div></div> : null}
            {historyEntries.map(({ kind, entry }) => (
              <button className={`delivery-session-history__item${kind === "testing" && entry.threadId === conversation?.threadId && !newConversation ? " is-selected" : ""}`} key={`${kind}-${entry.threadId}`} type="button" onClick={() => kind === "testing" ? selectConversation(entry.threadId) : onOpenPlanningConversation?.(entry.threadId)}>
                <MessageOutlined /><div><b>{entry.title || (kind === "testing" ? testingConversationTitle : t("delivery.session.untitled"))}</b><span>{[kind === "testing" ? t("delivery.testingCases.status") : t("delivery.planning.title"), entry.updatedAt ? dayjs(entry.updatedAt).format("MM-DD HH:mm") : ""].filter(Boolean).join(" · ")}</span></div>{entry.active ? <i /> : null}
              </button>
            ))}
            {!newConversation && !historyEntries.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.session.historyEmpty")} /> : null}
          </div>
        </aside>
        <main className="delivery-session-main">
          <header className="delivery-session-toolbar delivery-planning-session-toolbar">
            <div className="delivery-planning-session-toolbar__summary">
              <div className="delivery-session-title delivery-planning-session-title"><div className="delivery-planning-session-title__heading"><span>{t("delivery.requirement.testing")}</span><b>{requirement?.name || requirementKey}</b><small>{programName || programId}</small></div></div>
              <Tag color={statusColor[testingStatus]}>{t(`delivery.requirement.testingStatus.${testingStatus}`)}</Tag>
              <Tag color={testingCasesStatus === "ready" ? "success" : testingCasesStatus === "blocked" ? "warning" : testingCasesStatus === "doing" ? "processing" : "default"}>{t(`delivery.testingCases.status.${testingCasesStatus}`)}</Tag>
            </div>
            <div className="delivery-session-toolbar__actions">
              {embedded ? <Button icon={<ArrowLeftOutlined />} onClick={onClose}>{t("delivery.requirement.backToEditing")}</Button> : null}
              {testingCases.trim() && !active ? <Button onClick={executeExistingCases} disabled={!codexBridgeReady || sending}>{t("delivery.requirement.executeTesting")}</Button> : null}
              {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
              <Button icon={<ReloadOutlined />} loading={loading} disabled={!requirementKey} onClick={() => void load()} aria-label={t("delivery.session.refresh")} />
            </div>
          </header>
          <Tabs
            className="delivery-session-document-tabs"
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as "chat" | "cases" | "report")}
            items={[
              {
                key: "chat", label: t("delivery.requirement.testingChat"),
                children: <div className="delivery-session-transcript" ref={transcriptRef}>
                  <Alert className="delivery-testing-cases-chat-hint" type="info" showIcon message={t("delivery.testingCases.chatHint.title")} description={t("delivery.testingCases.chatHint.description")} />
                  {loading && !conversation ? <div className="delivery-session-transcript__loading"><LoadingOutlined spin /></div> : !newConversation && flattenedItems.length ? (conversation?.turns ?? []).map((turn) => <Fragment key={turn.id}>{turn.items.map((item) => <TestingTranscriptItem item={item} programId={programId} toolName={toolName} key={`${turn.id}-${item.id}-${item.type}`} />)}<SessionChangeSummary changes={changesOfTurn(turn.items)} /></Fragment>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.testingEmpty").replace("{tool}", toolName)} />}
                  {active ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
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
            <div className="delivery-session-composer__input"><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={draft} disabled={!codexBridgeReady || sending} placeholder={t(testCaseOnly ? "delivery.requirement.testingCasesInput" : "delivery.requirement.testingInput")} onChange={(event) => setDraft(event.target.value)} onPressEnter={(event) => { if (event.shiftKey) return; event.preventDefault(); void send(); }} /><Button type="primary" icon={<SendOutlined />} loading={sending} disabled={(!draft.trim() && !attachments.length) || !codexBridgeReady} onClick={() => void send()}>{t(testCaseOnly ? "delivery.requirement.generateTestCases" : "delivery.session.send")}</Button></div>
            {draggingAttachments ? <div className="delivery-session-composer__drop-target">{t("delivery.session.dropAttachments")}</div> : null}
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
