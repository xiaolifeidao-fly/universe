"use client";

import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  CalendarOutlined,
  HistoryOutlined,
  MessageOutlined,
  PlusOutlined,
  SearchOutlined,
  ReloadOutlined,
  ShareAltOutlined,
  SwapOutlined,
  TeamOutlined,
  UsergroupAddOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Empty, Input, Modal, Popconfirm, Segmented, Select, Spin, Tooltip, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import {
  deleteItem,
  deleteRequirement,
  fetchCodexGitWorkspaceStatus,
  fetchPrograms,
  isCodexGitWorkspaceUninitialized,
  REQUIREMENT_STATUSES,
  updateRequirementStatus,
  type DeliveryItemRecord,
  type DeliveryProgramRecord,
  type DeliveryRequirementRecord,
  type RequirementStatus,
} from "@/api/delivery.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { getProjectWorkspace } from "@/project-workspaces/projectWorkspacePreferences";
import { getAuthUser } from "@/utils/auth";
import { copyTextToClipboard } from "@/utils/clipboard";
import { requirementMentionPlainText } from "../../delivery/components/DeliveryRequirementDetailInput";
import { DeliveryRequirementAssignModal } from "../../delivery/components/DeliveryRequirementAssignModal";
import { DeliveryRequirementGitCheckModal } from "../../delivery/components/DeliveryRequirementGitCheckModal";
import { DeliveryRequirementTimePlanModal } from "../../delivery/components/DeliveryRequirementTimePlanModal";
import { DeliveryRequirementTimelineDrawer } from "../../delivery/components/DeliveryRequirementTimelineDrawer";
import { DeliveryRequirementProgressModal } from "../../delivery/components/DeliveryRequirementProgressModal";
import { DeliveryRequirementOutlineModal } from "../../delivery/components/DeliveryTaskOutline";
import { DeliveryRequirementSessionModal } from "../../delivery/components/DeliveryRequirementSessionModal";
import {
  ProgramWorkspacePreferenceModal,
  type ProgramWorkspacePreferenceTab,
} from "../../programs/components/ProgramWorkspacePreferenceModal";
import {
  fetchMyWorkGitWorkspaces,
  fetchMyWorkPrograms,
  fetchMyWorkProgramContext,
  fetchMyWorkRequirements,
  MyWorkRequirement,
  type MyWorkGitWorkspace,
  type MyWorkProgramContext,
} from "../api/myWork.api";

function formatTime(value: string | undefined, locale: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale, { hour12: false });
}

function memberNames(record: MyWorkRequirement) {
  const names = [...record.owners, ...record.assistants]
    .map((member) => member.name || member.id)
    .filter(Boolean);
  return Array.from(new Set(names)).join("、") || "-";
}

/** 卡片退场动画时长，必须与 globals.css 里的 my-work-card-exit 保持一致。 */
const CARD_EXIT_MS = 320;

type MyWorkType = "created" | "owner" | "assistant";
type MyWorkProgram = Awaited<ReturnType<typeof fetchMyWorkPrograms>>[number];

/** 就地打开需求弹窗所需的项目信息：新增需求时没有需求记录可读，只能单独带着。 */
interface MyWorkSessionProgram {
  programId: number;
  programName: string;
  gitEnabled: boolean;
  gitBaseBranch: string;
  bizLine: MyWorkRequirement["bizLine"];
}

function includesCurrentUser(members: MyWorkRequirement["owners"], userId: string) {
  return Boolean(userId) && members.some((member) => String(member.id) === userId);
}

export function MyWorkWorkspace() {
  const router = useRouter();
  const { t, locale } = useLocale();
  const { preferences } = useAIPreferences();
  const { activeBusinessLine, businessLinesLoaded } = useBusinessLine();
  const [records, setRecords] = useState<MyWorkRequirement[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [gitWorkspaces, setGitWorkspaces] = useState<Map<number, MyWorkGitWorkspace>>(new Map());
  const [gitLoading, setGitLoading] = useState(false);
  /** 卡片点「去设置 Git / 去设置工作目录」时就地打开的项目偏好设置，以及正在取项目记录的那条需求。 */
  const [preferenceProgram, setPreferenceProgram] = useState<DeliveryProgramRecord | null>(null);
  const [preferenceTab, setPreferenceTab] = useState<ProgramWorkspacePreferenceTab>("workspace");
  const [preferenceLoadingKey, setPreferenceLoadingKey] = useState("");
  // 就地打开的需求弹窗：卡片本身不跳转，只有「跳转看板」才离开工作台。
  const [sessionRecord, setSessionRecord] = useState<MyWorkRequirement | null>(null);
  // 新增需求同样在工作台就地打开：此时 sessionRecord 为空，只有项目上下文。
  const [sessionProgram, setSessionProgram] = useState<MyWorkSessionProgram | null>(null);
  const [sessionContext, setSessionContext] = useState<MyWorkProgramContext | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [outlineRecord, setOutlineRecord] = useState<MyWorkRequirement | null>(null);
  // 快速指派：只改负责人与协助人，不进需求编辑窗口。
  const [assignRecord, setAssignRecord] = useState<MyWorkRequirement | null>(null);
  // 关联时间计划的那条需求；为空表示弹窗关闭。
  const [timePlanRecord, setTimePlanRecord] = useState<MyWorkRequirement | null>(null);
  const [timelineRecord, setTimelineRecord] = useState<MyWorkRequirement | null>(null);
	const [progressRecord, setProgressRecord] = useState<MyWorkRequirement | null>(null);
  const [gitRecord, setGitRecord] = useState<MyWorkRequirement | null>(null);
  // 正在改状态的需求键：同一张卡片上的状态按钮转圈，别把整页都锁住。
  const [changingStatusKey, setChangingStatusKey] = useState("");
  // 正在退场的需求键：卡片先播一段收起动画，动画结束才从列表里真正拿掉。
  const [removingKeys, setRemovingKeys] = useState<Set<string>>(new Set());
  const removeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // 需求弹窗是否一打开就进总体测试：工作台的「开始测试」和需求列表同一个入口。
  const [sessionStartTesting, setSessionStartTesting] = useState(false);
  const [outlineBridgeReady, setOutlineBridgeReady] = useState(false);
  const [workType, setWorkType] = useState<MyWorkType>("created");
  // 列表筛选：项目默认「所有项目」，关键词按需求名称（含需求编号）模糊匹配。
  const [programFilter, setProgramFilter] = useState<number | "all">("all");
  const [keyword, setKeyword] = useState("");
  // 当前分支筛选：只留下与本机工作区当前分支一致的需求，卡片同时高亮。
  const [currentBranchOnly, setCurrentBranchOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"created" | "program">("created");
  const [createRequirementOpen, setCreateRequirementOpen] = useState(false);
  const [createRequirementPrograms, setCreateRequirementPrograms] = useState<MyWorkProgram[]>([]);
  const [createRequirementProgramId, setCreateRequirementProgramId] = useState<number>();
  const [createRequirementLoading, setCreateRequirementLoading] = useState(false);
  const [createRequirementEntering, setCreateRequirementEntering] = useState(false);
  const userId = String(getAuthUser()?.id ?? "");

  const requirementNames = useMemo(
    () => new Map(records.map((record) => [record.requirementKey, record.name])),
    [records],
  );

  useEffect(() => {
    if (!businessLinesLoaded) return;
    if (!activeBusinessLine.id) {
      setRecords([]);
      return;
    }
    let active = true;
    setLoading(true);
    fetchMyWorkRequirements(activeBusinessLine)
      .then((next) => {
        if (active) setRecords(next);
      })
      .catch((error) => {
        if (!active) return;
        setRecords([]);
        message.error((error as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [activeBusinessLine, businessLinesLoaded, reloadKey]);

  // 换空间后原来的项目筛选多半已不在这批数据里，回到「所有项目」更符合预期。
  useEffect(() => {
    setProgramFilter("all");
    setKeyword("");
    setCurrentBranchOnly(false);
  }, [activeBusinessLine.id]);

  // 只有挂了 Git 的项目才去问本机桥接，避免为纯文档项目发无意义的请求。
  const gitProgramIds = useMemo(
    () => Array.from(new Set(records.filter((record) => record.programGitEnabled).map((record) => record.programId))),
    [records],
  );

  useEffect(() => {
    if (!gitProgramIds.length) {
      setGitWorkspaces(new Map());
      return;
    }
    let active = true;
    setGitLoading(true);
    fetchMyWorkGitWorkspaces(gitProgramIds)
      .then((next) => {
        if (active) setGitWorkspaces(next);
      })
      .finally(() => {
        if (active) setGitLoading(false);
      });
    return () => { active = false; };
  }, [gitProgramIds, reloadKey]);

  /** 本机还没选工作目录的项目：与 Git 无关，任何项目的卡片都要提示。 */
  const workspaceUnsetProgramIds = useMemo(
    () => new Set(records.filter((record) => !getProjectWorkspace(record.programId)).map((record) => record.programId)),
    [records],
  );

  /**
   * 与需求列表同一套判定：先看项目和需求是否都开了 Git，再拿工作区当前分支比对。
   * 分支不一致只是提示，不阻断任何操作。
   */
  const gitStateOf = useCallback((record: MyWorkRequirement) => {
    if (!record.programGitEnabled || !record.gitEnabled || !record.gitBranch) return null;
    const workspace = gitWorkspaces.get(record.programId);
    const base = { current: false, dirty: false, currentBranch: workspace?.status?.currentBranch ?? "" };
    if (workspace?.error) return { ...base, tone: "is-idle", label: t("delivery.requirement.gitState.unavailable") };
    if (!workspace?.status) return { ...base, tone: "is-idle", label: t("delivery.requirement.gitState.pending") };
    if (workspace.status.detached) {
      return { ...base, currentBranch: "", tone: "is-danger", label: t("delivery.requirement.gitState.blocked") };
    }
    if (workspace.status.currentBranch !== record.gitBranch) {
      return { ...base, tone: "is-warning", label: t("delivery.requirement.gitState.mismatch") };
    }
    if (workspace.status.dirty) return { ...base, current: true, dirty: true, tone: "is-warning", label: t("delivery.requirement.gitState.dirty") };
    return { ...base, current: true, tone: "is-success", label: t("delivery.requirement.gitState.ready") };
  }, [gitWorkspaces, t]);

  /** 项目下拉的候选只来自已加载的需求，避免列出没有任何在办需求的项目。 */
  const programOptions = useMemo(() => {
    const names = new Map<number, string>();
    for (const record of records) {
      if (!names.has(record.programId)) {
        names.set(record.programId, record.programName || record.programCode || String(record.programId));
      }
    }
    return Array.from(names, ([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, locale));
  }, [locale, records]);

  /** 与本机工作区当前分支一致的需求键：分支筛选和卡片高亮共用这一份判定。 */
  const currentBranchKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const record of records) {
      if (!record.programGitEnabled || !record.gitEnabled || !record.gitBranch) continue;
      const status = gitWorkspaces.get(record.programId)?.status;
      if (!status || status.detached) continue;
      if (status.currentBranch === record.gitBranch) keys.add(record.requirementKey);
    }
    return keys;
  }, [gitWorkspaces, records]);

  // 一条都匹配不上时不让按钮进入选中态，否则点完只会得到一个空列表。
  useEffect(() => {
    if (currentBranchOnly && !currentBranchKeys.size) setCurrentBranchOnly(false);
  }, [currentBranchKeys, currentBranchOnly]);

  const filtering = programFilter !== "all" || Boolean(keyword.trim()) || currentBranchOnly;

  /** 项目与关键词是列表的统一入口条件：统计和身份分组都基于筛选后的这批需求。 */
  const filteredRecords = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return records.filter((record) => {
      if (programFilter !== "all" && record.programId !== programFilter) return false;
      if (currentBranchOnly && !currentBranchKeys.has(record.requirementKey)) return false;
      if (!query) return true;
      return (record.name || "").toLowerCase().includes(query)
        || record.requirementKey.toLowerCase().includes(query);
    });
  }, [currentBranchKeys, currentBranchOnly, keyword, programFilter, records]);

  /**
   * 顶部统计只描述当前空间已加载并通过筛选的这批需求，不额外请求聚合接口。
   * 正在退场的卡片先从统计里扣掉：数字随点击立刻变化，卡片再慢慢收起。
   */
  const stats = useMemo(() => {
    const counted = removingKeys.size
      ? filteredRecords.filter((record) => !removingKeys.has(record.requirementKey))
      : filteredRecords;
    return {
      total: counted.length,
      programs: new Set(counted.map((record) => record.programId)).size,
      created: counted.filter((record) => record.createdBy === userId).length,
      owner: counted.filter((record) => includesCurrentUser(record.owners, userId)).length,
      assistant: counted.filter((record) => includesCurrentUser(record.assistants, userId)).length,
    };
  }, [filteredRecords, removingKeys, userId]);

  // 三类身份互不排斥：同一条需求可以既是我提出的，又由我负责或协助。
  const recordsOfCurrentType = useMemo(() => filteredRecords.filter((record) => {
    if (workType === "created") return record.createdBy === userId;
    if (workType === "owner") return includesCurrentUser(record.owners, userId);
    return includesCurrentUser(record.assistants, userId);
  }), [filteredRecords, userId, workType]);

  const sortedRecords = useMemo(() => {
    const list = [...recordsOfCurrentType];
    if (sortBy === "program") {
      // 同一项目内仍按创建时间倒序，方便顺着项目一条条往下看。
      return list.sort((left, right) => (left.programName || "").localeCompare(right.programName || "", locale)
        || (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
    }
    return list.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  }, [locale, recordsOfCurrentType, sortBy]);

  const openBoard = useCallback((record: MyWorkRequirement, itemKey = "") => {
    const params = new URLSearchParams({
      bizLine: record.bizLine,
      programId: String(record.programId),
      focusRequirementKey: record.requirementKey,
      focusMode: itemKey ? "detail" : "board",
      focusToken: String(Date.now()),
    });
    if (itemKey) params.set("focusItemKey", itemKey);
    router.push(`/delivery?${params.toString()}`);
  }, [router]);

  /**
   * 卡片提示「先初始化 Git」时就地开项目偏好设置，停在 Git 页签，不跳项目管理。
   * 卡片本身只带了项目的几个字段，弹窗要的是完整项目记录，所以点开时按需取一次。
   */
  const openProgramPreference = useCallback(async (record: MyWorkRequirement, tab: ProgramWorkspacePreferenceTab) => {
    setPreferenceLoadingKey(record.requirementKey);
    try {
      const programs = await fetchPrograms(record.bizLine);
      const program = programs.find((item) => item.programId === record.programId);
      if (!program) {
        message.error(t("myWork.programMissing"));
        return;
      }
      setPreferenceTab(tab);
      setPreferenceProgram(program);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPreferenceLoadingKey("");
    }
  }, [t]);

  const openCreateRequirement = useCallback(async () => {
    if (!activeBusinessLine.id) return;
    setCreateRequirementOpen(true);
    setCreateRequirementProgramId(undefined);
    setCreateRequirementPrograms([]);
    setCreateRequirementLoading(true);
    try {
      setCreateRequirementPrograms(await fetchMyWorkPrograms(activeBusinessLine));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCreateRequirementLoading(false);
    }
  }, [activeBusinessLine]);

  /** 新增需求就地开窗：留在工作台，不跳转看板，也不改动地址栏。 */
  const enterRequirementEditor = useCallback(async () => {
    const program = createRequirementPrograms.find((item) => item.programId === createRequirementProgramId);
    if (!program) return;
    setCreateRequirementEntering(true);
    try {
      const context = await fetchMyWorkProgramContext(program.programId, "", preferences.globalTool);
      setSessionRecord(null);
      setSessionProgram({
        programId: program.programId,
        programName: program.name || program.programCode || String(program.programId),
        gitEnabled: program.gitEnabled,
        gitBaseBranch: program.gitBaseBranch,
        bizLine: activeBusinessLine.id,
      });
      setSessionContext(context);
      setCreateRequirementOpen(false);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCreateRequirementEntering(false);
    }
  }, [activeBusinessLine.id, createRequirementProgramId, createRequirementPrograms, preferences.globalTool]);

  const openSession = useCallback(async (record: MyWorkRequirement, startTesting = false) => {
    setSessionRecord(record);
    setSessionStartTesting(startTesting);
    setSessionProgram({
      programId: record.programId,
      programName: record.programName,
      gitEnabled: record.programGitEnabled,
      gitBaseBranch: record.programGitBaseBranch,
      bizLine: record.bizLine,
    });
    setSessionContext(null);
    setSessionLoading(true);
    try {
      setSessionContext(await fetchMyWorkProgramContext(record.programId, record.requirementKey, preferences.globalTool));
    } catch (error) {
      setSessionRecord(null);
      setSessionProgram(null);
      message.error((error as Error).message);
    } finally {
      setSessionLoading(false);
    }
  }, [preferences.globalTool]);

  /** 关掉需求弹窗时只刷新工作台这份列表，不做任何跳转。 */
  const closeSession = useCallback(() => {
    setSessionRecord(null);
    setSessionProgram(null);
    setSessionContext(null);
    setSessionStartTesting(false);
    setReloadKey((value) => value + 1);
  }, []);

  const openOutline = useCallback(async (record: MyWorkRequirement) => {
    setOutlineRecord(record);
    setOutlineBridgeReady(false);
    try {
      const context = await fetchMyWorkProgramContext(record.programId, record.requirementKey, preferences.globalTool);
      setOutlineBridgeReady(context.codexBridgeReady);
    } catch {
      setOutlineBridgeReady(false);
    }
  }, [preferences.globalTool]);

  /**
   * 让一条需求就地退场：先标记成退场态播动画，动画收尾再从本地列表拿掉。
   * 不走整表重取，页面不会闪一下 loading，统计也是跟着这份本地数据走。
   */
  const dismissRecord = useCallback((requirementKey: string) => {
    if (removeTimersRef.current.has(requirementKey)) return;
    setRemovingKeys((current) => {
      const next = new Set(current);
      next.add(requirementKey);
      return next;
    });
    const timer = setTimeout(() => {
      removeTimersRef.current.delete(requirementKey);
      setRecords((current) => current.filter((item) => item.requirementKey !== requirementKey));
      setRemovingKeys((current) => {
        if (!current.has(requirementKey)) return current;
        const next = new Set(current);
        next.delete(requirementKey);
        return next;
      });
    }, CARD_EXIT_MS);
    removeTimersRef.current.set(requirementKey, timer);
  }, []);

  // 卸载时把没跑完的退场定时器清掉，免得往已经不在的组件里写状态。
  useEffect(() => {
    const timers = removeTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  /**
   * 快速改状态走只改状态的接口：整条需求保存会把这里没带上的字段（例如计划起止时间）一并覆盖。
   * 工作台只收「进行中」的需求，所以改完直接让这张卡片退场，不再整表重取。
   */
  const handleStatusChange = useCallback(async (record: MyWorkRequirement, status: RequirementStatus) => {
    if (record.status === status) return;
    setChangingStatusKey(record.requirementKey);
    try {
      await updateRequirementStatus(record.programId, record.requirementKey, status, record.version);
      message.success(t("delivery.requirement.statusUpdated"));
      dismissRecord(record.requirementKey);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setChangingStatusKey("");
    }
  }, [dismissRecord, t]);

  const handleDeleteRequirement = useCallback(async (record: MyWorkRequirement) => {
    // 兜底再判一次：卡片上已禁用按钮，但确认框开着的时候工作区可能才变脏。
    const gitState = gitStateOf(record);
    if (gitState?.current && gitState.dirty) {
      message.warning(t("delivery.requirement.deleteBlockedDirty"));
      return;
    }
    try {
      await deleteRequirement(record.programId, record.requirementKey);
      message.success(t("delivery.requirement.deleted"));
      dismissRecord(record.requirementKey);
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [dismissRecord, gitStateOf, t]);

  /** Git 弹窗要的是这条需求所属项目的最新工作区状态，顺带更新卡片上的分支提示。 */
  const refreshGitWorkspace = useCallback(async (programId: number) => {
    if (!programId) return null;
    try {
      // 状态读得到不代表 Git 已就绪：仓库没关联远端时状态照样能读，所以这件事单独问一次。
      const uninitialized = await isCodexGitWorkspaceUninitialized(programId);
      const status = await fetchCodexGitWorkspaceStatus(programId);
      setGitWorkspaces((current) => new Map(current).set(programId, { status, error: "", uninitialized }));
      return status;
    } catch (error) {
      const uninitialized = await isCodexGitWorkspaceUninitialized(programId);
      setGitWorkspaces((current) => new Map(current).set(
        programId,
        { status: null, error: (error as Error).message, uninitialized },
      ));
      return null;
    }
  }, []);

  const handleShare = useCallback(async (requirement: DeliveryRequirementRecord) => {
    const link = new URL("/delivery", window.location.origin);
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

  const handleDeleteItem = useCallback(async (itemKey: string) => {
    if (!sessionProgram) return false;
    try {
      await deleteItem(sessionProgram.programId, itemKey);
      const next = await fetchMyWorkProgramContext(
        sessionProgram.programId,
        sessionRecord?.requirementKey ?? "",
        preferences.globalTool,
      );
      setSessionContext(next);
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    }
  }, [preferences.globalTool, sessionProgram, sessionRecord]);

  const handleRequirementSaved = useCallback((requirement: DeliveryRequirementRecord) => {
    setSessionRecord((current) => {
      if (current) {
        return Object.assign(Object.create(Object.getPrototypeOf(current)), current, requirement) as MyWorkRequirement;
      }
      // 新增需求刚落库：补上项目上下文，后续追问与「跳转看板」才有据可依。
      if (!sessionProgram) return current;
      return Object.assign(new MyWorkRequirement(), requirement, {
        programName: sessionProgram.programName,
        businessCode: sessionProgram.bizLine,
        spaceName: activeBusinessLine.label,
        canWrite: true,
        programGitEnabled: sessionProgram.gitEnabled,
        programGitBaseBranch: sessionProgram.gitBaseBranch,
      });
    });
    setReloadKey((value) => value + 1);
  }, [activeBusinessLine.label, sessionProgram]);

  return (
    <div className="manager-page-stack my-work-page">
      <header className="my-work-hero">
        <div className="my-work-hero__top">
          <div className="my-work-hero__lead">
            <span className="my-work-hero__space">
              <AppstoreOutlined />
              {activeBusinessLine.label || activeBusinessLine.id}
              <code className="manager-mono">{activeBusinessLine.code || activeBusinessLine.id}</code>
            </span>
            <p className="my-work-hero__summary">
              <b className="manager-mono">{stats.total}</b>
              <span>{t("myWork.openCount")}</span>
              <em />
              <b className="manager-mono">{stats.programs}</b>
              <span>{t("myWork.statPrograms")}</span>
            </p>
          </div>
          <div className="my-work-hero__tools">
            <Segmented
              aria-label={t("myWork.sort")}
              size="small"
              value={sortBy}
              onChange={(value) => setSortBy(value as "created" | "program")}
              options={[
                { value: "created", label: t("myWork.sortByCreated") },
                { value: "program", label: t("myWork.sortByProgram") },
              ]}
            />
            <Tooltip title={t("myWork.refresh")}>
              <Button
                aria-label={t("myWork.refresh")}
                className="my-work-hero__refresh"
                icon={<ReloadOutlined />}
                loading={loading || gitLoading}
                type="text"
                onClick={() => setReloadKey((value) => value + 1)}
              />
            </Tooltip>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!activeBusinessLine.id}
              onClick={() => void openCreateRequirement()}
            >
              {t("myWork.createRequirement")}
            </Button>
          </div>
        </div>

        {/* 三类身份既是统计也是筛选：数字和切换合成一排，不再上下重复两遍。 */}
        <div className="my-work-roles" role="tablist" aria-label={t("myWork.type")}>
          {([
            { value: "created", label: t("myWork.statCreated"), count: stats.created },
            { value: "owner", label: t("myWork.statOwner"), count: stats.owner },
            { value: "assistant", label: t("myWork.statAssistant"), count: stats.assistant },
          ] as { value: MyWorkType; label: string; count: number }[]).map((role) => (
            <button
              key={role.value}
              type="button"
              role="tab"
              aria-selected={workType === role.value}
              className={`my-work-role${workType === role.value ? " is-active" : ""}`}
              onClick={() => setWorkType(role.value)}
            >
              <b className="manager-mono">{role.count}</b>
              <span>{role.label}</span>
            </button>
          ))}
        </div>

        {/* 项目筛选与关键词搜索单独一行，跟身份 tab 分开，条件多时不会把 tab 挤换行。 */}
        <div className="my-work-filters">
          <Select
            className="my-work-filters__program"
            popupClassName="my-work-filters__dropdown"
            aria-label={t("myWork.filterProgram")}
            showSearch
            suffixIcon={<FolderOpenOutlined />}
            optionFilterProp="label"
            value={programFilter}
            onChange={(value) => setProgramFilter(value)}
            options={[{ value: "all" as const, label: t("myWork.allPrograms") }, ...programOptions]}
          />
          <Input
            className="my-work-filters__search"
            allowClear
            value={keyword}
            prefix={<SearchOutlined />}
            placeholder={t("myWork.searchPlaceholder")}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <Tooltip
            title={currentBranchKeys.size
              ? t("myWork.currentBranchFilterHint")
              : t("myWork.currentBranchFilterEmpty")}
          >
            {/* 禁用态的按钮不触发 Tooltip，套一层容器保证「没有匹配」也有解释。 */}
            <span className="my-work-filters__branch-wrap">
              <Button
                className={`my-work-filters__branch${currentBranchOnly ? " is-active" : ""}`}
                aria-pressed={currentBranchOnly}
                disabled={!currentBranchKeys.size}
                loading={gitLoading && !currentBranchKeys.size}
                icon={<BranchesOutlined />}
                onClick={() => setCurrentBranchOnly((value) => !value)}
              >
                {t("myWork.currentBranchFilter")}
                <b className="manager-mono">{currentBranchKeys.size}</b>
              </Button>
            </span>
          </Tooltip>
        </div>
      </header>

      {loading && !sortedRecords.length ? (
        <div className="my-work-loading"><Spin /></div>
      ) : sortedRecords.length ? (
        <section className="my-work-grid" aria-label={t("myWork.list")}>
          {sortedRecords.map((record) => {
            const gitState = gitStateOf(record);
            // 仓库都还没初始化时，需求分支无从谈起，先把「去初始化」这件事摆在卡片上。
            // 工作目录都没选的话先提示选目录：Git 那步在目录定下来之前无从判断。
            const workspaceUnset = workspaceUnsetProgramIds.has(record.programId);
            const gitUninitialized = record.programGitEnabled
              && Boolean(gitWorkspaces.get(record.programId)?.uninitialized)
              && !workspaceUnset;
            // 工作区正停在这条需求的分支上且还有未提交改动时不许删：改动会失去对应的需求上下文。
            const deleteBlocked = Boolean(gitState?.current && gitState?.dirty);
            const cardKey = `${record.bizLine}:${record.programId}:${record.requirementKey}`;
            return (
              <article
                className={`my-work-card${currentBranchOnly && currentBranchKeys.has(record.requirementKey) ? " is-current-branch" : ""}${removingKeys.has(record.requirementKey) ? " is-removing" : ""}`}
                aria-hidden={removingKeys.has(record.requirementKey) || undefined}
                key={cardKey}
              >
                <header className="my-work-card__head">
                  <div className="my-work-card__identity">
                    <span className="my-work-chip is-open">
                      <i />
                      {t("delivery.requirement.status.open")}
                    </span>
                    <code className="manager-mono">{record.requirementKey}</code>
                  </div>
                  <Tooltip title={t("myWork.openBoard")}>
                    <Button
                      aria-label={t("myWork.openBoard")}
                      className="my-work-card__open"
                      type="text"
                      shape="circle"
                      size="small"
                      icon={<ArrowRightOutlined />}
                      onClick={() => openBoard(record)}
                    />
                  </Tooltip>
                </header>

                <div className="my-work-card__content">
                  <h3>{record.name || record.requirementKey}</h3>
                  {record.detail ? <p>{requirementMentionPlainText(record.detail, requirementNames)}</p> : null}
                </div>

                {workspaceUnset ? (
                  <div className="my-work-card__git">
                    <FolderOpenOutlined />
                    <span className="my-work-chip is-warning" title={t("delivery.requirement.workspaceUnsetHint")}>
                      <i />
                      {t("delivery.requirement.workspaceUnset")}
                    </span>
                    <Button
                      type="link"
                      size="small"
                      loading={preferenceLoadingKey === record.requirementKey}
                      onClick={() => void openProgramPreference(record, "workspace")}
                    >
                      {t("delivery.requirement.workspaceUnsetAction")}
                    </Button>
                  </div>
                ) : null}
                {gitUninitialized ? (
                  <div className="my-work-card__git">
                    <BranchesOutlined />
                    <span className="my-work-chip is-warning" title={t("delivery.requirement.gitUninitializedHint")}>
                      <i />
                      {t("delivery.requirement.gitUninitialized")}
                    </span>
                    <Button
                      type="link"
                      size="small"
                      loading={preferenceLoadingKey === record.requirementKey}
                      onClick={() => void openProgramPreference(record, "git")}
                    >
                      {t("delivery.requirement.gitUninitializedAction")}
                    </Button>
                  </div>
                ) : null}
                {gitState ? (
                  <div className="my-work-card__git">
                    <BranchesOutlined />
                    <code className="manager-mono" title={record.gitBranch}>{record.gitBranch}</code>
                    {gitState.currentBranch ? (
                      <span className="my-work-card__git-current">
                        <em>{t("delivery.requirement.gitCurrentBranch")}</em>
                        <code className="manager-mono" title={gitState.currentBranch}>{gitState.currentBranch}</code>
                      </span>
                    ) : null}
                    {gitState.current ? (
                      <span className="my-work-chip is-open"><i />{t("delivery.requirement.gitCurrentBranchTag")}</span>
                    ) : null}
                    <span className={`my-work-chip ${gitState.tone}`}><i />{gitState.label}</span>
                    {gitState.current ? (
                      <Button
                        type="link"
                        size="small"
                        icon={<CloudDownloadOutlined />}
                        loading={gitLoading}
                        onClick={() => setGitRecord(record)}
                      >
                        {t("delivery.requirement.gitPullLatest")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                <dl className="my-work-card__facts">
                  <div title={record.programName || record.programCode}>
                    <dt><FolderOpenOutlined /></dt>
                    <dd>{record.programName || record.programCode || String(record.programId)}</dd>
                  </div>
                  <div title={memberNames(record)}>
                    <dt><TeamOutlined /></dt>
                    <dd>{memberNames(record)}</dd>
                  </div>
                  <div title={formatTime(record.createdAt, locale)}>
                    <dt><ClockCircleOutlined /></dt>
                    <dd className="manager-mono">{formatTime(record.createdAt, locale)}</dd>
                  </div>
                </dl>

                <footer className="my-work-card__actions">
                  <div className="my-work-card__utility-actions">
                    {/* 前四个是每天都在点的入口，各给一个颜色，和后面的次要操作分开。 */}
                    <Tooltip title={t("myWork.chat")}>
                      <Button
                        aria-label={t("myWork.chat")}
                        className="my-work-action is-chat"
                        type="text"
                        size="small"
                        icon={<MessageOutlined />}
                        loading={sessionLoading && sessionRecord?.requirementKey === record.requirementKey}
                        onClick={() => void openSession(record)}
                      />
                    </Tooltip>
                    <Tooltip title={t("delivery.progress.view")}>
                      <Button
                        aria-label={t("delivery.progress.view")}
                        className="my-work-action is-progress"
                        type="text"
                        size="small"
                        icon={<CheckSquareOutlined />}
                        onClick={() => setProgressRecord(record)}
                      />
                    </Tooltip>
                    <Tooltip title={t("delivery.requirement.outline")}>
                      <Button
                        aria-label={t("delivery.requirement.outline")}
                        className="my-work-action is-outline"
                        type="text"
                        size="small"
                        icon={<FileTextOutlined />}
                        onClick={() => void openOutline(record)}
                      />
                    </Tooltip>
                    {gitState ? (
                      <Tooltip title={t("delivery.requirement.gitCheck")}>
                        <Button
                          aria-label={t("delivery.requirement.gitCheck")}
                          className="my-work-action is-branch"
                          type="text"
                          size="small"
                          icon={<BranchesOutlined />}
                          loading={gitLoading}
                          onClick={() => setGitRecord(record)}
                        />
                      </Tooltip>
                    ) : null}
                    {record.canWrite ? (
                      <Tooltip title={t("delivery.requirement.assign")}>
                        <Button
                          aria-label={t("delivery.requirement.assign")}
                          type="text"
                          size="small"
                          icon={<UsergroupAddOutlined />}
                          onClick={() => setAssignRecord(record)}
                        />
                      </Tooltip>
                    ) : null}
                    {record.canWrite ? (
                      <Tooltip title={t("delivery.requirement.timePlan")}>
                        <Button
                          aria-label={t("delivery.requirement.timePlan")}
                          type="text"
                          size="small"
                          icon={<CalendarOutlined />}
                          onClick={() => setTimePlanRecord(record)}
                        />
                      </Tooltip>
                    ) : null}
                    <Tooltip title={t("delivery.requirement.shareLink")}>
                      <Button
                        aria-label={t("delivery.requirement.shareLink")}
                        type="text"
                        size="small"
                        icon={<ShareAltOutlined />}
                        onClick={() => void handleShare(record)}
                      />
                    </Tooltip>
                    {record.canWrite ? (
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: REQUIREMENT_STATUSES.map((status) => ({
                            key: status,
                            label: t(`delivery.requirement.status.${status}`),
                            disabled: status === record.status || changingStatusKey === record.requirementKey,
                          })),
                          onClick: ({ key }) => void handleStatusChange(record, key as RequirementStatus),
                        }}
                      >
                        <Tooltip title={t("delivery.requirement.quickStatus")}>
                          <Button
                            aria-label={t("delivery.requirement.quickStatus")}
                            type="text"
                            size="small"
                            icon={<SwapOutlined />}
                            loading={changingStatusKey === record.requirementKey}
                          />
                        </Tooltip>
                      </Dropdown>
                    ) : null}
                    {record.canWrite && deleteBlocked ? (
                      // 禁用态的按钮不触发 Tooltip，套一层容器把「为什么不能删」说清楚。
                      <Tooltip title={t("delivery.requirement.deleteBlockedDirty")}>
                        <span>
                          <Button
                            danger
                            disabled
                            aria-label={t("delivery.requirement.delete")}
                            type="text"
                            size="small"
                            icon={<DeleteOutlined />}
                          />
                        </span>
                      </Tooltip>
                    ) : null}
                    {record.canWrite && !deleteBlocked ? (
                      <Popconfirm
                        title={t("delivery.requirement.deleteConfirm")}
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void handleDeleteRequirement(record)}
                      >
                        <Tooltip title={t("delivery.requirement.delete")}>
                          <Button
                            danger
                            aria-label={t("delivery.requirement.delete")}
                            type="text"
                            size="small"
                            icon={<DeleteOutlined />}
                          />
                        </Tooltip>
                      </Popconfirm>
                    ) : null}
                    {/* 低频入口收进这里：菜单是竖着一条条展开的，不再往动作行后面平铺。 */}
                    <Dropdown
                      trigger={["click"]}
                      placement="bottomRight"
                      menu={{
                        items: [
                          {
                            key: "test",
                            icon: <ExperimentOutlined />,
                            label: t("delivery.requirement.startTesting"),
                          },
                          {
                            key: "timeline",
                            icon: <HistoryOutlined />,
                            label: t("delivery.requirement.viewTimeline"),
                          },
                        ],
                        onClick: ({ key }) => {
                          if (key === "test") void openSession(record, true);
                          if (key === "timeline") setTimelineRecord(record);
                        },
                      }}
                    >
                      <Tooltip title={t("delivery.requirement.moreActions")}>
                        <Button
                          aria-label={t("delivery.requirement.moreActions")}
                          type="text"
                          size="small"
                          icon={<EllipsisOutlined />}
                        />
                      </Tooltip>
                    </Dropdown>
                  </div>
                </footer>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="manager-data-card my-work-empty">
          <Empty
            description={currentBranchOnly
              ? t("myWork.currentBranchEmptyList")
              : filtering ? t("myWork.emptyBySearch") : t(`myWork.empty.${workType}`)}
          />
        </section>
      )}

      <DeliveryRequirementAssignModal
        open={Boolean(assignRecord)}
        programId={assignRecord?.programId ?? 0}
        requirement={assignRecord}
        onClose={() => setAssignRecord(null)}
        // 指派后当前用户可能已不再与这条需求相关，整表重取比就地改更贴近工作台的口径。
        onAssigned={() => setReloadKey((value) => value + 1)}
      />

      <DeliveryRequirementTimePlanModal
        requirement={timePlanRecord}
        programId={timePlanRecord?.programId ?? 0}
        onClose={() => setTimePlanRecord(null)}
        // 关联只改计划键，不影响这条需求还在不在我的工作台，就地重取一遍列表即可。
        onBound={() => setReloadKey((value) => value + 1)}
      />

      <DeliveryRequirementTimelineDrawer
        open={Boolean(timelineRecord)}
        programId={timelineRecord?.programId ?? 0}
        requirement={timelineRecord}
        onClose={() => setTimelineRecord(null)}
      />

      <DeliveryRequirementProgressModal
        open={Boolean(progressRecord)}
        programId={progressRecord?.programId ?? 0}
        bizLine={progressRecord?.bizLine ?? activeBusinessLine.id}
        requirement={progressRecord}
        onClose={() => setProgressRecord(null)}
      />

      <DeliveryRequirementGitCheckModal
        requirement={gitRecord}
        programId={gitRecord?.programId ?? 0}
        status={gitRecord ? gitWorkspaces.get(gitRecord.programId)?.status ?? null : null}
        statusError={gitRecord ? gitWorkspaces.get(gitRecord.programId)?.error ?? "" : ""}
        statusLoading={gitLoading}
        onRefreshStatus={() => refreshGitWorkspace(gitRecord?.programId ?? 0)}
        onClose={() => setGitRecord(null)}
        onPrepared={() => setReloadKey((value) => value + 1)}
      />

      <ProgramWorkspacePreferenceModal
        program={preferenceProgram}
        initialTab={preferenceTab}
        onClose={() => setPreferenceProgram(null)}
        // 目录或仓库刚配好，重拉一遍卡片和 Git 状态，提示才会消失。
        onSaved={() => setReloadKey((value) => value + 1)}
      />

      <DeliveryRequirementOutlineModal
        open={Boolean(outlineRecord)}
        programId={outlineRecord?.programId ?? 0}
        requirement={outlineRecord}
        codexBridgeReady={outlineBridgeReady}
        onClose={() => setOutlineRecord(null)}
      />

      {sessionProgram && sessionContext ? (
        <DeliveryRequirementSessionModal
          open
          requirement={sessionRecord}
          programId={sessionProgram.programId}
          programName={sessionProgram.programName}
          projectGitEnabled={sessionProgram.gitEnabled}
          projectGitBaseBranch={sessionProgram.gitBaseBranch}
          bizLine={sessionProgram.bizLine}
          stages={sessionContext.stages}
          modules={sessionContext.modules}
          itemCatalog={sessionContext.itemCatalog}
          requirements={sessionContext.requirements}
          codexBridgeReady={sessionContext.codexBridgeReady}
          startTestingOnOpen={sessionStartTesting}
          onClose={closeSession}
          onOpenItem={(item: DeliveryItemRecord) => {
            const target = sessionRecord;
            if (!target) return;
            setSessionRecord(null);
            setSessionProgram(null);
            setSessionContext(null);
            openBoard(target, item.itemKey);
          }}
          onDeleteItem={handleDeleteItem}
          onShare={handleShare}
          onRequirementSaved={handleRequirementSaved}
          onChanged={() => setReloadKey((value) => value + 1)}
        />
      ) : null}

      <Modal
        open={createRequirementOpen}
        title={t("myWork.createRequirement")}
        okText={t("myWork.openRequirementEditor")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !createRequirementProgramId }}
        confirmLoading={createRequirementEntering}
        onCancel={() => setCreateRequirementOpen(false)}
        onOk={() => void enterRequirementEditor()}
      >
        <p style={{ color: "var(--manager-text-soft)" }}>{t("myWork.createRequirementHint")}</p>
        <Select
          showSearch
          style={{ width: "100%" }}
          loading={createRequirementLoading}
          value={createRequirementProgramId}
          placeholder={t("myWork.selectProgram")}
          optionFilterProp="label"
          notFoundContent={createRequirementLoading ? <Spin size="small" /> : t("myWork.noWritableProgram")}
          onChange={setCreateRequirementProgramId}
          options={createRequirementPrograms.map((program) => ({
            value: program.programId,
            label: program.name || program.programCode || String(program.programId),
          }))}
        />
      </Modal>
    </div>
  );
}
