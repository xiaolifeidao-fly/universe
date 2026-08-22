"use client";

import {
  AppstoreOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  ExportOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  MessageOutlined,
  ReloadOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Button, Empty, Segmented, Spin, Tooltip, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAIPreferences } from "@/ai-preferences/AIPreferencesProvider";
import { deleteItem, type DeliveryItemRecord, type DeliveryRequirementRecord } from "@/api/delivery.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { getAuthUser } from "@/utils/auth";
import { copyTextToClipboard } from "@/utils/clipboard";
import { requirementMentionPlainText } from "../../delivery/components/DeliveryRequirementDetailInput";
import { DeliveryRequirementOutlineModal } from "../../delivery/components/DeliveryTaskOutline";
import { DeliveryRequirementSessionModal } from "../../delivery/components/DeliveryRequirementSessionModal";
import {
  fetchMyWorkGitWorkspaces,
  fetchMyWorkProgramContext,
  fetchMyWorkRequirements,
  type MyWorkGitWorkspace,
  type MyWorkProgramContext,
  type MyWorkRequirement,
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
  const [sessionContext, setSessionContext] = useState<MyWorkProgramContext | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [outlineRecord, setOutlineRecord] = useState<MyWorkRequirement | null>(null);
  const [outlineBridgeReady, setOutlineBridgeReady] = useState(false);
  const [sortBy, setSortBy] = useState<"created" | "program">("created");
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

  /** 顶部统计只描述当前空间已加载的这批需求，不额外请求聚合接口。 */
  const stats = useMemo(() => ({
    total: records.length,
    programs: new Set(records.map((record) => record.programId)).size,
    owner: records.filter((record) => record.owners.some((member) => String(member.id) === userId)).length,
    assistant: records.filter((record) => record.assistants.some((member) => String(member.id) === userId)).length,
  }), [records, userId]);

  const sortedRecords = useMemo(() => {
    const list = [...records];
    if (sortBy === "program") {
      // 同一项目内仍按创建时间倒序，方便顺着项目一条条往下看。
      return list.sort((left, right) => (left.programName || "").localeCompare(right.programName || "", locale)
        || (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
    }
    return list.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  }, [locale, records, sortBy]);

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

  const openSession = useCallback(async (record: MyWorkRequirement) => {
    setSessionRecord(record);
    setSessionContext(null);
    setSessionLoading(true);
    try {
      setSessionContext(await fetchMyWorkProgramContext(record.programId, record.requirementKey, preferences.globalTool));
    } catch (error) {
      setSessionRecord(null);
      message.error((error as Error).message);
    } finally {
      setSessionLoading(false);
    }
  }, [preferences.globalTool]);

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
    if (!sessionRecord) return false;
    try {
      await deleteItem(sessionRecord.programId, itemKey);
      const next = await fetchMyWorkProgramContext(sessionRecord.programId, sessionRecord.requirementKey, preferences.globalTool);
      setSessionContext(next);
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    }
  }, [preferences.globalTool, sessionRecord]);

  const handleRequirementSaved = useCallback((requirement: DeliveryRequirementRecord) => {
    setSessionRecord((current) => (current
      ? Object.assign(Object.create(Object.getPrototypeOf(current)), current, requirement) as MyWorkRequirement
      : current));
    setReloadKey((value) => value + 1);
  }, []);

  return (
    <div className="manager-page-stack my-work-page">
      <div className="my-work-stats">
        <div className="my-work-stats__figures">
          <div className="my-work-stat is-primary">
            <b className="manager-mono">{stats.total}</b>
            <span>{t("myWork.openCount")}</span>
          </div>
          <div className="my-work-stat">
            <b className="manager-mono">{stats.programs}</b>
            <span>{t("myWork.statPrograms")}</span>
          </div>
          <div className="my-work-stat">
            <b className="manager-mono">{stats.owner}</b>
            <span>{t("myWork.statOwner")}</span>
          </div>
          <div className="my-work-stat">
            <b className="manager-mono">{stats.assistant}</b>
            <span>{t("myWork.statAssistant")}</span>
          </div>
        </div>
        <div className="my-work-stats__tools">
          <span className="my-work-stats__space">
            <AppstoreOutlined />
            {activeBusinessLine.label || activeBusinessLine.id}
            <code className="manager-mono">{activeBusinessLine.code || activeBusinessLine.id}</code>
          </span>
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
              className="my-work-stats__refresh"
              icon={<ReloadOutlined />}
              loading={loading || gitLoading}
              size="small"
              type="text"
              onClick={() => setReloadKey((value) => value + 1)}
            />
          </Tooltip>
        </div>
      </div>

      {loading ? (
        <div className="my-work-loading"><Spin /></div>
      ) : records.length ? (
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
                  <Tooltip title={t("delivery.requirement.outline")}>
                    <Button aria-label={t("delivery.requirement.outline")} type="text" size="small" icon={<FileTextOutlined />} onClick={() => void openOutline(record)} />
                  </Tooltip>
                  <Tooltip title={t("myWork.openBoard")}>
                    <Button aria-label={t("myWork.openBoard")} type="text" size="small" icon={<ExportOutlined />} onClick={() => openBoard(record)} />
                  </Tooltip>
                </footer>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="manager-data-card my-work-empty">
          <Empty description={t("myWork.empty")} />
        </section>
      )}

      <DeliveryRequirementOutlineModal
        open={Boolean(outlineRecord)}
        programId={outlineRecord?.programId ?? 0}
        requirement={outlineRecord}
        codexBridgeReady={outlineBridgeReady}
        onClose={() => setOutlineRecord(null)}
      />

      {sessionRecord && sessionContext ? (
        <DeliveryRequirementSessionModal
          open
          requirement={sessionRecord}
          programId={sessionRecord.programId}
          programName={sessionRecord.programName}
          projectGitEnabled={sessionRecord.programGitEnabled}
          projectGitBaseBranch={sessionRecord.programGitBaseBranch}
          bizLine={sessionRecord.bizLine}
          stages={sessionContext.stages}
          modules={sessionContext.modules}
          itemCatalog={sessionContext.itemCatalog}
          requirements={sessionContext.requirements}
          codexBridgeReady={sessionContext.codexBridgeReady}
          onClose={() => {
            setSessionRecord(null);
            setSessionContext(null);
          }}
          onOpenItem={(item: DeliveryItemRecord) => {
            const target = sessionRecord;
            setSessionRecord(null);
            setSessionContext(null);
            openBoard(target, item.itemKey);
          }}
          onDeleteItem={handleDeleteItem}
          onShare={handleShare}
          onRequirementSaved={handleRequirementSaved}
          onChanged={() => setReloadKey((value) => value + 1)}
        />
      ) : null}
    </div>
  );
}
