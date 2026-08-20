"use client";

import {
  ArrowRightOutlined,
	BellOutlined,
	FastForwardOutlined,
  PlayCircleOutlined,
  DeploymentUnitOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Alert, Badge, Button, Empty, Input, Modal, Popover, Segmented, Select, Space, Spin, Switch, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyTextToClipboard } from "@/utils/clipboard";
import { useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import { getAuthUser } from "@/utils/auth";
import {
	DELIVERY_KINDS,
	bindRequirementGitBranch,
	DELIVERY_PHASES,
  DELIVERY_STATUSES,
  STATUS_COLORS,
  deleteRequirement,
	fetchMembers,
  saveRequirement,
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
import { DeliveryRequirementSessionModal } from "./DeliveryRequirementSessionModal";
import { DeliveryRequirementTimelineDrawer } from "./DeliveryRequirementTimelineDrawer";
import { DeliveryOnboardingGuide } from "./DeliveryOnboardingGuide";

// 全景视角已经独立成「全景视图」菜单（/panorama），这里只留看板和列表。
type ViewMode = "board" | "list";
type PendingGroupedExecution =
  | { mode: "batch"; itemKeys: string[]; closeDrawer?: boolean }
  | { mode: "sequence"; itemKeys?: string[]; startItemKey?: string; closeDrawer?: boolean };

type DeliveryNotificationStatus = "blocked" | "dropped" | "done";
type DeliveryNotificationCounts = Record<DeliveryNotificationStatus, number>;

const BOARD_SCALE_MIN = 35;
const BOARD_SCALE_MAX = 100;
const BOARD_WHEEL_SCALE_FACTOR = 0.05;

interface DeliveryNotificationStorage {
  counts: DeliveryNotificationCounts;
  readCounts: DeliveryNotificationCounts;
}

interface DeliveryNotificationReadState {
  scope: string;
  counts: DeliveryNotificationCounts;
}

const EMPTY_DELIVERY_NOTIFICATION_COUNTS: DeliveryNotificationCounts = {
  blocked: 0,
  dropped: 0,
  done: 0,
};

function readDeliveryNotificationCounts(value: unknown): DeliveryNotificationCounts {
  const counts = value as Partial<DeliveryNotificationCounts> | undefined;
  return {
    blocked: Math.max(0, Number(counts?.blocked) || 0),
    dropped: Math.max(0, Number(counts?.dropped) || 0),
    done: Math.max(0, Number(counts?.done) || 0),
  };
}

function readDeliveryNotificationStorage(storageKey: string): DeliveryNotificationCounts {
  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) return EMPTY_DELIVERY_NOTIFICATION_COUNTS;
    const saved = JSON.parse(rawValue) as Partial<DeliveryNotificationStorage>;
    return readDeliveryNotificationCounts(saved.readCounts);
  } catch {
    return EMPTY_DELIVERY_NOTIFICATION_COUNTS;
  }
}

export function DeliveryWorkspace() {
  const searchParams = useSearchParams();
  const { activeBusinessLine, setActiveBusinessLine } = useBusinessLine();
  const { preferences } = useAIPreferences();
  const { t } = useLocale();
  const userId = getAuthUser()?.id ?? 0;
  const sharedRequirementKey = (searchParams?.get("requirementKey") ?? "").trim();
  const sharedProgramId = Number(searchParams?.get("programId")) || 0;
  const sharedBizLine = (searchParams?.get("bizLine") ?? "").trim();

  // 分享链接明确写入业务线和项目，打开时不受接收者本地记忆的上下文影响。
  useEffect(() => {
    if (sharedBizLine && sharedBizLine !== activeBusinessLine.id) {
      setActiveBusinessLine(sharedBizLine);
    }
  }, [activeBusinessLine.id, setActiveBusinessLine, sharedBizLine]);

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
		prepareRequirementGitBranch,
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
  const [changingOwnerItemKey, setChangingOwnerItemKey] = useState("");
  const [editing, setEditing] = useState<DeliveryItemRecord | null>(null);
  const [sessionItem, setSessionItem] = useState<DeliveryItemRecord | null>(null);
  const [documentItem, setDocumentItem] = useState<DeliveryItemRecord | null>(null);
  const [outlineRequirement, setOutlineRequirement] = useState<DeliveryRequirementRecord | null>(null);
  const [startTaskTestingCases, setStartTaskTestingCases] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  // 新增需求时为 null，编辑需求时是那条需求；两种情况共用同一个弹窗。
  const [editingRequirement, setEditingRequirement] = useState<DeliveryRequirementRecord | null>(null);
  const [startRequirementTesting, setStartRequirementTesting] = useState(false);
	const [timelineRequirement, setTimelineRequirement] = useState<DeliveryRequirementRecord | null>(null);
	const [gitRequirement, setGitRequirement] = useState<DeliveryRequirementRecord | null>(null);
	const [gitPrepareStrategy, setGitPrepareStrategy] = useState<"switch" | "commit" | "stash">("switch");
	const [gitCommitMessage, setGitCommitMessage] = useState("");
	const [gitPreparing, setGitPreparing] = useState(false);
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
  const [notificationReadState, setNotificationReadState] = useState<DeliveryNotificationReadState>({
    scope: "",
    counts: EMPTY_DELIVERY_NOTIFICATION_COUNTS,
  });
  const taskPanelScrollRef = useRef<HTMLDivElement>(null);
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
  const notificationStorageKey = useMemo(() => {
    if (!userId || !bizLine || !programId || !filters.requirementKey) return "";
    return `zb.delivery.notification-center.v2:${userId}:${bizLine}:${programId}:${filters.requirementKey}`;
  }, [bizLine, filters.requirementKey, programId, userId]);
  const notificationCounts = useMemo<DeliveryNotificationCounts>(() => (
    itemCatalog.reduce<DeliveryNotificationCounts>((counts, item) => {
      if (item.status === "blocked" || item.status === "dropped" || item.status === "done") {
        counts[item.status] += 1;
      }
      return counts;
    }, { ...EMPTY_DELIVERY_NOTIFICATION_COUNTS })
  ), [itemCatalog]);
  const notificationReadCounts = notificationReadState.scope === notificationStorageKey
    ? notificationReadState.counts
    : EMPTY_DELIVERY_NOTIFICATION_COUNTS;
  const notificationUnreadCount = useMemo(
    () => (Object.keys(notificationCounts) as DeliveryNotificationStatus[]).reduce(
      (total, status) => total + Math.max(0, notificationCounts[status] - notificationReadCounts[status]),
      0,
    ),
    [notificationCounts, notificationReadCounts],
  );

  useEffect(() => {
    setNotificationReadState({
      scope: notificationStorageKey,
      counts: notificationStorageKey
        ? readDeliveryNotificationStorage(notificationStorageKey)
        : EMPTY_DELIVERY_NOTIFICATION_COUNTS,
    });
  }, [notificationStorageKey]);

  useEffect(() => {
    if (!notificationStorageKey || notificationReadState.scope !== notificationStorageKey) return;
    const value: DeliveryNotificationStorage = {
      counts: notificationCounts,
      readCounts: notificationReadCounts,
    };
    window.localStorage.setItem(notificationStorageKey, JSON.stringify(value));
  }, [notificationCounts, notificationReadCounts, notificationReadState.scope, notificationStorageKey]);

  const handleNotificationOpenChange = useCallback((open: boolean) => {
    if (!open || !notificationStorageKey) return;
    setNotificationReadState({ scope: notificationStorageKey, counts: notificationCounts });
  }, [notificationCounts, notificationStorageKey]);
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
  const taskOwnerOptions = useMemo(() => {
    const options = new Map<string, string>();
    members.forEach((member) => {
      const label = member.displayName || member.username || member.id;
      if (member.id) options.set(member.id, label);
    });
    // 存量任务可能尚未回填 ownerId，保留原显示名，避免下拉框看起来像未分配。
    allItems.forEach((item) => {
      const value = item.ownerId || item.ownerName;
      if (value && !options.has(value)) options.set(value, item.ownerName || value);
    });
    return Array.from(options, ([value, label]) => ({ value, label }));
  }, [allItems, members]);
  const filterOwnerOptions = useMemo(
    () => Array.from(new Set(taskOwnerOptions.map((option) => option.label)))
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .map((name) => ({ value: name, label: name })),
    [taskOwnerOptions],
  );

  useEffect(() => {
    let cancelled = false;
    fetchMembers()
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => {
        // 保留存量负责人的回退选项；接口短暂失败不影响浏览或编辑其他字段。
        if (!cancelled) message.warning(t("delivery.ownerQuickAssign.membersFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      const member = members.find((candidate) => candidate.id === ownerId);
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
    [members, patch, t],
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

  // 需求的起始阶段是任务面板的权威筛选起点。选中需求时一并切换，
  // 简易模式的任务便会直接落在「动作执行」，不再停留在默认的「梳理需求」。
  const handleRequirementSelect = useCallback((requirementKey: string) => {
    const selectedRequirementKey = sharedRequirementOnly ? sharedRequirementKey : requirementKey;
    const requirement = requirements.find((item) => item.requirementKey === selectedRequirementKey);
    setSelectedItemKeys([]);
    setFilters((current) => ({
      ...current,
      requirementKey: selectedRequirementKey || undefined,
      phase: requirement?.startPhase ?? current.phase,
    }));
  }, [requirements, setFilters, sharedRequirementKey, sharedRequirementOnly]);

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
    try {
      await deleteRequirement(programId, requirementKey);
      // 需求没了但任务还在看板上，选中的筛选条件要一并清掉。
      if (filters.requirementKey === requirementKey) setFilters({ ...filters, requirementKey: undefined });
      await Promise.all([refreshRequirements(), refresh()]);
      message.success(t("delivery.requirement.deleted"));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [filters, programId, refresh, refreshRequirements, setFilters, t]);

  const handleRequirementStatusChange = useCallback(async (
    requirement: DeliveryRequirementRecord,
    status: RequirementStatus,
  ) => {
    if (!programId || requirement.status === status) return;
    try {
      await saveRequirement({
        programId,
        requirementKey: requirement.requirementKey,
        name: requirement.name,
        detail: requirement.detail,
        status,
        mode: requirement.mode,
        startPhase: requirement.startPhase,
        splitTasks: requirement.splitTasks,
        preGenerateTaskDocuments: requirement.preGenerateTaskDocuments,
        generatePrototype: requirement.generatePrototype,
        stageKey: requirement.stageKey,
        moduleKey: requirement.moduleKey,
        kind: requirement.kind,
        owners: requirement.owners,
        assistants: requirement.assistants,
        version: requirement.version,
      });
      await Promise.all([refreshRequirements(), refresh()]);
      message.success(t("delivery.requirement.statusUpdated"));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [programId, refresh, refreshRequirements, t]);

	const openGitCheck = useCallback((requirement: DeliveryRequirementRecord) => {
		setGitRequirement(requirement);
		setGitPrepareStrategy(gitWorkspaceStatus?.dirty ? "stash" : "switch");
		setGitCommitMessage(`chore: save work before ${requirement.gitBranch}`);
		void refreshGitWorkspaceStatus().then((status) => {
			// 弹窗打开前可能还是上一次需求的快照；真正确认的状态回来后再选默认策略。
			setGitPrepareStrategy(status?.dirty ? "stash" : "switch");
		});
	}, [gitWorkspaceStatus?.dirty, refreshGitWorkspaceStatus]);

	const confirmGitPreparation = useCallback(async () => {
		if (!gitRequirement?.gitBranch) return;
		setGitPreparing(true);
		try {
			const result = await prepareRequirementGitBranch(
				gitRequirement.gitBranch,
				gitPrepareStrategy,
				gitCommitMessage.trim(),
			);
			// 从 origin/feature 关联时，本机实际分支会变成 feature；把这个规范化名称写回需求。
			if (result.branch && result.branch !== gitRequirement.gitBranch) {
				await bindRequirementGitBranch(
					programId,
					gitRequirement.requirementKey,
					gitRequirement.gitBaseBranch,
					result.branch,
				);
			}
			await refreshRequirements();
			setGitRequirement(null);
			message.success(result.stashed
				? t("delivery.requirement.gitPreparedStashed")
				: result.committed
					? t("delivery.requirement.gitPreparedCommitted")
					: t("delivery.requirement.gitPrepared"));
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setGitPreparing(false);
		}
	}, [gitCommitMessage, gitPrepareStrategy, gitRequirement, prepareRequirementGitBranch, programId, refreshRequirements, t]);

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

  const gitAlreadyOnRequirementBranch = Boolean(
    gitWorkspaceStatus?.currentBranch
    && gitRequirement?.gitBranch
    && gitWorkspaceStatus.currentBranch === gitRequirement.gitBranch,
  );
  const gitBranchesDiffer = Boolean(
    gitWorkspaceStatus?.currentBranch
    && gitRequirement?.gitBranch
    && gitWorkspaceStatus.currentBranch !== gitRequirement.gitBranch,
  );

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
          <Popover
            placement="bottomRight"
            trigger="click"
            title={t("delivery.notificationCenter.title")}
            onOpenChange={handleNotificationOpenChange}
            content={(
              <div className="delivery-notification-popover">
                <div className="delivery-notification-popover__row is-blocked">
                  <span>{t("delivery.notificationCenter.blocked")}</span>
                  <b>{notificationCounts.blocked}</b>
                </div>
                <div className="delivery-notification-popover__row is-dropped">
                  <span>{t("delivery.notificationCenter.dropped")}</span>
                  <b>{notificationCounts.dropped}</b>
                </div>
                <div className="delivery-notification-popover__row is-done">
                  <span>{t("delivery.notificationCenter.done")}</span>
                  <b>{notificationCounts.done}</b>
                </div>
              </div>
            )}
          >
            <Badge count={notificationUnreadCount} overflowCount={99} size="small">
              <Button
                className="delivery-notification-button"
                icon={<BellOutlined />}
                aria-label={t("delivery.notificationCenter.title")}
              />
            </Badge>
          </Popover>
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
          onTest={(requirement) => {
            setEditingRequirement(requirement);
            setStartRequirementTesting(true);
            setPlanningOpen(true);
          }}
          onOutline={setOutlineRequirement}
		  onTimeline={setTimelineRequirement}
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

      <DeliveryRequirementTimelineDrawer
        open={Boolean(timelineRequirement)}
        programId={programId}
        requirement={timelineRequirement}
        onClose={() => setTimelineRequirement(null)}
      />

		<Modal
			open={Boolean(gitRequirement)}
			title={t("delivery.requirement.gitCheckTitle")}
			okText={t("delivery.requirement.gitPrepare")}
			confirmLoading={gitPreparing}
			footer={gitAlreadyOnRequirementBranch ? (
				<Button type="primary" onClick={() => setGitRequirement(null)}>
					{t("common.close")}
				</Button>
			) : undefined}
			okButtonProps={{
				disabled: Boolean(gitWorkspaceLoading || gitWorkspaceError || !gitRequirement?.gitBranch || !gitWorkspaceStatus?.remoteMatches || gitWorkspaceStatus?.detached),
			}}
			onCancel={() => setGitRequirement(null)}
			onOk={() => void confirmGitPreparation()}
		>
			<div className="delivery-drawer">
				{gitWorkspaceError ? <Alert type="warning" showIcon message={gitWorkspaceError} /> : null}
				{gitWorkspaceStatus && !gitWorkspaceStatus.remoteMatches ? <Alert type="error" showIcon message={t("delivery.requirement.gitRemoteMismatch")} /> : null}
				{gitWorkspaceStatus?.detached ? <Alert type="error" showIcon message={t("delivery.requirement.gitDetached")} /> : null}
				{gitAlreadyOnRequirementBranch ? <Alert
					type="success"
					showIcon
					message={t("delivery.requirement.gitAlreadyOnBranch")}
				/> : null}
				{gitWorkspaceStatus?.remoteMatches && !gitWorkspaceStatus.detached && gitWorkspaceStatus.currentBranch !== gitRequirement?.gitBranch ? <Alert
					type="warning"
					showIcon
					message={t("delivery.requirement.gitBranchMismatch")
						.replace("{current}", gitWorkspaceStatus.currentBranch || "HEAD")
						.replace("{target}", gitRequirement?.gitBranch || "")}
				/> : null}
				<label>
					{t("delivery.requirement.gitCurrentBranch")}
					<Input readOnly value={gitWorkspaceStatus?.currentBranch || "HEAD"} className="manager-mono" />
				</label>
				<label>
					{t("delivery.requirement.gitTargetBranch")}
					<Input readOnly value={gitRequirement?.gitBranch || ""} className="manager-mono" />
				</label>
				{gitBranchesDiffer && gitWorkspaceStatus ? <Alert
					type={gitWorkspaceStatus.dirty ? "warning" : "info"}
					showIcon
					message={t("delivery.requirement.gitPendingFiles")
						.replace("{changed}", String(gitWorkspaceStatus.changed))
						.replace("{staged}", String(gitWorkspaceStatus.staged))
						.replace("{unstaged}", String(gitWorkspaceStatus.unstaged))
						.replace("{untracked}", String(gitWorkspaceStatus.untracked))}
					description={gitWorkspaceStatus.dirty ? t("delivery.requirement.gitDirtySwitchHint") : undefined}
				/> : null}
				{gitWorkspaceStatus?.dirty && !gitBranchesDiffer ? <Alert
					type="warning"
					showIcon
					message={t("delivery.requirement.gitDirtySummary")
						.replace("{staged}", String(gitWorkspaceStatus.staged))
						.replace("{unstaged}", String(gitWorkspaceStatus.unstaged))
						.replace("{untracked}", String(gitWorkspaceStatus.untracked))}
					description={gitAlreadyOnRequirementBranch ? undefined : t("delivery.requirement.gitDirtySwitchHint")}
				/> : null}
				{gitWorkspaceStatus?.dirty && gitWorkspaceStatus.currentBranch !== gitRequirement?.gitBranch ? <>
					<label>
						{t("delivery.requirement.gitDirtyStrategy")}
						<Segmented
							value={gitPrepareStrategy}
							onChange={(value) => setGitPrepareStrategy(value as "commit" | "stash")}
							options={[
								{ value: "stash", label: t("delivery.requirement.gitStrategy.stash") },
								{ value: "commit", label: t("delivery.requirement.gitStrategy.commit") },
							]}
						/>
					</label>
					{gitPrepareStrategy === "commit" ? <label>
						{t("delivery.requirement.gitCommitMessage")}
						<Input value={gitCommitMessage} onChange={(event) => setGitCommitMessage(event.target.value)} />
					</label> : null}
				</> : null}
			</div>
		</Modal>

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
