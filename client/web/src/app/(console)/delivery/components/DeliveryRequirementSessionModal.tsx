"use client";

import {
	BranchesOutlined,
	CloudDownloadOutlined,
	CloudUploadOutlined,
	SwapOutlined,
	LeftOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExpandOutlined,
  ExportOutlined,
  FileOutlined,
  FileTextOutlined,
  FolderOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  DownOutlined,
	ReloadOutlined,
	RightOutlined,
  SaveOutlined,
  SendOutlined,
  ShareAltOutlined,
  ToolOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, DatePicker, Empty, Input, Modal, Popconfirm, Segmented, Select, Spin, Switch, Tabs, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DeliveryDocumentSetModal, DeliveryDocumentSetPanel } from "./DeliveryDocumentSet";
import { DeliveryGitChangesModal } from "./DeliveryGitChangesModal";
import { DeliveryRequirementGitCheckModal } from "./DeliveryRequirementGitCheckModal";
import { DeliveryHtmlFrame, inlineHtmlAssets, resolveFrameHref } from "./DeliveryHtmlFrame";
import { useLocale } from "@/i18n/LocaleProvider";
import { useImeCompositionGuard } from "@/utils/ime";
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
  DELIVERY_PHASES,
  REQUIREMENT_MODES,
  REQUIREMENT_STATUSES,
	bindRequirementGitBranch,
	createCodexGitBranch,
	fetchCodexGitBranches,
	fetchCodexGitProjects,
	fetchCodexGitWorkspaceStatus,
	pushCodexGitBranch,
  fetchCodexRequirementPrototype,
  fetchCodexRequirementPrototypeConversation,
  fetchCodexRequirementReviewConversation,
  fetchCodexRequirementTestingConversation,
  fetchCodexPlanningConversation,
  fetchDeliveryConversationMentionCatalog,
	fetchDeliveryDocumentSet,
	fetchProgramMembers,
  generateCodexRequirementPrototype,
  fetchRequirement,
  saveRequirement,
  updateRequirementName,
  sendCodexRequirementPrototypeMessage,
  sendCodexPlanningMessage,
  stopCodexPlanningConversation,
  uploadCodexPlanningAttachments,
  type CodexConversationItem,
  type CodexGitProjectStatus,
  type CodexGitTargetOutcome,
  type CodexGitWorkspaceStatus,
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
  type CodexRequirementPrototype,
  type DeliveryConversationReference,
  type RequirementMember,
  type RequirementMode,
  type RequirementStatus,
} from "@/api/delivery.api";
import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";
import { DeliveryRequirementDetailInput, requirementMentionKeys, requirementMentionReferences } from "./DeliveryRequirementDetailInput";
import { DeliveryConversationMentionInput, type DeliveryConversationMentionFile } from "./DeliveryConversationMentionInput";
import { usePollingLoop } from "../hooks/usePollingLoop";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { SessionChangeSummary, SessionDocumentText, SessionMessageContent, SessionProcessGroup, groupSessionItems } from "./DeliverySessionMessage";
import { DeliveryRequirementReviewModal } from "./DeliveryRequirementReviewModal";
import { DeliveryRequirementTestingModal } from "./DeliveryRequirementTestingModal";
import { DeliverySessionHistoryTabs, type DeliveryHistoryTab } from "./DeliverySessionHistoryTabs";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  clipboardAttachments,
  readableAttachmentSize,
} from "./DeliverySessionAttachments";
import { getProjectWorkspace } from "@/project-workspaces/projectWorkspacePreferences";

interface DeliveryRequirementSessionModalProps {
  open: boolean;
  /** 为空表示「新增需求」；带值表示编辑既有需求，可以继续追问上一次的拆解。 */
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  programName: string;
	/** 项目级 Git 能力是总开关；关闭时需求不读取或写入任何 Git 设置。 */
	projectGitEnabled: boolean;
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

let lastNewRequirementGitBranchTimestamp = 0;

function defaultNewRequirementGitBranch(existingBranches: readonly string[] = []) {
  let timestamp = Math.max(Date.now(), lastNewRequirementGitBranchTimestamp + 1);
  let branch = `feature/issue_req-${timestamp}`;
  while (existingBranches.includes(branch)) {
    timestamp += 1;
    branch = `feature/issue_req-${timestamp}`;
  }
  lastNewRequirementGitBranchTimestamp = timestamp;
  return branch;
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
	projectGitEnabled,
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
  const { compositionProps, isComposingEnter } = useImeCompositionGuard();
  const { preferences, configFor, setSceneOverride } = useAIPreferences();
  const planningPreference = configFor("taskPlanning");
  const [planningExecutorType, setPlanningExecutorType] = useState<AITool | "">("");
  // 续已有拆解会话时跟着这条线程自己的工具走：正文在那个执行器的缓存里，模型选项也要对齐。
  const planningConfig = useMemo<AIExecutionConfig>(
    () => ({ ...planningPreference, tool: planningExecutorType || planningPreference.tool }),
    [planningExecutorType, planningPreference],
  );
  const planningProvider = planningConfig.tool;
  const testingProvider = configFor("productTesting").tool;
  // 会话里所有露出工具名的地方都跟着场景选的 provider 走，不再写死 Codex。
  const toolName = toolDisplayName(planningProvider);
  const [conversation, setConversation] = useState<CodexPlanningConversation | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [switchingThreadId, setSwitchingThreadId] = useState("");
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
	const [membersProgramId, setMembersProgramId] = useState(0);
  const [mentionCatalog, setMentionCatalog] = useState<{
    requirements: DeliveryRequirementRecord[];
    items: DeliveryItemRecord[];
  } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<DeliveryConversationMentionFile[]>([]);

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
	// 分支只在工具栏上建：下面这几个是「创建分支」弹窗的表单值，不参与需求表单的脏检查。
	const [gitBaseBranch, setGitBaseBranch] = useState("");
	const [gitBranch, setGitBranch] = useState("");
	const [gitBranches, setGitBranches] = useState<string[]>([]);
	const [gitCurrentBranch, setGitCurrentBranch] = useState("");
	const [gitBranchesLoading, setGitBranchesLoading] = useState(false);
	const [gitCreating, setGitCreating] = useState(false);
	const [gitBranchFormOpen, setGitBranchFormOpen] = useState(false);
	// 表单开在哪种用途上："branch" 是建需求分支，"subprojects" 是给已有需求补建子项目分支。
	const [gitBranchFormMode, setGitBranchFormMode] = useState<"branch" | "subprojects">("branch");
	// 创建分支失败的原因直接留在表单里：多行原文加上处理指引，比弹一层 Modal 更好接着操作。
	const [gitBranchError, setGitBranchError] = useState<{ detail: string; dirty: boolean; branch: string } | null>(null);
	const [gitStatus, setGitStatus] = useState<CodexGitWorkspaceStatus | null>(null);
	// 工作目录下一级的独立 Git 子项目：面板要分工程列状态，建分支要按工程勾选。
	const [gitSubprojects, setGitSubprojects] = useState<CodexGitProjectStatus[]>([]);
	const [gitBranchTargets, setGitBranchTargets] = useState<string[]>([]);
	// 子项目默认收起：面板要先能一眼看完根工作目录，展开的工程才铺开完整信息。
	const [expandedSubprojects, setExpandedSubprojects] = useState<string[]>([]);
	const [gitStatusRefreshing, setGitStatusRefreshing] = useState(false);
	const [gitPushOpen, setGitPushOpen] = useState(false);
	// 提交/推送的目标分支：默认是需求分支，创建分支被脏工作区拦下时改成当前所处的那条。
	const [gitPushBranch, setGitPushBranch] = useState("");
	const [gitPushMessage, setGitPushMessage] = useState("");
	// 主项目推送时一并提交的子项目：默认全选，用户可以按需取消。
	const [gitPushTargets, setGitPushTargets] = useState<string[]>([]);
	const [gitPushing, setGitPushing] = useState(false);
	const [gitChangesOpen, setGitChangesOpen] = useState(false);
	// 「变更」看的是哪个工程：空串是项目根工作目录，否则是子项目的绝对路径。
	const [gitChangesWorkspace, setGitChangesWorkspace] = useState("");
	// 分支不一致时从 Git 面板直接进检查并切换弹窗，不用退回需求列表。
	const [gitCheckOpen, setGitCheckOpen] = useState(false);
	// 切换 / 推送作用在哪个工程：空串是项目根工作目录，否则是子项目的绝对路径。
	const [gitCheckWorkspace, setGitCheckWorkspace] = useState("");
	const [gitPushWorkspace, setGitPushWorkspace] = useState("");
	// 新建窗口即使在落库后收到父组件回传，也仍属于同一轮新建流程；Git 项目要据此持续拦截首轮对话。
	const newRequirementFlowRef = useRef(false);
	const modalOpenRef = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  // 一级先区分需求与测试，避免五个页签在窄侧栏横向溢出，让 HTML 原型入口消失。
  const [activePhaseTab, setActivePhaseTab] = useState<RequirementPhaseTab>("requirement");
  const [activeRequirementTab, setActiveRequirementTab] = useState<RequirementStageTab>("requirement");
  const [activeTestingTab, setActiveTestingTab] = useState<TestingStageTab>("testingCases");
  const [testingWorkspaceOpen, setTestingWorkspaceOpen] = useState(false);
  // 聊天历史分栏在需求编辑和测试工作区之间共用，返回时还停在原来那一栏。
  const [historyTab, setHistoryTab] = useState<DeliveryHistoryTab>("planning");
  const [testingConversations, setTestingConversations] = useState<CodexPlanningSessionSummary[]>([]);
  const [reviewConversations, setReviewConversations] = useState<CodexPlanningSessionSummary[]>([]);
  const [reviewWorkspaceOpen, setReviewWorkspaceOpen] = useState(false);
  const [reviewThreadId, setReviewThreadId] = useState("");
  const [startNewReviewConversation, setStartNewReviewConversation] = useState(false);
  const [testingThreadId, setTestingThreadId] = useState("");
  const [startNewTestingConversation, setStartNewTestingConversation] = useState(false);
  const [outlineFullscreen, setOutlineFullscreen] = useState(false);
  const [testingFullscreen, setTestingFullscreen] = useState(false);
  const [prototypeFullscreen, setPrototypeFullscreen] = useState(false);
  const [prototypeViewportFullscreen, setPrototypeViewportFullscreen] = useState(false);
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
	const [contextCollapsed, setContextCollapsed] = useState(false);
	const [gitPanelCollapsed, setGitPanelCollapsed] = useState(false);
  const [resizingContext, setResizingContext] = useState(false);
  const planningShellRef = useRef<HTMLDivElement>(null);
  const contextResizePointerIdRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const awaitingPlanningResultRef = useRef("");
  // React 状态要到下一次渲染才更新；请求回调必须同步知道用户已经进入“新会话”草稿，
  // 否则旧线程稍晚返回时会把它自己的 Codex / Claude 再写回模型选择器。
  const newConversationRef = useRef(false);
  const loadRequestIdRef = useRef(0);

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

  // key 允许显式传入：需求是在「发送」那一刻才落库的，这一轮里 requirementKey 还是上一次渲染
  // 留下的空值，不带着新键调用就会被下面这行挡掉，聊天要等重新打开弹窗才出得来。
  const load = useCallback(async (threadId = "", preserveSelected = false, key = "") => {
    const targetKey = key || requirementKey;
    if (!programId || !targetKey) return null;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const next = await fetchCodexPlanningConversation(programId, threadId, targetKey, planningPreference.tool);
      if (requestId !== loadRequestIdRef.current) return null;
      setConversation(next);
      if (!newConversationRef.current) {
        setPlanningExecutorType(next.threadId ? next.executorType : "");
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
  }, [planningPreference.tool, programId, requirementKey]);

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

  const loadReviewHistory = useCallback(async () => {
    if (!programId || !requirementKey || !codexBridgeReady) {
      setReviewConversations([]);
      return;
    }
    try {
      const next = await fetchCodexRequirementReviewConversation(programId, requirementKey, "", testingProvider);
      setReviewConversations(next.conversations);
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [codexBridgeReady, programId, requirementKey, testingProvider]);

  // 自动写进来的那个名字（先是占位名，随后是 AI 标题）；用户自己改过就不再跟着变。
  const autoNameRef = useRef("");
	useEffect(() => {
		if (open && !modalOpenRef.current) {
			newRequirementFlowRef.current = !requirement;
			// 新增和编辑需求都一样：右侧详情默认收起，把宽度让给会话；确认写入跑完后再自动展开。
			setContextCollapsed(true);
			setGitPanelCollapsed(false);
		}
		if (!open) newRequirementFlowRef.current = false;
		modalOpenRef.current = open;
    if (!open) {
      newConversationRef.current = false;
      loadRequestIdRef.current += 1;
      setConversation(null);
      setSelectedThreadId("");
      setSwitchingThreadId("");
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
      setReviewWorkspaceOpen(false);
      setReviewConversations([]);
      setReviewThreadId("");
      setStartNewReviewConversation(false);
      setHistoryTab("planning");
      setTestingConversations([]);
      setTestingThreadId("");
      setStartNewTestingConversation(false);
      setOutlineFullscreen(false);
      setTestingFullscreen(false);
      setPrototypeFullscreen(false);
      setPrototypeViewportFullscreen(false);
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
		  setContextCollapsed(false);
		  setGitPanelCollapsed(false);
      awaitingPlanningResultRef.current = "";
      return;
    }
    setSaved(requirement);
    // 换一条需求就重新认「哪个名字是自动写进来的」，否则上一条的占位名会被当成本条的。
    // 需求编号是 Git 新需求首轮等待 AI 标题期间的临时名称，父组件回传时不能把它忘掉。
    autoNameRef.current = requirement?.name && requirement.name === requirement.requirementKey
      ? requirement.requirementKey
      : "";
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
		// 分支表单每次打开都按当前需求重置；已经建过分支的需求在工具栏上只读展示。
		setGitBranchFormOpen(false);
		setGitStatus(null);
		setGitSubprojects([]);
		setExpandedSubprojects([]);
		setGitBaseBranch(requirement?.gitBaseBranch ?? projectGitBaseBranch);
		setGitBranch(requirement?.gitBranch ?? "");
		setGitBranches([]);
		// 打开需求聊天就要能直接看到 Git 信息，别让用户先去点开小圆点。
		setGitPanelCollapsed(false);
    setStageKey(requirement?.stageKey ?? "");
    setModuleKey(requirement?.moduleKey ?? "");
    setKind(requirement?.kind ?? "");
    setOwnerIds((requirement?.owners ?? []).map((member) => member.id));
    setAssistantIds((requirement?.assistants ?? []).map((member) => member.id));
	}, [open, projectGitBaseBranch, projectGitEnabled, requirement]);

  useEffect(() => {
    if (!open || !programId) {
      setMembers([]);
		setMembersProgramId(0);
      return undefined;
    }
    let cancelled = false;
		setMembers([]);
		setMembersProgramId(0);
    void fetchProgramMembers(programId)
      .then((next) => {
			if (!cancelled) {
				setMembers(next);
				setMembersProgramId(programId);
			}
      })
      .catch(() => {
        if (!cancelled) message.warning(t("delivery.requirement.membersFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, programId, t]);

	useEffect(() => {
		if (!open || !projectGitEnabled || !gitBranchFormOpen) return;
		let cancelled = false;
		setGitBranchesLoading(true);
		void fetchCodexGitBranches(programId)
			.then((catalog) => {
				if (cancelled) return;
				setGitBranches(catalog.branches);
				setGitCurrentBranch(catalog.currentBranch || "");
				// 拉不到远端时列表只有本机已知的分支，别人刚推的分支会缺；这一点必须说出来。
				if (catalog.fetchError) message.warning(t("delivery.requirement.gitFetchBranchesFailed"));
				setGitBaseBranch((current) => current || catalog.defaultBranch || catalog.branches[0] || "");
				setGitBranch((current) => {
					if (saved?.requirementKey || !current || !current.startsWith("feature/issue_req-") || !catalog.branches.includes(current)) return current;
					return defaultNewRequirementGitBranch(catalog.branches);
				});
			})
			.catch(() => {
				if (cancelled) return;
				setGitCurrentBranch("");
				message.warning(t("delivery.requirement.gitLoadBranchesFailed"));
			})
			.finally(() => {
				if (!cancelled) setGitBranchesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [gitBranchFormOpen, open, programId, projectGitEnabled, saved?.requirementKey, t]);

	// 需求分支已经建好时，工具栏上要能看出它现在有多少待提交改动。
	const refreshGitProjects = useCallback(async () => {
		if (!open || !projectGitEnabled || !codexBridgeReady || !saved?.gitBranch) {
			setGitStatus(null);
			setGitSubprojects([]);
			return { root: null as CodexGitWorkspaceStatus | null, subprojects: [] as CodexGitProjectStatus[] };
		}
		// 状态常常几十毫秒就回来了，转一圈都看不见；这里兜一个最短时长，让手动刷新一定有画面反馈。
		const startedAt = Date.now();
		setGitStatusRefreshing(true);
		let next: CodexGitWorkspaceStatus | null = null;
		let subprojects: CodexGitProjectStatus[] = [];
		try {
			// 一次把根目录和子项目的状态都读回来：面板要分工程展示，多打一次接口没必要。
			const catalog = await fetchCodexGitProjects(programId, saved.gitBranch);
			next = catalog.projects.find((project) => !project.path) ?? null;
			subprojects = catalog.projects.filter((project) => project.path);
			setGitStatus(next);
			setGitSubprojects(subprojects);
		} catch {
			// 桥接还是旧版本（没有子项目接口）时退回单目录状态，别让整块 Git 信息一起消失。
			setGitSubprojects([]);
			try {
				next = await fetchCodexGitWorkspaceStatus(programId);
				setGitStatus(next);
			} catch {
				// 工作区状态是附加信息，读不到就只显示分支名，不打扰用户。
				setGitStatus(null);
			}
		} finally {
			const rest = 480 - (Date.now() - startedAt);
			if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
			setGitStatusRefreshing(false);
		}
		return { root: next, subprojects };
	}, [codexBridgeReady, open, programId, projectGitEnabled, saved?.gitBranch]);

	const refreshGitStatus = useCallback(async () => (await refreshGitProjects()).root, [refreshGitProjects]);

	const gitPushProject = gitPushWorkspace
		? gitSubprojects.find((project) => project.workspace === gitPushWorkspace) ?? null
		: null;

	const gitCheckProject = gitCheckWorkspace
		? gitSubprojects.find((project) => project.workspace === gitCheckWorkspace) ?? null
		: null;

	const gitChangesProject = gitChangesWorkspace
		? gitSubprojects.find((project) => project.workspace === gitChangesWorkspace) ?? null
		: null;

	// 推送和切换会自动带上「本机已经有这条分支」的子项目，弹窗里要先把名单说清楚。
	// 面板和推送弹窗都按「扫到的 Git 工程」列；gitLinked 只用来判断还有哪些工程缺这条需求分支。
	const gitLinkedSubprojects = gitSubprojects.filter((project) => project.hasBranch && !project.error);
	const gitVisibleSubprojects = gitSubprojects.filter((project) => !project.error);
	const gitPushSubprojects = gitVisibleSubprojects;


	// 工作目录停在别的分支上：Git 面板要同时给出提示和切换入口。
	const gitBranchMismatched = Boolean(
		gitStatus?.currentBranch && saved?.gitBranch && gitStatus.currentBranch !== saved.gitBranch,
	);

	useEffect(() => {
		void refreshGitStatus();
	}, [refreshGitStatus]);

  useEffect(() => {
    if (!open || !requirementKey) return;
    void load("");
    // 切到另一条需求时会话要整条重来，不能沿用上一条需求的 thread。
  }, [load, open, requirementKey]);

  useEffect(() => {
    if (!open || !requirementKey) return;
    void loadTestingHistory();
    void loadReviewHistory();
  }, [loadReviewHistory, loadTestingHistory, open, requirementKey]);

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

  const pollPrototypeGeneration = useCallback(async () => {
    const next = await loadPrototype();
    if (!next) return;
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
  }, [loadPrototype, onChanged, t]);
  usePollingLoop(Boolean(prototypeGenerating && open && requirementKey), 3000, pollPrototypeGeneration, true);

  const loadPrototypeEditConversation = useCallback(async (threadId: string) => {
    if (!open || !requirementKey || !threadId || !codexBridgeReady) return null;
    setPrototypeEditLoading(true);
    try {
      const next = await fetchCodexRequirementPrototypeConversation(programId, requirementKey, threadId, planningPreference.tool);
      setPrototypeEditConversation(next);
      return next;
    } catch (error) {
      message.error((error as Error).message);
      return null;
    } finally {
      setPrototypeEditLoading(false);
    }
  }, [codexBridgeReady, open, planningPreference.tool, programId, requirementKey]);

  const openPrototypeEditor = () => {
    setPrototypeEditorOpen(true);
  };

  const sendPrototypeEdit = async () => {
    const text = prototypeEditDraft.trim();
    if (!text || !codexBridgeReady || !requirementKey) return;
    setPrototypeEditSending(true);
    try {
      // 原型会话另有自己的线程归属，模型和工具都跟着它走。
      const prototypeConfig: AIExecutionConfig = {
        ...planningPreference,
        tool: prototypeEditConversation?.threadId ? prototypeEditConversation.executorType : planningPreference.tool,
      };
      const action = await sendCodexRequirementPrototypeMessage(programId, requirementKey, text, {
        threadId: prototypeEditConversation?.threadId || undefined,
        provider: prototypeConfig.tool,
        model: modelForConfig(prototypeConfig),
        reasoningEffort: effortForConfig(prototypeConfig),
        fastMode: prototypeConfig.tool === "claude" && prototypeConfig.claudeFastMode,
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

  const prototypeEditThreadId = prototypeEditConversation?.threadId || "";
  const pollPrototypeEdit = useCallback(async () => {
    const next = await loadPrototypeEditConversation(prototypeEditThreadId);
    if (!next || next.active) return;
    await loadPrototype();
    void onChanged();
    message.success(t("delivery.prototype.updated"));
  }, [loadPrototype, loadPrototypeEditConversation, onChanged, prototypeEditThreadId, t]);
  usePollingLoop(
    Boolean(prototypeEditorOpen && prototypeEditActive && prototypeEditThreadId),
    3000,
    pollPrototypeEdit,
  );

  const active = Boolean(conversation?.active && !newConversation);

	// 拆解回合结束时工作区多半刚被改过，待提交数要跟着更新。
	useEffect(() => {
		if (active) return;
		void refreshGitStatus();
	}, [active, refreshGitStatus]);

  // 需求名称留空时，桥接在开聊那一刻就先用首条消息的前十个字占位，再并行起一轮命名，
  // AI 的标题回来后把占位名换掉。名字在拆解跑着的过程中会变两次，所以运行期间一直取，
  // 回合结束后再补取一次。
  // 只在本地名字还是自动写进来的那个（或仍为空）时采用，免得盖掉用户自己敲的名字。
  const planningActiveRef = useRef(false);
  useEffect(() => {
    const finished = planningActiveRef.current && !active;
    planningActiveRef.current = active;
    const local = name.trim();
    if (!open || !saved?.requirementKey || (local && local !== autoNameRef.current)) return undefined;
    if (!active && !finished) return undefined;
    let cancelled = false;
    const requirementKeyToName = saved.requirementKey;
    const pullName = async () => {
      try {
        const next = await fetchRequirement(programId, requirementKeyToName);
        const nextName = (next.name ?? "").trim();
        if (cancelled || !nextName || nextName === autoNameRef.current) return;
        autoNameRef.current = nextName;
        setSaved(next);
        setName(next.name);
        onRequirementSaved(next);
      } catch {
        // 名字是补充信息，取不到就等下一轮，不能打断正在跑的拆解。
      }
    };
    void pullName();
    if (!active) return undefined;
    // 名字在一轮里会变两次（占位名 → AI 标题），取得勤一点，用户才觉得是「立刻」变的。
    const timer = window.setInterval(() => void pullName(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, name, onRequirementSaved, open, programId, saved]);
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

  // 多页原型的导航是同目录的相对链接，iframe 里自己跳会跳成空白，改成切换选中的原型页。
  const navigatePrototype = useCallback((href: string) => {
    const current = selectedPrototypeFile?.path ?? "";
    if (!current) return;
    const resolved = resolveFrameHref(current, href);
    const target = prototype?.files.find((file) => file.path === resolved);
    if (target) setPrototypeFilePath(target.path);
    else message.warning(`${t("delivery.prototype.missingPage")}：${href}`);
  }, [prototype, selectedPrototypeFile, t]);

  const openPrototypeInBrowser = () => {
    const html = selectedPrototypeFile?.html ?? "";
    if (!html.trim()) return;
    // 新标签页也是 blob 地址，同目录的样式脚本先内联，否则打开的原型没有样式。
    const url = URL.createObjectURL(new Blob([
      inlineHtmlAssets(html, selectedPrototypeFile?.assets),
    ], { type: "text/html;charset=utf-8" }));
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) message.warning(t("delivery.docset.openBlocked"));
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  usePollingLoop(open && active, 5000, load);

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

  const { ref: transcriptRef, onScroll: onTranscriptScroll } = useStickToBottom<HTMLDivElement>(
    [active, flattenedItems.length],
    !switchingThreadId && conversation?.threadId
      ? `zb.delivery.scroll.requirement.${programId}.${requirementKey}.${conversation.threadId}`
      : "",
  );

  const prototypeEditItems = useMemo(
    () => (prototypeEditConversation?.turns ?? []).flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id }))),
    [prototypeEditConversation],
  );

  const { ref: prototypeEditTranscriptRef, onScroll: onPrototypeEditTranscriptScroll } = useStickToBottom<HTMLDivElement>([
    prototypeEditActive,
    prototypeEditItems.length,
  ]);

  // 确认写入只在「已经出过一轮预览、当前没有回合在跑」时可用：没有方案可确认，或方案还在生成中都不放行。
  const canConfirmWrite =
    codexBridgeReady && !sending && !saving && !active && !newConversation && Boolean(conversation?.threadId);

  // 拆解会话读的是已落库的那份需求，表单改了没存必须在保存条上说出来。
  const dirty = useMemo(() => {
    const sameMembers = (ids: string[], list: RequirementMember[] | undefined) =>
      ids.join(",") === (list ?? []).map((member) => member.id).join(",");
		if (!saved) return Boolean(name.trim() || detail.trim() || ownerIds.length || assistantIds.length);
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
      || stageKey !== (saved.stageKey ?? "")
      || moduleKey !== (saved.moduleKey ?? "")
      || kind !== (saved.kind ?? "")
      || !sameMembers(ownerIds, saved.owners)
      || !sameMembers(assistantIds, saved.assistants)
    );
  }, [assistantIds, detail, generatePrototype, preGenerateTaskDocuments, kind, mode, moduleKey, name, ownerIds, plannedEndAt, plannedStartAt, saved, splitTasks, stageKey, startPhase, status]);

	// 弹窗在切换项目时也不能展示上一个项目的缓存成员。
	const projectMembers = membersProgramId === programId ? members : [];
  const memberOptions = useMemo(
		() => projectMembers.map((member) => ({ value: member.id, label: member.displayName || member.username })),
		[projectMembers],
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

  // “文件”候选只来自当前需求受控的三个目录；任一栏目暂未生成都不影响其他候选展示。
  useEffect(() => {
    const requirementKey = saved?.requirementKey ?? "";
    if (!open || !programId || !requirementKey || !codexBridgeReady) {
      setMentionFiles([]);
      return undefined;
    }
    let cancelled = false;
    void Promise.allSettled([
      fetchDeliveryDocumentSet(programId, "requirement-outline", requirementKey),
      fetchDeliveryDocumentSet(programId, "requirement-testing", requirementKey),
      fetchCodexRequirementPrototype(programId, requirementKey),
    ]).then(([outlineResult, testingResult, prototypeResult]) => {
      if (cancelled) return;
      const next: DeliveryConversationMentionFile[] = [];
      if (outlineResult.status === "fulfilled") {
        next.push(...outlineResult.value.files.map((file) => ({
          path: file.path,
          name: file.name,
          scope: "requirement-outline" as const,
        })));
      }
      if (testingResult.status === "fulfilled") {
        next.push(...testingResult.value.files.map((file) => ({
          path: file.path,
          name: file.name,
          scope: "requirement-testing" as const,
        })));
      }
      if (prototypeResult.status === "fulfilled") {
        next.push(...prototypeResult.value.files.map((file) => ({
          path: file.path,
          name: file.name,
          scope: "requirement-prototype" as const,
        })));
      }
      const unique = new Map(next.map((file) => [file.path, file]));
      setMentionFiles(Array.from(unique.values()));
    });
    return () => {
      cancelled = true;
    };
  }, [active, codexBridgeReady, open, programId, prototype?.generatedAt, saved?.requirementKey]);

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
			projectMembers.find((member) => member.id === id)?.displayName
          ?? fallback.find((member) => member.id === id)?.name
          ?? id,
      })),
		[projectMembers],
  );

	const save = async (gitOverrides?: { gitEnabled?: boolean; gitBaseBranch?: string; gitBranch?: string }) => {
    // 名称允许留空：先和 AI 把需求聊清楚，标题由拆解会话结束后按聊天内容自动生成。
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
			// 分支由工具栏的创建入口单独绑定，需求保存只把已绑定的值原样带回，别覆盖成表单里的临时值。
			...(projectGitEnabled ? {
				gitEnabled: gitOverrides?.gitEnabled ?? saved?.gitEnabled ?? true,
				gitBaseBranch: gitOverrides?.gitBaseBranch ?? saved?.gitBaseBranch ?? "",
				gitBranch: gitOverrides?.gitBranch ?? saved?.gitBranch ?? "",
			} : {}),
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

	const openGitBranchForm = async (mode: "branch" | "subprojects" = "branch") => {
		// 新需求不先保存：先在本机创建分支，成功后才创建需求并写入关联。
		setGitBranchFormMode(mode);
		setGitBaseBranch(saved?.gitBaseBranch || projectGitBaseBranch || "");
		setGitBranch(saved?.gitBranch || (saved?.requirementKey ? defaultRequirementGitBranch(saved.requirementKey) : defaultNewRequirementGitBranch()));
		setGitBranchError(null);
		setGitBranchFormOpen(true);
		// 工作目录下可能摆着若干个独立工程，建分支时要能一次把它们都带上；默认全选。
		try {
			const catalog = await fetchCodexGitProjects(programId, saved?.gitBranch || "");
			const subprojects = catalog.projects.filter((project) => project.path);
			setGitSubprojects(subprojects);
			// 默认勾还没有这条分支的工程：已经有的再建一次没有意义，只会白拉一轮远端。
			setGitBranchTargets(subprojects
				.filter((project) => project.isGitRepository && !project.error && !project.hasBranch)
				.map((project) => project.path));
		} catch {
			// 读不到子项目不该挡住建分支：退化成只在根工作目录建这一条。
			setGitSubprojects([]);
			setGitBranchTargets([]);
		}
	};

	/** 建分支 / 推送这类批量动作里，逐个子项目的失败原因要留在屏幕上，不能用 toast 一闪而过。 */
	const reportGitTargetFailures = (title: string, results: CodexGitTargetOutcome[]) => {
		const failed = results.filter((entry) => entry.path && entry.error);
		if (!failed.length) return;
		Modal.warning({
			title,
			width: 560,
			okText: t("common.close"),
			wrapClassName: "manager-form-skin",
			content: (
				<div className="delivery-requirement-git-error">
					{failed.map((entry) => (
						<div key={entry.path}>
							<b>{entry.name || entry.path}</b>
							<pre>{entry.error}</pre>
						</div>
					))}
				</div>
			),
		});
	};

	const createGitBranch = async () => {
		if (!projectGitEnabled) return;
		if (!gitBaseBranch) {
			message.warning(t("delivery.requirement.gitBaseBranchRequired"));
			return;
		}
		setGitCreating(true);
		setGitBranchError(null);
		try {
			// 补建只在子项目里建分支：需求关联早就写好了，根工作目录这一轮完全不动。
			if (gitBranchFormMode === "subprojects" && saved?.gitBranch) {
				const patched = await createCodexGitBranch(programId, gitBaseBranch, saved.gitBranch, gitBranchTargets, true);
				setGitBranchFormOpen(false);
				void refreshGitProjects();
				message.success(t("delivery.requirement.gitSubprojectBranchCreated"));
				reportGitTargetFailures(t("delivery.requirement.gitSubprojectBranchFailed"), patched.results);
				return;
			}
			const current = saved;
			const needsTemporaryName = newRequirementFlowRef.current && !current?.name.trim();
			const nextBranch = gitBranch.trim() || (current?.requirementKey ? defaultRequirementGitBranch(current.requirementKey) : defaultNewRequirementGitBranch());
			if (!nextBranch) return;
			// 新建流程严格按「先创建本机分支，再创建需求」执行；需求保存失败时不会提前落库。
			const created = await createCodexGitBranch(programId, gitBaseBranch, nextBranch, gitBranchTargets);
			let next = current
				? await bindRequirementGitBranch(programId, current.requirementKey, created.baseBranch, created.branch)
				: await save({ gitEnabled: true, gitBaseBranch: created.baseBranch, gitBranch: created.branch });
			if (!next) return;
			// 分支成功后才把需求编号作为临时名称；首轮 AI 标题只允许替换这个精确旧值。
			if (needsTemporaryName) {
				next = await updateRequirementName(programId, next.requirementKey, next.requirementKey, "");
				autoNameRef.current = next.requirementKey;
				setName(next.requirementKey);
			}
			// 新建需求要在拿到服务端编号后补记分支关联时间；已有需求已经在上一步完成绑定。
			if (!current) {
				next = await bindRequirementGitBranch(programId, next.requirementKey, created.baseBranch, created.branch);
			}
			setGitBaseBranch(next.gitBaseBranch);
			setGitBranch(next.gitBranch);
			setSaved(next);
			onRequirementSaved(next);
			// 创建（或切换）成功后项目就停在这条分支上，标注要立刻跟上。
			setGitCurrentBranch(created.branch);
			setGitBranchFormOpen(false);
			void refreshGitStatus();
			message.success(t("delivery.requirement.gitBranchCreated"));
			// 根目录建成了，个别子项目没建成的原因单独摆出来：需求已经关联，用户补建即可。
			reportGitTargetFailures(t("delivery.requirement.gitSubprojectBranchFailed"), created.results);
		} catch (error) {
			// Git 的失败原因往往是多行输出，toast 会截断，直接留在表单里，用户看完就能接着处理。
			const detail = (error as Error).message;
			// 未提交改动是最常见的失败原因，光给原文不够，得说清楚是哪条分支、去哪里提交。
			setGitBranchError({ detail, dirty: detail.includes("未提交改动"), branch: gitCurrentBranch });
		} finally {
			setGitCreating(false);
		}
	};

	// 需求已经关联到本机的一条分支时才谈得上推送；只在面板上填了分支名（没真正建过）不算。
	const gitLinked = Boolean(projectGitEnabled && saved?.gitBranch && saved?.gitBranchCreatedAt);
	const gitPushReady = Boolean(gitLinked && saved?.gitEnabled);
	const gitBranchRequiredBeforeConversation = Boolean(projectGitEnabled && newRequirementFlowRef.current && !gitLinked);
	// 工具栏的分支区域跟着标题走：名字定下来之后才出现建分支入口。
	const gitToolbarReady = Boolean(projectGitEnabled && (gitLinked || newRequirementFlowRef.current || (saved && name.trim())));

	// 当前所处分支往往是别的需求的分支：提交说明要按那条需求写，找不到就退回分支名。
	const requirementOfBranch = (branch: string) =>
		branch ? requirements.find((entry) => entry.gitBranch === branch) ?? null : null;

	const openGitPush = (branch = "", workspace = "") => {
		const target = branch || saved?.gitBranch || "";
		const owner = target && target === saved?.gitBranch ? saved : requirementOfBranch(target);
		setGitPushWorkspace(workspace);
		// 单独推某个子项目时不再牵扯别的工程；推主项目才带上默认全选的子项目。
		setGitPushTargets(workspace
			? []
			: gitSubprojects
				.filter((project) => !project.error && (project.hasBranch || project.currentBranch))
				.map((project) => project.path));
		setGitPushBranch(target);
		setGitPushMessage(owner ? `feat: ${owner.name || owner.requirementKey}（${owner.requirementKey}）` : target ? `chore: ${target}` : "");
		setGitPushOpen(true);
	};

	// commitOnly：只在本机提交，不推远端。推送冲突要 AI 帮忙时才走完整推送。
	const pushGitBranch = async (commitOnly = false) => {
		const branch = gitPushBranch || saved?.gitBranch || "";
		if (!branch) return;
		setGitPushing(true);
		try {
			const result = await pushCodexGitBranch(programId, branch, gitPushMessage.trim(), {
				// 推子项目时只动那一个工程；推主项目则按弹窗里勾选的子项目一并处理。
				...(gitPushWorkspace ? { workspace: gitPushWorkspace, targets: [] } : { targets: gitPushTargets }),
				provider: planningProvider,
				model: modelForConfig(planningConfig),
				reasoningEffort: effortForConfig(planningConfig),
				fastMode: planningProvider === "claude" && planningConfig.claudeFastMode,
				commitOnly,
			});
			setGitPushOpen(false);
			// 挡住创建分支的那点未提交改动已经落成提交，表单里的错误提示跟着清掉，直接重试即可。
			setGitBranchError(null);
			void refreshGitStatus();
			reportGitTargetFailures(t("delivery.requirement.gitSubprojectPushFailed"), result.results);
			if (commitOnly) {
				message.success(
					result.committed
						? t("delivery.requirement.gitCommitted").replace("{branch}", result.branch)
						: t("delivery.requirement.gitCommitNothing"),
				);
				return;
			}
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
					: (result.synced === "rebased"
						? t("delivery.requirement.gitPushedRebased")
						: t("delivery.requirement.gitPushed")).replace("{branch}", `${result.remote}/${result.branch}`),
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
    if (switchingThreadId) return;
    const text = draft.trim() || (confirmWrite
      ? t("delivery.planning.confirmMessage")
      : chatReferences.length ? t("delivery.chatMention.referenceMessage") : "");
    if (!text && !attachments.length) return;
    if (!codexBridgeReady) {
      message.warning(t("delivery.execution.bridgeOffline"));
      return;
    }
		if (gitBranchRequiredBeforeConversation) {
			message.warning(t("delivery.requirement.gitBranchRequiredBeforeConversation"));
			return;
		}
    // 会话必须挂在一条已经落库的需求上，否则拆出来的任务无处归属，附件也没有归档的键。
    const current = saved ?? (await save());
    if (!current) return;
    // 一次都没聊过的需求（不管是新增还是从编辑入口进来的）：首轮的标题由 AI 按用户的问题
    // 重定，所以把此刻的名字当成「自动写进来的名字」，桥接回写之后本地才会跟着换。
    if (!(conversation?.conversations ?? []).length) autoNameRef.current = current.name.trim();
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
      newConversationRef.current = false;
      setNewConversation(false);
      setSelectedThreadId(action.threadId);
      setSwitchingThreadId("");
      // 只有写入轮次结束后才跳到「拆解结果」：预览轮次没有产出，跳过去只会看到一片空。
      awaitingPlanningResultRef.current = confirmWrite ? action.turnId : "";
      await load(action.threadId, false, current.requirementKey);
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
		if (codexBridgeReady && !sending && !gitBranchRequiredBeforeConversation) setDraggingAttachments(true);
  };

  const handleAttachmentDragLeave = (event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingAttachments(false);
  };

  const handleAttachmentDrop = (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDraggingAttachments(false);
		if (!codexBridgeReady || sending || gitBranchRequiredBeforeConversation) return;
    selectAttachments(event.dataTransfer.files);
  };

  /** 输入框里直接 Cmd/Ctrl+V 粘贴截图或文件，和拖拽走同一条上传通道。 */
  const handleAttachmentPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardAttachments(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
		if (!codexBridgeReady || sending || gitBranchRequiredBeforeConversation) return;
    selectAttachments(files);
  };

  const startNewConversation = () => {
    if (active) return;
    newConversationRef.current = true;
    // 使所有仍在读取旧窗口的请求失效；它们可以结束，但不能覆盖新草稿的模型。
    loadRequestIdRef.current += 1;
    setLoading(false);
    setNewConversation(true);
    // 新开会话回到偏好里选的工具，不再沿用上一条线程的执行器。
    setPlanningExecutorType("");
    setSelectedThreadId("");
    setSwitchingThreadId("");
    setDraft("");
    setChatReferences([]);
    setAttachments([]);
  };

  const selectConversation = (threadId: string) => {
    if (threadId === selectedThreadId && !newConversation) return;
    newConversationRef.current = false;
    setNewConversation(false);
    setSelectedThreadId(threadId);
    setSwitchingThreadId(threadId);
    setDraft("");
    setChatReferences([]);
    setAttachments([]);
    void load(threadId, true);
  };

  // 回到拆解会话：空线程号表示直接新开一轮拆解。
  const openPlanningConversation = (threadId: string) => {
    setHistoryTab("planning");
    if (testingWorkspaceOpen) {
      setTestingWorkspaceOpen(false);
      setStartNewTestingConversation(false);
      void loadTestingHistory();
    }
    if (reviewWorkspaceOpen) {
      setReviewWorkspaceOpen(false);
      setStartNewReviewConversation(false);
      void loadReviewHistory();
    }
    if (threadId) selectConversation(threadId);
    else startNewConversation();
  };

  const openReviewConversation = (threadId = "", startNew = false) => {
    setHistoryTab("review");
    setTestingWorkspaceOpen(false);
    setStartNewTestingConversation(false);
    setReviewThreadId(threadId);
    setStartNewReviewConversation(startNew);
    setReviewWorkspaceOpen(true);
  };

  const openTestingConversation = (threadId = "", startNewConversation = false) => {
    setHistoryTab("testing");
    setReviewWorkspaceOpen(false);
    setStartNewReviewConversation(false);
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
    // 写入跑完才有拆解结果可看，这时把默认收起的右侧详情展开。
    setContextCollapsed(false);
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

  // Git 悬浮框在拆解和 review 两个会话区里共用，抽成一份，别在两处各维护一遍。
  const gitPanel = (
    <>
          {/* Git 相关入口全部收在这个悬浮框里：还没建分支时给创建入口，建好后是分支、变更和推送。 */}
          {gitLinked || gitToolbarReady ? (
            <aside className={`delivery-requirement-git-panel${gitPanelCollapsed ? " is-collapsed" : ""}`}>
              <header>
                {!gitPanelCollapsed ? <span>{t("delivery.requirement.gitPanelTitle")}</span> : null}
                <div className="delivery-requirement-git-panel__header-actions">
                  {!gitPanelCollapsed && gitLinked ? (
                    <Tooltip title={t("delivery.requirement.gitPanelRefresh")}>
                      <Button
                        type="text"
                        size="small"
                        shape="circle"
                        icon={<ReloadOutlined spin={gitStatusRefreshing} />}
                        aria-label={t("delivery.requirement.gitPanelRefresh")}
                        disabled={gitStatusRefreshing}
                        onClick={() => void refreshGitStatus()}
                      />
                    </Tooltip>
                  ) : null}
                  <Tooltip title={t(gitPanelCollapsed ? "delivery.requirement.gitPanelExpand" : "delivery.requirement.gitPanelCollapse")}>
                    <Button
                      className="delivery-requirement-git-panel__toggle"
                      type="text"
                      size="small"
                      shape="circle"
                      icon={gitPanelCollapsed ? <LeftOutlined /> : <RightOutlined />}
                      aria-label={t(gitPanelCollapsed ? "delivery.requirement.gitPanelExpand" : "delivery.requirement.gitPanelCollapse")}
                      aria-expanded={!gitPanelCollapsed}
                      onClick={() => setGitPanelCollapsed((collapsed) => !collapsed)}
                    />
                  </Tooltip>
                </div>
              </header>
              {/* 内容单独一层：标题和刷新/收起按钮要一直钉在顶上，长出来的只让下面这块滚。 */}
              {!gitPanelCollapsed ? (
                <div className="delivery-requirement-git-panel__body">
              {/* 还没建分支：面板里只放创建入口，顺带把「先建分支再对话」的原因说清楚。 */}
              {!gitLinked ? (
                <>
                  <button
                    className={`delivery-requirement-git-panel__row is-action${saving ? " is-disabled" : ""}`}
                    type="button"
                    aria-disabled={saving}
                    onClick={() => {
                      if (saving) return;
                      void openGitBranchForm();
                    }}
                  >
                    {saving ? <LoadingOutlined spin /> : <BranchesOutlined />}
                    <span>{t("delivery.requirement.gitCreateBranch")}</span>
                  </button>
                  {gitBranchRequiredBeforeConversation ? (
                    <div className="delivery-requirement-git-panel__row">
                      <span className="delivery-requirement-git-panel__row-caption">
                        {t("delivery.requirement.gitBranchRequiredBeforeConversation")}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {gitLinked ? (
                <>
                  <Tooltip
                    placement="left"
                    title={gitStatus
                      ? `${t("delivery.requirement.gitPanelChangesDetail")
                        .replace("{staged}", String(gitStatus.staged))
                        .replace("{unstaged}", String(gitStatus.unstaged))
                        .replace("{untracked}", String(gitStatus.untracked))}\n${t("delivery.requirement.gitPanelChangesOpen")}`
                      : t("delivery.requirement.gitPanelChangesOpen")}
                  >
                    <button
                      className="delivery-requirement-git-panel__row is-action"
                      type="button"
                      onClick={() => {
                        setGitChangesWorkspace("");
                        setGitChangesOpen(true);
                      }}
                    >
                      <FileTextOutlined />
                      {/* 面板宽度固定，标题和取值分两行放，长文案就不会互相挤掉。 */}
                      <span className="delivery-requirement-git-panel__row-body">
                        <span className="delivery-requirement-git-panel__row-label">{t("delivery.requirement.gitPanelChanges")}</span>
                        <b className={gitStatus?.changed ? "is-dirty" : "is-clean"}>
                          {gitStatus
                            ? gitStatus.changed
                              ? t("delivery.requirement.gitBranchPending").replace("{changed}", String(gitStatus.changed))
                              : t("delivery.requirement.gitBranchClean")
                            : "—"}
                        </b>
                      </span>
                    </button>
                  </Tooltip>
                  {/* 需求分支和工作目录分支合成一行：一致时只有一条，不一致时第二条标出「当前分支」。 */}
                  <div className="delivery-requirement-git-panel__row">
                    <BranchesOutlined />
                    <span className="delivery-requirement-git-panel__row-body">
                      <span className="delivery-requirement-git-panel__branch">
                        <Tooltip title={saved?.gitBranch} placement="left">
                          <code className="manager-mono">{saved?.gitBranch}</code>
                        </Tooltip>
                        {gitStatus?.currentBranch ? (
                          <Tooltip
                            placement="left"
                            title={gitBranchMismatched
                              ? t("delivery.requirement.gitBranchNotCurrent").replace("{current}", gitStatus.currentBranch)
                              : t("delivery.requirement.gitAlreadyOnBranch")}
                          >
                            <span className={`delivery-requirement-git-panel__tag${gitBranchMismatched ? " is-mismatch" : " is-ready"}`}>
                              {t(gitBranchMismatched ? "delivery.requirement.gitState.mismatch" : "delivery.requirement.gitState.ready")}
                            </span>
                          </Tooltip>
                        ) : null}
                      </span>
                      {gitBranchMismatched ? (
                        <span className="delivery-requirement-git-panel__branch">
                          <Tooltip title={gitStatus?.currentBranch} placement="left">
                            <code className="manager-mono">{gitStatus?.currentBranch}</code>
                          </Tooltip>
                          <span className="delivery-requirement-git-panel__tag is-current">
                            {t("delivery.requirement.gitCurrentBranchTag")}
                          </span>
                        </span>
                      ) : null}
                      {gitStatus && !gitStatus.currentBranch ? (
                        <span className="delivery-requirement-git-panel__row-caption">
                          {t("delivery.requirement.gitCurrentBranchDetached")}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {/* 分支不一致时给出直达入口：切换动作交给共用的检查弹窗，脏工作区的暂存/提交策略都在那里选。 */}
                  {gitBranchMismatched ? (
                    <Tooltip placement="left" title={codexBridgeReady ? t("delivery.requirement.gitCheckTitle") : t("delivery.requirement.gitPanelUnavailable")}>
                      <button
                        className={`delivery-requirement-git-panel__row is-action is-warning${!codexBridgeReady ? " is-disabled" : ""}`}
                        type="button"
                        aria-disabled={!codexBridgeReady}
                        onClick={() => {
                          if (!codexBridgeReady) return;
                          setGitCheckWorkspace("");
                          setGitCheckOpen(true);
                        }}
                      >
                        <SwapOutlined />
                        <span>{t("delivery.requirement.gitCheck")}</span>
                      </button>
                    </Tooltip>
                  ) : null}
                  {gitStatus?.currentBranch === saved?.gitBranch ? (
                    <Tooltip placement="left" title={codexBridgeReady ? t("delivery.requirement.gitPullLatest") : t("delivery.requirement.gitPanelUnavailable")}>
                      <button
                        className={`delivery-requirement-git-panel__row is-action${!codexBridgeReady ? " is-disabled" : ""}`}
                        type="button"
                        aria-disabled={!codexBridgeReady}
                        onClick={() => {
                          if (!codexBridgeReady) return;
                          setGitCheckWorkspace("");
                          setGitCheckOpen(true);
                        }}
                      >
                        <CloudDownloadOutlined />
                        <span>{t("delivery.requirement.gitPullLatest")}</span>
                      </button>
                    </Tooltip>
                  ) : null}
                  {gitPushReady ? (
                    <Tooltip
                      placement="left"
                      title={codexBridgeReady
                        ? t("delivery.requirement.gitPushHint").replace("{branch}", saved?.gitBranch ?? "")
                        : t("delivery.requirement.gitPanelUnavailable")}
                    >
                      <button
                        // 用 aria-disabled 而不是 disabled：原生禁用按钮收不到 hover，Tooltip 里的原因就没人看得到。
                        className={`delivery-requirement-git-panel__row is-action${!codexBridgeReady || gitPushing ? " is-disabled" : ""}`}
                        type="button"
                        aria-disabled={!codexBridgeReady || gitPushing}
                        onClick={() => {
                          if (!codexBridgeReady || gitPushing) return;
                          openGitPush();
                        }}
                      >
                        {gitPushing ? <LoadingOutlined spin /> : <CloudUploadOutlined />}
                        <span>{t("delivery.requirement.gitPanelPush")}</span>
                      </button>
                    </Tooltip>
                  ) : null}
                  {/* 参与这条需求的子工程：默认收起，展开后是一整块和根目录同样的 Git 信息。 */}
                  {gitSubprojects.length ? (
                    <>
                      <div className="delivery-requirement-git-panel__section">
                        <span>{t("delivery.requirement.gitSubprojects")}</span>
                      </div>
                      {/* 一个都没列出来时不能整块留白：说清楚原因，并给一个补建分支的入口。 */}
                      {!gitVisibleSubprojects.length ? (
                        <div className="delivery-requirement-git-panel__row">
                          <span className="delivery-requirement-git-panel__row-caption">
                            {t("delivery.requirement.gitSubprojectsUnreadable")}
                          </span>
                        </div>
                      ) : null}
                      {gitVisibleSubprojects.map((project) => {
                        const expanded = expandedSubprojects.includes(project.path);
                        // 游离 HEAD 也算没停在需求分支上，同样要给切换入口。
                        const projectMismatched = project.currentBranch !== saved?.gitBranch;
                        // 没有这条需求分支的工程只是「工作目录里的另一个仓库」：不给切换，
                        // 提交也只针对它自己当前所在的分支。
                        const projectTag = project.hasBranch
                          ? (projectMismatched ? "is-mismatch" : "is-ready")
                          : "is-none";
                        const projectTagText = t(project.hasBranch
                          ? (projectMismatched
                            ? "delivery.requirement.gitState.mismatch"
                            : "delivery.requirement.gitState.ready")
                          : "delivery.requirement.gitSubprojectNoBranch");
                        const pushBranch = project.hasBranch ? saved?.gitBranch ?? "" : project.currentBranch;
                        return (
                          <div className="delivery-requirement-git-panel__group" key={project.path}>
                            <div className="delivery-requirement-git-panel__group-head">
                              <button
                                className="delivery-requirement-git-panel__row is-action is-subproject"
                                type="button"
                                aria-expanded={expanded}
                                onClick={() => setExpandedSubprojects((current) => (
                                  current.includes(project.path)
                                    ? current.filter((path) => path !== project.path)
                                    : [...current, project.path]
                                ))}
                              >
                                {expanded ? <DownOutlined /> : <RightOutlined />}
                                <span className="delivery-requirement-git-panel__row-body">
                                  <span className="delivery-requirement-git-panel__row-label">{project.name}</span>
                                  {/* 收起时也要能看出这个工程有没有活儿，不然还得一个个点开。 */}
                                  <b className={project.changed ? "is-dirty" : "is-clean"}>
                                    {project.changed
                                      ? t("delivery.requirement.gitBranchPending").replace("{changed}", String(project.changed))
                                      : t("delivery.requirement.gitBranchClean")}
                                  </b>
                                </span>
                                <span className={`delivery-requirement-git-panel__tag ${projectTag}`}>{projectTagText}</span>
                              </button>
                              {project.hasBranch && !projectMismatched ? (
                                <Tooltip placement="left" title={codexBridgeReady ? t("delivery.requirement.gitPullLatest") : t("delivery.requirement.gitPanelUnavailable")}>
                                  <button
                                    className={`delivery-requirement-git-panel__quick-action${!codexBridgeReady ? " is-disabled" : ""}`}
                                    type="button"
                                    aria-label={`${project.name} · ${t("delivery.requirement.gitPullLatest")}`}
                                    aria-disabled={!codexBridgeReady}
                                    onClick={() => {
                                      if (!codexBridgeReady) return;
                                      setGitCheckWorkspace(project.workspace);
                                      setGitCheckOpen(true);
                                    }}
                                  >
                                    <CloudDownloadOutlined />
                                    <span>{t("delivery.requirement.gitPullLatest")}</span>
                                  </button>
                                </Tooltip>
                              ) : null}
                            </div>
                            {expanded ? (
                              <div className="delivery-requirement-git-panel__group-body">
                                <Tooltip
                                  placement="left"
                                  title={`${t("delivery.requirement.gitPanelChangesDetail")
                                    .replace("{staged}", String(project.staged))
                                    .replace("{unstaged}", String(project.unstaged))
                                    .replace("{untracked}", String(project.untracked))}\n${t("delivery.requirement.gitSubprojectChangesOpen")}`}
                                >
                                  <button
                                    className="delivery-requirement-git-panel__row is-action"
                                    type="button"
                                    onClick={() => {
                                      setGitChangesWorkspace(project.workspace);
                                      setGitChangesOpen(true);
                                    }}
                                  >
                                    <FileTextOutlined />
                                    <span className="delivery-requirement-git-panel__row-body">
                                      <span className="delivery-requirement-git-panel__row-label">
                                        {t("delivery.requirement.gitPanelChanges")}
                                      </span>
                                      <b className={project.changed ? "is-dirty" : "is-clean"}>
                                        {project.changed
                                          ? t("delivery.requirement.gitBranchPending").replace("{changed}", String(project.changed))
                                          : t("delivery.requirement.gitBranchClean")}
                                      </b>
                                    </span>
                                  </button>
                                </Tooltip>
                                <div className="delivery-requirement-git-panel__row">
                                  <BranchesOutlined />
                                  <span className="delivery-requirement-git-panel__row-body">
                                    {/* 有这条需求分支才把它摆在第一行；没有的工程只说自己此刻停在哪。 */}
                                    {project.hasBranch ? (
                                      <span className="delivery-requirement-git-panel__branch">
                                        <Tooltip title={saved?.gitBranch} placement="left">
                                          <code className="manager-mono">{saved?.gitBranch}</code>
                                        </Tooltip>
                                        <Tooltip
                                          placement="left"
                                          title={projectMismatched
                                            ? t("delivery.requirement.gitBranchNotCurrent")
                                              .replace("{current}", project.currentBranch || t("delivery.requirement.gitCurrentBranchDetached"))
                                            : t("delivery.requirement.gitAlreadyOnBranch")}
                                        >
                                          <span className={`delivery-requirement-git-panel__tag ${projectTag}`}>{projectTagText}</span>
                                        </Tooltip>
                                      </span>
                                    ) : null}
                                    {project.currentBranch && (projectMismatched || !project.hasBranch) ? (
                                      <span className="delivery-requirement-git-panel__branch">
                                        <Tooltip title={project.currentBranch} placement="left">
                                          <code className="manager-mono">{project.currentBranch}</code>
                                        </Tooltip>
                                        <span className="delivery-requirement-git-panel__tag is-current">
                                          {t("delivery.requirement.gitCurrentBranchTag")}
                                        </span>
                                      </span>
                                    ) : null}
                                    {!project.currentBranch ? (
                                      <span className="delivery-requirement-git-panel__row-caption">
                                        {t("delivery.requirement.gitCurrentBranchDetached")}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                                {project.hasBranch && projectMismatched ? (
                                  <Tooltip placement="left" title={codexBridgeReady ? t("delivery.requirement.gitCheckTitle") : t("delivery.requirement.gitPanelUnavailable")}>
                                    <button
                                      className={`delivery-requirement-git-panel__row is-action is-warning${!codexBridgeReady ? " is-disabled" : ""}`}
                                      type="button"
                                      aria-disabled={!codexBridgeReady}
                                      onClick={() => {
                                        if (!codexBridgeReady) return;
                                        setGitCheckWorkspace(project.workspace);
                                        setGitCheckOpen(true);
                                      }}
                                    >
                                      <SwapOutlined />
                                      <span>{t("delivery.requirement.gitCheck")}</span>
                                    </button>
                                  </Tooltip>
                                ) : null}
                                {gitPushReady ? (
                                  <Tooltip
                                    placement="left"
                                    title={!codexBridgeReady
                                      ? t("delivery.requirement.gitPanelUnavailable")
                                      : pushBranch
                                        ? t("delivery.requirement.gitPushHint").replace("{branch}", pushBranch)
                                        : t("delivery.requirement.gitCurrentBranchDetached")}
                                  >
                                    <button
                                      className={`delivery-requirement-git-panel__row is-action${!codexBridgeReady || gitPushing || !pushBranch ? " is-disabled" : ""}`}
                                      type="button"
                                      aria-disabled={!codexBridgeReady || gitPushing || !pushBranch}
                                      onClick={() => {
                                        if (!codexBridgeReady || gitPushing || !pushBranch) return;
                                        openGitPush(pushBranch, project.workspace);
                                      }}
                                    >
                                      {gitPushing ? <LoadingOutlined spin /> : <CloudUploadOutlined />}
                                      <span>{t("delivery.requirement.gitPanelPush")}</span>
                                    </button>
                                  </Tooltip>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      {gitLinkedSubprojects.length < gitSubprojects.length ? (
                        <button
                          className={`delivery-requirement-git-panel__row is-action${saving ? " is-disabled" : ""}`}
                          type="button"
                          aria-disabled={saving}
                          onClick={() => {
                            if (saving) return;
                            void openGitBranchForm("subprojects");
                          }}
                        >
                          <BranchesOutlined />
                          <span>{t("delivery.requirement.gitSubprojectCreateBranch")}</span>
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
                </div>
              ) : null}
            </aside>
          ) : null}
    </>
  );

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
            <>
      <div
		className={`delivery-planning-shell${resizingContext ? " is-resizing-context" : ""}${contextCollapsed ? " is-context-collapsed" : ""}`}
		ref={planningShellRef}
		style={{ "--delivery-planning-context-width": `${contextPanelWidth}px` } as CSSProperties}
		>
        {/* 左：会话列表按用途分成拆解 / 代码 review / 测试三栏，追问和重开在各自那一栏里切。 */}
        <DeliverySessionHistoryTabs
          activeTab={historyTab}
          onTabChange={setHistoryTab}
          planningConversations={conversation?.conversations ?? []}
          reviewConversations={reviewConversations}
          testingConversations={testingConversations}
          selectedKind={testingWorkspaceOpen ? "testing" : reviewWorkspaceOpen ? "review" : "planning"}
          selectedThreadId={testingWorkspaceOpen
            ? (startNewTestingConversation ? "" : testingThreadId)
            : reviewWorkspaceOpen
              ? (startNewReviewConversation ? "" : reviewThreadId)
              : newConversation ? "" : switchingThreadId || conversation?.threadId || ""}
          draft={testingWorkspaceOpen
            ? startNewTestingConversation ? { kind: "testing" as const, title: `${saved?.name || requirementKey} · ${t("delivery.testingCases.status")}`, subtitle: `${t("delivery.testingCases.status")} · ${t("delivery.requirement.testingDraft")}` } : null
            : reviewWorkspaceOpen
              ? startNewReviewConversation ? { kind: "review" as const, title: `${t("delivery.review.title")} · ${saved?.name || requirementKey}`, subtitle: `${t("delivery.review.title")} · ${t("delivery.session.newDraft").replace("{tool}", toolName)}` } : null
              : newConversation ? { kind: "planning" as const, title: t("delivery.session.newConversation"), subtitle: `${t("delivery.planning.title")} · ${t("delivery.session.newDraft").replace("{tool}", toolName)}` } : null}
          onSelect={(kind, threadId) => (kind === "planning" ? openPlanningConversation(threadId) : kind === "review" ? openReviewConversation(threadId) : openTestingConversation(threadId))}
          onNew={(tab) => (tab === "planning" ? openPlanningConversation("") : tab === "review" ? openReviewConversation("", true) : openTestingConversation("", true))}
          newDisabled={testingWorkspaceOpen || reviewWorkspaceOpen ? !requirementKey : active || !requirementKey}
          newDisabledTip={!testingWorkspaceOpen && !reviewWorkspaceOpen && active ? t("delivery.session.newDisabled") : ""}
          testingTitleFallback={`${saved?.name || requirementKey} · ${t("delivery.testingCases.status")}`}
        />

        {/* 中：拆解会话，或者测试工作区的会话区——两者共用同一套左右两栏。 */}
        {reviewWorkspaceOpen && saved ? (
        <DeliveryRequirementReviewModal
          requirement={saved}
          programId={programId}
          programName={programName}
          codexBridgeReady={codexBridgeReady}
          startNewConversationOnOpen={startNewReviewConversation}
          initialThreadId={reviewThreadId}
          gitPanel={gitPanel}
          contextCollapsed={contextCollapsed}
          onToggleContext={() => {
            setContextCollapsed(!contextCollapsed);
            setGitPanelCollapsed(false);
          }}
          onConversationStateChange={({ threadId, isNew }) => {
            setReviewThreadId(threadId);
            setStartNewReviewConversation(isNew);
          }}
          onChanged={async () => {
            await loadReviewHistory();
          }}
        />
        ) : testingWorkspaceOpen && saved ? (
        <DeliveryRequirementTestingModal
          embedded
          mainOnly
          open
          requirement={saved}
          programId={programId}
          programName={programName}
          codexBridgeReady={codexBridgeReady}
          startNewConversationOnOpen={startNewTestingConversation}
          initialThreadId={testingThreadId}
          contextCollapsed={contextCollapsed}
          onToggleContext={() => {
            setContextCollapsed(!contextCollapsed);
            setGitPanelCollapsed(false);
          }}
          onConversationStateChange={({ threadId, isNew }) => {
            setTestingThreadId(threadId);
            setStartNewTestingConversation(isNew);
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
        <main className="delivery-session-main">
          <header className="delivery-session-toolbar delivery-planning-session-toolbar">
            <div className="delivery-planning-session-toolbar__summary">
              <div className="delivery-session-title delivery-planning-session-title">
                <div className="delivery-planning-session-title__heading">
                  <span>{saved ? t("delivery.requirement.edit") : t("delivery.requirement.new")}</span>
                  <b>{name.trim() || saved?.requirementKey || programName || programId}</b>
                  {name.trim() || saved?.requirementKey ? <small>{programName || programId}</small> : null}
                </div>
                {saved?.createdAt ? (
                  <small className="delivery-planning-session-title__created-at">
                    {t("delivery.requirement.createdAt")} {dayjs(saved.createdAt).format("YYYY-MM-DD HH:mm")}
                  </small>
                ) : null}
              </div>
              {/* 分享、刷新提到标题行，且只留图标，靠 Tooltip 说明文案；创建分支归到 Git 悬浮框。 */}
              <div className="delivery-planning-session-toolbar__quick">
                <Tooltip title={requirementKey ? t("delivery.requirement.shareLink") : t("delivery.requirement.saveFirst")}>
                  <Button
                    icon={<ShareAltOutlined />}
                    disabled={!saved}
                    aria-label={t("delivery.requirement.shareLink")}
                    onClick={() => {
                      if (saved) onShare(saved);
                    }}
                  />
                </Tooltip>
                <Tooltip title={t("delivery.session.refresh")}>
                  <Button icon={<ReloadOutlined />} loading={loading} disabled={!requirementKey} onClick={() => void load()} aria-label={t("delivery.session.refresh")} />
                </Tooltip>
              </div>
              {/* 没有会话状态可说时仍保留位置，避免刷新按钮在不同状态下左右跳动。 */}
              {!requirementKey ? (
                <span className="delivery-planning-session-toolbar__state delivery-planning-session-toolbar__state--save-required">
                  {t(gitBranchRequiredBeforeConversation ? "delivery.requirement.gitBranchRequiredBeforeConversation" : "delivery.requirement.saveFirst")}
                </span>
              ) : newConversation ? (
                <span className="delivery-planning-session-toolbar__state">{t("delivery.session.newConversation")}</span>
              ) : conversation?.threadId ? (
                <span className="delivery-planning-session-toolbar__state"><i /> {t("delivery.session.connected").replace("{tool}", toolName)}</span>
              ) : (
                <span className="delivery-planning-session-toolbar__state" />
              )}
              {/* 展开/收起跟弹窗的关闭按钮排在同一行，右上角只留这两个。 */}
              <Tooltip title={t(contextCollapsed ? "delivery.planning.expandContext" : "delivery.planning.collapseContext")}>
                <Button
                  className="delivery-planning-context-toggle"
                  type="text"
                  shape="circle"
                  icon={contextCollapsed ? <RightOutlined /> : <LeftOutlined />}
                  aria-label={t(contextCollapsed ? "delivery.planning.expandContext" : "delivery.planning.collapseContext")}
                  onClick={() => {
                    const nextCollapsed = !contextCollapsed;
                    setContextCollapsed(nextCollapsed);
                    setGitPanelCollapsed(false);
                  }}
                />
              </Tooltip>
            </div>
            <div className="delivery-session-toolbar__actions">
              {/* 分支与推送都搬到收起需求信息后出现的 Git 悬浮框里，这里不再重复。 */}
              {prototype?.exists ? (
                <Button icon={<EditOutlined />} disabled={!codexBridgeReady} onClick={openPrototypeEditor}>
                  {t("delivery.prototype.edit")}
                </Button>
              ) : null}
              {active ? <Button danger icon={<PauseCircleOutlined />} loading={stopping} onClick={() => void stop()}>{t("delivery.planning.stop")}</Button> : null}
            </div>
          </header>
          {gitPanel}
          <div className="delivery-session-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
            {/* 首次加载时只显示转圈，不要再叠一层空状态：两个「空」摞在一起像坏了。 */}
            {switchingThreadId || (loading && !conversation) ? (
              <div className="delivery-session-transcript__loading"><Spin /></div>
            ) : !newConversation && flattenedItems.length ? (
              // 按回合渲染：每个回合末尾补一份「本次改动」，对齐直接用 Codex / Claude 时看到的改动清单。
              (conversation?.turns ?? []).map((turn) => (
                <Fragment key={turn.id}>
                  {groupSessionItems(turn.items).map((group) => (group.kind === "process" ? (
                    <SessionProcessGroup items={group.items} key={`${turn.id}-${group.id}`} />
                  ) : (
                    <PlanningTranscriptItem item={group.item} programId={programId} toolName={toolName} key={`${turn.id}-${group.id}`} />
                  )))}
                  <SessionChangeSummary items={turn.items} programId={programId} />
                </Fragment>
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t(newConversation ? "delivery.session.newEmpty" : "delivery.planning.empty").replace("{tool}", toolName)}
              />
            )}
            {active && !switchingThreadId ? <div className="delivery-session-thinking"><LoadingOutlined spin /> {toolName}</div> : null}
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
                disabled={!codexBridgeReady || sending || gitBranchRequiredBeforeConversation}
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
                disabled={!codexBridgeReady || sending || gitBranchRequiredBeforeConversation}
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
                    disabled={!codexBridgeReady || sending || gitBranchRequiredBeforeConversation}
                    aria-label={t("aiPreferences.fastMode")}
                    onChange={(checked) => setSceneOverride("taskPlanning", { ...(preferences.scenes.taskPlanning ?? {}), claudeFastMode: checked })}
                  />
                </Tooltip>
              ) : null}
              <Tooltip title={t("delivery.session.addImage")}>
                <Button type="text" shape="circle" icon={<PictureOutlined />} aria-label={t("delivery.session.addImage")} disabled={!codexBridgeReady || sending || gitBranchRequiredBeforeConversation} onClick={() => imageInputRef.current?.click()} />
              </Tooltip>
              <Tooltip title={t("delivery.session.addFile")}>
                <Button type="text" shape="circle" icon={<PaperClipOutlined />} aria-label={t("delivery.session.addFile")} disabled={!codexBridgeReady || sending || gitBranchRequiredBeforeConversation} onClick={() => attachmentInputRef.current?.click()} />
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
				disabled={!codexBridgeReady || sending || gitBranchRequiredBeforeConversation}
				placeholder={gitBranchRequiredBeforeConversation
					? t("delivery.requirement.gitBranchRequiredBeforeConversation")
					: t(newConversation ? "delivery.session.newPlaceholder" : "delivery.planning.placeholder")}
                requirements={chatRequirements}
                items={chatItems}
                files={mentionFiles}
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
					disabled={(!draft.trim() && !attachments.length) || !codexBridgeReady || gitBranchRequiredBeforeConversation}
                    onClick={() => void send()}
                  />
                </Tooltip>
              </div>
            </div>
			<small className="delivery-planning-composer__hint">
				{t(gitBranchRequiredBeforeConversation
					? "delivery.requirement.gitBranchRequiredBeforeConversation"
					: "delivery.planning.previewHint")}
			</small>
            {draggingAttachments ? <div className="delivery-session-composer__drop-target">{t("delivery.session.dropAttachments")}</div> : null}
          </footer>
        </main>
        )}

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
                          <span className="delivery-field-label">{t("delivery.requirement.name")}</span>
                          <Input
                            value={name}
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
                        disabled={saving || (saved ? !dirty : projectGitEnabled)}
                        loading={saving}
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
                    <DeliveryDocumentSetPanel
                      programId={programId}
                      scope="requirement-testing"
                      subjectKey={requirementKey}
                      codexBridgeReady={codexBridgeReady}
                      emptyText={t("delivery.requirement.testingCasesEmpty")}
                      browserContent={saved?.testingCases || requirement?.testingCases || ""}
                      browserTitle={t("delivery.requirement.testingCases")}
                      onExpand={() => setTestingFullscreen(true)}
                      refreshToken={active ? "running" : "idle"}
                      fallback={(
                        <SessionDocumentText
                          value={saved?.testingCases || requirement?.testingCases || ""}
                          fallback={t("delivery.requirement.testingCasesEmpty")}
                        />
                      )}
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
                  <DeliveryDocumentSetPanel
                    programId={programId}
                    scope="requirement-outline"
                    subjectKey={requirementKey}
                    codexBridgeReady={codexBridgeReady}
                    uploadable
                    emptyText={t("delivery.outline.requirementEmpty")}
                    onExpand={() => setOutlineFullscreen(true)}
                    refreshToken={active ? "running" : "idle"}
                    scroll="fill"
                  />
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
                            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                              <Tooltip title={t("delivery.prototype.previewRefresh")}>
                                <Button type="text" shape="circle" icon={<ReloadOutlined />} onClick={() => void loadPrototype()} aria-label={t("delivery.prototype.previewRefresh")} />
                              </Tooltip>
                              <Tooltip title={t("delivery.docset.openInBrowser")}>
                                <Button type="text" shape="circle" icon={<ExportOutlined />} onClick={openPrototypeInBrowser} aria-label={t("delivery.docset.openInBrowser")} />
                              </Tooltip>
                              <Tooltip title={t("delivery.docset.expand")}>
                                <Button type="text" shape="circle" icon={<ExpandOutlined />} onClick={() => setPrototypeFullscreen(true)} aria-label={t("delivery.docset.expand")} />
                              </Tooltip>
                            </div>
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
                          {selectedPrototypeFile ? <DeliveryHtmlFrame autoHeight title={`${t("delivery.prototype.preview")} · ${selectedPrototypeFile.name}`} html={selectedPrototypeFile.html} assets={selectedPrototypeFile.assets} onNavigate={navigatePrototype} style={{ width: "100%", minHeight: 560, border: "1px solid var(--manager-border)", borderRadius: 8, background: "#fff" }} /> : null}
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
      <DeliveryDocumentSetModal
        open={outlineFullscreen}
        programId={programId}
        scope="requirement-outline"
        subjectKey={requirementKey}
        codexBridgeReady={codexBridgeReady}
        title={`${t("delivery.outline.tab")} · ${requirement?.name || requirementKey}`}
        uploadable
        emptyText={t("delivery.outline.requirementEmpty")}
        onClose={() => setOutlineFullscreen(false)}
      />
      <DeliveryDocumentSetModal
        open={testingFullscreen}
        programId={programId}
        scope="requirement-testing"
        subjectKey={requirementKey}
        codexBridgeReady={codexBridgeReady}
        title={`${t("delivery.requirement.testingCases")} · ${requirement?.name || requirementKey}`}
        emptyText={t("delivery.requirement.testingCasesEmpty")}
        browserContent={saved?.testingCases || requirement?.testingCases || ""}
        browserTitle={t("delivery.requirement.testingCases")}
        onClose={() => setTestingFullscreen(false)}
      />
      <Modal
        className={`delivery-document-set-modal delivery-prototype-preview-modal${prototypeViewportFullscreen ? " is-fullscreen" : ""}`}
        open={prototypeFullscreen}
        title={null}
        width={prototypeViewportFullscreen ? "100vw" : "min(1240px, calc(100vw - 32px))"}
        footer={null}
        destroyOnClose
        onCancel={() => {
          setPrototypeFullscreen(false);
          setPrototypeViewportFullscreen(false);
        }}
      >
        {prototype?.exists ? (
          <div className="delivery-document-set">
            <aside className="delivery-document-set__files" aria-label={t("delivery.docset.files")}>
              <header>{t("delivery.docset.files")}</header>
              <ul>
                {prototype.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={file.path === selectedPrototypeFile?.path ? "is-active" : ""}
                      onClick={() => setPrototypeFilePath(file.path)}
                    >
                      <FileTextOutlined />
                      <span className="delivery-document-set__name" title={file.name}>{file.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
            <section className="delivery-document-panel">
              <header className="delivery-outline-panel__bar">
                <b className="delivery-outline-panel__title">{`${t("delivery.prototype.tab")} · ${requirement?.name || requirementKey}`}</b>
                <span className="delivery-outline-panel__actions">
                  <Tooltip title={t("delivery.prototype.previewRefresh")}>
                    <Button
                      size="small"
                      type="text"
                      icon={<ReloadOutlined />}
                      loading={prototypeLoading}
                      onClick={() => void loadPrototype()}
                      aria-label={t("delivery.prototype.previewRefresh")}
                    />
                  </Tooltip>
                  <Tooltip title={t("delivery.docset.openInBrowser")}>
                    <Button
                      size="small"
                      type="text"
                      icon={<ExportOutlined />}
                      onClick={openPrototypeInBrowser}
                      aria-label={t("delivery.docset.openInBrowser")}
                    />
                  </Tooltip>
                  <Tooltip title={t(prototypeViewportFullscreen ? "delivery.docset.exitFullscreen" : "delivery.docset.fullscreen")}>
                    <Button
                      size="small"
                      type="text"
                      icon={prototypeViewportFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                      onClick={() => setPrototypeViewportFullscreen((value) => !value)}
                      aria-label={t(prototypeViewportFullscreen ? "delivery.docset.exitFullscreen" : "delivery.docset.fullscreen")}
                    />
                  </Tooltip>
                </span>
              </header>
              {selectedPrototypeFile ? (
                <>
                  <div className="delivery-document-panel__path" title={selectedPrototypeFile.path}>
                    <FileTextOutlined className="delivery-document-panel__path-icon" />
                    <span className="delivery-document-panel__path-text">
                      <span className="delivery-document-panel__path-name">{selectedPrototypeFile.path}</span>
                    </span>
                  </div>
                  <DeliveryHtmlFrame
                    autoHeight
                    className="delivery-prototype-preview-modal__frame"
                    title={`${t("delivery.prototype.preview")} · ${selectedPrototypeFile.name}`}
                    html={selectedPrototypeFile.html}
                    assets={selectedPrototypeFile.assets}
                    onNavigate={navigatePrototype}
                  />
                </>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.prototype.notGenerated")} />}
            </section>
          </div>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.prototype.notGenerated")} />}
      </Modal>
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
            <div ref={prototypeEditTranscriptRef} onScroll={onPrototypeEditTranscriptScroll} className="delivery-session-transcript" style={{ flex: 1, minHeight: 360, maxHeight: "calc(100vh - 350px)" }}>
              {prototypeEditItems.length ? prototypeEditItems.map((item, index) => (
                <Fragment key={`${item.turnId}-${item.id || index}`}>
                  <PlanningTranscriptItem item={item} programId={programId} toolName={toolName} />
                  {index === prototypeEditItems.length - 1 ? <SessionChangeSummary items={prototypeEditConversation?.turns.find((turn) => turn.id === item.turnId)?.items ?? []} programId={programId} /> : null}
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
                  {...compositionProps}
                  onPressEnter={(event) => {
                    // 输入法用回车确认候选词，这一下不能当成发送。
                    if (isComposingEnter(event)) return;
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
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Tooltip title={t("delivery.prototype.previewRefresh")}>
                  <Button type="text" shape="circle" icon={<ReloadOutlined />} loading={prototypeLoading} onClick={() => void loadPrototype()} aria-label={t("delivery.prototype.previewRefresh")} />
                </Tooltip>
                <Tooltip title={t("delivery.docset.openInBrowser")}>
                  <Button type="text" shape="circle" icon={<ExportOutlined />} onClick={openPrototypeInBrowser} aria-label={t("delivery.docset.openInBrowser")} />
                </Tooltip>
              </div>
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
              <DeliveryHtmlFrame
                autoHeight
                title={`${t("delivery.prototype.preview")} · ${selectedPrototypeFile.name}`}
                html={selectedPrototypeFile.html}
                assets={selectedPrototypeFile.assets}
                onNavigate={navigatePrototype}
                style={{ width: "100%", flex: "0 0 auto", minHeight: 540, border: "1px solid var(--manager-border)", borderRadius: 8, background: "#fff" }}
              />
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.prototype.notGenerated")} />}
          </section>
      </div>
      </Modal>
      </>

      {/* 建分支只问两件事：从哪条分支切出来、这条需求的分支叫什么。 */}
      <Modal
        wrapClassName="manager-form-skin"
        open={gitBranchFormOpen}
        destroyOnClose
        title={t(gitBranchFormMode === "subprojects"
          ? "delivery.requirement.gitSubprojectCreateBranch"
          : "delivery.requirement.gitBranchFormTitle")}
        okText={t(gitBranchFormMode === "subprojects"
          ? "delivery.requirement.gitSubprojectCreateBranch"
          : "delivery.requirement.gitCreateBranch")}
        cancelText={t("common.cancel")}
        confirmLoading={gitCreating}
        okButtonProps={{ disabled: !gitBaseBranch || !gitBranch.trim() || gitBranchesLoading }}
        onCancel={() => setGitBranchFormOpen(false)}
        onOk={() => void createGitBranch()}
      >
        <div className="delivery-requirement-git-push">
          {/* 建分支前先把项目此刻所处的分支摆出来，基准分支选错的代价太高。 */}
          <small className="delivery-requirement-git-status">
            <span>{gitCurrentBranch ? t("delivery.requirement.gitCurrentBranch") : t("delivery.requirement.gitCurrentBranchDetached")}</span>
            {gitCurrentBranch ? <code className="manager-mono">{gitCurrentBranch}</code> : null}
          </small>
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
              // 补建走的是需求已有的那条分支，改名字就不是补建了。
              disabled={gitBranchFormMode === "subprojects"}
              value={gitBranch}
              placeholder={saved?.requirementKey
                ? t("delivery.requirement.gitBranchPlaceholder").replace("{key}", saved.requirementKey)
                : t("delivery.requirement.gitBranchPlaceholderUnsaved")}
              onChange={(event) => setGitBranch(event.target.value)}
            />
          </label>
          {gitBranchFormMode === "subprojects" ? null : <label>
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
          </label>}
          {/* 工作目录下的独立子工程：默认全勾，勾上的会用同一个分支名各建一条。 */}
          {gitSubprojects.length ? (
            <label>
              {t("delivery.requirement.gitSubprojectTargets")}
              <Checkbox.Group
                className="delivery-requirement-git-targets"
                value={gitBranchTargets}
                onChange={(values) => setGitBranchTargets(values as string[])}
                options={gitSubprojects.map((project) => ({
                  value: project.path,
                  disabled: !project.isGitRepository,
                  label: (
                    <span className="delivery-requirement-git-targets__item">
                      <b>{project.name}</b>
                      <code className="manager-mono">
                        {project.currentBranch || t("delivery.requirement.gitCurrentBranchDetached")}
                      </code>
                      {project.hasBranch ? <i>{t("delivery.requirement.gitSubprojectHasBranch")}</i> : null}
                    </span>
                  ),
                }))}
              />
              <small>{t("delivery.requirement.gitSubprojectTargetsHint")}</small>
            </label>
          ) : null}
          {/* 失败原因留在表单里，脏工作区还顺手给一个提交入口，不用退出去重新找。 */}
          {gitBranchError ? (
            <div className="delivery-requirement-git-error">
              <b>{t("delivery.requirement.gitBranchCreateFailed")}</b>
              <pre>{gitBranchError.detail}</pre>
              {gitBranchError.dirty ? (
                <>
                  <p>
                    {t("delivery.requirement.gitBranchCreateDirtyBranch")
                      .replace("{branch}", gitBranchError.branch || t("delivery.requirement.gitCurrentBranchDetached"))
                      .replace(
                        "{requirement}",
                        (() => {
                          const owner = requirementOfBranch(gitBranchError.branch);
                          return owner
                            ? `${owner.name || owner.requirementKey}（${owner.requirementKey}）`
                            : t("delivery.requirement.gitBranchCreateDirtyNoRequirement");
                        })(),
                      )}
                  </p>
                  <p>{t("delivery.requirement.gitBranchCreateDirtyHint").replace("{workspace}", getProjectWorkspace(programId) || "")}</p>
                  <Button
                    type="primary"
                    icon={<CloudUploadOutlined />}
                    disabled={!codexBridgeReady || !gitBranchError.branch}
                    onClick={() => openGitPush(gitBranchError.branch)}
                  >
                    {t("delivery.requirement.gitBranchCreateCommit")}
                  </Button>
                </>
              ) : null}
              <p>{t("delivery.requirement.gitBranchCreateRetryHint")}</p>
            </div>
          ) : null}
        </div>
      </Modal>

      {/* 「变更」点开后的文件级明细，读的是本机工作区，跟推送用的是同一份状态。 */}
      {projectGitEnabled && saved?.gitBranch ? (
        <DeliveryRequirementGitCheckModal
          requirement={gitCheckOpen ? saved : null}
          programId={programId}
          // 切子项目时弹窗里的现状要按那个工程读，不能拿根目录的状态糊弄。
          status={gitCheckProject ?? gitStatus}
          workspace={gitCheckWorkspace}
          projectName={gitCheckProject?.name ?? ""}
          statusError=""
          statusLoading={gitStatusRefreshing}
          onRefreshStatus={async () => {
            const catalog = await refreshGitProjects();
            if (!gitCheckWorkspace) return catalog.root;
            return catalog.subprojects.find((project) => project.workspace === gitCheckWorkspace) ?? null;
          }}
          onClose={() => {
            setGitCheckOpen(false);
            setGitCheckWorkspace("");
          }}
          onPrepared={() => {
            void refreshGitProjects();
          }}
        />
      ) : null}

      <DeliveryGitChangesModal
        open={gitChangesOpen}
        programId={programId}
        // 看子项目时标题上的分支要按那个工程当前所处的分支写，不能挂需求分支。
        branch={gitChangesProject ? gitChangesProject.currentBranch : saved?.gitBranch}
        workspace={gitChangesWorkspace}
        projectName={gitChangesProject?.name ?? ""}
        onClose={() => setGitChangesOpen(false)}
      />

      {/* 推送前让用户确认提交说明：这一步会把工作区改动整体提交到需求分支。 */}
      <Modal
        wrapClassName="manager-form-skin"
        open={gitPushOpen}
        destroyOnClose
        title={gitPushProject
          ? `${t("delivery.requirement.gitPush")} · ${gitPushProject.name}`
          : t("delivery.requirement.gitPush")}
        confirmLoading={gitPushing}
        onCancel={() => setGitPushOpen(false)}
        onOk={() => void pushGitBranch()}
        // 有人只想在本机留个提交点，别逼着他连远端一起推。
        footer={[
          <Button key="cancel" disabled={gitPushing} onClick={() => setGitPushOpen(false)}>
            {t("common.cancel")}
          </Button>,
          <Button key="commit" loading={gitPushing} onClick={() => void pushGitBranch(true)}>
            {t("delivery.requirement.gitCommitOnly")}
          </Button>,
          <Button key="push" type="primary" loading={gitPushing} onClick={() => void pushGitBranch()}>
            {t("delivery.requirement.gitPushConfirm")}
          </Button>,
        ]}
      >
        <div className="delivery-requirement-git-push">
          <p>{t("delivery.requirement.gitPushDescription").replace("{branch}", gitPushBranch || saved?.gitBranch || "")}</p>
          {/* 工作目录里还有别的 Git 工程时，让用户自己决定这一轮带上谁；单独推某个工程时不出现。 */}
          {!gitPushWorkspace && gitPushSubprojects.length ? (
            <label>
              {t("delivery.requirement.gitPushSubprojects")}
              <Checkbox.Group
                className="delivery-requirement-git-targets"
                value={gitPushTargets}
                onChange={(values) => setGitPushTargets(values as string[])}
                options={gitPushSubprojects.map((project) => ({
                  value: project.path,
                  // 游离 HEAD 没有可提交的分支，勾了也没处落。
                  disabled: !project.hasBranch && !project.currentBranch,
                  label: (
                    <span className="delivery-requirement-git-targets__item">
                      <b>{project.name}</b>
                      <code className="manager-mono">
                        {(project.hasBranch ? saved?.gitBranch : project.currentBranch)
                          || t("delivery.requirement.gitCurrentBranchDetached")}
                      </code>
                      <i className={project.changed ? "is-dirty" : "is-clean"}>
                        {project.changed
                          ? t("delivery.requirement.gitBranchPending").replace("{changed}", String(project.changed))
                          : t("delivery.requirement.gitBranchClean")}
                      </i>
                    </span>
                  ),
                }))}
              />
              <small>{t("delivery.requirement.gitPushSubprojectsHint")}</small>
            </label>
          ) : null}
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
