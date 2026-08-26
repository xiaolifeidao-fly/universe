"use client";

import {
  CheckCircleOutlined,
  CloseOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  FileOutlined,
  PaperClipOutlined,
  PictureOutlined,
  LoadingOutlined,
  MessageOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Button, Empty, Modal, Select, Spin, Switch, Tabs, Tooltip, message } from "antd";
import dayjs from "dayjs";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
  effortForConfig,
  modelForConfig,
  sceneForPhase,
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
  fetchCodexConversation,
  fetchCodexRequirementDocument,
  fetchCodexTaskTestingCasesConversation,
  fetchDeliveryConversationMentionCatalog,
  fetchItemDetail,
  sendCodexConversationMessage,
  stopCodexConversation,
  uploadCodexConversationAttachments,
  type CodexConversationAttachment,
  type CodexConversation,
  type CodexConversationItem,
  type CodexConversationSummary,
  type DeliveryConversationReference,
  type DeliveryItemRecord,
  type DeliveryRequirementRecord,
  type ExecutionProgressEvent,
} from "@/api/delivery.api";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  clipboardAttachments,
  readableAttachmentSize,
} from "./DeliverySessionAttachments";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { SessionChangeSummary, SessionDocumentText, SessionMessageContent, SessionProcessGroup, groupSessionItems } from "./DeliverySessionMessage";
import { DeliveryTaskTestingCasesModal } from "./DeliveryTaskTestingCasesModal";
import { DeliveryConversationMentionInput } from "./DeliveryConversationMentionInput";

interface DeliveryTaskSessionModalProps {
  open: boolean;
  item: DeliveryItemRecord | null;
  programId: number;
  bizLine: BusinessLineId;
  /** 与任务详情同项目的候选数据，避免打开会话时再请求一遍列表。 */
  requirements: DeliveryRequirementRecord[];
  itemCatalog: DeliveryItemRecord[];
  codexBridgeReady: boolean;
  /** 从任务详情的“预先生成测试用例”直接进入测试用例聊天草稿。 */
  startTestingCasesOnOpen?: boolean;
  onClose: () => void;
  onOpenEditor: (item: DeliveryItemRecord) => void;
  onChanged: () => Promise<void> | void;
}

const itemTypeIcon = (item: CodexConversationItem) => {
  if (item.type === "commandExecution") return <CodeOutlined />;
  if (item.type === "fileChange" || item.type === "fileEdit") return <FileOutlined />;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return <ToolOutlined />;
  return <MessageOutlined />;
};

const progressEventState = (status: string) => {
  if (["success", "completed", "done"].includes(status)) return "success";
  if (["failed", "interrupted", "blocked", "error"].includes(status)) return "failed";
  return "running";
};

const progressEventIcon = (status: string) => {
  const state = progressEventState(status);
  if (state === "success") return <CheckCircleOutlined />;
  if (state === "failed") return <CloseCircleOutlined />;
  return <LoadingOutlined spin />;
};

function TranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
  const { t } = useLocale();
  const isUser = item.type === "userMessage";
  const isCommand = item.type === "commandExecution";
  const label = isUser
    ? t("delivery.session.you")
    : item.type === "agentMessage"
      ? toolName
      : t(`delivery.session.item.${item.type}`);
  return (
    <article className={`delivery-session-message${isUser ? " is-user" : ""}${isCommand ? " is-command" : ""}`}>
      <header>
        <span className="delivery-session-message__icon">{isUser ? <MessageOutlined /> : itemTypeIcon(item)}</span>
        <b>{label}</b>
        {item.status ? <small>{item.status}</small> : null}
      </header>
      <SessionMessageContent item={item} programId={programId} fallback={t("delivery.session.fileChanged")} />
    </article>
  );
}

const MIN_DOCUMENT_PANEL_WIDTH = 360;
const MIN_CONVERSATION_WIDTH = 440;

const defaultDocumentPanelWidth = () => typeof window === "undefined"
  ? 480
  : Math.max(MIN_DOCUMENT_PANEL_WIDTH, Math.min(780, Math.round(window.innerWidth * 0.38)));

const terminalConversationReady = (conversation: CodexConversation | null) => {
  const lastTurn = conversation?.turns.at(-1);
  return Boolean(
    lastTurn
    && ["completed", "failed", "interrupted"].includes(lastTurn.status)
    && lastTurn.items.some((entry) => entry.type === "agentMessage" && entry.text.trim()),
  );
};

export function DeliveryTaskSessionModal({
  open,
  item,
  programId,
  bizLine,
  requirements,
  itemCatalog,
  codexBridgeReady,
  startTestingCasesOnOpen = false,
  onClose,
  onOpenEditor,
  onChanged,
}: DeliveryTaskSessionModalProps) {
  const { t } = useLocale();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  const [detail, setDetail] = useState<DeliveryItemRecord | null>(null);
  const activeScene = sceneForPhase((detail || item)?.phase || "requirement");
  const scenePreference = configFor(activeScene);
  const [conversationExecutorType, setConversationExecutorType] = useState<AITool | "">("");
  // 续已有会话时跟着这条线程自己的工具走：正文在那个执行器的缓存里，模型选项也要对齐。
  const activeConfig = useMemo<AIExecutionConfig>(
    () => ({ ...scenePreference, tool: conversationExecutorType || scenePreference.tool }),
    [conversationExecutorType, scenePreference],
  );
  const activeProvider = activeConfig.tool;
  const taskTestingProvider = configFor("productTesting").tool;
  // 会话里所有露出工具名的地方都跟着该阶段选的 provider 走，不再写死 Codex。
  const toolName = toolDisplayName(activeProvider);
  const [conversation, setConversation] = useState<CodexConversation | null>(null);
  const [requirementDocument, setRequirementDocument] = useState("");
  const [requirementDocumentLoading, setRequirementDocumentLoading] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documentPanelWidth, setDocumentPanelWidth] = useState(defaultDocumentPanelWidth);
  const [resizingDocuments, setResizingDocuments] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatReferences, setChatReferences] = useState<DeliveryConversationReference[]>([]);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [liveEvents, setLiveEvents] = useState<ExecutionProgressEvent[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [testingConversations, setTestingConversations] = useState<CodexConversationSummary[]>([]);
  const [testingWorkspaceOpen, setTestingWorkspaceOpen] = useState(false);
  const [testingThreadId, setTestingThreadId] = useState("");
  const [startNewTestingConversation, setStartNewTestingConversation] = useState(false);
  const [mentionCatalog, setMentionCatalog] = useState<{
    requirements: DeliveryRequirementRecord[];
    items: DeliveryItemRecord[];
  } | null>(null);
  const sessionShellRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const documentResizePointerIdRef = useRef<number | null>(null);
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const activeItem = detail ?? item;
  const active = Boolean(conversation?.active && !newConversation);
  const taskHasActiveConversation = Boolean(conversation?.taskHasActiveConversation);
  const awaitingTerminalResult = Boolean(
    conversation?.threadId
    && conversation.taskStatus === "done"
    && !terminalConversationReady(conversation),
  );
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((entry) => ({ ...entry, turnId: turn.id, turnStatus: turn.status }))),
    [conversation],
  );
  // 阶段推进后仍保留旧聊天的可读历史，但它不能再向已经切换的执行阶段发送消息。
  const selectedTaskConversation = useMemo(
    () => conversation?.conversations.find((entry) => entry.threadId === conversation.threadId),
    [conversation?.conversations, conversation?.threadId],
  );
  const historicalConversation = Boolean(
    !newConversation
    && selectedTaskConversation
    && selectedTaskConversation.phase !== activeItem?.phase,
  );
  useEffect(() => {
    if (!open || !programId) return undefined;
    let cancelled = false;
    void fetchDeliveryConversationMentionCatalog(programId).then((catalog) => {
      if (!cancelled) setMentionCatalog(catalog);
    }).catch(() => {
      // 候选目录是补充能力；请求失败时仍可使用当前需求已经加载的任务列表。
      if (!cancelled) setMentionCatalog(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, programId]);
  const mentionableRequirements = useMemo(
    () => (mentionCatalog?.requirements ?? requirements).filter((requirement) => requirement.requirementKey !== activeItem?.requirementKey),
    [activeItem?.requirementKey, mentionCatalog?.requirements, requirements],
  );
  const mentionableItems = useMemo(
    () => (mentionCatalog?.items ?? itemCatalog).filter((candidate) => candidate.itemKey !== activeItem?.itemKey),
    [activeItem?.itemKey, itemCatalog, mentionCatalog?.items],
  );
  const searchMentionCandidates = useCallback(async (keyword: string) => {
    const catalog = await fetchDeliveryConversationMentionCatalog(programId, keyword);
    return {
      requirements: catalog.requirements.filter((requirement) => requirement.requirementKey !== activeItem?.requirementKey),
      items: catalog.items.filter((candidate) => candidate.itemKey !== activeItem?.itemKey),
    };
  }, [activeItem?.itemKey, activeItem?.requirementKey, programId]);
  const load = useCallback(async (threadId = selectedThreadId) => {
    if (!item || !programId) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const [nextDetail, nextConversation, nextTestingConversation] = await Promise.all([
        fetchItemDetail(programId, item.itemKey),
        codexBridgeReady ? fetchCodexConversation(programId, item.itemKey, threadId, scenePreference.tool) : Promise.resolve(null),
        codexBridgeReady ? fetchCodexTaskTestingCasesConversation(programId, item.itemKey, "", taskTestingProvider) : Promise.resolve(null),
      ]);
      if (requestId !== loadRequestIdRef.current) return null;
      setDetail(nextDetail);
      setConversation(nextConversation);
      if (!newConversationRef.current) {
        setConversationExecutorType(nextConversation?.threadId ? nextConversation.executorType : "");
        if (nextConversation?.threadId) setSelectedThreadId(nextConversation.threadId);
      }
      setTestingConversations(nextTestingConversation?.conversations ?? []);
      if (terminalConversationReady(nextConversation)) setLiveEvents([]);
      return nextConversation;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
        setSwitchingThreadId("");
      }
    }
  }, [codexBridgeReady, item, programId, scenePreference.tool, selectedThreadId, taskTestingProvider]);

  const loadRequirementDocument = useCallback(async () => {
    if (!item || !programId || !codexBridgeReady) {
      setRequirementDocument("");
      return;
    }
    setRequirementDocumentLoading(true);
    try {
      const document = await fetchCodexRequirementDocument(programId, item.itemKey);
      setRequirementDocument(document.exists ? document.content : "");
    } catch (error) {
      setRequirementDocument("");
      message.error((error as Error).message);
    } finally {
      setRequirementDocumentLoading(false);
    }
  }, [codexBridgeReady, item, programId]);

  const clampDocumentPanelWidth = useCallback((width: number) => {
    const shell = sessionShellRef.current;
    if (!shell) return Math.max(MIN_DOCUMENT_PANEL_WIDTH, Math.round(width));
    const historyWidth = shell.querySelector<HTMLElement>(".delivery-session-history")?.getBoundingClientRect().width ?? 0;
    const maximum = Math.max(
      MIN_DOCUMENT_PANEL_WIDTH,
      shell.getBoundingClientRect().width - historyWidth - MIN_CONVERSATION_WIDTH,
    );
    return Math.min(maximum, Math.max(MIN_DOCUMENT_PANEL_WIDTH, Math.round(width)));
  }, []);

  const setClampedDocumentPanelWidth = useCallback((width: number) => {
    setDocumentPanelWidth(clampDocumentPanelWidth(width));
  }, [clampDocumentPanelWidth]);

  const resizeDocumentPanel = useCallback((clientX: number) => {
    const shell = sessionShellRef.current;
    if (!shell) return;
    setClampedDocumentPanelWidth(shell.getBoundingClientRect().right - clientX);
  }, [setClampedDocumentPanelWidth]);

  const refreshTerminalResult = useCallback(async () => {
    for (const delay of [0, 400, 1000]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      const nextConversation = await load();
      if (terminalConversationReady(nextConversation)) {
        setLiveEvents([]);
        break;
      }
    }
    await Promise.all([loadRequirementDocument(), onChanged()]);
  }, [load, loadRequirementDocument, onChanged]);

  useEffect(() => {
    if (!open) {
      newConversationRef.current = false;
      loadRequestIdRef.current += 1;
      setDetail(null);
      setConversation(null);
      setRequirementDocument("");
      setDocumentsOpen(false);
      setResizingDocuments(false);
      setLiveEvents([]);
      setDraft("");
      setChatReferences([]);
      setAttachments([]);
      setDraggingAttachments(false);
      setSelectedThreadId("");
      setSwitchingThreadId("");
      setNewConversation(false);
      setTestingConversations([]);
      setTestingWorkspaceOpen(false);
      setTestingThreadId("");
      setStartNewTestingConversation(false);
      return;
    }
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open || !item || !startTestingCasesOnOpen) return;
    setTestingThreadId("");
    setStartNewTestingConversation(true);
    setTestingWorkspaceOpen(true);
  }, [item, open, startTestingCasesOnOpen]);

  useEffect(() => {
    if (open) void loadRequirementDocument();
  }, [loadRequirementDocument, open]);

  useEffect(() => {
    if (!open || !documentsOpen) return undefined;
    const handleResize = () => setDocumentPanelWidth((width) => clampDocumentPanelWidth(width));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampDocumentPanelWidth, documentsOpen, open]);

  useEffect(() => {
    if (!resizingDocuments) return undefined;
    const handlePointerMove = (event: PointerEvent) => resizeDocumentPanel(event.clientX);
    const handlePointerEnd = () => {
      documentResizePointerIdRef.current = null;
      setResizingDocuments(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [resizingDocuments, resizeDocumentPanel]);

  usePollingLoop(open && (active || awaitingTerminalResult), 5000, load);

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>([
    flattenedItems.length,
    liveEvents.length,
    active,
  ], !switchingThreadId && conversation?.threadId && activeItem?.itemKey
    ? `zb.delivery.scroll.task.${programId}.${activeItem.itemKey}.${conversation.threadId}`
    : "");

  const send = async () => {
    if (switchingThreadId) return;
    const text = draft.trim() || (chatReferences.length ? t("delivery.chatMention.referenceMessage") : "");
    if (!activeItem || (!text && !attachments.length)) return;
    if (historicalConversation) return;
    if (!codexBridgeReady) {
      message.warning(t("delivery.execution.bridgeOffline"));
      return;
    }
    setSending(true);
    try {
      const uploaded = attachments.length
        ? await uploadCodexConversationAttachments(programId, activeItem.itemKey, attachments)
        : [];
      const action = await sendCodexConversationMessage(programId, activeItem.itemKey, text, {
        provider: activeConfig.tool,
        threadId: newConversation ? undefined : conversation?.threadId,
        newConversation,
        attachmentIds: uploaded.map((attachment) => attachment.id),
        references: chatReferences,
        model: modelForConfig(activeConfig),
        reasoningEffort: effortForConfig(activeConfig),
        fastMode: activeProvider === "claude" && activeConfig.claudeFastMode,
      });
      setDraft("");
      setChatReferences([]);
      setAttachments([]);
      newConversationRef.current = false;
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
      setSwitchingThreadId("");
      await Promise.all([load(action.threadId), onChanged()]);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!activeItem) return;
    setStopping(true);
    try {
      await stopCodexConversation(programId, activeItem.itemKey, conversation?.threadId, activeProvider);
      message.success(t("delivery.session.stopRequested"));
      await load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    newConversationRef.current = false;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setSwitchingThreadId(threadId);
    setLiveEvents([]);
    setDraft("");
    setChatReferences([]);
    setAttachments([]);
    void load(threadId);
  };

  const startNewConversation = () => {
    if (taskHasActiveConversation) return;
    newConversationRef.current = true;
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    // 新开会话回到偏好里选的工具，不再沿用上一条线程的执行器。
    setConversationExecutorType("");
    setSelectedThreadId("");
    setSwitchingThreadId("");
    setLiveEvents([]);
    setDraft("");
    setChatReferences([]);
    setAttachments([]);
  };

  const taskHistory = useMemo(() => [
    ...(conversation?.conversations ?? []).map((entry) => ({ kind: "task" as const, entry })),
    ...testingConversations.map((entry) => ({ kind: "testing" as const, entry })),
  ].sort((left, right) => (right.entry.updatedAt || "").localeCompare(left.entry.updatedAt || "")), [conversation?.conversations, testingConversations]);

  const openTestingConversation = (threadId = "", startNewConversation = false) => {
    setTestingThreadId(threadId);
    setStartNewTestingConversation(startNewConversation);
    setTestingWorkspaceOpen(true);
  };

  const selectAttachments = (files: FileList | File[] | null) => {
    if (!files) return;
    const incoming = Array.from(files);
    const tooLarge = incoming.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (tooLarge) {
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

  /** 输入框里直接 Cmd/Ctrl+V 粘贴截图或文件，和拖拽走同一条上传通道。 */
  const handleAttachmentPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardAttachments(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    if (!codexBridgeReady || sending) return;
    selectAttachments(files);
  };

  const handleDocumentResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    documentResizePointerIdRef.current = event.pointerId;
    setResizingDocuments(true);
    resizeDocumentPanel(event.clientX);
  };

  const handleDocumentResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (documentResizePointerIdRef.current === event.pointerId) resizeDocumentPanel(event.clientX);
  };

  const handleDocumentResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (documentResizePointerIdRef.current === event.pointerId) documentResizePointerIdRef.current = null;
    setResizingDocuments(false);
  };

  const handleDocumentResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setClampedDocumentPanelWidth(documentPanelWidth + 24);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setClampedDocumentPanelWidth(documentPanelWidth - 24);
    }
    if (event.key === "Home") {
      event.preventDefault();
      setClampedDocumentPanelWidth(MIN_DOCUMENT_PANEL_WIDTH);
    }
    if (event.key === "End") {
      event.preventDefault();
      const shell = sessionShellRef.current;
      if (shell) setClampedDocumentPanelWidth(shell.getBoundingClientRect().width);
    }
  };

  return (
    <Modal
      className="delivery-task-session-modal"
      open={open}
      footer={null}
      onCancel={onClose}
      width="100vw"
      style={{ top: 0, maxWidth: "none", paddingBottom: 0 }}
      styles={{ content: { padding: 0 }, body: { padding: 0 } }}
      title={activeItem ? (
        <div className="delivery-session-title">
          <span>{t("delivery.session.title")}</span>
          <b>{activeItem.title}</b>
          <small className="manager-mono">{activeItem.itemKey}</small>
        </div>
      ) : t("delivery.session.title")}
    >
      {activeItem ? (
        testingWorkspaceOpen ? (
          <DeliveryTaskTestingCasesModal
            embedded
            open
            item={activeItem}
            programId={programId}
            codexBridgeReady={codexBridgeReady}
            startNewConversationOnOpen={startNewTestingConversation}
            initialThreadId={testingThreadId}
            taskConversations={conversation?.conversations ?? []}
            onOpenTaskConversation={(threadId) => {
              setTestingWorkspaceOpen(false);
              setStartNewTestingConversation(false);
              selectConversation(threadId);
            }}
            onClose={() => {
              setTestingWorkspaceOpen(false);
              setStartNewTestingConversation(false);
              void load();
            }}
            onChanged={async () => {
              await onChanged();
              await load();
            }}
          />
        ) : (
        <div
          className={`delivery-session-shell${documentsOpen ? " has-documents" : ""}${resizingDocuments ? " is-resizing-documents" : ""}`}
          ref={sessionShellRef}
          style={documentsOpen ? { "--delivery-document-panel-width": `${documentPanelWidth}px` } as CSSProperties : undefined}
        >
          <aside className="delivery-session-history" aria-label={t("delivery.session.history")}>
            <header className="delivery-session-history__header">
              <h3>{t("delivery.session.history")}</h3>
              <Tooltip title={taskHasActiveConversation ? t("delivery.session.newDisabled") : t("delivery.session.new")}>
                <Button
                  type="text"
                  shape="circle"
                  icon={<PlusOutlined />}
                  disabled={taskHasActiveConversation}
                  onClick={startNewConversation}
                  aria-label={t("delivery.session.new")}
                />
              </Tooltip>
            </header>
            <div className="delivery-session-history__list">
              {newConversation ? (
                <div className="delivery-session-history__item is-selected is-draft">
                  <MessageOutlined />
                  <div><b>{t("delivery.session.newConversation")}</b><span>{t(`delivery.phase.${activeItem.phase}`)} · {t("delivery.session.newDraft").replace("{tool}", toolName)}</span></div>
                </div>
              ) : null}
              {taskHistory.map(({ kind, entry }) => (
                <button
                  className={`delivery-session-history__item${kind === "task" && entry.threadId === (switchingThreadId || conversation?.threadId) && !newConversation ? " is-selected" : ""}`}
                  key={`${kind}-${entry.threadId}`}
                  type="button"
                  onClick={() => kind === "task" ? selectConversation(entry.threadId) : openTestingConversation(entry.threadId)}
                >
                  <MessageOutlined />
                  <div>
                    <Tooltip title={entry.title || t("delivery.session.untitled")} placement="topLeft" mouseEnterDelay={0.3}><b>{entry.title || t("delivery.session.untitled")}</b></Tooltip>
                    <span>{kind === "task" ? `${t(`delivery.phase.${entry.phase}`)} · ${entry.progress}%` : t("delivery.testingCases.status")}{` · ${toolDisplayName(entry.executorType)}`}</span>
                    {/* 时间单独占一行：跟阶段、工具挤在一行时窄侧栏里必被省略号吃掉。 */}
                    {entry.updatedAt ? <span className="delivery-session-history__item-time">{dayjs(entry.updatedAt).format("MM-DD HH:mm")}</span> : null}
                  </div>
                  {entry.active ? <i aria-label={t("delivery.session.running")} /> : null}
                </button>
              ))}
              {!newConversation && !taskHistory.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.session.historyEmpty")} />
              ) : null}
            </div>
          </aside>
          <main className="delivery-session-main">
            <header className="delivery-session-toolbar">
              <span>{newConversation
                ? t("delivery.session.newConversation")
                : conversation?.threadId ? <><i /> {t("delivery.session.connected").replace("{tool}", toolName)}</> : t("delivery.session.notStarted")}</span>
              <div className="delivery-session-toolbar__actions">
                {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.session.stop")}</Button> : null}
                <Button onClick={() => openTestingConversation("", true)} disabled={!codexBridgeReady || taskHasActiveConversation}>{t("delivery.testingCases.generate")}</Button>
                <Button onClick={() => onOpenEditor(activeItem)}>{t("delivery.session.editTask")}</Button>
                <Tooltip title={t("delivery.session.refresh")}>
                  <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void Promise.all([load(), loadRequirementDocument()])} aria-label={t("delivery.session.refresh")} />
                </Tooltip>
                <Tooltip title={t(documentsOpen ? "delivery.session.closeDocuments" : "delivery.session.openDocuments")}>
                  <Button
                    className="delivery-session-toolbar__document-toggle"
                    type={documentsOpen ? "default" : "text"}
                    shape="circle"
                    icon={documentsOpen ? <CloseOutlined /> : <FileOutlined />}
                    aria-label={t(documentsOpen ? "delivery.session.closeDocuments" : "delivery.session.openDocuments")}
                    aria-pressed={documentsOpen}
                    onClick={() => setDocumentsOpen((current) => !current)}
                  />
                </Tooltip>
              </div>
            </header>
            <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
              {switchingThreadId ? (
                <div className="delivery-session-transcript__loading"><Spin /></div>
              ) : <Spin spinning={loading && !detail}>
                {!newConversation && flattenedItems.length ? (
                  // 按回合渲染：每个回合末尾补一份「本次改动」，对齐直接用 Codex / Claude 时看到的改动清单。
                  (conversation?.turns ?? []).map((turn) => (
                    <Fragment key={turn.id}>
                      {groupSessionItems(turn.items).map((group) => (group.kind === "process" ? (
                        <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                      ) : (
                        <TranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />
                      )))}
                      <SessionChangeSummary items={turn.items} programId={programId} />
                    </Fragment>
                  ))
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t(newConversation ? "delivery.session.newEmpty" : "delivery.session.empty").replace("{tool}", toolName)}
                  />
                )}
                {!newConversation && liveEvents.map((event) => (
                  <article className={`delivery-session-live-event is-${progressEventState(event.status)}`} key={event.id}>
                    {progressEventIcon(event.status)}
                    <div><b>{event.title}</b>{event.body ? <span>{event.body}</span> : null}</div>
                    <time>{event.timestamp ? dayjs(event.timestamp).format("HH:mm:ss") : ""}</time>
                  </article>
                ))}
                {historicalConversation && selectedTaskConversation ? (
                  <div className="delivery-session-historical-note" role="status">
                    {t("delivery.session.historicalReadonly").replace("{phase}", t(`delivery.phase.${selectedTaskConversation.phase}`))}
                  </div>
                ) : null}
                {active ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
              </Spin>}
            </div>
            <footer
              className={`delivery-session-composer${draggingAttachments ? " is-dragging" : ""}`}
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
              <DeliveryConversationMentionInput
                value={draft}
                disabled={!codexBridgeReady || sending || historicalConversation}
                placeholder={t(newConversation ? "delivery.session.newPlaceholder" : "delivery.session.placeholder").replace("{tool}", toolName)}
                requirements={mentionableRequirements}
                items={mentionableItems}
                references={chatReferences}
                onChange={setDraft}
                onReferencesChange={setChatReferences}
                onSearchCandidates={searchMentionCandidates}
                onPaste={handleAttachmentPaste}
                onPressEnter={(event) => {
                  if (!event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="delivery-session-composer__tools">
                <Select
                  className="delivery-session-composer__model"
                  value={modelForConfig(activeConfig)}
                  disabled={!codexBridgeReady || sending || historicalConversation}
                  aria-label={t("delivery.execution.model")}
                  onChange={(value) => setSceneOverride(activeScene, {
                    ...(preferences.scenes[activeScene] ?? {}),
                    ...(activeProvider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }),
                  })}
                  options={(activeProvider === "codex"
                    ? CODEX_MODEL_OPTIONS
                    : CLAUDE_MODEL_OPTIONS) as Array<{ value: string; label: string }>}
                />
                <Select
                  className="delivery-session-composer__effort"
                  value={effortForConfig(activeConfig)}
                  disabled={!codexBridgeReady || sending || historicalConversation}
                  aria-label={t(activeProvider === "codex" ? "aiPreferences.reasoningEffort" : "aiPreferences.claudeEffort")}
                  options={(activeProvider === "codex" ? CODEX_REASONING_EFFORTS : CLAUDE_EFFORTS).map((value) => ({ value, label: t(`aiPreferences.reasoning.${value}`) }))}
                  onChange={(value) => setSceneOverride(activeScene, {
                    ...(preferences.scenes[activeScene] ?? {}),
                    ...(activeProvider === "codex"
                      ? { codexReasoningEffort: value as CodexReasoningEffort }
                      : { claudeEffort: value as ClaudeEffort }),
                  })}
                />
                {activeProvider === "claude" ? (
                  <Tooltip title={t("aiPreferences.fastMode")}>
                    <Switch
                      size="small"
                      checked={activeConfig.claudeFastMode}
                      disabled={!codexBridgeReady || sending || historicalConversation}
                      aria-label={t("aiPreferences.fastMode")}
                      onChange={(checked) => setSceneOverride(activeScene, { ...(preferences.scenes[activeScene] ?? {}), claudeFastMode: checked })}
                    />
                  </Tooltip>
                ) : null}
                <Tooltip title={t("delivery.session.addImage")}>
                  <Button type="text" shape="circle" icon={<PictureOutlined />} aria-label={t("delivery.session.addImage")} disabled={!codexBridgeReady || sending || historicalConversation} onClick={() => imageInputRef.current?.click()} />
                </Tooltip>
                <Tooltip title={t("delivery.session.addFile")}>
                  <Button type="text" shape="circle" icon={<PaperClipOutlined />} aria-label={t("delivery.session.addFile")} disabled={!codexBridgeReady || sending || historicalConversation} onClick={() => attachmentInputRef.current?.click()} />
                </Tooltip>
              </div>
              <Tooltip title={t("delivery.session.send")}>
                <Button type="primary" shape="circle" icon={<SendOutlined />} loading={sending} disabled={(!draft.trim() && !attachments.length) || !codexBridgeReady || historicalConversation} onClick={() => void send()} />
              </Tooltip>
              {draggingAttachments ? <div className="delivery-session-composer__drop-target">{t("delivery.session.dropAttachments")}</div> : null}
            </footer>
          </main>
          <aside className="delivery-session-documents" aria-label={t("delivery.session.documents")} aria-hidden={!documentsOpen}>
            <div
              className="delivery-session-documents__resize-handle"
              role="separator"
              aria-label={t("delivery.session.resizeDocuments")}
              aria-orientation="vertical"
              aria-valuemin={MIN_DOCUMENT_PANEL_WIDTH}
              aria-valuenow={documentPanelWidth}
              tabIndex={documentsOpen ? 0 : -1}
              onPointerDown={handleDocumentResizeStart}
              onPointerMove={handleDocumentResizeMove}
              onPointerUp={handleDocumentResizeEnd}
              onPointerCancel={handleDocumentResizeEnd}
              onKeyDown={handleDocumentResizeKeyDown}
            />
            <Tabs
              className="delivery-session-document-tabs"
              defaultActiveKey="requirement"
              items={[
                {
                  key: "requirement",
                  label: t("delivery.session.document.requirement"),
                  children: (
                    <Spin spinning={requirementDocumentLoading}>
                      {activeItem.requirementDocumentPath ? <code className="delivery-session-document__path">{activeItem.requirementDocumentPath}</code> : null}
                      <SessionDocumentText value={requirementDocument} fallback={t("delivery.document.requirementEmpty")} />
                    </Spin>
                  ),
                },
                {
                  key: "design",
                  label: t("delivery.session.document.design"),
                  children: <SessionDocumentText value={activeItem.actionOutput} fallback={t("delivery.document.designEmpty")} />,
                },
                {
                  key: "testingCases",
                  label: t("delivery.session.document.testingCases"),
                  children: (
                    <>
                      {activeItem.testingCasesPath ? <code className="delivery-session-document__path">{activeItem.testingCasesPath}</code> : null}
                      <SessionDocumentText value={activeItem.testingCases} fallback={t("delivery.document.testingCasesEmpty")} />
                    </>
                  ),
                },
                {
                  key: "testing",
                  label: t("delivery.session.document.testing"),
                  children: <SessionDocumentText value={activeItem.testingReport} fallback={t("delivery.document.testingEmpty")} />,
                },
              ]}
            />
          </aside>
        </div>
        )
      ) : null}
    </Modal>
  );
}
