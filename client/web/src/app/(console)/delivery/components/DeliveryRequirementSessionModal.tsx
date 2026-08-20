"use client";

import {
	BranchesOutlined,
	CloudUploadOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  FileOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  DownOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  ShareAltOutlined,
  ToolOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { Button, DatePicker, Empty, Input, Modal, Popconfirm, Segmented, Select, Spin, Switch, Tabs, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
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
  DELIVERY_PHASES,
  REQUIREMENT_MODES,
  REQUIREMENT_STATUSES,
	bindRequirementGitBranch,
	createCodexGitBranch,
	fetchCodexGitBranches,
	pushCodexGitBranch,
  fetchCodexRequirementOutline,
  fetchCodexRequirementPrototype,
  fetchCodexRequirementPrototypeConversation,
  fetchCodexRequirementTestingConversation,
  fetchCodexPlanningConversation,
  fetchDeliveryConversationMentionCatalog,
  fetchMembers,
  generateCodexRequirementPrototype,
  saveRequirement,
  sendCodexRequirementPrototypeMessage,
  sendCodexPlanningMessage,
  stopCodexPlanningConversation,
  uploadCodexPlanningAttachments,
  type CodexConversationItem,
  type CodexPlanningConversation,
  type CodexPlanningSessionSummary,
  type CodexRequirementPrototypeConversation,
  type DeliveryItemRecord,
  type DeliveryKind,
  type DeliveryModuleRecord,
  type DeliveryPhase,
  type DeliveryRequirementRecord,
  type DeliveryStageRecord,
  type MemberRecord,
  type CodexRequirementOutline,
  type CodexRequirementPrototype,
  type DeliveryConversationReference,
  type RequirementMember,
  type RequirementMode,
  type RequirementStatus,
} from "@/api/delivery.api";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";
import { DeliveryRequirementDetailInput, requirementMentionKeys, requirementMentionReferences } from "./DeliveryRequirementDetailInput";
import { DeliveryConversationMentionInput } from "./DeliveryConversationMentionInput";
import { SessionChangeSummary, SessionDocumentText, SessionMessageContent, changesOfTurn } from "./DeliverySessionMessage";
import { DeliveryRequirementTestingModal } from "./DeliveryRequirementTestingModal";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  clipboardAttachments,
  readableAttachmentSize,
} from "./DeliverySessionAttachments";

interface DeliveryRequirementSessionModalProps {
  open: boolean;
  /** 为空表示「新增需求」；带值表示编辑既有需求，可以继续追问上一次的拆解。 */
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  programName: string;
	/** 项目级默认基准分支；需求自身已配置时始终优先。 */
	projectGitBaseBranch?: string;
  bizLine: BusinessLineId;
  stages: DeliveryStageRecord[];
  modules: DeliveryModuleRecord[];
  itemCatalog: DeliveryItemRecord[];
  /** 需求详情里 @ 引用的候选：同项目下已有的需求。 */
  requirements: DeliveryRequirementRecord[];
  codexBridgeReady: boolean;
  /** 从需求列表直接开始测试时，仍进入同一份需求聊天历史。 */
  startTestingOnOpen?: boolean;
  onClose: () => void;
  onOpenItem: (item: DeliveryItemRecord) => void;
  onDeleteItem: (itemKey: string) => Promise<boolean>;
  onShare: (requirement: DeliveryRequirementRecord) => void;
  onRequirementSaved: (requirement: DeliveryRequirementRecord) => void;
  onTasksWritten?: (requirement: DeliveryRequirementRecord) => void;
  onChanged: () => Promise<void> | void;
}

type RequirementPhaseTab = "requirement" | "testing";
type RequirementStageTab = "requirement" | "result" | "outline" | "prototype";
type TestingStageTab = "testingCases" | "testingReport";

// 右侧需求详情可拖宽，但要给中间的会话留出能读的宽度。
const MIN_CONTEXT_PANEL_WIDTH = 320;
const MIN_PLANNING_CONVERSATION_WIDTH = 380;

const defaultContextPanelWidth = () => (typeof window === "undefined"
  ? 480
  : Math.max(MIN_CONTEXT_PANEL_WIDTH, Math.min(760, Math.round(window.innerWidth * 0.32))));

function normalizedDateTime(value?: string | null) {
  if (!value) return null;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.toISOString() : null;
}

function defaultRequirementGitBranch(requirementKey: string) {
  return requirementKey ? `feature/issue_${requirementKey}` : "";
}

const progressState = (status: string) => {
  if (["completed", "success", "done"].includes(status)) return "success";
  if (["failed", "interrupted", "blocked", "error"].includes(status)) return "failed";
  return "running";
};

const itemIcon = (item: CodexConversationItem) => {
  if (item.type === "fileChange" || item.type === "fileEdit") return <FileTextOutlined />;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return <ToolOutlined />;
  return <MessageOutlined />;
};

function PlanningTranscriptItem({ item, programId, toolName }: { item: CodexConversationItem; programId: number; toolName: string }) {
  const { t } = useLocale();
  const isUser = item.type === "userMessage";
  const isCommand = item.type === "commandExecution";
  return (
    <article className={`delivery-session-message${isUser ? " is-user" : ""}${isCommand ? " is-command" : ""}`}>
      <header>
        <span className="delivery-session-message__icon">{itemIcon(item)}</span>
        <b>{isUser ? t("delivery.session.you") : item.type === "agentMessage" ? toolName : t(`delivery.session.item.${item.type}`)}</b>
        {item.status ? <small>{item.status}</small> : null}
      </header>
      <SessionMessageContent item={item} programId={programId} fallback={t("delivery.session.fileChanged")} />
    </article>
  );
}

export function DeliveryRequirementSessionModal({
  open,
  requirement,
  programId,
  programName,
	projectGitBaseBranch = "",
  bizLine,
  stages,
  modules,
  itemCatalog,
  requirements,
  codexBridgeReady,
  startTestingOnOpen = false,
  onClose,
  onOpenItem,
  onDeleteItem,
  onShare,
  onRequirementSaved,
  onTasksWritten,
  onChanged,
}: DeliveryRequirementSessionModalProps) {
  const { t } = useLocale();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  const planningConfig = configFor("taskPlanning");
  const planningProvider = planningConfig.tool;
  const testingProvider = configFor("productTesting").tool;
  // 会话里所有露出工具名的地方都跟着场景选的 provider 走，不再写死 Codex。
  const toolName = toolDisplayName(planningProvider);
  const [conversation, setConversation] = useState<CodexPlanningConversation | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatReferences, setChatReferences] = useState<DeliveryConversationReference[]>([]);
  const [stageKey, setStageKey] = useState("");
  const [moduleKey, setModuleKey] = useState("");
  const [kind, setKind] = useState<DeliveryKind | "">("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [mentionCatalog, setMentionCatalog] = useState<{
    requirements: DeliveryRequirementRecord[];
    items: DeliveryItemRecord[];
  } | null>(null);

  // 需求表单。saved 是「已经落库的那份」，拆解会话的归属键从它上面取。
  const [saved, setSaved] = useState<DeliveryRequirementRecord | null>(null);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [plannedStartAt, setPlannedStartAt] = useState<string | null>(null);
  const [plannedEndAt, setPlannedEndAt] = useState<string | null>(null);
  const [status, setStatus] = useState<RequirementStatus>("open");
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  const [mode, setMode] = useState<RequirementMode>("simple");
  const [startPhase, setStartPhase] = useState<DeliveryPhase>("development");
  const [splitTasks, setSplitTasks] = useState(true);
  // 预生成是任务需求文档的初稿，正式梳理仍会在同一文件中校正和补全。
  const [preGenerateTaskDocuments, setPreGenerateTaskDocuments] = useState(false);
  // 单任务模式下，唯一业务任务必须直接承接完整需求文档；不改写用户保存的开关值。
  const taskDocumentPreGenerationRequired = preGenerateTaskDocuments || !splitTasks;
  const [generatePrototype, setGeneratePrototype] = useState(false);
	const [gitEnabled, setGitEnabled] = useState(false);
	// 偏好里的默认值只在打开需求时读一次：编辑途中改偏好不该把当前需求的开关顶掉。
	const gitEnabledByDefaultRef = useRef(preferences.gitEnabledByDefault);
	gitEnabledByDefaultRef.current = preferences.gitEnabledByDefault;
	const [gitBaseBranch, setGitBaseBranch] = useState("");
	const [gitBranch, setGitBranch] = useState("");
	const [gitBranches, setGitBranches] = useState<string[]>([]);
	const [gitBranchesLoading, setGitBranchesLoading] = useState(false);
	const [gitCreating, setGitCreating] = useState(false);
	const [gitPushOpen, setGitPushOpen] = useState(false);
	const [gitPushMessage, setGitPushMessage] = useState("");
	const [gitPushing, setGitPushing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  // 一级先区分需求与测试，避免五个页签在窄侧栏横向溢出，让 HTML 原型入口消失。
  const [activePhaseTab, setActivePhaseTab] = useState<RequirementPhaseTab>("requirement");
  const [activeRequirementTab, setActiveRequirementTab] = useState<RequirementStageTab>("requirement");
  const [activeTestingTab, setActiveTestingTab] = useState<TestingStageTab>("testingCases");
  const [testingWorkspaceOpen, setTestingWorkspaceOpen] = useState(false);
  const [testingConversations, setTestingConversations] = useState<CodexPlanningSessionSummary[]>([]);
  const [testingThreadId, setTestingThreadId] = useState("");
  const [startNewTestingConversation, setStartNewTestingConversation] = useState(false);
  const [outline, setOutline] = useState<CodexRequirementOutline | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [prototype, setPrototype] = useState<CodexRequirementPrototype | null>(null);
  const [prototypeFilePath, setPrototypeFilePath] = useState("");
  const [prototypeLoading, setPrototypeLoading] = useState(false);
  const [prototypeGenerating, setPrototypeGenerating] = useState(false);
  const [prototypeEditorOpen, setPrototypeEditorOpen] = useState(false);
  const [prototypeEditConversation, setPrototypeEditConversation] = useState<CodexRequirementPrototypeConversation | null>(null);
  const [prototypeEditDraft, setPrototypeEditDraft] = useState("");
  const [prototypeEditLoading, setPrototypeEditLoading] = useState(false);
  const [prototypeEditSending, setPrototypeEditSending] = useState(false);
  const [contextPanelWidth, setContextPanelWidth] = useState(defaultContextPanelWidth);
  const [resizingContext, setResizingContext] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const planningShellRef = useRef<HTMLDivElement>(null);
  const contextResizePointerIdRef = useRef<number | null>(null);
  const prototypeEditTranscriptRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const awaitingPlanningResultRef = useRef("");

  const requirementKey = saved?.requirementKey ?? "";

  const clampContextPanelWidth = useCallback((width: number) => {
    const shell = planningShellRef.current;
    if (!shell) return Math.max(MIN_CONTEXT_PANEL_WIDTH, Math.round(width));
    const historyWidth = shell.querySelector<HTMLElement>(".delivery-planning-history")?.getBoundingClientRect().width ?? 0;
    const maximum = Math.max(
      MIN_CONTEXT_PANEL_WIDTH,
      shell.getBoundingClientRect().width - historyWidth - MIN_PLANNING_CONVERSATION_WIDTH,
    );
    return Math.min(maximum, Math.max(MIN_CONTEXT_PANEL_WIDTH, Math.round(width)));
  }, []);

  const setClampedContextPanelWidth = useCallback((width: number) => {
    setContextPanelWidth(clampContextPanelWidth(width));
  }, [clampContextPanelWidth]);

  const resizeContextPanel = useCallback((clientX: number) => {
    const shell = planningShellRef.current;
    if (!shell) return;
    setClampedContextPanelWidth(shell.getBoundingClientRect().right - clientX);
  }, [setClampedContextPanelWidth]);

  const handleContextResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    contextResizePointerIdRef.current = event.pointerId;
    setResizingContext(true);
    resizeContextPanel(event.clientX);
  };

  const handleContextResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (contextResizePointerIdRef.current === event.pointerId) resizeContextPanel(event.clientX);
  };

  const handleContextResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (contextResizePointerIdRef.current === event.pointerId) contextResizePointerIdRef.current = null;
    setResizingContext(false);
  };

  const handleContextResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setClampedContextPanelWidth(contextPanelWidth + 24);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setClampedContextPanelWidth(contextPanelWidth - 24);
    }
    if (event.key === "Home") {
      event.preventDefault();
      setClampedContextPanelWidth(MIN_CONTEXT_PANEL_WIDTH);
    }
    if (event.key === "End") {
      event.preventDefault();
      const shell = planningShellRef.current;
      if (shell) setClampedContextPanelWidth(shell.getBoundingClientRect().width);
    }
  };

  const load = useCallback(async (threadId = "", preserveSelected = false) => {
    if (!programId || !requirementKey) return null;
    setLoading(true);
    try {
      const next = await fetchCodexPlanningConversation(programId, threadId, requirementKey, planningProvider);
      setConversation(next);
      if (!newConversation && !preserveSelected) setSelectedThreadId(next.threadId);
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [newConversation, planningProvider, programId, requirementKey]);

  const loadTestingHistory = useCallback(async () => {
    if (!programId || !requirementKey || !codexBridgeReady) {
      setTestingConversations([]);
      return;
    }
    try {
      const next = await fetchCodexRequirementTestingConversation(programId, requirementKey, "", testingProvider);
      setTestingConversations(next.conversations);
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [codexBridgeReady, programId, requirementKey, testingProvider]);

  useEffect(() => {
    if (!open) {
      setConversation(null);
      setSelectedThreadId("");
      setNewConversation(false);
      setDraft("");
      setChatReferences([]);
      setMoreOpen(false);
      setAttachments([]);
      setDraggingAttachments(false);
      setActivePhaseTab("requirement");
      setActiveRequirementTab("requirement");
      setActiveTestingTab("testingCases");
      setTestingWorkspaceOpen(false);
      setTestingConversations([]);
      setTestingThreadId("");
      setStartNewTestingConversation(false);
      setOutline(null);
      setOutlineLoading(false);
      setPrototype(null);
      setPrototypeFilePath("");
      setPrototypeLoading(false);
      setPrototypeGenerating(false);
      setPrototypeEditorOpen(false);
      setPrototypeEditConversation(null);
      setPrototypeEditDraft("");
      setPrototypeEditLoading(false);
      setPrototypeEditSending(false);
      setResizingContext(false);
      awaitingPlanningResultRef.current = "";
      return;
    }
    setSaved(requirement);
    setTestingWorkspaceOpen(Boolean(requirement && startTestingOnOpen));
    setTestingThreadId("");
    setStartNewTestingConversation(Boolean(requirement && startTestingOnOpen));
    setName(requirement?.name ?? "");
    setDetail(requirement?.detail ?? "");
    setPlannedStartAt(normalizedDateTime(requirement?.plannedStartAt));
    setPlannedEndAt(normalizedDateTime(requirement?.plannedEndAt));
    setStatus(requirement?.status ?? "open");
    const nextMode = requirement?.mode ?? "simple";
    setMode(nextMode);
    setStartPhase(requirement?.startPhase ?? (nextMode === "simple" ? "development" : "requirement"));
    setSplitTasks(requirement?.splitTasks ?? true);
    setPreGenerateTaskDocuments(Boolean(requirement?.preGenerateTaskDocuments));
    setGeneratePrototype(requirement?.generatePrototype ?? false);
		// Git 开关以需求自身的设置为准；这条需求没单独设置过（新建或历史需求）才用偏好里的默认值。
		setGitEnabled(requirement?.gitEnabled ?? gitEnabledByDefaultRef.current);
		setGitBaseBranch(requirement?.gitBaseBranch ?? projectGitBaseBranch);
		setGitBranch(requirement?.gitBranch ?? "");
		setGitBranches([]);
    setStageKey(requirement?.stageKey ?? "");
    setModuleKey(requirement?.moduleKey ?? "");
    setKind(requirement?.kind ?? "");
    setOwnerIds((requirement?.owners ?? []).map((member) => member.id));
    setAssistantIds((requirement?.assistants ?? []).map((member) => member.id));
	}, [open, projectGitBaseBranch, requirement]);

  useEffect(() => {
    if (!open) return;
    fetchMembers()
      .then(setMembers)
      .catch(() => message.warning(t("delivery.requirement.membersFailed")));
  }, [open, t]);

	useEffect(() => {
		if (!open || !gitEnabled) return;
		let cancelled = false;
		setGitBranchesLoading(true);
		void fetchCodexGitBranches(programId)
			.then((catalog) => {
				if (cancelled) return;
				setGitBranches(catalog.branches);
				setGitBaseBranch((current) => current || catalog.defaultBranch || catalog.branches[0] || "");
			})
			.catch(() => {
				if (!cancelled) message.warning(t("delivery.requirement.gitLoadBranchesFailed"));
			})
			.finally(() => {
				if (!cancelled) setGitBranchesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [gitEnabled, open, programId, t]);

	useEffect(() => {
		if (!open || !gitEnabled || !saved?.requirementKey || gitBranch) return;
		setGitBranch(defaultRequirementGitBranch(saved.requirementKey));
	}, [gitBranch, gitEnabled, open, saved?.requirementKey]);

  useEffect(() => {
    if (!open || !requirementKey) return;
    void load("");
    // 切到另一条需求时会话要整条重来，不能沿用上一条需求的 thread。
  }, [load, open, requirementKey]);

  useEffect(() => {
    if (!open || !requirementKey) return;
    void loadTestingHistory();
  }, [loadTestingHistory, open, requirementKey]);

  const loadOutline = useCallback(async () => {
    if (!open || !requirementKey || !codexBridgeReady) {
      setOutline(null);
      return null;
    }
    setOutlineLoading(true);
    try {
      const next = await fetchCodexRequirementOutline(programId, requirementKey);
      setOutline(next);
      return next;
    } catch (error) {
      setOutline(null);
      message.error((error as Error).message);
      return null;
    } finally {
      setOutlineLoading(false);
    }
  }, [codexBridgeReady, open, programId, requirementKey]);

  const loadPrototype = useCallback(async () => {
    if (!open || !requirementKey || !codexBridgeReady) {
      setPrototype(null);
      return null;
    }
    setPrototypeLoading(true);
    try {
      const next = await fetchCodexRequirementPrototype(programId, requirementKey);
      setPrototype(next);
      setPrototypeFilePath((current) => next.files.some((file) => file.path === current) ? current : next.files[0]?.path ?? "");
      return next;
    } catch (error) {
      setPrototype(null);
      if (!prototypeGenerating) message.error((error as Error).message);
      return null;
    } finally {
      setPrototypeLoading(false);
    }
  }, [codexBridgeReady, open, programId, prototypeGenerating, requirementKey]);

  useEffect(() => {
    // 原型只在用户查看该页签或生成流程轮询时读取。打开普通需求编辑页不应
    // 因本机桥接的可选原型能力不可用而报错。
    if (!open || !requirementKey || !codexBridgeReady || activePhaseTab !== "requirement" || activeRequirementTab !== "prototype") return;
    void loadPrototype();
  }, [activePhaseTab, activeRequirementTab, codexBridgeReady, loadPrototype, open, requirementKey]);

  useEffect(() => {
    if (!prototypeGenerating || !open || !requirementKey) return undefined;
    let activePolling = true;
    const poll = async () => {
      const next = await loadPrototype();
      if (!activePolling || !next) return;
      if (next.exists) {
        setPrototypeGenerating(false);
        message.success(t("delivery.prototype.generated"));
        void onChanged();
        return;
      }
      if (!next.active) {
        setPrototypeGenerating(false);
        message.error(t("delivery.prototype.failed"));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      activePolling = false;
      window.clearInterval(timer);
    };
  }, [loadPrototype, onChanged, open, prototypeGenerating, requirementKey, t]);

  const loadPrototypeEditConversation = useCallback(async (threadId: string) => {
    if (!open || !requirementKey || !threadId || !codexBridgeReady) return null;
    setPrototypeEditLoading(true);
    try {
      const next = await fetchCodexRequirementPrototypeConversation(programId, requirementKey, threadId, planningProvider);
      setPrototypeEditConversation(next);
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setPrototypeEditLoading(false);
    }
  }, [codexBridgeReady, open, planningProvider, programId, requirementKey]);

  const openPrototypeEditor = () => {
    setPrototypeEditorOpen(true);
  };

  const sendPrototypeEdit = async () => {
    const text = prototypeEditDraft.trim();
    if (!text || !codexBridgeReady || !requirementKey) return;
    setPrototypeEditSending(true);
    try {
      const action = await sendCodexRequirementPrototypeMessage(programId, requirementKey, text, {
        threadId: prototypeEditConversation?.threadId || undefined,
        provider: planningProvider,
        model: modelForConfig(planningConfig),
        reasoningEffort: effortForConfig(planningConfig),
        fastMode: planningProvider === "claude" && planningConfig.claudeFastMode,
      });
      setPrototypeEditDraft("");
      await loadPrototypeEditConversation(action.threadId);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPrototypeEditSending(false);
    }
  };

  const prototypeEditActive = Boolean(prototypeEditConversation?.active);

  useEffect(() => {
    if (!prototypeEditorOpen || !prototypeEditActive || !prototypeEditConversation?.threadId) return undefined;
    let activePolling = true;
    const poll = async () => {
      const next = await loadPrototypeEditConversation(prototypeEditConversation.threadId);
      if (!activePolling || !next || next.active) return;
      await loadPrototype();
      void onChanged();
      message.success(t("delivery.prototype.updated"));
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      activePolling = false;
      window.clearInterval(timer);
    };
  }, [loadPrototype, loadPrototypeEditConversation, onChanged, prototypeEditActive, prototypeEditConversation?.threadId, prototypeEditorOpen, t]);

  const active = Boolean(conversation?.active && !newConversation);
  const flattenedItems = useMemo(
    () => (conversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [conversation],
  );

  // 结果面板给的是「这条需求现在有哪些任务」：本轮新建的 + 之前几轮建过的。
  const resultItems = useMemo(() => {
    const existing = requirementKey
      ? itemCatalog.filter((item) => item.requirementKey === requirementKey)
      : [];
    const merged = new Map(existing.map((item) => [item.itemKey, item]));
    for (const item of conversation?.result.items ?? []) {
      merged.set(item.itemKey, itemCatalog.find((candidate) => candidate.itemKey === item.itemKey) ?? item);
    }
    return Array.from(merged.values());
  }, [conversation, itemCatalog, requirementKey]);

  const selectedPrototypeFile = useMemo(
    () => prototype?.files.find((file) => file.path === prototypeFilePath) ?? prototype?.files[0] ?? null,
    [prototype, prototypeFilePath],
  );

  useEffect(() => {
    if (!open || !active) return undefined;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [active, load, open]);

  useEffect(() => {
    // 大纲是拆解会话写在工作区里的文件，面板不会自己知道它变了：进入该页签时读一次，
    // 本轮拆解跑完（active 落回 false）再读一次。
    if (!open || !requirementKey || !codexBridgeReady) return;
    if (activePhaseTab !== "requirement" || activeRequirementTab !== "outline") return;
    void loadOutline();
  }, [active, activePhaseTab, activeRequirementTab, codexBridgeReady, loadOutline, open, requirementKey]);

  useEffect(() => {
    if (!open) return undefined;
    const handleWindowResize = () => setContextPanelWidth((width) => clampContextPanelWidth(width));
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [clampContextPanelWidth, open]);

  useEffect(() => {
    if (!resizingContext) return undefined;
    const handlePointerMove = (event: PointerEvent) => resizeContextPanel(event.clientX);
    const handlePointerEnd = () => {
      contextResizePointerIdRef.current = null;
      setResizingContext(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [resizeContextPanel, resizingContext]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [active, flattenedItems.length]);

  const prototypeEditItems = useMemo(
    () => (prototypeEditConversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [prototypeEditConversation],
  );

  useEffect(() => {
    prototypeEditTranscriptRef.current?.scrollTo({ top: prototypeEditTranscriptRef.current.scrollHeight, behavior: "smooth" });
  }, [prototypeEditActive, prototypeEditItems.length]);

  // 确认写入只在「已经出过一轮预览、当前没有回合在跑」时可用：没有方案可确认，或方案还在生成中都不放行。
  const canConfirmWrite =
    codexBridgeReady && !sending && !saving && !active && !newConversation && Boolean(conversation?.threadId) && Boolean(name.trim());

  // 拆解会话读的是已落库的那份需求，表单改了没存必须在保存条上说出来。
  const dirty = useMemo(() => {
    const sameMembers = (ids: string[], list: RequirementMember[] | undefined) =>
      ids.join(",") === (list ?? []).map((member) => member.id).join(",");
    if (!saved) return Boolean(name.trim() || detail.trim() || gitEnabled || ownerIds.length || assistantIds.length);
    return (
      name !== (saved.name ?? "")
      || detail !== (saved.detail ?? "")
      || plannedStartAt !== normalizedDateTime(saved.plannedStartAt)
      || plannedEndAt !== normalizedDateTime(saved.plannedEndAt)
      || status !== saved.status
      || mode !== saved.mode
      || startPhase !== saved.startPhase
      || splitTasks !== (saved.splitTasks ?? true)
      || preGenerateTaskDocuments !== Boolean(saved.preGenerateTaskDocuments)
      || generatePrototype !== Boolean(saved.generatePrototype)
			|| gitEnabled !== (saved.gitEnabled ?? preferences.gitEnabledByDefault)
			|| gitBaseBranch !== (saved.gitBaseBranch ?? "")
			|| gitBranch !== (saved.gitBranch ?? "")
      || stageKey !== (saved.stageKey ?? "")
      || moduleKey !== (saved.moduleKey ?? "")
      || kind !== (saved.kind ?? "")
      || !sameMembers(ownerIds, saved.owners)
      || !sameMembers(assistantIds, saved.assistants)
    );
  }, [assistantIds, detail, generatePrototype, gitBaseBranch, gitBranch, gitEnabled, preferences.gitEnabledByDefault, preGenerateTaskDocuments, kind, mode, moduleKey, name, ownerIds, plannedEndAt, plannedStartAt, saved, splitTasks, stageKey, startPhase, status]);

  const memberOptions = useMemo(
    () => members.map((member) => ({ value: member.id, label: member.displayName || member.username })),
    [members],
  );

  useEffect(() => {
    if (!open || !programId) return undefined;
    let cancelled = false;
    void fetchDeliveryConversationMentionCatalog(programId).then((catalog) => {
      if (!cancelled) setMentionCatalog(catalog);
    }).catch(() => {
      // 候选目录请求不影响编辑或聊天；失败时继续使用当前需求的已加载任务。
      if (!cancelled) setMentionCatalog(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, programId]);

  const chatRequirements = useMemo(
    () => (mentionCatalog?.requirements ?? requirements).filter((item) => item.requirementKey !== saved?.requirementKey),
    [mentionCatalog?.requirements, requirements, saved?.requirementKey],
  );
  const chatItems = useMemo(
    () => (mentionCatalog?.items ?? itemCatalog).filter((item) => item.itemKey !== ""),
    [itemCatalog, mentionCatalog?.items],
  );
  const searchMentionCandidates = useCallback(async (keyword: string) => {
    const catalog = await fetchDeliveryConversationMentionCatalog(programId, keyword);
    return {
      requirements: catalog.requirements.filter((item) => item.requirementKey !== saved?.requirementKey),
      items: catalog.items.filter((item) => item.itemKey !== ""),
    };
  }, [programId, saved?.requirementKey]);
  // 正文中的 @需求键 / @任务键 是保存关联的来源。候选目录只加载最近 20 条，
  // 所以已保存但不在这 20 条内的引用，只要正文仍保留该键也必须原样保存，不能被误删。
  const detailReferences = useMemo(() => {
    const references = requirementMentionReferences(detail, chatRequirements, chatItems);
    const mentionedKeys = new Set(requirementMentionKeys(detail));
    const seenKeys = new Set(references.map((reference) => reference.key));
    for (const key of saved?.referenceRequirementKeys ?? []) {
      if (mentionedKeys.has(key) && !seenKeys.has(key)) {
        references.push({ kind: "requirement", key });
        seenKeys.add(key);
      }
    }
    for (const key of saved?.referenceItemKeys ?? []) {
      if (mentionedKeys.has(key) && !seenKeys.has(key)) {
        references.push({ kind: "task", key });
        seenKeys.add(key);
      }
    }
    return references;
  }, [chatItems, chatRequirements, detail, saved?.referenceItemKeys, saved?.referenceRequirementKeys]);
  /**
   * 发给桥接层的是已落库的那份引用，不是表单里还没保存的草稿：send 之前一定先 save，
   * 两者最终一致。只传键和名字 —— 插件拿到的是这些需求的大纲产物地址，由它按需读取，
   * 面板不把大纲正文塞进提示词。
   */
  const requirementReferencesOf = useCallback(
    (current: DeliveryRequirementRecord) => (current.referenceRequirementKeys ?? []).map((requirementKey) => ({
      requirementKey,
      name: requirements.find((item) => item.requirementKey === requirementKey)?.name ?? requirementKey,
    })),
    [requirements],
  );

  const requirementItemReferencesOf = useCallback(
    (current: DeliveryRequirementRecord) => (current.referenceItemKeys ?? []).map((itemKey) => ({
      itemKey,
      title: chatItems.find((item) => item.itemKey === itemKey)?.title ?? itemKey,
    })),
    [chatItems],
  );

  const membersOf = useCallback(
    (ids: string[], fallback: RequirementMember[]): RequirementMember[] =>
      ids.map((id) => ({
        id,
        name:
          members.find((member) => member.id === id)?.displayName
          ?? fallback.find((member) => member.id === id)?.name
          ?? id,
      })),
    [members],
  );

  const save = async () => {
    if (!name.trim()) {
      message.warning(t("delivery.requirement.nameRequired"));
      return null;
    }
    setSaving(true);
    try {
      const next = await saveRequirement({
        programId,
        requirementKey: saved?.requirementKey,
        name: name.trim(),
        detail,
        referenceRequirementKeys: detailReferences
          .filter((reference) => reference.kind === "requirement")
          .map((reference) => reference.key),
        referenceItemKeys: detailReferences
          .filter((reference) => reference.kind === "task")
          .map((reference) => reference.key),
        plannedStartAt,
        plannedEndAt,
        status,
        mode,
        // 简易模式的起始阶段由服务端按模式定死，这里传的是专业模式下用户的选择。
        startPhase,
        splitTasks,
        preGenerateTaskDocuments,
        generatePrototype,
			gitEnabled,
			gitBaseBranch: gitEnabled ? gitBaseBranch : "",
			gitBranch: gitEnabled ? gitBranch.trim() : "",
        stageKey,
        moduleKey,
        kind,
        owners: membersOf(ownerIds, saved?.owners ?? []),
        assistants: membersOf(assistantIds, saved?.assistants ?? []),
        version: saved?.version,
      });
      setSaved(next);
      onRequirementSaved(next);
      message.success(t("delivery.requirement.saved"));
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

	const createGitBranch = async () => {
		if (!gitBaseBranch) {
			message.warning(t("delivery.requirement.gitBaseBranchRequired"));
			return;
		}
		setGitCreating(true);
		try {
			// 新需求先落库以取得业务编号，默认分支名必须以该编号生成。
			const current = await save();
			if (!current) return;
			const nextBranch = gitBranch.trim() || defaultRequirementGitBranch(current.requirementKey);
			if (!nextBranch) return;
			const created = await createCodexGitBranch(programId, gitBaseBranch, nextBranch);
			const next = await bindRequirementGitBranch(programId, current.requirementKey, created.baseBranch, created.branch);
			setGitBaseBranch(next.gitBaseBranch);
			setGitBranch(next.gitBranch);
			setSaved(next);
			onRequirementSaved(next);
			message.success(t("delivery.requirement.gitBranchCreated"));
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setGitCreating(false);
		}
	};

	// 需求已经关联到本机的一条分支时才谈得上推送；只在面板上填了分支名（没真正建过）不算。
	const gitPushReady = Boolean(saved?.gitEnabled && saved?.gitBranch && saved?.gitBranchCreatedAt);

	const openGitPush = () => {
		setGitPushMessage(saved ? `feat: ${saved.name || saved.requirementKey}（${saved.requirementKey}）` : "");
		setGitPushOpen(true);
	};

	const pushGitBranch = async () => {
		if (!saved?.gitBranch) return;
		setGitPushing(true);
		try {
			const result = await pushCodexGitBranch(programId, saved.gitBranch, gitPushMessage.trim(), {
				provider: planningProvider,
				model: modelForConfig(planningConfig),
				reasoningEffort: effortForConfig(planningConfig),
				fastMode: planningProvider === "claude" && planningConfig.claudeFastMode,
			});
			setGitPushOpen(false);
			if (result.repaired) {
				// AI 介入过就把它的处理说明留在屏幕上，别用一闪而过的 toast 交代。
				Modal.info({
					title: t("delivery.requirement.gitPushRepaired").replace("{tool}", toolDisplayName(planningProvider)),
					content: result.repairSummary || t("delivery.requirement.gitPushRepairedEmpty"),
					okText: t("common.close"),
					wrapClassName: "manager-form-skin",
				});
				return;
			}
			message.success(
				result.upToDate
					? t("delivery.requirement.gitPushUpToDate").replace("{branch}", result.branch)
					: t("delivery.requirement.gitPushed").replace("{branch}", `${result.remote}/${result.branch}`),
			);
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setGitPushing(false);
		}
	};

  /**
   * confirmWrite 为 true 表示这一轮是「确认并写入」：其余轮次桥接层只给规划插件只读权限，
   * 拆解方案先以预览回到聊天里，用户点确认之后才真正落库。
   */
  const send = async (confirmWrite = false) => {
    const text = draft.trim() || (confirmWrite
      ? t("delivery.planning.confirmMessage")
      : chatReferences.length ? t("delivery.chatMention.referenceMessage") : "");
    if (!text && !attachments.length) return;
    if (!codexBridgeReady) {
      message.warning(t("delivery.execution.bridgeOffline"));
      return;
    }
    // 会话必须挂在一条已经落库的需求上，否则拆出来的任务无处归属，附件也没有归档的键。
    const current = saved ?? (await save());
    if (!current) return;
    setSending(true);
    try {
      const uploaded = attachments.length
        ? await uploadCodexPlanningAttachments(programId, current.requirementKey, attachments)
        : [];
      const action = await sendCodexPlanningMessage(programId, text, {
        provider: planningProvider,
        threadId: newConversation ? undefined : conversation?.threadId,
        newConversation,
        stageKey: stageKey || undefined,
        moduleKey: moduleKey || undefined,
        kind: kind || undefined,
        model: modelForConfig(planningConfig),
        reasoningEffort: effortForConfig(planningConfig),
        fastMode: planningProvider === "claude" && planningConfig.claudeFastMode,
        requirementKey: current.requirementKey,
        requirementName: current.name,
        requirementDetail: current.detail,
        requirementOwners: (current.owners ?? []).map((member) => member.name).join("、"),
        requirementAssistants: (current.assistants ?? []).map((member) => member.name).join("、"),
        requirementStartPhase: current.startPhase,
        requirementSplitTasks: current.splitTasks,
        requirementPreGenerateTaskDocuments: current.preGenerateTaskDocuments,
        requirementGeneratePrototype: current.generatePrototype,
        requirementReferences: requirementReferencesOf(current),
        requirementItemReferences: requirementItemReferencesOf(current),
        chatReferences,
        attachmentIds: uploaded.map((attachment) => attachment.id),
        confirmWrite,
      });
      setDraft("");
      setChatReferences([]);
      setAttachments([]);
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
      // 只有写入轮次结束后才跳到「拆解结果」：预览轮次没有产出，跳过去只会看到一片空。
      awaitingPlanningResultRef.current = confirmWrite ? action.turnId : "";
      await load(action.threadId);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    awaitingPlanningResultRef.current = "";
    try {
      await stopCodexPlanningConversation(programId, conversation?.threadId, requirementKey, planningProvider);
      message.success(t("delivery.planning.stopRequested"));
      await load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const startRequirementPrototype = async (current: DeliveryRequirementRecord) => {
    setPrototypeLoading(true);
    setActivePhaseTab("requirement");
    setActiveRequirementTab("prototype");
    try {
      await generateCodexRequirementPrototype(programId, current.requirementKey, {
        provider: planningProvider,
        model: modelForConfig(planningConfig),
        reasoningEffort: effortForConfig(planningConfig),
        fastMode: planningProvider === "claude" && planningConfig.claudeFastMode,
      });
      setPrototypeGenerating(true);
      message.success(t("delivery.prototype.generating"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPrototypeLoading(false);
    }
  };

  const selectAttachments = (files: FileList | File[] | null) => {
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

  /** 输入框里直接 Cmd/Ctrl+V 粘贴截图或文件，和拖拽走同一条上传通道。 */
  const handleAttachmentPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardAttachments(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    if (!codexBridgeReady || sending) return;
    selectAttachments(files);
  };

  const startNewConversation = () => {
    if (active) return;
    setNewConversation(true);
    setSelectedThreadId("");
    setDraft("");
    setChatReferences([]);
    setAttachments([]);
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setDraft("");
    setChatReferences([]);
    setAttachments([]);
    void load(threadId, true);
  };

  const requirementHistory = useMemo(() => [
    ...(conversation?.conversations ?? []).map((entry) => ({ kind: "planning" as const, entry })),
    ...testingConversations.map((entry) => ({ kind: "testing" as const, entry })),
  ].sort((left, right) => (right.entry.updatedAt || "").localeCompare(left.entry.updatedAt || "")), [conversation?.conversations, testingConversations]);

  const openTestingConversation = (threadId = "", startNewConversation = false) => {
    setTestingThreadId(threadId);
    setStartNewTestingConversation(startNewConversation);
    setTestingWorkspaceOpen(true);
  };

  useEffect(() => {
    const awaitedTurnId = awaitingPlanningResultRef.current;
    const awaitedTurn = conversation?.turns.find((turn) => turn.id === awaitedTurnId);
    if (!awaitedTurnId || active || !awaitedTurn) return;
    awaitingPlanningResultRef.current = "";
    if (progressState(awaitedTurn.status) !== "success") return;
    setActivePhaseTab("requirement");
    setActiveRequirementTab("result");
    // 写入轮次刚落库了任务，看板上的列表也要跟着刷新。
    void onChanged();
    if (saved && (conversation?.result.items.length ?? 0) > 0) onTasksWritten?.(saved);
    if (saved?.generatePrototype) {
      Modal.confirm({
        title: t("delivery.prototype.confirmTitle"),
        content: t("delivery.prototype.confirmContent"),
        okText: t("delivery.prototype.confirmOk"),
        cancelText: t("delivery.prototype.confirmCancel"),
        onOk: () => startRequirementPrototype(saved),
      });
    }
  }, [active, conversation, onChanged, onTasksWritten, saved, t]);

  return (
    <Modal
      className="delivery-task-session-modal delivery-planning-session-modal"
      open={open}
      footer={null}
      onCancel={onClose}
      // 用 100% 而不是 100vw：100vw 不减去滚动条宽度，会把整个弹窗顶出一条横向滚动。
      width="100%"
      style={{ top: 0, maxWidth: "none", margin: 0, paddingBottom: 0 }}
      styles={{ content: { padding: 0 }, body: { padding: 0 } }}
      title={null}
    >
      {testingWorkspaceOpen && saved ? (
        <DeliveryRequirementTestingModal
          embedded
          open
          requirement={saved}
          programId={programId}
          programName={programName}
          codexBridgeReady={codexBridgeReady}
          startNewConversationOnOpen={startNewTestingConversation}
          initialThreadId={testingThreadId}
          planningConversations={conversation?.conversations ?? []}
          onOpenPlanningConversation={(threadId) => {
            setTestingWorkspaceOpen(false);
            setStartNewTestingConversation(false);
            selectConversation(threadId);
          }}
          onClose={() => {
            setTestingWorkspaceOpen(false);
            setStartNewTestingConversation(false);
            void loadTestingHistory();
          }}
          onChanged={async () => {
            await onChanged();
            await loadTestingHistory();
          }}
        />
      ) : (
      <>
      <div
        className={`delivery-planning-shell${resizingContext ? " is-resizing-context" : ""}`}
        ref={planningShellRef}
        style={{ "--delivery-planning-context-width": `${contextPanelWidth}px` } as CSSProperties}
      >
        {/* 左：会话列表。同一条需求可以开多轮拆解，追问和重开在这里切。 */}
        <aside className="delivery-planning-history">
          <header className="delivery-session-history__header">
            <h3>{t("delivery.session.history")}</h3>
            <Tooltip title={active ? t("delivery.session.newDisabled") : t("delivery.session.new")}>
              <Button
                type="text"
                shape="circle"
                icon={<PlusOutlined />}
                disabled={active || !requirementKey}
                onClick={startNewConversation}
                aria-label={t("delivery.session.new")}
              />
            </Tooltip>
          </header>
          <div className="delivery-session-history__list">
            {newConversation ? (
              <div className="delivery-session-history__item is-selected is-draft">
                <MessageOutlined />
                <div><b>{t("delivery.session.newConversation")}</b><span>{t("delivery.planning.title")} · {t("delivery.session.newDraft").replace("{tool}", toolName)}</span></div>
              </div>
            ) : null}
            {requirementHistory.map(({ kind, entry }) => (
              <button
                className={`delivery-session-history__item${kind === "planning" && entry.threadId === conversation?.threadId && !newConversation ? " is-selected" : ""}`}
                key={`${kind}-${entry.threadId}`}
                type="button"
                onClick={() => kind === "planning" ? selectConversation(entry.threadId) : openTestingConversation(entry.threadId)}
              >
                <MessageOutlined />
                <div><Tooltip title={entry.title || t("delivery.session.untitled")} placement="topLeft" mouseEnterDelay={0.3}><b>{entry.title || t("delivery.session.untitled")}</b></Tooltip><span>{[kind === "planning" ? t("delivery.planning.title") : t("delivery.testingCases.status"), entry.updatedAt ? dayjs(entry.updatedAt).format("MM-DD HH:mm") : ""].filter(Boolean).join(" · ")}</span></div>
                {entry.active ? <i /> : null}
              </button>
            ))}
            {!newConversation && !requirementHistory.length ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.session.historyEmpty")} />
            ) : null}
          </div>
        </aside>

        {/* 中：聊天记录 + 输入框，与任务会话弹窗同一套结构。 */}
        <main className="delivery-session-main">
          <header className="delivery-session-toolbar delivery-planning-session-toolbar">
            <div className="delivery-planning-session-toolbar__summary">
              <div className="delivery-session-title delivery-planning-session-title">
                <div className="delivery-planning-session-title__heading">
                  <span>{saved ? t("delivery.requirement.edit") : t("delivery.requirement.new")}</span>
                  <b>{name.trim() || programName || programId}</b>
                  {name.trim() ? <small>{programName || programId}</small> : null}
                </div>
                {saved?.createdAt ? (
                  <small className="delivery-planning-session-title__created-at">
                    {t("delivery.requirement.createdAt")} {dayjs(saved.createdAt).format("YYYY-MM-DD HH:mm")}
                  </small>
                ) : null}
              </div>
              {/* 没有会话状态可说时仍保留位置，避免刷新按钮在不同状态下左右跳动。 */}
              {!requirementKey ? (
                <span className="delivery-planning-session-toolbar__state delivery-planning-session-toolbar__state--save-required">{t("delivery.requirement.saveFirst")}</span>
              ) : newConversation ? (
                <span className="delivery-planning-session-toolbar__state">{t("delivery.session.newConversation")}</span>
              ) : conversation?.threadId ? (
                <span className="delivery-planning-session-toolbar__state"><i /> {t("delivery.session.connected").replace("{tool}", toolName)}</span>
              ) : (
                <span className="delivery-planning-session-toolbar__state" />
              )}
            </div>
            <div className="delivery-session-toolbar__actions">
              {gitPushReady ? (
                <Tooltip title={t("delivery.requirement.gitPushHint").replace("{branch}", saved?.gitBranch ?? "")}>
                  <Button icon={<CloudUploadOutlined />} loading={gitPushing} disabled={!codexBridgeReady} onClick={openGitPush}>
                    {t("delivery.requirement.gitPush")}
                  </Button>
                </Tooltip>
              ) : null}
              <Tooltip title={requirementKey ? t("delivery.requirement.shareLink") : t("delivery.requirement.saveFirst")}>
                <Button
                  icon={<ShareAltOutlined />}
                  disabled={!saved}
                  onClick={() => {
                    if (saved) onShare(saved);
                  }}
                >
                  {t("delivery.requirement.shareLink")}
                </Button>
              </Tooltip>
              {prototype?.exists ? (
                <Button icon={<EditOutlined />} disabled={!codexBridgeReady} onClick={openPrototypeEditor}>
                  {t("delivery.prototype.edit")}
                </Button>
              ) : null}
              {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.planning.stop")}</Button> : null}
              <Tooltip title={t("delivery.session.refresh")}>
                <Button icon={<ReloadOutlined />} loading={loading} disabled={!requirementKey} onClick={() => void load()} aria-label={t("delivery.session.refresh")} />
              </Tooltip>
            </div>
          </header>
          <div className="delivery-session-transcript" ref={transcriptRef}>
            {/* 首次加载时只显示转圈，不要再叠一层空状态：两个「空」摞在一起像坏了。 */}
            {loading && !conversation ? (
              <div className="delivery-session-transcript__loading"><Spin /></div>
            ) : !newConversation && flattenedItems.length ? (
              // 按回合渲染：每个回合末尾补一份「本次改动」，对齐直接用 Codex / Claude 时看到的改动清单。
              (conversation?.turns ?? []).map((turn) => (
                <Fragment key={turn.id}>
                  {turn.items.map((item) => (
                    <PlanningTranscriptItem item={item} programId={programId} toolName={toolName} key={`${turn.id}-${item.id}-${item.type}`} />
                  ))}
                  <SessionChangeSummary changes={changesOfTurn(turn.items)} />
                </Fragment>
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t(newConversation ? "delivery.session.newEmpty" : "delivery.planning.empty").replace("{tool}", toolName)}
              />
            )}
            {active ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
          </div>
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
            {/* 模型选择在输入框上方：发送前先确认这一轮用的是哪个模型。 */}
            <div className="delivery-session-composer__header">
              <Select
                className="delivery-session-composer__model"
                value={modelForConfig(planningConfig)}
                disabled={!codexBridgeReady || sending}
                aria-label={t("delivery.execution.model")}
                onChange={(value) => setSceneOverride("taskPlanning", {
                  ...(preferences.scenes.taskPlanning ?? {}),
                  ...(planningProvider === "codex" ? { codexModel: value as CodexModel } : { claudeModel: value as ClaudeModel }),
                })}
                options={(planningProvider === "codex"
                  ? CODEX_MODEL_OPTIONS
                  : CLAUDE_MODEL_OPTIONS) as Array<{ value: string; label: string }>}
              />
              <Select
                className="delivery-session-composer__effort"
                value={effortForConfig(planningConfig)}
                disabled={!codexBridgeReady || sending}
                aria-label={t(planningProvider === "codex" ? "aiPreferences.reasoningEffort" : "aiPreferences.claudeEffort")}
                options={(planningProvider === "codex" ? CODEX_REASONING_EFFORTS : CLAUDE_EFFORTS).map((value) => ({ value, label: t(`aiPreferences.reasoning.${value}`) }))}
                onChange={(value) => setSceneOverride("taskPlanning", {
                  ...(preferences.scenes.taskPlanning ?? {}),
                  ...(planningProvider === "codex"
                    ? { codexReasoningEffort: value as CodexReasoningEffort }
                    : { claudeEffort: value as ClaudeEffort }),
                })}
              />
              {planningProvider === "claude" ? (
                <Tooltip title={t("aiPreferences.fastMode")}>
                  <Switch
                    size="small"
                    checked={planningConfig.claudeFastMode}
                    disabled={!codexBridgeReady || sending}
                    aria-label={t("aiPreferences.fastMode")}
                    onChange={(checked) => setSceneOverride("taskPlanning", { ...(preferences.scenes.taskPlanning ?? {}), claudeFastMode: checked })}
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
            <div className="delivery-session-composer__input">
              <DeliveryConversationMentionInput
                value={draft}
                disabled={!codexBridgeReady || sending}
                placeholder={t(newConversation ? "delivery.session.newPlaceholder" : "delivery.planning.placeholder")}
                requirements={chatRequirements}
                items={chatItems}
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
              {/* 发送只做梳理和预览；写入任务面板要走右边这颗确认按钮，一次一轮。 */}
              <div className="delivery-planning-composer__actions">
                <Tooltip title={canConfirmWrite ? t("delivery.planning.confirmWriteHint") : t("delivery.planning.confirmWriteDisabled")}>
                  <Button
                    icon={<CheckOutlined />}
                    loading={sending || saving}
                    disabled={!canConfirmWrite}
                    onClick={() => void send(true)}
                  >
                    {t("delivery.planning.confirmWrite")}
                  </Button>
                </Tooltip>
                <Tooltip title={t("delivery.session.send")}>
                  <Button
                    type="primary"
                    shape="circle"
                    icon={<SendOutlined />}
                    loading={sending || saving}
                    disabled={(!draft.trim() && !attachments.length) || !codexBridgeReady || !name.trim()}
                    onClick={() => void send()}
                  />
                </Tooltip>
              </div>
            </div>
            <small className="delivery-planning-composer__hint">{t("delivery.planning.previewHint")}</small>
            {draggingAttachments ? <div className="delivery-session-composer__drop-target">{t("delivery.session.dropAttachments")}</div> : null}
          </footer>
        </main>

        {/* 右：需求详情。项目是只读的 —— 需求跟着当前项目走，不在这里换。 */}
        <aside className="delivery-planning-context">
          <div
            className="delivery-planning-context__resize-handle"
            role="separator"
            aria-label={t("delivery.planning.resizeContext")}
            aria-orientation="vertical"
            aria-valuemin={MIN_CONTEXT_PANEL_WIDTH}
            aria-valuenow={contextPanelWidth}
            tabIndex={0}
            onPointerDown={handleContextResizeStart}
            onPointerMove={handleContextResizeMove}
            onPointerUp={handleContextResizeEnd}
            onPointerCancel={handleContextResizeEnd}
            onKeyDown={handleContextResizeKeyDown}
          />
          <section className="delivery-planning-tabs">
            <div className="delivery-planning-phase-tabs" role="tablist" aria-label={t("delivery.planning.title")}>
              <button
                className={activePhaseTab === "requirement" ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={activePhaseTab === "requirement"}
                onClick={() => setActivePhaseTab("requirement")}
              >
                {t("delivery.requirement.phase.requirement")}
              </button>
              <button
                className={activePhaseTab === "testing" ? "is-active" : ""}
                type="button"
                role="tab"
                aria-selected={activePhaseTab === "testing"}
                onClick={() => setActivePhaseTab("testing")}
              >
                {t("delivery.requirement.phase.testing")}
              </button>
            </div>
            <Tabs
            className="delivery-planning-stage-tabs"
            activeKey={activePhaseTab === "requirement" ? activeRequirementTab : activeTestingTab}
            onChange={(key) => {
              if (activePhaseTab === "requirement") setActiveRequirementTab(key as RequirementStageTab);
              else setActiveTestingTab(key as TestingStageTab);
            }}
            items={[
              {
                key: "requirement",
                label: t("delivery.planning.context"),
                children: (
                  <section className="delivery-planning-tab-panel is-form">
                    <div className="delivery-planning-context__fields">
                      {/* 基础信息：新增需求时多数人只填这一组。 */}
                      <div className="delivery-planning-context__group">
                        <span className="delivery-planning-context__group-title">{t("delivery.requirement.groupBasic")}</span>
                        <label>
                          <span className="delivery-field-label">{t("delivery.requirement.name")}<em aria-hidden="true">*</em></span>
                          <Input
                            value={name}
                            status={name.trim() ? undefined : "warning"}
                            placeholder={t("delivery.requirement.namePlaceholder")}
                            onChange={(event) => setName(event.target.value)}
                          />
                        </label>
                        {/* 里程碑和模块都是短选项，并排一行，别让它们各占一整行把表单撑得很散。 */}
                        <div className="delivery-planning-context__row">
                          <label>
                            {t("delivery.field.stageKey")}
                            <Select
                              allowClear
                              value={stageKey || undefined}
                              placeholder={t("delivery.requirement.optional")}
                              onChange={(value) => setStageKey(value ?? "")}
                              options={stages.map((stage) => ({ value: stage.stageKey, label: stage.tag || stage.title || stage.stageKey }))}
                            />
                          </label>
                          <label>
                            {t("delivery.field.moduleKey")}
                            <Select
                              allowClear
                              value={moduleKey || undefined}
                              placeholder={t("delivery.requirement.optional")}
                              onChange={(value) => setModuleKey(value ?? "")}
                              options={modules.map((module) => ({ value: module.moduleKey, label: module.name || module.moduleKey }))}
                            />
                          </label>
                        </div>
                        <label>
                          {t("delivery.requirement.plannedPeriod")}
                          <DatePicker.RangePicker
                            allowClear
                            showTime={{ format: "HH:mm" }}
                            format="YYYY-MM-DD HH:mm"
                            value={plannedStartAt && plannedEndAt ? [dayjs(plannedStartAt), dayjs(plannedEndAt)] : null}
                            placeholder={[t("delivery.requirement.plannedStartAt"), t("delivery.requirement.plannedEndAt")]}
                            onChange={(values) => {
                              setPlannedStartAt(values?.[0]?.toISOString() ?? null);
                              setPlannedEndAt(values?.[1]?.toISOString() ?? null);
                            }}
                          />
                        </label>
                        <label>
                          {t("delivery.requirement.owners")}
                          <Select
                            mode="multiple"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            maxTagCount="responsive"
                            value={ownerIds}
                            placeholder={t("delivery.requirement.memberPlaceholder")}
                            onChange={setOwnerIds}
                            options={memberOptions}
                          />
                        </label>
                      </div>

                      {/* 拆解设置：决定这条需求怎么被拆、拆完做什么。 */}
                      <div className="delivery-planning-context__group">
                        <span className="delivery-planning-context__group-title">{t("delivery.requirement.groupBreakdown")}</span>
                        <label className="delivery-planning-context__mode">
                          {t("delivery.requirement.mode")}
                          <Segmented
                            block
                            value={mode}
                            onChange={(value) => {
                              const next = value as RequirementMode;
                              setMode(next);
                              // 简易模式的起始阶段就是模式本身的定义，切过去时同步好，别让右侧显示和实际落库不一致。
                              setStartPhase(next === "simple" ? "development" : startPhase || "requirement");
                              if (next === "simple") setGeneratePrototype(false);
                            }}
                            options={REQUIREMENT_MODES.map((value) => ({ value, label: t(`delivery.requirement.mode.${value}`) }))}
                          />
                          <small className="delivery-field-hint">{t(`delivery.requirement.mode.${mode}Hint`)}</small>
                        </label>
                        {/* 是否拆解成多条任务：简易和专业模式都可能遇到「一条就够了」的小需求。 */}
                        <div className={`delivery-planning-context__toggle${splitTasks ? " is-on" : ""}`}>
                          <div role="presentation" onClick={() => setSplitTasks((current) => !current)}>
                            <b>{t("delivery.requirement.splitTasks")}</b>
                            <small>{t("delivery.requirement.splitTasksHint")}</small>
                          </div>
                          <Switch
                            size="small"
                            checked={splitTasks}
                            aria-label={t("delivery.requirement.splitTasks")}
                            onChange={setSplitTasks}
                          />
                        </div>
                        <div className={`delivery-planning-context__toggle${taskDocumentPreGenerationRequired ? " is-on" : ""}`}>
                          <div role="presentation" onClick={() => { if (splitTasks) setPreGenerateTaskDocuments((current) => !current); }}>
                            <b>{t("delivery.requirement.preGenerateTaskDocuments")}</b>
                            <small>{t("delivery.requirement.preGenerateTaskDocumentsHint")}</small>
                          </div>
                          <Switch
                            size="small"
                            checked={taskDocumentPreGenerationRequired}
                            disabled={!splitTasks}
                            aria-label={t("delivery.requirement.preGenerateTaskDocuments")}
                            onChange={setPreGenerateTaskDocuments}
                          />
                        </div>
                        {mode === "professional" ? (
                          <>
                            <label>
                              {t("delivery.requirement.startPhase")}
                              <Select
                                value={startPhase}
                                onChange={setStartPhase}
                                options={DELIVERY_PHASES.map((value) => ({ value, label: t(`delivery.phase.${value}`) }))}
                              />
                            </label>
                            {/* 生成原型是个开关型选项：说明在左、开关在右，比复选框加一段长说明好读。 */}
                            <div className={`delivery-planning-context__toggle${generatePrototype ? " is-on" : ""}`}>
                              <div role="presentation" onClick={() => setGeneratePrototype((current) => !current)}>
                                <b>{t("delivery.requirement.generatePrototype")}</b>
                                <small>{t("delivery.requirement.generatePrototypeHint")}</small>
                              </div>
                              <Switch
                                size="small"
                                checked={generatePrototype}
                                aria-label={t("delivery.requirement.generatePrototype")}
                                onChange={setGeneratePrototype}
                              />
                            </div>
                          </>
                        ) : null}
                      </div>

						{/* Git 设置独立成组：开关控制是否关联，开启后才能选择基准并创建需求分支。 */}
						<div className="delivery-planning-context__group">
							<span className="delivery-planning-context__group-title">{t("delivery.requirement.groupGit")}</span>
							<div className={`delivery-planning-context__toggle${gitEnabled ? " is-on" : ""}`}>
								<div role="presentation" onClick={() => setGitEnabled((current) => !current)}>
									<b>{t("delivery.requirement.gitEnabled")}</b>
									<small>{t("delivery.requirement.gitEnabledHint")}</small>
								</div>
								<Switch
									size="small"
									checked={gitEnabled}
									aria-label={t("delivery.requirement.gitEnabled")}
									onChange={setGitEnabled}
								/>
							</div>
							{gitEnabled ? (
								<>
									<label>
										{t("delivery.requirement.gitBaseBranch")}
										<Select
											showSearch
											optionFilterProp="label"
											loading={gitBranchesLoading}
											value={gitBaseBranch || undefined}
											placeholder={t("delivery.requirement.gitBaseBranchEmpty")}
											onChange={setGitBaseBranch}
											options={gitBranches.map((branch) => ({ value: branch, label: branch }))}
										/>
									</label>
									<label>
										{t("delivery.requirement.gitBranch")}
										<Input
											value={gitBranch}
											placeholder={saved?.requirementKey
												? t("delivery.requirement.gitBranchPlaceholder").replace("{key}", saved.requirementKey)
												: t("delivery.requirement.gitBranchPlaceholderUnsaved")}
											onChange={(event) => setGitBranch(event.target.value)}
										/>
									</label>
									<label>
										{t("delivery.requirement.gitExistingBranch")}
										<Select
											showSearch
											optionFilterProp="label"
											loading={gitBranchesLoading}
											placeholder={t("delivery.requirement.gitExistingBranchPlaceholder")}
											value={undefined}
											onChange={setGitBranch}
											options={gitBranches.map((branch) => ({ value: branch, label: branch }))}
										/>
									</label>
									<Button
										block
										icon={<BranchesOutlined />}
										loading={gitCreating}
										disabled={!gitBaseBranch || gitBranchesLoading || saving}
										onClick={() => void createGitBranch()}
									>
										{t("delivery.requirement.gitCreateBranch")}
									</Button>
									{saved?.gitBranchCreatedAt ? (
										<small className="delivery-requirement-git-status">
											{t("delivery.requirement.gitBranchLinked").replace("{branch}", saved.gitBranch)}
										</small>
									) : null}
								</>
							) : null}
						</div>

                      {/* 其余字段收在「更多」里，默认不占版面。 */}
                      <Button
                        type="link"
                        size="small"
                        className="delivery-requirement-more"
                        icon={moreOpen ? <UpOutlined /> : <DownOutlined />}
                        onClick={() => setMoreOpen((current) => !current)}
                      >
                        {t(moreOpen ? "delivery.requirement.less" : "delivery.requirement.more")}
                      </Button>
                      {moreOpen ? (
                        <div className="delivery-planning-context__group">
                          <span className="delivery-planning-context__group-title">{t("delivery.requirement.groupMore")}</span>
                          <div className="delivery-planning-context__row">
                            <label>
                              {t("delivery.requirement.status")}
                              <Select
                                value={status}
                                onChange={setStatus}
                                options={REQUIREMENT_STATUSES.map((value) => ({ value, label: t(`delivery.requirement.status.${value}`) }))}
                              />
                            </label>
                            <label>
                              {t("delivery.field.kind")}
                              <Select
                                allowClear
                                value={kind || undefined}
                                placeholder={t("delivery.requirement.optional")}
                                onChange={(value) => setKind((value ?? "") as DeliveryKind | "")}
                                options={["capability", "gap", "asset"].map((value) => ({ value, label: t(`delivery.kind.${value}`) }))}
                              />
                            </label>
                          </div>
                          <label>
                            {t("delivery.requirement.assistants")}
                            <Select
                              mode="multiple"
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              maxTagCount="responsive"
                              value={assistantIds}
                              placeholder={t("delivery.requirement.memberPlaceholder")}
                              onChange={setAssistantIds}
                              options={memberOptions}
                            />
                          </label>
                          {/* 需求详情此前只能由拆解会话读取、没有编辑入口，补一个多行输入。 */}
                          <label>
                            {t("delivery.requirement.detail")}
                            <DeliveryRequirementDetailInput
                              value={detail}
                              placeholder={t("delivery.requirement.detailPlaceholder")}
                              requirements={chatRequirements}
                              items={chatItems}
                              onChange={setDetail}
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>
                    {/* 保存原本是页签右上角的一个图标，太容易被忽略；固定在表单底部当主操作。 */}
                    <footer className="delivery-planning-context__actions">
                      <Button
                        block
                        type="primary"
                        icon={<SaveOutlined />}
                        loading={saving}
                        disabled={!name.trim()}
                        onClick={() => void save()}
                      >
                        {t("delivery.requirement.save")}
                      </Button>
                      {/* 拆解会话依赖已落库的那份需求，所以「改了没存」必须看得见。 */}
                      <small className={`delivery-planning-context__dirty${dirty ? " is-dirty" : ""}`}>
                        {t(dirty ? "delivery.requirement.unsaved" : "delivery.requirement.allSaved")}
                      </small>
                    </footer>
                  </section>
                ),
              },
              {
                key: "result",
                label: t("delivery.planning.result"),
                children: (
                  <section className="delivery-planning-result" aria-label={t("delivery.planning.result")}>
                    {/* 标题页签上已经写了「拆解结果」，这里只留计数和同步状态。 */}
                    <header>
                      <span>{t("delivery.planning.resultCount").replace("{count}", String(resultItems.length))}</span>
                      <Tag color={active ? "processing" : "default"}>
                        {active ? t("delivery.session.running") : t("delivery.planning.synced")}
                      </Tag>
                    </header>
                    <div className="delivery-planning-result__list">
                      {resultItems.length ? resultItems.map((item) => (
                        <article className="delivery-planning-result__item" key={item.itemKey}>
							<div><b>{item.title}</b><span className="manager-mono">{item.itemKey}</span></div>
							{item.benefitTags.length ? <div className="delivery-benefit-tags">{item.benefitTags.map((tag) => <Tag color="gold" key={tag}>{tag}</Tag>)}</div> : null}
                          <p>{item.description || t("delivery.empty")}</p>
                          <footer>
                            <span>
                              {stages.find((stage) => stage.stageKey === item.stageKey)?.tag || item.stageKey || t("delivery.empty")}
                              {" \u00b7 "}
                              {modules.find((module) => module.moduleKey === item.moduleKey)?.name || item.moduleKey || t("delivery.empty")}
                            </span>
                            <div>
                              <Tooltip title={t("delivery.planning.editTask")}>
                                <Button type="text" shape="circle" icon={<EditOutlined />} onClick={() => onOpenItem(item)} aria-label={t("delivery.planning.editTask")} />
                              </Tooltip>
                              <Popconfirm
                                title={t("delivery.deleteConfirm")}
                                okButtonProps={{ danger: true }}
                                onConfirm={async () => {
                                  if (await onDeleteItem(item.itemKey)) await Promise.all([load(), onChanged()]);
                                }}
                              >
                                <Tooltip title={t("delivery.delete")}>
                                  <Button danger type="text" shape="circle" icon={<DeleteOutlined />} aria-label={t("delivery.delete")} />
                                </Tooltip>
                              </Popconfirm>
                            </div>
                          </footer>
                        </article>
                      )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.planning.resultEmpty")} />}
                    </div>
                  </section>
                ),
              },
              ...(activePhaseTab === "testing" ? [
              {
                key: "testingCases",
                label: t("delivery.requirement.testingCases"),
                children: (
                  <section className="delivery-planning-result" aria-label={t("delivery.requirement.testingCases")}>
                    <header>
                      <span>{saved?.testingCasesPath || requirement?.testingCasesPath || t("delivery.requirement.testingCases")}</span>
                      <Tooltip title={!saved ? t("delivery.requirement.saveFirst") : !codexBridgeReady ? t("delivery.execution.bridgeOffline") : t("delivery.testingCases.hint")}>
                        <Button
                          size="small"
                          type="primary"
                          icon={<ToolOutlined />}
                          disabled={!saved || !codexBridgeReady}
                          onClick={() => openTestingConversation("", true)}
                        >
                          {t("delivery.testingCases.generate")}
                        </Button>
                      </Tooltip>
                    </header>
                    <SessionDocumentText
                      value={saved?.testingCases || requirement?.testingCases || ""}
                      fallback={t("delivery.requirement.testingCasesEmpty")}
                    />
                  </section>
                ),
              },
              {
                key: "testingReport",
                label: t("delivery.requirement.testingReport"),
                children: (
                  <section className="delivery-planning-result" aria-label={t("delivery.requirement.testingReport")}>
                    <header>
                      <span>{saved?.testingReportPath || requirement?.testingReportPath || t("delivery.requirement.testingReport")}</span>
                    </header>
                    <SessionDocumentText
                      value={saved?.testingReport || requirement?.testingReport || ""}
                      fallback={t("delivery.requirement.testingReportEmpty")}
                    />
                  </section>
                ),
              },
              ] : [
              {
                key: "outline",
                label: t("delivery.outline.tab"),
                children: (
                  <section className="delivery-planning-result" aria-label={t("delivery.outline.tab")}>
                    <header>
                      <span>{outline?.path || t("delivery.outline.pathPending")}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Tag color={outline?.exists ? "success" : "default"}>
                          {outline?.exists ? t("delivery.outline.ready") : t("delivery.outline.notGenerated")}
                        </Tag>
                        <Tooltip title={t("delivery.session.refresh")}>
                          <Button
                            type="text"
                            shape="circle"
                            icon={<ReloadOutlined />}
                            loading={outlineLoading}
                            onClick={() => void loadOutline()}
                            aria-label={t("delivery.session.refresh")}
                          />
                        </Tooltip>
                      </div>
                    </header>
                    <Spin spinning={outlineLoading}>
                      {outline?.exists ? (
                        <>
                          <small style={{ display: "block", marginBottom: 8 }}>
                            <code>{outline.path}</code>
                            {outline.updatedAt ? ` · ${dayjs(outline.updatedAt).format("YYYY-MM-DD HH:mm")}` : ""}
                          </small>
                          <SessionDocumentText value={outline.markdown} fallback={t("delivery.outline.empty")} />
                        </>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.outline.notGenerated")} />
                      )}
                    </Spin>
                  </section>
                ),
              },
              {
                key: "prototype",
                label: t("delivery.prototype.tab"),
                children: (
                  <section className="delivery-planning-result" aria-label={t("delivery.prototype.tab")}>
                    <header>
                      <span>{prototype?.path || t("delivery.prototype.pathPending")}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {prototype?.exists ? (
                          <Button size="small" icon={<EditOutlined />} disabled={!codexBridgeReady} onClick={openPrototypeEditor}>
                            {t("delivery.prototype.edit")}
                          </Button>
                        ) : null}
                        <Tag color={prototypeGenerating ? "processing" : prototype?.exists ? "success" : "default"}>
                          {prototypeGenerating ? t("delivery.prototype.generating") : prototype?.exists ? t("delivery.prototype.ready") : t("delivery.prototype.notGenerated")}
                        </Tag>
                      </div>
                    </header>
                    <Spin spinning={prototypeLoading || prototypeGenerating}>
                      {prototype?.exists ? (
                        <div className="delivery-prototype-preview">
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                            <small>{t("delivery.prototype.path")}: <code>{prototype.path}</code>{prototype.generatedAt ? ` · ${dayjs(prototype.generatedAt).format("YYYY-MM-DD HH:mm")}` : ""}</small>
                            <Tooltip title={t("delivery.prototype.previewRefresh")}>
                              <Button type="text" shape="circle" icon={<ReloadOutlined />} onClick={() => void loadPrototype()} aria-label={t("delivery.prototype.previewRefresh")} />
                            </Tooltip>
                          </div>
                          {prototype.files.length > 1 ? (
                            <Select
                              aria-label={t("delivery.prototype.file")}
                              value={selectedPrototypeFile?.path}
                              onChange={setPrototypeFilePath}
                              options={prototype.files.map((file) => ({ value: file.path, label: file.name }))}
                              style={{ width: "100%", margin: "12px 0" }}
                            />
                          ) : null}
                          {selectedPrototypeFile ? <iframe title={`${t("delivery.prototype.preview")} · ${selectedPrototypeFile.name}`} sandbox="" srcDoc={selectedPrototypeFile.html} style={{ width: "100%", minHeight: 560, border: "1px solid var(--manager-border)", borderRadius: 8, background: "#fff" }} /> : null}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={prototypeGenerating ? t("delivery.prototype.generating") : t("delivery.prototype.notGenerated")} />
                      )}
                    </Spin>
                  </section>
                ),
              },
              ]),
            ]}
          />
          </section>
        </aside>
      </div>
      <Modal
        open={prototypeEditorOpen}
        footer={null}
        onCancel={() => setPrototypeEditorOpen(false)}
        title={t("delivery.prototype.editTitle")}
        width="min(1240px, calc(100vw - 32px))"
        destroyOnClose={false}
        styles={{ body: { paddingTop: 8 } }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(440px, 1.1fr)", gap: 20, minHeight: 620 }}>
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <header style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <b>{t("delivery.prototype.editTitle")}</b>
                <small style={{ display: "block", color: "var(--manager-text-secondary)", marginTop: 4 }}>{t("delivery.prototype.editHint")}</small>
              </div>
              <Tooltip title={t("delivery.session.refresh")}>
                <Button
                  type="text"
                  shape="circle"
                  icon={<ReloadOutlined />}
                  disabled={!prototypeEditConversation?.threadId}
                  loading={prototypeEditLoading}
                  onClick={() => void loadPrototypeEditConversation(prototypeEditConversation?.threadId ?? "")}
                  aria-label={t("delivery.session.refresh")}
                />
              </Tooltip>
            </header>
            <div ref={prototypeEditTranscriptRef} className="delivery-session-transcript" style={{ flex: 1, minHeight: 360, maxHeight: "calc(100vh - 350px)" }}>
              {prototypeEditItems.length ? prototypeEditItems.map((item, index) => (
                <Fragment key={`${item.turnId}-${item.id || index}`}>
                  <PlanningTranscriptItem item={item} programId={programId} toolName={toolName} />
                  {index === prototypeEditItems.length - 1 ? <SessionChangeSummary changes={changesOfTurn(prototypeEditConversation?.turns.find((turn) => turn.id === item.turnId)?.items ?? [])} /> : null}
                </Fragment>
              )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.prototype.editEmpty")} />}
              {prototypeEditActive ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
            </div>
            <footer className="delivery-session-composer" style={{ marginTop: 12 }}>
              <div className="delivery-session-composer__input">
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 7 }}
                  value={prototypeEditDraft}
                  disabled={!codexBridgeReady || prototypeEditSending}
                  placeholder={t("delivery.prototype.editPlaceholder")}
                  onChange={(event) => setPrototypeEditDraft(event.target.value)}
                  onPressEnter={(event) => {
                    if (!event.shiftKey) {
                      event.preventDefault();
                      void sendPrototypeEdit();
                    }
                  }}
                />
                <Tooltip title={t("delivery.prototype.editSend")}>
                  <Button
                    type="primary"
                    shape="circle"
                    icon={<SendOutlined />}
                    loading={prototypeEditSending}
                    disabled={!codexBridgeReady || !prototypeEditDraft.trim()}
                    onClick={() => void sendPrototypeEdit()}
                    aria-label={t("delivery.prototype.editSend")}
                  />
                </Tooltip>
              </div>
            </footer>
          </section>
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <header style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <b>{t("delivery.prototype.preview")}</b>
              <Tooltip title={t("delivery.prototype.previewRefresh")}>
                <Button type="text" shape="circle" icon={<ReloadOutlined />} loading={prototypeLoading} onClick={() => void loadPrototype()} aria-label={t("delivery.prototype.previewRefresh")} />
              </Tooltip>
            </header>
            {prototype?.files.length && prototype.files.length > 1 ? (
              <Select
                aria-label={t("delivery.prototype.file")}
                value={selectedPrototypeFile?.path}
                onChange={setPrototypeFilePath}
                options={prototype.files.map((file) => ({ value: file.path, label: file.name }))}
                style={{ width: "100%", margin: "12px 0" }}
              />
            ) : null}
            {selectedPrototypeFile ? (
              <iframe
                title={`${t("delivery.prototype.preview")} · ${selectedPrototypeFile.name}`}
                sandbox=""
                srcDoc={selectedPrototypeFile.html}
                style={{ width: "100%", flex: 1, minHeight: 540, border: "1px solid var(--manager-border)", borderRadius: 8, background: "#fff" }}
              />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.prototype.notGenerated")} />}
          </section>
      </div>
      </Modal>
      </>
      )}

      {/* 推送前让用户确认提交说明：这一步会把工作区改动整体提交到需求分支。 */}
      <Modal
        wrapClassName="manager-form-skin"
        open={gitPushOpen}
        destroyOnClose
        title={t("delivery.requirement.gitPush")}
        okText={t("delivery.requirement.gitPushConfirm")}
        cancelText={t("common.cancel")}
        confirmLoading={gitPushing}
        onCancel={() => setGitPushOpen(false)}
        onOk={() => void pushGitBranch()}
      >
        <div className="delivery-requirement-git-push">
          <p>{t("delivery.requirement.gitPushDescription").replace("{branch}", saved?.gitBranch ?? "")}</p>
          <label>
            {t("delivery.requirement.gitPushMessage")}
            <Input.TextArea
              rows={3}
              value={gitPushMessage}
              placeholder={t("delivery.requirement.gitPushMessagePlaceholder")}
              onChange={(event) => setGitPushMessage(event.target.value)}
            />
          </label>
          <small>{t("delivery.requirement.gitPushRepairHint").replace("{tool}", toolDisplayName(planningProvider))}</small>
        </div>
      </Modal>
    </Modal>
  );
}
