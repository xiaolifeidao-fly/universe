"use client";

import {
  ArrowRightOutlined,
	FastForwardOutlined,
  PlayCircleOutlined,
  DeploymentUnitOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Modal, Segmented, Select, Space, Spin, Switch, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyTextToClipboard } from "@/utils/clipboard";
import { useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import { getAuthUser } from "@/utils/auth";
import {
	DELIVERY_KINDS,
	DELIVERY_PHASES,
  DELIVERY_STATUSES,
  STATUS_COLORS,
  deleteRequirement,
	fetchProgramMembers,
  updateRequirementStatus,
  type BoardGroupBy,
  type DeliveryItemRecord,
  type DeliveryKind,
	type DeliveryOverview,
	type DeliveryPhase,
  type DeliveryRequirementRecord,
  type MemberRecord,
  type RequirementStatus,
  type DeliveryStatus,
} from "@/api/delivery.api";
import { useDeliveryBoard } from "../hooks/useDeliveryBoard";
import { DeliveryItemDrawer } from "./DeliveryItemDrawer";
import { DeliveryKanban } from "./DeliveryKanban";
import { DeliveryTaskSessionModal } from "./DeliveryTaskSessionModal";
import { DeliveryRequirementOutlineModal } from "./DeliveryTaskOutline";
import { DeliveryTaskDocumentModal } from "./DeliveryTaskDocument";
import { DeliveryRequirementList } from "./DeliveryRequirementList";
import { DeliveryRequirementAssignModal } from "./DeliveryRequirementAssignModal";
import { DeliveryRequirementGitCheckModal } from "./DeliveryRequirementGitCheckModal";
import { DeliveryRequirementSessionModal } from "./DeliveryRequirementSessionModal";
import { DeliveryRequirementTimelineDrawer } from "./DeliveryRequirementTimelineDrawer";
import { DeliveryOnboardingGuide } from "./DeliveryOnboardingGuide";
import { DeliveryGitWorkspaceBadge } from "./DeliveryGitWorkspaceBadge";

// 全景视角已经独立成「全景视图」菜单（/panorama），这里只留看板和列表。
type ViewMode = "board" | "list";
type PendingGroupedExecution =
  | { mode: "batch"; itemKeys: string[]; closeDrawer?: boolean }
  | { mode: "sequence"; itemKeys?: string[]; startItemKey?: string; closeDrawer?: boolean };

/** 消息中心或工作台跳过来要落到哪儿：看板 / 任务聊天 / 需求编辑 / 需求大纲。 */
type FocusMode = "board" | "detail" | "requirement" | "outline";

/** 消息中心跳转令牌的有效期：点一下到页面就位是秒级的，超过这个时间就当过期链接。 */
const FOCUS_TOKEN_TTL_MS = 30_000;

const BOARD_SCALE_MIN = 35;
const BOARD_SCALE_MAX = 100;
const BOARD_WHEEL_SCALE_FACTOR = 0.05;

export function DeliveryWorkspace() {
  const searchParams = useSearchParams();
  const { activeBusinessLine, businessLines, businessLinesLoaded, setActiveBusinessLine } = useBusinessLine();
  const { preferences } = useAIPreferences();
  const { t } = useLocale();
  const userId = getAuthUser()?.id ?? 0;
  const sharedRequirementKey = (searchParams?.get("requirementKey") ?? "").trim();
  const sharedProgramId = Number(searchParams?.get("programId")) || 0;
  const sharedBizLine = (searchParams?.get("bizLine") ?? "").trim();
  // 消息中心跳转带来的聚焦参数：可定位任务，也可只定位一条需求（完成批次通知）。
  const focusItemKey = (searchParams?.get("focusItemKey") ?? "").trim();
  const focusRequirementKey = (searchParams?.get("focusRequirementKey") ?? "").trim();
  const focusModeParam = (searchParams?.get("focusMode") ?? "board").trim();
  const focusMode: FocusMode = ["detail", "requirement", "outline"].includes(focusModeParam)
    ? focusModeParam as FocusMode
    : "board";
  // 令牌有两个作用：同一条任务连点两次也要重新聚焦；以及带时间戳，
  // 过期的链接（比如照着旧地址刷新页面）不再触发定位和弹窗。
  const focusToken = Number(searchParams?.get("focusToken")) || 0;
  const focusFresh = focusToken > 0 && Date.now() - focusToken < FOCUS_TOKEN_TTL_MS;
  const focusTarget = focusItemKey || focusRequirementKey;
  const focusSignature = focusTarget && focusFresh ? `${focusToken}:${sharedProgramId}:${focusTarget}` : "";
  // 工作台发起新需求时复用同一套时效令牌，避免用户刷新旧地址后反复弹出空白编辑器。
  const newRequirementToken = Number(searchParams?.get("newRequirementToken")) || 0;
  const newRequirementFresh = newRequirementToken > 0 && Date.now() - newRequirementToken < FOCUS_TOKEN_TTL_MS;
  const newRequirementSignature = newRequirementFresh && sharedProgramId ? `${newRequirementToken}:${sharedProgramId}` : "";

  // 分享链接明确写入业务线和项目，打开时不受接收者本地记忆的上下文影响。
  // 只在链接首次落地时对齐一次：地址栏里的 bizLine 会一直留着，若每次渲染都强行对齐，
  // 用户在顶部切换业务线会被立刻拉回分享链接里的那条，看起来就是“切换没作用”。
  const appliedSharedBizLineRef = useRef("");
  useEffect(() => {
    if (!sharedBizLine || !businessLinesLoaded) return;
    if (appliedSharedBizLineRef.current === sharedBizLine) return;
    // 业务线列表还没包含这条（无权限或编码已失效）时不记账，避免把一次有效对齐吞掉。
    if (!businessLines.some((line) => line.id === sharedBizLine)) return;
    appliedSharedBizLineRef.current = sharedBizLine;
    if (sharedBizLine !== activeBusinessLine.id) {
      setActiveBusinessLine(sharedBizLine);
    }
  }, [activeBusinessLine.id, businessLines, businessLinesLoaded, setActiveBusinessLine, sharedBizLine]);

  const {
    bizLine,
    programs,
		selectedProgram,
    programId,
    setProgramId,
    stages,
    modules,
    itemCatalog,
    requirements,
    requirementsLoading,
    requirementScope,
    setRequirementScope,
    requirementKeyword,
    setRequirementKeyword,
    sharedRequirementOnly,
    queryAllRequirements,
    refreshRequirements,
    refreshRequirement,
    board,
    allItems,
    filters,
    setFilters,
    loading,
    submitting,
    codexBridgeReady,
		gitWorkspaceStatus,
		gitWorkspaceError,
		gitWorkspaceLoading,
		refreshGitWorkspaceStatus,
    executingItemKey,
    batchStarting,
    sequenceStarting,
    refresh,
    refreshProjectStructure,
    patch,
    create,
    remove,
    advancePhase,
    executeWithCodex,
    executeBatchWithCodex,
    executeSequenceWithCodex,
    stageName,
    moduleName,
  } = useDeliveryBoard({
    programId: sharedProgramId,
    requirementKey: sharedRequirementKey,
  });

  const [view, setView] = useState<ViewMode>("board");
  const [requirementsExpanded, setRequirementsExpanded] = useState(false);
  const [showDependencyArrows, setShowDependencyArrows] = useState(true);
  const [boardScale, setBoardScale] = useState(100);
  const [keyword, setKeyword] = useState("");
  const [highlightedOwner, setHighlightedOwner] = useState("");
  const [members, setMembers] = useState<MemberRecord[]>([]);
	const [membersProgramId, setMembersProgramId] = useState(0);
  const [changingOwnerItemKey, setChangingOwnerItemKey] = useState("");
  const [editing, setEditing] = useState<DeliveryItemRecord | null>(null);
  const [sessionItem, setSessionItem] = useState<DeliveryItemRecord | null>(null);
  const [documentItem, setDocumentItem] = useState<DeliveryItemRecord | null>(null);
  const [outlineRequirement, setOutlineRequirement] = useState<DeliveryRequirementRecord | null>(null);
  const [startTaskTestingCases, setStartTaskTestingCases] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  // 快速指派用独立弹窗，不复用需求编辑窗口，避免为了改个负责人整条需求都进编辑态。
  const [assigningRequirement, setAssigningRequirement] = useState<DeliveryRequirementRecord | null>(null);
  // 新增需求时为 null，编辑需求时是那条需求；两种情况共用同一个弹窗。
  const [editingRequirement, setEditingRequirement] = useState<DeliveryRequirementRecord | null>(null);
  const [startRequirementTesting, setStartRequirementTesting] = useState(false);
	const [timelineRequirement, setTimelineRequirement] = useState<DeliveryRequirementRecord | null>(null);
	const [gitRequirement, setGitRequirement] = useState<DeliveryRequirementRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftModule, setDraftModule] = useState("");
  const [draftStage, setDraftStage] = useState("");
  const [draftKind, setDraftKind] = useState<DeliveryKind>("capability");
	const [draftBenefitTags, setDraftBenefitTags] = useState<string[]>([]);
  const [draftDependencies, setDraftDependencies] = useState<string[]>([]);
	const [selectedItemKeys, setSelectedItemKeys] = useState<string[]>([]);
  const [pendingGroupedExecution, setPendingGroupedExecution] = useState<PendingGroupedExecution | null>(null);
  const [executionConstraints, setExecutionConstraints] = useState("");
  const [onboardingWrittenRequirementKey, setOnboardingWrittenRequirementKey] = useState("");
  const [onboardingExecutionStartedVersion, setOnboardingExecutionStartedVersion] = useState(0);
  const taskPanelScrollRef = useRef<HTMLDivElement>(null);
  // 消息中心定位的任务：高亮 + 滚动到可视区，滚一次就够，不随后续渲染反复跳。
  const [focusedItemKey, setFocusedItemKey] = useState("");
  const appliedFocusRef = useRef("");
  const appliedNewRequirementRef = useRef("");
  // 待落地的定位放在 state 里而不是 ref：任务目录或需求列表可能本来就是现成的，
  // 用 ref 存的话这两个 effect 不会因为「有活要干」而重跑，弹窗就永远打不开。
  const [pendingFocus, setPendingFocus] = useState<{ itemKey: string; mode: FocusMode } | null>(null);
  // 跳转过来只带了需求：还要等需求清单到位，才知道它的起始阶段该落在哪个阶段页。
  const [pendingPhaseRequirementKey, setPendingPhaseRequirementKey] = useState("");
  const [pendingRequirementFocus, setPendingRequirementFocus] = useState<{
    requirementKey: string;
    action: "requirement" | "outline";
  } | null>(null);
  const scrolledFocusRef = useRef("");
  const boardScaleRef = useRef(boardScale);

  useEffect(() => {
    boardScaleRef.current = boardScale;
  }, [boardScale]);

  const setBoardScaleAtPointer = useCallback((nextScale: number, pointerX: number) => {
    const scroller = taskPanelScrollRef.current;
    const currentScale = boardScaleRef.current;
    const clampedScale = Math.round(Math.min(BOARD_SCALE_MAX, Math.max(BOARD_SCALE_MIN, nextScale)) * 10) / 10;
    if (!scroller || clampedScale === currentScale) return;

    // Keep the board position below the pointer stable while its real layout dimensions change.
    const logicalOffset = (scroller.scrollLeft + pointerX) / currentScale;
    boardScaleRef.current = clampedScale;
    setBoardScale(clampedScale);
    window.requestAnimationFrame(() => {
      scroller.scrollLeft = Math.max(0, logicalOffset * clampedScale - pointerX);
    });
  }, []);

  useEffect(() => {
    const scroller = taskPanelScrollRef.current;
    if (!scroller || view !== "board") return undefined;
    let previousGestureScale = 1;

    const handleWheel = (event: WheelEvent) => {
      // Chrome reports a trackpad pinch as ctrl+wheel; macOS mice use cmd+wheel.
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.deltaY === 0) return;

      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const pointerX = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
      const delta = event.deltaMode === 1 ? event.deltaY * 12 : event.deltaMode === 2 ? event.deltaY * rect.height : event.deltaY;
      setBoardScaleAtPointer(boardScaleRef.current - delta * BOARD_WHEEL_SCALE_FACTOR, pointerX);
    };

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      previousGestureScale = (event as Event & { scale?: number }).scale ?? 1;
    };

    const handleGestureChange = (event: Event) => {
      const gesture = event as Event & { scale?: number; clientX?: number };
      if (!gesture.scale || gesture.scale <= 0) return;

      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      const pointerX = Math.min(rect.width, Math.max(0, (gesture.clientX ?? rect.left + rect.width / 2) - rect.left));
      setBoardScaleAtPointer(boardScaleRef.current * (gesture.scale / previousGestureScale), pointerX);
      previousGestureScale = gesture.scale;
    };

    scroller.addEventListener("wheel", handleWheel, { passive: false });
    scroller.addEventListener("gesturestart", handleGestureStart, { passive: false });
    scroller.addEventListener("gesturechange", handleGestureChange, { passive: false });
    return () => {
      scroller.removeEventListener("wheel", handleWheel);
      scroller.removeEventListener("gesturestart", handleGestureStart);
      scroller.removeEventListener("gesturechange", handleGestureChange);
    };
  }, [setBoardScaleAtPointer, view]);

  // 分享页先选中链接中的需求；切到全量列表后保留用户自行选择的需求。
  useEffect(() => {
    if (!sharedRequirementKey || !sharedRequirementOnly) return;
    const requirement = requirements.find((item) => item.requirementKey === sharedRequirementKey);
    if (!requirement) return;
    setFilters((current) => {
      if (current.requirementKey === requirement.requirementKey && current.phase === requirement.startPhase) return current;
      return {
        ...current,
        requirementKey: requirement.requirementKey,
        phase: requirement.startPhase,
      };
    });
  }, [requirements, setFilters, sharedRequirementKey, sharedRequirementOnly]);

  const overview = board.overview;
  const ownerOptions = useMemo(
    () => Array.from(new Set(allItems.map((item) => item.ownerName.trim()).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .map((name) => ({ value: name, label: name })),
    [allItems],
  );
  const highlightedOwnerTaskCount = useMemo(
    () => highlightedOwner ? allItems.filter((item) => item.ownerName === highlightedOwner).length : 0,
    [allItems, highlightedOwner],
  );
	// 项目切换到候选接口返回之间，绝不能短暂复用上一个项目的成员。
	const projectMembers = membersProgramId === programId ? members : [];
  const taskOwnerOptions = useMemo(() => {
    const options = new Map<string, string>();
		projectMembers.forEach((member) => {
      const label = member.displayName || member.username || member.id;
      if (member.id) options.set(member.id, label);
    });
    return Array.from(options, ([value, label]) => ({ value, label }));
  }, [projectMembers]);
  const filterOwnerOptions = useMemo(
    () => Array.from(new Set(taskOwnerOptions.map((option) => option.label)))
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .map((name) => ({ value: name, label: name })),
    [taskOwnerOptions],
  );

  useEffect(() => {
    if (!programId) {
      setMembers([]);
		setMembersProgramId(0);
      return undefined;
    }
    let cancelled = false;
		setMembers([]);
		setMembersProgramId(0);
    fetchProgramMembers(programId)
      .then((list) => {
			if (!cancelled) {
				setMembers(list);
				setMembersProgramId(programId);
			}
      })
      .catch(() => {
        // 候选加载失败时不显示项目外人员；用户仍可查看其他字段。
        if (!cancelled) message.warning(t("delivery.ownerQuickAssign.membersFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [programId, t]);

  useEffect(() => {
    if (highlightedOwner && !ownerOptions.some((owner) => owner.value === highlightedOwner)) {
      setHighlightedOwner("");
    }
  }, [highlightedOwner, ownerOptions]);

  const buildKpis = useCallback(
    (summary: DeliveryOverview) => [
      { label: t("delivery.kpi.total"), value: summary.totalCount, tone: "var(--manager-text)" },
      {
        label: t("delivery.status.doing"),
        value: summary.statusCounts?.doing ?? 0,
        tone: STATUS_COLORS.doing,
      },
      {
        label: t("delivery.status.done"),
        value: summary.statusCounts?.done ?? 0,
        tone: STATUS_COLORS.done,
      },
      {
        label: t("delivery.status.blocked"),
        value: summary.statusCounts?.blocked ?? 0,
        tone: STATUS_COLORS.blocked,
      },
      {
        label: t("delivery.kpi.maturity"),
        value: `${summary.maturityScore ?? 0}%`,
        tone: "var(--manager-primary)",
        hint: t("delivery.kpi.maturityHint"),
      },
      {
        label: t("delivery.kpi.plain"),
        value: `${summary.plainProgress ?? 0}%`,
        tone: "var(--manager-text-faint)",
        hint: t("delivery.kpi.plainHint"),
      },
    ],
    [t],
  );
  const kpis = useMemo(() => buildKpis(overview), [buildKpis, overview]);
  const requirementKpis = useMemo(
    () => (board.requirementOverview ? buildKpis(board.requirementOverview) : []),
    [board.requirementOverview, buildKpis],
  );

  const handleMove = useCallback(async (items: DeliveryItemRecord[], columnKey: string, sortOrder: number) => {
    await Promise.all(items.map((item, index) => {
      const payload: Parameters<typeof patch>[0] = {
        itemKey: item.itemKey,
        version: item.version,
        sortOrder: sortOrder + index,
      };
      if (filters.groupBy === "stage") payload.stageKey = columnKey;
      if (filters.groupBy === "status") payload.status = columnKey as DeliveryStatus;
      if (filters.groupBy === "module") payload.moduleKey = columnKey;
      return patch(payload);
    }));
  }, [filters.groupBy, patch]);

  const handleOwnerChange = useCallback(
    async (item: DeliveryItemRecord, ownerId: string) => {
		const member = projectMembers.find((candidate) => candidate.id === ownerId);
      const ownerName = member ? (member.displayName || member.username || member.id) : "";
      if (!member && ownerId && !item.ownerId && ownerId === item.ownerName) return;
      if (item.ownerId === ownerId && item.ownerName === ownerName) return;

      setChangingOwnerItemKey(item.itemKey);
      try {
        const ok = await patch({
          itemKey: item.itemKey,
          version: item.version,
          ownerId,
          ownerName,
        });
        if (ok) message.success(t("delivery.ownerQuickAssign.updated"));
      } finally {
        setChangingOwnerItemKey("");
      }
    },
		[patch, projectMembers, t],
  );

  const handleCreateDependency = useCallback(
	async (predecessorItemKey: string, successorItemKey: string, sourceSide: "top" | "right" | "bottom" | "left", targetSide: "top" | "right" | "bottom" | "left") => {
      const successor = itemCatalog.find((item) => item.itemKey === successorItemKey);
      if (!successor || predecessorItemKey === successorItemKey) return;
      if (successor.dependsOnItemKeys.includes(predecessorItemKey)) {
        message.info(t("delivery.dependencies.duplicate"));
        return;
      }

      const ok = await patch({
        itemKey: successor.itemKey,
        version: successor.version,
		dependsOnItemKeys: [...successor.dependsOnItemKeys, predecessorItemKey].sort(),
		dependencySourceSides: { ...successor.dependencySourceSides, [predecessorItemKey]: sourceSide },
		dependencyTargetSides: { ...successor.dependencyTargetSides, [predecessorItemKey]: targetSide },
      });
      if (ok) message.success(t("delivery.dependencies.created"));
    },
    [itemCatalog, patch, t],
  );

  const handleDeleteDependency = useCallback(
    (predecessorItemKey: string, successorItemKey: string) => {
      const predecessor = itemCatalog.find((item) => item.itemKey === predecessorItemKey);
      const successor = itemCatalog.find((item) => item.itemKey === successorItemKey);
      if (!successor || !successor.dependsOnItemKeys.includes(predecessorItemKey)) return;

      Modal.confirm({
        title: t("delivery.dependencies.deleteConfirm"),
        content: (
          <div className="delivery-dependency-confirm">
            <span>
              <b>{predecessor?.title ?? predecessorItemKey}</b>
              <code>{predecessorItemKey}</code>
            </span>
            <ArrowRightOutlined />
            <span>
              <b>{successor.title}</b>
              <code>{successorItemKey}</code>
            </span>
          </div>
        ),
        okText: t("delivery.delete"),
        okButtonProps: { danger: true },
        onOk: async () => {
          const ok = await patch({
            itemKey: successor.itemKey,
            version: successor.version,
			dependsOnItemKeys: successor.dependsOnItemKeys.filter((itemKey) => itemKey !== predecessorItemKey),
			dependencySourceSides: Object.fromEntries(
				Object.entries(successor.dependencySourceSides).filter(([itemKey]) => itemKey !== predecessorItemKey),
			),
			dependencyTargetSides: Object.fromEntries(
              Object.entries(successor.dependencyTargetSides).filter(([itemKey]) => itemKey !== predecessorItemKey),
            ),
          });
          if (ok) message.success(t("delivery.dependencies.deleted"));
        },
      });
    },
    [itemCatalog, patch, t],
  );

  const handleCreate = async () => {
    if (!draftTitle.trim()) {
      message.warning(t("delivery.titleRequired"));
      return;
    }
		if (draftBenefitTags.length === 0) {
			message.warning(t("delivery.benefitTagsRequired"));
			return;
		}
    const ok = await create({
      title: draftTitle.trim(),
      moduleKey: draftModule || modules[0]?.moduleKey,
      stageKey: draftStage || stages[0]?.stageKey,
      // 需求列表选中哪条，手工建的任务就挂到哪条；没选就是不归属任何需求。
      requirementKey: filters.requirementKey,
      kind: draftKind,
		benefitTags: draftBenefitTags,
      status: "todo",
      dependsOnItemKeys: draftDependencies,
    });
    if (ok) {
      setCreateOpen(false);
      setDraftTitle("");
		setDraftBenefitTags([]);
      setDraftDependencies([]);
    }
  };

  const canExecute = useCallback(
    (item: DeliveryItemRecord) =>
      codexBridgeReady &&
			(item.status === "todo" || item.status === "blocked") &&
      item.dependsOnItemKeys.every(
						(itemKey) => itemCatalog.find((candidate) => candidate.itemKey === itemKey)?.status === "done",
      ),
    [codexBridgeReady, itemCatalog],
  );

  const handleExecute = useCallback(
    async (item: DeliveryItemRecord) => {
      try {
        const result = await executeWithCodex(item);
        message.success(t("delivery.execution.started").replace("{id}", result.threadId));
        setOnboardingExecutionStartedVersion((current) => current + 1);
        return true;
      } catch (error) {
        message.error((error as Error).message);
        return false;
      }
    },
    [executeWithCodex, t],
  );

  const handleExecuteSequence = useCallback(async (
    options: { itemKeys?: string[]; startItemKey?: string },
    constraints = "",
  ) => {
    try {
      const result = await executeSequenceWithCodex({ ...options, executionConstraints: constraints });
      setSelectedItemKeys([]);
      message.success(t("delivery.execution.sequenceStarted").replace("{count}", String(result.itemKeys.length)));
      setOnboardingExecutionStartedVersion((current) => current + 1);
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    }
  }, [executeSequenceWithCodex, t]);

	const selectedItems = useMemo(
		() => itemCatalog.filter((item) => selectedItemKeys.includes(item.itemKey)),
		[itemCatalog, selectedItemKeys],
	);

	const selectedExecutableItems = useMemo(
		() => selectedItems.filter((item) => item.status !== "done"),
		[selectedItems],
	);

	const selectedBatchItems = selectedExecutableItems;

	const selectedAdvanceableItems = useMemo(
		() => selectedItems.filter((item) => item.status === "done" && item.phase === filters.phase),
		[filters.phase, selectedItems],
	);

	const handleExecuteBatch = useCallback(async (itemKeys: string[], constraints = "") => {
		try {
			const result = await executeBatchWithCodex(itemKeys, constraints);
			setSelectedItemKeys((current) => current.filter((itemKey) => !result.itemKeys.includes(itemKey)));
			message.success(t("delivery.execution.batchStarted").replace("{count}", String(result.itemKeys.length)));
			setOnboardingExecutionStartedVersion((current) => current + 1);
			return true;
		} catch (error) {
			message.error((error as Error).message);
			return false;
		}
	}, [executeBatchWithCodex, t]);

  const openGroupedExecution = useCallback((execution: PendingGroupedExecution) => {
    setExecutionConstraints("");
    setPendingGroupedExecution(execution);
  }, [t]);

  const confirmGroupedExecution = useCallback(async () => {
    if (!pendingGroupedExecution) return;
    const constraints = executionConstraints.trim();
    const ok = pendingGroupedExecution.mode === "batch"
      ? await handleExecuteBatch(pendingGroupedExecution.itemKeys, constraints)
      : await handleExecuteSequence(
        {
          itemKeys: pendingGroupedExecution.itemKeys,
          startItemKey: pendingGroupedExecution.startItemKey,
        },
        constraints,
      );
    if (!ok) return;
    if (pendingGroupedExecution.closeDrawer) setEditing(null);
    setPendingGroupedExecution(null);
    setExecutionConstraints("");
  }, [executionConstraints, handleExecuteBatch, handleExecuteSequence, pendingGroupedExecution]);

	const handleAdvance = useCallback(async (
		phase: "requirement" | "development",
		items: DeliveryItemRecord[],
	) => {
		const ok = await advancePhase(phase, items.map((item) => ({ itemKey: item.itemKey, version: item.version })));
		if (ok) {
			setSelectedItemKeys([]);
			message.success(t("delivery.phase.advanced"));
		}
		return ok;
		}, [advancePhase, t]);

  const handleSessionChanged = useCallback(async () => {
    await Promise.all([refresh(), refreshProjectStructure(), refreshRequirements()]);
  }, [refresh, refreshProjectStructure, refreshRequirements]);

  /**
   * 需求创建/编辑窗口关闭后，刷新这条需求本身与右侧任务面板：
   * 弹窗里可能改过需求属性、写入或调整任务，关闭时需要让列表和看板跟上。
   */
  const handleRequirementModalClosed = useCallback(async () => {
    const requirementKey = editingRequirement?.requirementKey;
    await Promise.all([
      requirementKey ? refreshRequirement(requirementKey) : refreshRequirements(),
      refresh(),
    ]);
  }, [editingRequirement?.requirementKey, refresh, refreshRequirement, refreshRequirements]);

  // 需求的起始阶段是任务面板的权威筛选起点。选中需求时一并切换，
  // 简易模式的任务便会直接落在「动作执行」，不再停留在默认的「梳理需求」。
  const handleRequirementSelect = useCallback((requirementKey: string) => {
    const selectedRequirementKey = sharedRequirementOnly ? sharedRequirementKey : requirementKey;
    const requirement = requirements.find((item) => item.requirementKey === selectedRequirementKey);
    const nextPhase = requirement?.startPhase ?? filters.phase;
    // 点的还是当前这条需求时筛选条件没有变化，拉取任务的副作用不会重跑，得手动补一次。
    const filtersUnchanged = (filters.requirementKey ?? "") === selectedRequirementKey && filters.phase === nextPhase;
    setSelectedItemKeys([]);
    // 手动换需求就说明消息中心那次定位结束了，别再留着高亮。
    setFocusedItemKey("");
    setFilters((current) => ({
      ...current,
      requirementKey: selectedRequirementKey || undefined,
      phase: requirement?.startPhase ?? current.phase,
    }));
    if (selectedRequirementKey && filtersUnchanged) void refresh();
  }, [filters.phase, filters.requirementKey, refresh, requirements, setFilters, sharedRequirementKey, sharedRequirementOnly]);

  // 第一步：项目切到位后先选中需求，任务目录随之按需求加载。
  useEffect(() => {
    if (!focusSignature || appliedFocusRef.current === focusSignature) return;
    if (!programId || (sharedProgramId && programId !== sharedProgramId)) return;
    appliedFocusRef.current = focusSignature;
    setPendingFocus(focusItemKey ? { itemKey: focusItemKey, mode: focusMode } : null);
    // 带任务的跳转由 pendingFocus 按任务自身阶段切页，这里只管「只给了需求」的情况。
    // 需求清单已经在手上就直接取起始阶段，只有还没加载到才挂起等下面那个 effect 补。
    const focusedRequirement = focusItemKey || !focusRequirementKey
      ? undefined
      : requirements.find((record) => record.requirementKey === focusRequirementKey);
    setPendingPhaseRequirementKey(!focusItemKey && focusRequirementKey && !focusedRequirement ? focusRequirementKey : "");
    setPendingRequirementFocus(
      focusRequirementKey && (focusMode === "requirement" || focusMode === "outline")
        ? { requirementKey: focusRequirementKey, action: focusMode }
        : null,
    );
    scrolledFocusRef.current = "";
    setFocusedItemKey(focusItemKey);
    setView("board");
    setRequirementsExpanded(false);
    setSelectedItemKeys([]);
    // 左侧列表可能还停在「只看我的」或某个关键词上，先恢复全量，跳过来的需求才一定在列表里。
    queryAllRequirements();
    // 需求和阶段一次性设进筛选条件：拉取任务的副作用只会因此跑一遍，
    // 不再出现「先按默认阶段拉一次、切完阶段又拉一次」的双重刷新。
    if (focusRequirementKey) {
      setFilters((current) => ({
        ...current,
        requirementKey: focusRequirementKey,
        phase: focusedRequirement?.startPhase || current.phase,
      }));
    }

    // 定位是一次性的：参数留在地址栏里，刷新页面会再弹一次需求编辑窗口。
    // 用 history.replaceState 就地抹掉（保留 programId），不触发路由跳转。
    const url = new URL(window.location.href);
    for (const key of ["focusItemKey", "focusRequirementKey", "focusMode", "focusToken"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [
    focusItemKey,
    focusMode,
    focusRequirementKey,
    focusSignature,
    programId,
    queryAllRequirements,
    requirements,
    setFilters,
    sharedProgramId,
  ]);

  // 工作台已先选好项目，到达看板并确认项目上下文后直接打开空白需求编辑器。
  useEffect(() => {
    if (!newRequirementSignature || appliedNewRequirementRef.current === newRequirementSignature) return;
    if (!programId || programId !== sharedProgramId || !selectedProgram) return;
    appliedNewRequirementRef.current = newRequirementSignature;
    setRequirementsExpanded(true);
    setEditingRequirement(null);
    setStartRequirementTesting(false);
    setPlanningOpen(true);

    const url = new URL(window.location.href);
    url.searchParams.delete("newRequirementToken");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [newRequirementSignature, programId, selectedProgram, sharedProgramId]);

  /**
   * 跳转时需求清单还没加载完的兜底：等它到位后把阶段切到这条需求的起始阶段。
   * 否则看板停在默认的「梳理需求」，任务都在开发阶段就会显示为空，只能靠用户自己再点刷新。
   * 阶段没变就什么都不做，避免多发一次没有意义的请求。
   */
  useEffect(() => {
    if (!pendingPhaseRequirementKey) return;
    const requirement = requirements.find((record) => record.requirementKey === pendingPhaseRequirementKey);
    if (!requirement) return;
    setPendingPhaseRequirementKey("");
    const nextPhase = requirement.startPhase;
    if (!nextPhase) return;
    setFilters((current) => (current.phase === nextPhase ? current : { ...current, phase: nextPhase }));
  }, [pendingPhaseRequirementKey, requirements, setFilters]);

  // 第二步：任务目录到位后，把看板阶段切到这条任务所在的阶段；要看详情的直接开聊天。
  useEffect(() => {
    if (!pendingFocus) return;
    const item = itemCatalog.find((record) => record.itemKey === pendingFocus.itemKey);
    if (!item) {
      // 目录已经按这条需求加载完却没有这条任务：它多半被删了，别把定位一直挂着。
      if (itemCatalog.length) {
        setPendingFocus(null);
        setFocusedItemKey("");
      }
      return;
    }
    setPendingFocus(null);
    setFilters((current) => (current.phase === item.phase ? current : { ...current, phase: item.phase }));
    if (pendingFocus.mode === "detail") setSessionItem(item);
  }, [itemCatalog, pendingFocus, setFilters]);

  // 从消息中心或待我处理工作台点进来：需求加载好后直接打开编辑窗或大纲。
  useEffect(() => {
    if (!pendingRequirementFocus) return;
    const requirement = requirements.find((record) => record.requirementKey === pendingRequirementFocus.requirementKey);
    if (!requirement) return;
    setPendingRequirementFocus(null);
    if (pendingRequirementFocus.action === "outline") {
      setOutlineRequirement(requirement);
    } else {
      setEditingRequirement(requirement);
      setPlanningOpen(true);
    }
  }, [pendingRequirementFocus, requirements]);

  // 第三步：卡片渲染出来后把它挪到看板正中间，横向纵向都自己算。
  //
  // 这里不用 scrollIntoView：它会一路把所有可滚动祖先都滚一遍，卡片经常停在容器边缘而不是正中，
  // 依赖连线和卡片高度也还在变。自己按容器矩形算目标位置，只滚任务面板这一层。
  useEffect(() => {
    if (!focusedItemKey || pendingFocus || scrolledFocusRef.current === focusedItemKey) return;
    if (view !== "board" || loading) return;
    const scroller = taskPanelScrollRef.current;
    const card = scroller?.querySelector<HTMLElement>(`[data-delivery-item-key="${CSS.escape(focusedItemKey)}"]`);
    if (!scroller || !card) return;
    scrolledFocusRef.current = focusedItemKey;

    const centerFocusedCard = () => {
      const cardRect = card.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
      scroller.scrollTo({
        left: clamp(
          scroller.scrollLeft + (cardRect.left - scrollerRect.left) - (scroller.clientWidth - cardRect.width) / 2,
          scroller.scrollWidth - scroller.clientWidth,
        ),
        top: clamp(
          scroller.scrollTop + (cardRect.top - scrollerRect.top) - (scroller.clientHeight - cardRect.height) / 2,
          scroller.scrollHeight - scroller.clientHeight,
        ),
        behavior: "smooth",
      });
    };
    // 等这一帧的布局落定再量，否则量到的是依赖连线铺开之前的位置。
    const frame = window.requestAnimationFrame(centerFocusedCard);

    // 左侧需求栏是另一个滚动容器，单独把选中的需求卡片带进可视区，不牵动任务面板。
    const requirementCard = document.querySelector<HTMLElement>(
      `[data-delivery-requirement-key="${CSS.escape(filters.requirementKey ?? "")}"]`,
    );
    const requirementList = requirementCard?.closest<HTMLElement>(".delivery-requirement-rail__list");
    if (requirementCard && requirementList) {
      const cardRect = requirementCard.getBoundingClientRect();
      const listRect = requirementList.getBoundingClientRect();
      if (cardRect.top < listRect.top || cardRect.bottom > listRect.bottom) {
        requirementList.scrollTo({
          top: Math.max(0, requirementList.scrollTop + (cardRect.top - listRect.top) - 12),
          behavior: "smooth",
        });
      }
    }

    return () => window.cancelAnimationFrame(frame);
  }, [allItems, filters.requirementKey, focusedItemKey, loading, pendingFocus, view]);

  // 重置只影响左侧需求查询；恢复全部需求，当前任务看板保持不动。
  const handleResetRequirementQuery = useCallback(() => {
    queryAllRequirements();
  }, [queryAllRequirements]);

  const handleShareRequirement = useCallback(async (requirement: DeliveryRequirementRecord) => {
    const link = new URL(window.location.href);
    link.search = "";
    link.searchParams.set("bizLine", activeBusinessLine.id);
    link.searchParams.set("programId", String(requirement.programId));
    link.searchParams.set("requirementKey", requirement.requirementKey);
    try {
			await copyTextToClipboard(link.toString());
      message.success(t("delivery.requirement.shareLinkCopied"));
    } catch {
      message.error(t("delivery.requirement.shareLinkCopyFailed"));
    }
  }, [activeBusinessLine.id, t]);

  const handleDeleteRequirement = useCallback(async (requirementKey: string) => {
    // 兜底再判一次：列表已禁用按钮，但工作区状态可能在弹窗打开期间才变脏。
    const target = requirements.find((item) => item.requirementKey === requirementKey);
    if (
      selectedProgram?.gitEnabled
      && target?.gitEnabled
      && target.gitBranch
      && gitWorkspaceStatus
      && !gitWorkspaceStatus.detached
      && gitWorkspaceStatus.currentBranch === target.gitBranch
      && gitWorkspaceStatus.dirty
    ) {
      message.warning(t("delivery.requirement.deleteBlockedDirty"));
      return;
    }
    try {
      await deleteRequirement(programId, requirementKey);
      // 需求没了但任务还在看板上，选中的筛选条件要一并清掉。
      if (filters.requirementKey === requirementKey) setFilters({ ...filters, requirementKey: undefined });
      await Promise.all([refreshRequirements(), refresh()]);
      message.success(t("delivery.requirement.deleted"));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [filters, gitWorkspaceStatus, programId, refresh, refreshRequirements, requirements, selectedProgram?.gitEnabled, setFilters, t]);

  /**
   * 快速改状态只提交状态字段。早先这里走的是整条需求保存，
   * 请求里没带计划起止时间，改一次状态就把排期清空了。
   */
  const handleRequirementStatusChange = useCallback(async (
    requirement: DeliveryRequirementRecord,
    status: RequirementStatus,
  ) => {
    if (!programId || requirement.status === status) return;
    try {
      await updateRequirementStatus(programId, requirement.requirementKey, status, requirement.version);
      await Promise.all([refreshRequirement(requirement.requirementKey), refresh()]);
      message.success(t("delivery.requirement.statusUpdated"));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [programId, refresh, refreshRequirement, t]);

	const openGitCheck = useCallback((requirement: DeliveryRequirementRecord) => {
		if (!selectedProgram?.gitEnabled) return;
		setGitRequirement(requirement);
	}, [selectedProgram?.gitEnabled]);

  const columns: ColumnsType<DeliveryItemRecord> = [
    {
      title: t("delivery.field.title"),
      dataIndex: "title",
      render: (_, record) => (
        <div className="delivery-table-title">
          <div>
            <b>{record.title}</b>
						{record.benefitTags.length ? <div className="delivery-benefit-tags">{record.benefitTags.map((tag) => <Tag color="gold" key={tag}>{tag}</Tag>)}</div> : null}
          </div>
          <Tooltip title={t("delivery.session.viewTask")}>
            <Button
              size="small"
              shape="circle"
              icon={<MessageOutlined />}
              aria-label={t("delivery.session.viewTask")}
              onClick={(event) => {
                event.stopPropagation();
                setStartTaskTestingCases(false);
                setSessionItem(record);
              }}
            />
          </Tooltip>
        </div>
      ),
    },
    {
      title: t("delivery.field.moduleKey"),
      dataIndex: "moduleKey",
      width: 160,
      render: (value: string) => moduleName(value),
    },
    {
      title: t("delivery.field.stageKey"),
      dataIndex: "stageKey",
      width: 110,
      render: (value: string) => stageName(value),
    },
    {
      title: t("delivery.field.status"),
      dataIndex: "status",
      width: 110,
      render: (value: DeliveryStatus) => (
        <Tag color={STATUS_COLORS[value]} style={{ borderRadius: 20 }}>
          {t(`delivery.status.${value}`)}
        </Tag>
      ),
    },
    {
      title: t("delivery.field.createdAt"),
      dataIndex: "createdAt",
      width: 150,
      render: (value?: string) => (value ? dayjs(value).format("YYYY-MM-DD HH:mm") : t("delivery.empty")),
    },
    {
      title: t("delivery.field.dependsOnItemKeys"),
      dataIndex: "dependsOnItemKeys",
      width: 210,
      render: (value: string[]) =>
        value.length > 0
          ? value.map((itemKey) => itemCatalog.find((candidate) => candidate.itemKey === itemKey)?.title ?? itemKey).join("、")
          : t("delivery.empty"),
    },
    {
      title: t("delivery.field.progress"),
      dataIndex: "progress",
      width: 150,
      render: (value: number, record) => (
        <div className="delivery-card-rail" style={{ ["--card-accent" as string]: STATUS_COLORS[record.status] }}>
          <i style={{ width: `${value}%` }} />
        </div>
      ),
    },
    {
      title: t("delivery.field.ownerName"),
      dataIndex: "ownerName",
      width: 180,
      render: (_value: string, record) => (
        <Select
          allowClear
          showSearch
          size="small"
          className="delivery-table-owner-select"
          optionFilterProp="label"
          value={record.ownerId || record.ownerName || undefined}
          placeholder={t("delivery.unassigned")}
          options={taskOwnerOptions}
          loading={changingOwnerItemKey === record.itemKey}
          disabled={changingOwnerItemKey === record.itemKey}
          aria-label={t("delivery.field.ownerName")}
          onClick={(event) => event.stopPropagation()}
          onChange={(value) => void handleOwnerChange(record, value ?? "")}
        />
      ),
    },
    { title: t("delivery.field.dueDate"), dataIndex: "dueDate", width: 120 },
  ];

  return (
    <div className="manager-page-stack manager-delivery">
      <div className="manager-page-heading">
        <div>
          <span className="manager-section-label">DELIVERY BOARD</span>
          <div className="delivery-heading-title-row">
            <h1>{overview.name || t("delivery.title")}</h1>
            <div className="delivery-kpi-inline">
              {kpis.map((kpi) => (
                <Tooltip title={kpi.hint} key={kpi.label}>
                  <span className="delivery-kpi-inline__item">
                    {kpi.label}
                    <b style={{ color: kpi.tone }}>{kpi.value}</b>
                  </span>
                </Tooltip>
              ))}
            </div>
          </div>
          <DeliveryGitWorkspaceBadge
            enabled={Boolean(selectedProgram?.gitEnabled)}
            programName={selectedProgram?.name ?? ""}
            status={gitWorkspaceStatus}
            error={gitWorkspaceError}
            loading={gitWorkspaceLoading}
            onRefresh={() => void refreshGitWorkspaceStatus()}
          />
          {filters.requirementKey && board.requirementOverview ? (
            <div className="delivery-requirement-kpi-line">
              <span className="delivery-requirement-kpi-line__label">{t("delivery.kpi.requirementProgress")}</span>
              <div className="delivery-kpi-inline">
                {requirementKpis.map((kpi) => (
                  <Tooltip title={kpi.hint} key={kpi.label}>
                    <span className="delivery-kpi-inline__item">
                      {kpi.label}
                      <b style={{ color: kpi.tone }}>{kpi.value}</b>
                    </span>
                  </Tooltip>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <Space>
          <DeliveryOnboardingGuide
            enabled={Boolean(userId) && !sharedRequirementKey}
            userId={userId}
            programId={programId}
            activeRequirementKey={editingRequirement?.requirementKey ?? ""}
            writtenRequirementKey={onboardingWrittenRequirementKey}
            executionStartedVersion={onboardingExecutionStartedVersion}
            onOpenRequirement={(requirementKey) => {
              if (!programId) return;
              setRequirementsExpanded(true);
              setEditingRequirement(requirementKey ? requirements.find((item) => item.requirementKey === requirementKey) ?? null : null);
              setPlanningOpen(true);
            }}
            onShowTasks={(requirementKey) => {
              if (!requirementKey) return;
              setRequirementsExpanded(false);
              handleRequirementSelect(requirementKey);
            }}
          />
          <Select
            value={programId || undefined}
            style={{ minWidth: 180 }}
            placeholder={t("delivery.selectProgram")}
            disabled={Boolean(sharedRequirementKey)}
            onChange={setProgramId}
            options={programs.map((program) => ({ value: program.programId, label: program.name || program.programId }))}
          />
          {/* 没选项目时这些动作没有意义：programId 为空发出去，服务端只会回一句「缺少项目标识」。 */}
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!programId}
            onClick={() => void refresh()}
          />
          {/* 新增需求只留需求列表栏里的那个入口，顶部不再重复一个。 */}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!programId}
            onClick={() => setCreateOpen(true)}
          >
            {t("delivery.newItem")}
          </Button>
        </Space>
      </div>

      <div className={`delivery-requirement-layout${requirementsExpanded ? " is-requirements-expanded" : ""}`}>
        <DeliveryRequirementList
          requirements={requirements}
          loading={requirementsLoading}
          programName={programs.find((program) => program.programId === programId)?.name ?? String(programId)}
          selectedKey={filters.requirementKey ?? ""}
          scope={requirementScope}
          keyword={requirementKeyword}
          disabled={!programId}
          expanded={requirementsExpanded}
          stageName={stageName}
          moduleName={moduleName}
          stages={stages}
          modules={modules}
          onScopeChange={setRequirementScope}
          onKeywordChange={setRequirementKeyword}
          onExpandedChange={setRequirementsExpanded}
          onSelect={handleRequirementSelect}
          onResetQuery={handleResetRequirementQuery}
          onShare={handleShareRequirement}
          onCreate={() => {
            setEditingRequirement(null);
            setPlanningOpen(true);
          }}
          onEdit={(requirement) => {
            setEditingRequirement(requirement);
            setPlanningOpen(true);
          }}
          onAssign={(requirement) => setAssigningRequirement(requirement)}
          onTest={(requirement) => {
            setEditingRequirement(requirement);
            setStartRequirementTesting(true);
            setPlanningOpen(true);
          }}
		  onOutline={setOutlineRequirement}
		  onTimeline={setTimelineRequirement}
		  projectGitEnabled={Boolean(selectedProgram?.gitEnabled)}
		  onGitCheck={openGitCheck}
		  gitWorkspaceStatus={gitWorkspaceStatus}
		  gitWorkspaceError={gitWorkspaceError}
		  gitWorkspaceLoading={gitWorkspaceLoading}
          onStatusChange={handleRequirementStatusChange}
          onDelete={(requirementKey) => void handleDeleteRequirement(requirementKey)}
        />
        <div className="delivery-requirement-layout__main">
          <div className="delivery-toolbar">
    		<Tooltip title={t("delivery.execution.batchHint")}>
    			<Button
    				icon={<PlayCircleOutlined />}
    				loading={batchStarting}
    				disabled={!codexBridgeReady || selectedBatchItems.length === 0}
				onClick={() => openGroupedExecution({
              mode: "batch",
              itemKeys: selectedBatchItems.map((item) => item.itemKey),
            })}
    			>
    				{t("delivery.execution.batchSelected").replace("{count}", String(selectedBatchItems.length))}
    			</Button>
    		</Tooltip>
            <Tooltip title={t("delivery.execution.sequenceHint")}>
              <Button
                icon={<FastForwardOutlined />}
                loading={sequenceStarting}
                disabled={!codexBridgeReady || selectedExecutableItems.length === 0}
                onClick={() => openGroupedExecution({
                  mode: "sequence",
                  itemKeys: selectedExecutableItems.map((item) => item.itemKey),
                })}
              >
                {t("delivery.execution.sequenceSelected").replace("{count}", String(selectedExecutableItems.length))}
              </Button>
            </Tooltip>
            <Segmented
              value={view}
              onChange={(value) => setView(value as ViewMode)}
              options={[
                { label: t("delivery.view.board"), value: "board" },
                { label: t("delivery.view.list"), value: "list" },
              ]}
            />
            {view === "board" ? (
              <Segmented
                value={filters.groupBy}
                onChange={(value) => {
                  const groupBy = value as BoardGroupBy;
    				setSelectedItemKeys([]);
                  setFilters({
                    ...filters,
                    groupBy,
                    phase: groupBy === "stage" || groupBy === "status"
                      ? filters.phase ?? "requirement"
                      : undefined,
                  });
                }}
                options={[
                  { label: t("delivery.groupBy.stage"), value: "stage" },
                  { label: t("delivery.groupBy.status"), value: "status" },
                  { label: t("delivery.groupBy.module"), value: "module" },
                ]}
              />
            ) : null}
            {view === "board" && (filters.groupBy === "stage" || filters.groupBy === "status") ? (
    			<>
    				<Segmented
    					value={filters.phase ?? "requirement"}
    					onChange={(value) => { setSelectedItemKeys([]); setFilters({ ...filters, phase: value as DeliveryPhase }); }}
    					options={DELIVERY_PHASES.map((phase) => ({ value: phase, label: t(`delivery.phase.${phase}`) }))}
    				/>
    				{filters.groupBy === "status" && (filters.phase ?? "requirement") !== "testing" ? (
    					<Button
    						icon={<FastForwardOutlined />}
    						disabled={selectedAdvanceableItems.length === 0 || submitting}
    						onClick={() => void handleAdvance(filters.phase === "development" ? "development" : "requirement", selectedAdvanceableItems)}
    					>
    						{t("delivery.phase.advanceSelected").replace("{count}", String(selectedAdvanceableItems.length))}
    					</Button>
    				) : null}
    			</>
            ) : null}
            {view === "board" ? (
              <label className="delivery-dependency-toggle">
                <DeploymentUnitOutlined />
                <span>{t("delivery.dependencies.lines")}</span>
                <Switch size="small" checked={showDependencyArrows} onChange={setShowDependencyArrows} />
              </label>
            ) : null}
            {view === "board" && filters.groupBy === "status" ? (
              <Select
                allowClear
                style={{ minWidth: 150 }}
                placeholder={t("delivery.filter.stage")}
                value={filters.stageKey}
                onChange={(value) => setFilters({ ...filters, stageKey: value })}
                options={stages.map((stage) => ({ value: stage.stageKey, label: stage.tag }))}
              />
            ) : null}
            <Select
              allowClear
              style={{ minWidth: 150 }}
              placeholder={t("delivery.filter.module")}
              value={filters.moduleKey}
              onChange={(value) => setFilters({ ...filters, moduleKey: value })}
              options={modules.map((module) => ({ value: module.moduleKey, label: module.name }))}
            />
            <Select
              allowClear
              style={{ minWidth: 130 }}
              placeholder={t("delivery.filter.status")}
              value={filters.status}
              onChange={(value) => setFilters({ ...filters, status: value })}
              options={DELIVERY_STATUSES.map((status) => ({ value: status, label: t(`delivery.status.${status}`) }))}
            />
            <Select
              allowClear
              style={{ minWidth: 130 }}
              placeholder={t("delivery.filter.kind")}
              value={filters.kind}
              onChange={(value) => setFilters({ ...filters, kind: value })}
              options={DELIVERY_KINDS.map((kind) => ({ value: kind, label: t(`delivery.kind.${kind}`) }))}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 150 }}
              placeholder={t("delivery.filter.owner")}
              value={filters.ownerName}
              onChange={(value) => setFilters({ ...filters, ownerName: value })}
              options={filterOwnerOptions}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              className="delivery-owner-highlight-select"
              placeholder={t("delivery.ownerHighlight.placeholder")}
              value={highlightedOwner || undefined}
              suffixIcon={<UserOutlined />}
              onChange={(value) => setHighlightedOwner(value ?? "")}
              options={ownerOptions}
            />
            {highlightedOwner ? (
              <Tag className="delivery-owner-highlight-count" color="green">
                {t("delivery.ownerHighlight.count").replace("{count}", String(highlightedOwnerTaskCount))}
              </Tag>
            ) : null}
            <Input
              allowClear
              style={{ maxWidth: 220 }}
              prefix={<SearchOutlined />}
              placeholder={t("delivery.filter.keyword")}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onPressEnter={() => setFilters({ ...filters, keyword })}
              onBlur={() => setFilters({ ...filters, keyword })}
            />
          </div>
          <div className="delivery-task-panel-scroll" ref={taskPanelScrollRef}>
            <Spin spinning={loading}>
              {!programId ? (
                <Empty description={t("delivery.noProgram")} />
              ) : !filters.requirementKey ? (
                <Empty description={t("delivery.requirement.selectToViewTasks")} />
              ) : view === "board" ? (
                <DeliveryKanban
                  focusedItemKey={focusedItemKey}
                  groupBy={filters.groupBy}
                  columns={board.columns}
                  boardScale={boardScale}
                  moduleName={moduleName}
                  stageName={stageName}
                  showDependencies={showDependencyArrows}
                  onOpen={setEditing}
      				onOpenSession={setSessionItem}
                  onOpenDocument={setDocumentItem}
                  onExecute={(item) => void handleExecute(item)}
                  canExecute={canExecute}
                  executingItemKey={executingItemKey}
				  highlightedOwner={highlightedOwner}
				  ownerOptions={taskOwnerOptions}
				  changingOwnerItemKey={changingOwnerItemKey}
				  onOwnerChange={(item, ownerId) => void handleOwnerChange(item, ownerId)}
                  selectedItemKeys={selectedItemKeys}
      				onSelectionChange={setSelectedItemKeys}
                  onMove={handleMove}
                  onCreateDependency={handleCreateDependency}
                  onDeleteDependency={handleDeleteDependency}
                />
              ) : (
                <div className="manager-data-card">
                  <Table
                    rowKey="itemKey"
                    size="middle"
                    columns={columns}
                    dataSource={allItems}
                    rowSelection={{
                      selectedRowKeys: selectedItemKeys,
                      getCheckboxProps: () => ({ disabled: false }),
                      onChange: (keys) => setSelectedItemKeys(keys.map(String)),
                    }}
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    rowClassName={(record) => record.ownerName === highlightedOwner && highlightedOwner ? "delivery-owner-highlight-row" : ""}
                    onRow={(record) => ({ onClick: () => setEditing(record) })}
                  />
                </div>
              )}
            </Spin>
          </div>
        </div>
      </div>

      <DeliveryItemDrawer
        open={Boolean(editing)}
        item={editing}
        bizLine={bizLine}
        programId={programId}
        stages={stages}
        modules={modules}
        items={itemCatalog}
        ownerOptions={taskOwnerOptions}
        submitting={submitting}
        codexBridgeReady={codexBridgeReady}
        executing={editing?.itemKey === executingItemKey}
        onClose={() => setEditing(null)}
        onSave={patch}
        onExecute={handleExecute}
        onOpenTestingCasesChat={(item, startNewConversation = false) => {
          setEditing(null);
          setStartTaskTestingCases(startNewConversation);
          setSessionItem(item);
        }}
        onExecuteFollowing={(item) => {
          openGroupedExecution({ mode: "sequence", startItemKey: item.itemKey, closeDrawer: true });
          return Promise.resolve(false);
        }}
        onDelete={remove}
			onAdvancePhase={(phase, item) => handleAdvance(phase, [item])}
      />

      <DeliveryTaskSessionModal
        open={Boolean(sessionItem)}
        item={sessionItem}
        programId={programId}
        bizLine={bizLine}
        requirements={requirements}
        itemCatalog={itemCatalog}
        codexBridgeReady={codexBridgeReady}
        startTestingCasesOnOpen={startTaskTestingCases}
        onClose={() => {
          setSessionItem(null);
          setStartTaskTestingCases(false);
        }}
        onOpenEditor={(next) => {
          setSessionItem(null);
          setStartTaskTestingCases(false);
          setEditing(next);
        }}
        onChanged={handleSessionChanged}
      />

      <DeliveryTaskDocumentModal
        open={Boolean(documentItem)}
        programId={programId}
        item={documentItem}
        codexBridgeReady={codexBridgeReady}
        onClose={() => setDocumentItem(null)}
      />

      <DeliveryRequirementOutlineModal
        open={Boolean(outlineRequirement)}
        programId={programId}
        requirement={outlineRequirement}
        codexBridgeReady={codexBridgeReady}
        onClose={() => setOutlineRequirement(null)}
      />

      <DeliveryRequirementSessionModal
        open={planningOpen}
        requirement={editingRequirement}
		programId={programId}
		programName={programs.find((program) => program.programId === programId)?.name ?? ""}
		projectGitEnabled={Boolean(selectedProgram?.gitEnabled)}
		projectGitBaseBranch={selectedProgram?.gitBaseBranch ?? ""}
        bizLine={bizLine}
        stages={stages}
        modules={modules}
        itemCatalog={itemCatalog}
        requirements={requirements}
        codexBridgeReady={codexBridgeReady}
        startTestingOnOpen={startRequirementTesting}
        onClose={() => {
          setPlanningOpen(false);
          setStartRequirementTesting(false);
          void handleRequirementModalClosed();
        }}
        onOpenItem={(item) => {
          setPlanningOpen(false);
          setStartRequirementTesting(false);
          setEditing(item);
        }}
        onDeleteItem={remove}
        onShare={handleShareRequirement}
        onRequirementSaved={(requirement) => {
          setEditingRequirement(requirement);
          setStartRequirementTesting(false);
          void refreshRequirements();
        }}
        onTasksWritten={(requirement) => {
          setEditingRequirement(requirement);
          setOnboardingWrittenRequirementKey(requirement.requirementKey);
          setFilters((current) => ({
            ...current,
            requirementKey: requirement.requirementKey,
            phase: requirement.startPhase,
          }));
        }}
        onChanged={handleSessionChanged}
      />

      <DeliveryRequirementAssignModal
        open={Boolean(assigningRequirement)}
        programId={programId}
        requirement={assigningRequirement}
        onClose={() => setAssigningRequirement(null)}
        onAssigned={(requirement) => {
          setEditingRequirement((current) => (current?.requirementKey === requirement.requirementKey ? requirement : current));
          void refreshRequirement(requirement.requirementKey);
        }}
      />

      <DeliveryRequirementTimelineDrawer
        open={Boolean(timelineRequirement)}
        programId={programId}
        requirement={timelineRequirement}
        onClose={() => setTimelineRequirement(null)}
      />

		{selectedProgram?.gitEnabled ? <DeliveryRequirementGitCheckModal
			requirement={gitRequirement}
			programId={programId}
			status={gitWorkspaceStatus}
			statusError={gitWorkspaceError}
			statusLoading={gitWorkspaceLoading}
			onRefreshStatus={refreshGitWorkspaceStatus}
			onClose={() => setGitRequirement(null)}
			onPrepared={() => {
				void refreshGitWorkspaceStatus();
				void refreshRequirements();
			}}
		/> : null}

      <Modal
        open={Boolean(pendingGroupedExecution)}
        title={t("delivery.execution.constraintsTitle")}
        okText={t("delivery.execution.confirmStart")}
        confirmLoading={batchStarting || sequenceStarting}
        onCancel={() => {
          setPendingGroupedExecution(null);
          setExecutionConstraints("");
        }}
        onOk={() => void confirmGroupedExecution()}
      >
        <div className="delivery-drawer">
          <label>
            {t("delivery.execution.constraintsLabel")}
            <Input.TextArea
              autoFocus
              rows={5}
              maxLength={32768}
              showCount
              value={executionConstraints}
              placeholder={t("delivery.execution.constraintsPlaceholder")}
              onChange={(event) => setExecutionConstraints(event.target.value)}
            />
            <small className="delivery-field-hint">{t("delivery.execution.constraintsHint")}</small>
          </label>
        </div>
      </Modal>

      <Modal
        open={createOpen}
        title={t("delivery.newItem")}
        okText={t("delivery.save")}
        confirmLoading={submitting}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
      >
        <div className="delivery-drawer">
          <label>
            {t("delivery.field.title")}
            <Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
          </label>
			<label>
				{t("delivery.field.benefitTags")}
				<Select mode="tags" tokenSeparators={[",", "，", ";", "；"]} maxCount={6} value={draftBenefitTags} placeholder={t("delivery.field.benefitTagsHint")} onChange={setDraftBenefitTags} />
			</label>
          <div className="delivery-drawer-row">
            <label>
              {t("delivery.field.moduleKey")}
              <Select
                value={draftModule || modules[0]?.moduleKey}
                onChange={setDraftModule}
                options={modules.map((module) => ({ value: module.moduleKey, label: module.name }))}
              />
            </label>
            <label>
              {t("delivery.field.stageKey")}
              <Select
                value={draftStage || stages[0]?.stageKey}
                onChange={setDraftStage}
                options={stages.map((stage) => ({ value: stage.stageKey, label: `${stage.tag} · ${stage.timeWindow}` }))}
              />
            </label>
          </div>
          <label>
            {t("delivery.field.kind")}
            <Select
              value={draftKind}
              onChange={setDraftKind}
              options={DELIVERY_KINDS.map((kind) => ({ value: kind, label: t(`delivery.kind.${kind}`) }))}
            />
          </label>
          <label>
            {t("delivery.field.dependsOnItemKeys")}
            <Select
              mode="multiple"
              showSearch
              allowClear
              maxTagCount="responsive"
              optionFilterProp="label"
              value={draftDependencies}
              placeholder={t("delivery.dependencies.placeholder")}
              onChange={(value) => setDraftDependencies([...value].sort())}
              options={itemCatalog.map((candidate) => ({
                value: candidate.itemKey,
                label: `${candidate.title} · ${candidate.itemKey}`,
              }))}
            />
            <small className="delivery-field-hint">{t("delivery.dependencies.hint")}</small>
          </label>
        </div>
      </Modal>
    </div>
  );
}
