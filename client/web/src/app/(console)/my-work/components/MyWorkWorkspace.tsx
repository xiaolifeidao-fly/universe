"use client";

import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import {
  deleteItem,
  deleteRequirement,
  fetchCodexGitWorkspaceStatus,
  REQUIREMENT_STATUSES,
  updateRequirementStatus,
  type DeliveryItemRecord,
  type DeliveryRequirementRecord,
  type RequirementStatus,
} from "@/api/delivery.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { getAuthUser } from "@/utils/auth";
import { copyTextToClipboard } from "@/utils/clipboard";
import { requirementMentionPlainText } from "../../delivery/components/DeliveryRequirementDetailInput";
import { DeliveryRequirementAssignModal } from "../../delivery/components/DeliveryRequirementAssignModal";
import { DeliveryRequirementGitCheckModal } from "../../delivery/components/DeliveryRequirementGitCheckModal";
import { DeliveryRequirementTimelineDrawer } from "../../delivery/components/DeliveryRequirementTimelineDrawer";
import { DeliveryRequirementOutlineModal } from "../../delivery/components/DeliveryTaskOutline";
import { DeliveryRequirementSessionModal } from "../../delivery/components/DeliveryRequirementSessionModal";
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
  // 就地打开的需求弹窗：卡片本身不跳转，只有「跳转看板」才离开工作台。
  const [sessionRecord, setSessionRecord] = useState<MyWorkRequirement | null>(null);
  // 新增需求同样在工作台就地打开：此时 sessionRecord 为空，只有项目上下文。
  const [sessionProgram, setSessionProgram] = useState<MyWorkSessionProgram | null>(null);
  const [sessionContext, setSessionContext] = useState<MyWorkProgramContext | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [outlineRecord, setOutlineRecord] = useState<MyWorkRequirement | null>(null);
  // 快速指派：只改负责人与协助人，不进需求编辑窗口。
  const [assignRecord, setAssignRecord] = useState<MyWorkRequirement | null>(null);
  const [timelineRecord, setTimelineRecord] = useState<MyWorkRequirement | null>(null);
  const [gitRecord, setGitRecord] = useState<MyWorkRequirement | null>(null);
  // 正在改状态的需求键：同一张卡片上的状态按钮转圈，别把整页都锁住。
  const [changingStatusKey, setChangingStatusKey] = useState("");
  // 需求弹窗是否一打开就进总体测试：工作台的「开始测试」和需求列表同一个入口。
  const [sessionStartTesting, setSessionStartTesting] = useState(false);
  const [outlineBridgeReady, setOutlineBridgeReady] = useState(false);
  const [workType, setWorkType] = useState<MyWorkType>("created");
  // 列表筛选：项目默认「所有项目」，关键词按需求名称（含需求编号）模糊匹配。
  const [programFilter, setProgramFilter] = useState<number | "all">("all");
  const [keyword, setKeyword] = useState("");
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

  /**
   * 与需求列表同一套判定：先看项目和需求是否都开了 Git，再拿工作区当前分支比对。
   * 分支不一致只是提示，不阻断任何操作。
   */
  const gitStateOf = useCallback((record: MyWorkRequirement) => {
    if (!record.programGitEnabled || !record.gitEnabled || !record.gitBranch) return null;
    const workspace = gitWorkspaces.get(record.programId);
    const base = { current: false, currentBranch: workspace?.status?.currentBranch ?? "" };
    if (workspace?.error) return { ...base, tone: "is-idle", label: t("delivery.requirement.gitState.unavailable") };
    if (!workspace?.status) return { ...base, tone: "is-idle", label: t("delivery.requirement.gitState.pending") };
    if (workspace.status.detached) {
      return { ...base, currentBranch: "", tone: "is-danger", label: t("delivery.requirement.gitState.blocked") };
    }
    if (workspace.status.currentBranch !== record.gitBranch) {
      return { ...base, tone: "is-warning", label: t("delivery.requirement.gitState.mismatch") };
    }
    if (workspace.status.dirty) return { ...base, current: true, tone: "is-warning", label: t("delivery.requirement.gitState.dirty") };
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

  const filtering = programFilter !== "all" || Boolean(keyword.trim());

  /** 项目与关键词是列表的统一入口条件：统计和身份分组都基于筛选后的这批需求。 */
  const filteredRecords = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return records.filter((record) => {
      if (programFilter !== "all" && record.programId !== programFilter) return false;
      if (!query) return true;
      return (record.name || "").toLowerCase().includes(query)
        || record.requirementKey.toLowerCase().includes(query);
    });
  }, [keyword, programFilter, records]);

  /** 顶部统计只描述当前空间已加载并通过筛选的这批需求，不额外请求聚合接口。 */
  const stats = useMemo(() => ({
    total: filteredRecords.length,
    programs: new Set(filteredRecords.map((record) => record.programId)).size,
    created: filteredRecords.filter((record) => record.createdBy === userId).length,
    owner: filteredRecords.filter((record) => includesCurrentUser(record.owners, userId)).length,
    assistant: filteredRecords.filter((record) => includesCurrentUser(record.assistants, userId)).length,
  }), [filteredRecords, userId]);

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
   * 快速改状态走只改状态的接口：整条需求保存会把这里没带上的字段（例如计划起止时间）一并覆盖。
   * 改完整表重取——需求可能因此不再是「进行中」，工作台就不该继续留着它。
   */
  const handleStatusChange = useCallback(async (record: MyWorkRequirement, status: RequirementStatus) => {
    if (record.status === status) return;
    setChangingStatusKey(record.requirementKey);
    try {
      await updateRequirementStatus(record.programId, record.requirementKey, status, record.version);
      message.success(t("delivery.requirement.statusUpdated"));
      setReloadKey((value) => value + 1);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setChangingStatusKey("");
    }
  }, [t]);

  const handleDeleteRequirement = useCallback(async (record: MyWorkRequirement) => {
    try {
      await deleteRequirement(record.programId, record.requirementKey);
      message.success(t("delivery.requirement.deleted"));
      setReloadKey((value) => value + 1);
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [t]);

  /** Git 弹窗要的是这条需求所属项目的最新工作区状态，顺带更新卡片上的分支提示。 */
  const refreshGitWorkspace = useCallback(async (programId: number) => {
    if (!programId) return null;
    try {
      const status = await fetchCodexGitWorkspaceStatus(programId);
      setGitWorkspaces((current) => new Map(current).set(programId, { status, error: "" }));
      return status;
    } catch (error) {
      setGitWorkspaces((current) => new Map(current).set(programId, { status: null, error: (error as Error).message }));
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
        </div>
      </header>

      {loading ? (
        <div className="my-work-loading"><Spin /></div>
      ) : sortedRecords.length ? (
        <section className="my-work-grid" aria-label={t("myWork.list")}>
          {sortedRecords.map((record) => {
            const gitState = gitStateOf(record);
            return (
              <article
                className="my-work-card"
                key={`${record.bizLine}:${record.programId}:${record.requirementKey}`}
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
                    <Tooltip title={t("myWork.chat")}>
                      <Button
                        aria-label={t("myWork.chat")}
                        type="text"
                        size="small"
                        icon={<MessageOutlined />}
                        loading={sessionLoading && sessionRecord?.requirementKey === record.requirementKey}
                        onClick={() => void openSession(record)}
                      />
                    </Tooltip>
                    {gitState ? (
                      <Tooltip title={t("delivery.requirement.gitCheck")}>
                        <Button
                          aria-label={t("delivery.requirement.gitCheck")}
                          type="text"
                          size="small"
                          icon={<BranchesOutlined />}
                          loading={gitLoading}
                          onClick={() => setGitRecord(record)}
                        />
                      </Tooltip>
                    ) : null}
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
                    <Tooltip title={t("delivery.requirement.startTesting")}>
                      <Button
                        aria-label={t("delivery.requirement.startTesting")}
                        type="text"
                        size="small"
                        icon={<ExperimentOutlined />}
                        onClick={() => void openSession(record, true)}
                      />
                    </Tooltip>
                    <Tooltip title={t("delivery.requirement.viewTimeline")}>
                      <Button
                        aria-label={t("delivery.requirement.viewTimeline")}
                        type="text"
                        size="small"
                        icon={<HistoryOutlined />}
                        onClick={() => setTimelineRecord(record)}
                      />
                    </Tooltip>
                    <Tooltip title={t("delivery.requirement.shareLink")}>
                      <Button
                        aria-label={t("delivery.requirement.shareLink")}
                        type="text"
                        size="small"
                        icon={<ShareAltOutlined />}
                        onClick={() => void handleShare(record)}
                      />
                    </Tooltip>
                    <Tooltip title={t("delivery.requirement.outline")}>
                      <Button aria-label={t("delivery.requirement.outline")} type="text" size="small" icon={<FileTextOutlined />} onClick={() => void openOutline(record)} />
                    </Tooltip>
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
                  </div>
                  <Button
                    className="my-work-card__board-link"
                    type="link"
                    size="small"
                    icon={<ArrowRightOutlined />}
                    onClick={() => openBoard(record)}
                  >
                    {t("myWork.openBoard")}
                  </Button>
                </footer>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="manager-data-card my-work-empty">
          <Empty description={filtering ? t("myWork.emptyBySearch") : t(`myWork.empty.${workType}`)} />
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

      <DeliveryRequirementTimelineDrawer
        open={Boolean(timelineRecord)}
        programId={timelineRecord?.programId ?? 0}
        requirement={timelineRecord}
        onClose={() => setTimelineRecord(null)}
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
