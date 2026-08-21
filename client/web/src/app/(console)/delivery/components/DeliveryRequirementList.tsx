"use client";

import {
	BranchesOutlined,
	ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
	HistoryOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PlusOutlined,
	ReloadOutlined,
  ShareAltOutlined,
	SearchOutlined,
	SwapOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Empty, Input, Popconfirm, Segmented, Select, Spin, Tag, Tooltip } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  REQUIREMENT_MODES,
  REQUIREMENT_STATUSES,
  type BoardGroupBy,
	type CodexGitWorkspaceStatus,
  type DeliveryModuleRecord,
  type DeliveryRequirementRecord,
  type DeliveryStageRecord,
  type RequirementMode,
  type RequirementStatus,
} from "@/api/delivery.api";
import { requirementMentionPlainText } from "./DeliveryRequirementDetailInput";

type RequirementView = "board" | "list";
type OwnerFilter = "" | "assigned" | "unassigned";

interface RequirementBoardColumn {
  key: string;
  label: string;
  requirements: DeliveryRequirementRecord[];
}

interface DeliveryRequirementListProps {
  requirements: DeliveryRequirementRecord[];
  loading: boolean;
  /** 需求隶属于项目，栏头把当前项目写出来，避免切了项目还以为在看上一份需求。 */
  programName: string;
  /** 空串表示尚未选中需求，右侧任务区保持空白。 */
  selectedKey: string;
  scope: "mine" | "";
  keyword: string;
  disabled: boolean;
  expanded: boolean;
  stageName: (stageKey: string) => string;
  moduleName: (moduleKey: string) => string;
  stages: DeliveryStageRecord[];
  modules: DeliveryModuleRecord[];
  onScopeChange: (scope: "mine" | "") => void;
  onKeywordChange: (keyword: string) => void;
  onExpandedChange: (expanded: boolean) => void;
  onSelect: (requirementKey: string) => void;
  /** 仅重置左侧需求查询条件，不能影响右侧正在查看的任务。 */
  onResetQuery: () => void;
  onShare: (requirement: DeliveryRequirementRecord) => void;
  onCreate: () => void;
  onEdit: (requirement: DeliveryRequirementRecord) => void;
  onTest: (requirement: DeliveryRequirementRecord) => void;
  /** 需求级大纲弹窗，可直接改并保存回工作区。 */
  onOutline: (requirement: DeliveryRequirementRecord) => void;
	/** 需求时间线包含需求本身及其下所有任务的变动。 */
  onTimeline: (requirement: DeliveryRequirementRecord) => void;
	/** 项目级 Git 关闭时，历史需求的分支信息也不能操作或展示。 */
	projectGitEnabled: boolean;
  /** 用户显式确认后才会进入分支切换步骤。 */
  onGitCheck: (requirement: DeliveryRequirementRecord) => void;
  gitWorkspaceStatus: CodexGitWorkspaceStatus | null;
  gitWorkspaceError: string;
  gitWorkspaceLoading: boolean;
  onStatusChange: (requirement: DeliveryRequirementRecord, status: RequirementStatus) => Promise<void>;
  onDelete: (requirementKey: string) => void;
}

export function DeliveryRequirementList({
  requirements,
  loading,
  programName,
  selectedKey,
  scope,
  keyword,
  disabled,
  expanded,
  stageName,
  moduleName,
  stages,
  modules,
  onScopeChange,
  onKeywordChange,
  onExpandedChange,
  onSelect,
  onResetQuery,
  onShare,
  onCreate,
  onEdit,
  onTest,
	onOutline,
	onTimeline,
	projectGitEnabled,
	onGitCheck,
	gitWorkspaceStatus,
	gitWorkspaceError,
	gitWorkspaceLoading,
  onStatusChange,
  onDelete,
}: DeliveryRequirementListProps) {
  const { t } = useLocale();
  const [expandedView, setExpandedView] = useState<RequirementView>("list");
  // 展开的需求看板默认沿用最容易判断推进情况的状态分列，也可切到项目结构分列。
  const [boardGroupBy, setBoardGroupBy] = useState<BoardGroupBy>("status");
  // 需求列表优先服务当前推进中的工作；展开后仍可按需切到其他状态或清除筛选。
  const [statusFilter, setStatusFilter] = useState<RequirementStatus | "">("open");
  const [stageFilter, setStageFilter] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [modeFilter, setModeFilter] = useState<RequirementMode | "">("");
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("");
  const [ownerIdFilter, setOwnerIdFilter] = useState("");
  const [changingStatusKey, setChangingStatusKey] = useState("");
  const [keywordDraft, setKeywordDraft] = useState(keyword);

  useEffect(() => {
    setKeywordDraft(keyword);
  }, [keyword]);

  const resetQueryConditions = () => {
    setStatusFilter("");
    setStageFilter("");
    setModuleFilter("");
    setModeFilter("");
    setOwnerFilter("");
    setOwnerIdFilter("");
    setKeywordDraft("");
    onResetQuery();
  };

  const ownerOptions = useMemo(() => {
    const owners = new Map<string, string>();
    requirements.forEach((requirement) => {
      (requirement.owners ?? []).forEach((owner) => {
        const id = owner.id || owner.name;
        if (id) owners.set(id, owner.name || owner.id);
      });
    });
    return Array.from(owners, ([value, label]) => ({ value, label }));
  }, [requirements]);

  // 卡片摘要里把 @需求键 还原成需求名，键本身对读的人没有意义。
  const requirementNameByKey = useMemo(
    () => new Map(requirements.map((requirement) => [requirement.requirementKey, requirement.name])),
    [requirements],
  );

  const visibleRequirements = useMemo(
    () => requirements.filter((requirement) => {
      if (statusFilter && requirement.status !== statusFilter) return false;
      if (stageFilter && requirement.stageKey !== stageFilter) return false;
      if (moduleFilter && requirement.moduleKey !== moduleFilter) return false;
      if (modeFilter && requirement.mode !== modeFilter) return false;
      if (ownerFilter === "assigned" && (requirement.owners ?? []).length === 0) return false;
      if (ownerFilter === "unassigned" && (requirement.owners ?? []).length > 0) return false;
      if (ownerIdFilter && !(requirement.owners ?? []).some((owner) => (owner.id || owner.name) === ownerIdFilter)) return false;
      return true;
    }),
    [modeFilter, moduleFilter, ownerFilter, ownerIdFilter, requirements, stageFilter, statusFilter],
  );

  const requirementBoardColumns = useMemo<RequirementBoardColumn[]>(() => {
    if (boardGroupBy === "status") {
      return REQUIREMENT_STATUSES.map((status) => ({
        key: status,
        label: t(`delivery.requirement.status.${status}`),
        requirements: visibleRequirements.filter((requirement) => requirement.status === status),
      }));
    }

    const isStage = boardGroupBy === "stage";
    const groups = isStage
      ? stages.map((stage) => ({
        key: stage.stageKey,
        label: stage.tag || stage.title || stage.stageKey,
      }))
      : modules.map((module) => ({
        key: module.moduleKey,
        label: module.name || module.moduleKey,
      }));
    const knownKeys = new Set(groups.map((group) => group.key));
    const groupKey = (requirement: DeliveryRequirementRecord) => (isStage ? requirement.stageKey : requirement.moduleKey);

    // 结构被调整后，历史需求不能因为原分组已经不存在而在看板中消失。
    visibleRequirements.forEach((requirement) => {
      const key = groupKey(requirement);
      if (!key || knownKeys.has(key)) return;
      knownKeys.add(key);
      groups.push({ key, label: isStage ? stageName(key) : moduleName(key) });
    });

    groups.push({ key: "", label: t("delivery.requirement.unassigned") });
    return groups.map((group) => ({
      ...group,
      requirements: visibleRequirements.filter((requirement) => groupKey(requirement) === group.key),
    }));
  }, [boardGroupBy, moduleName, modules, stageName, stages, t, visibleRequirements]);

	const gitStateOf = (requirement: DeliveryRequirementRecord) => {
		if (!projectGitEnabled || !requirement.gitEnabled || !requirement.gitBranch) return null;
		// current 表示这条需求的分支正是项目此刻所处的分支，卡片上要单独标出来。
		const base = { current: false, currentBranch: gitWorkspaceStatus?.currentBranch ?? "" };
		if (gitWorkspaceError) return { ...base, color: "default", label: t("delivery.requirement.gitState.unavailable") };
		if (!gitWorkspaceStatus) return { ...base, color: "default", label: t("delivery.requirement.gitState.pending") };
		if (gitWorkspaceStatus.detached) {
			return { ...base, currentBranch: "", color: "error", label: t("delivery.requirement.gitState.blocked") };
		}
		if (gitWorkspaceStatus.currentBranch !== requirement.gitBranch) {
			return { ...base, color: "warning", label: t("delivery.requirement.gitState.mismatch") };
		}
		if (gitWorkspaceStatus.dirty) return { ...base, current: true, color: "warning", label: t("delivery.requirement.gitState.dirty") };
		return { ...base, current: true, color: "success", label: t("delivery.requirement.gitState.ready") };
	};

  const renderRequirementCard = (requirement: DeliveryRequirementRecord, boardCard = false) => {
    const isSelected = requirement.requirementKey === selectedKey;
    const statusChanging = changingStatusKey === requirement.requirementKey;
		const gitState = gitStateOf(requirement);
    // 信息位省略了字段名、长值也会截断，悬停提示得把「字段名 + 完整取值」补回来。
    const ownerNames = (requirement.owners ?? []).map((member) => member.name).join("、") || t("delivery.requirement.unassigned");

    const changeStatus = async (status: RequirementStatus) => {
      if (status === requirement.status || statusChanging) return;
      setChangingStatusKey(requirement.requirementKey);
      try {
        await onStatusChange(requirement, status);
      } finally {
        setChangingStatusKey("");
      }
    };

    return (
      <div
        key={requirement.requirementKey}
        className={`delivery-requirement-card${isSelected ? " is-selected" : ""}${boardCard ? " is-board-card" : ""}`}
        // 消息中心跳过来时按这个属性把需求卡片滚进可视区。
        data-delivery-requirement-key={requirement.requirementKey}
        role="button"
        tabIndex={0}
        // 点卡片一律是「看这条需求」：再点一次也重新拉一次任务，不做取消选中。
        onClick={() => onSelect(requirement.requirementKey)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(requirement.requirementKey);
          }
        }}
      >
        <div className="delivery-requirement-card__head">
          <Tooltip title={requirement.name || requirement.requirementKey}>
            <b>{requirement.name || requirement.requirementKey}</b>
          </Tooltip>
        </div>
        <div
          className="delivery-requirement-card__actions"
          // 只有点在动作按钮上才拦下冒泡；动作行的空白处仍然算点中这条需求。
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) event.stopPropagation();
          }}
        >
			{gitState ? <Tooltip title={t("delivery.requirement.gitCheck")}>
				<Button
					type="text"
					size="small"
					shape="circle"
					icon={<BranchesOutlined />}
					loading={gitWorkspaceLoading}
					aria-label={t("delivery.requirement.gitCheck")}
					onClick={(event) => {
						event.stopPropagation();
						onGitCheck(requirement);
					}}
				/>
			</Tooltip> : null}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: REQUIREMENT_STATUSES.map((status) => ({
                key: status,
                label: t(`delivery.requirement.status.${status}`),
                disabled: status === requirement.status || statusChanging,
              })),
              onClick: ({ key }) => void changeStatus(key as RequirementStatus),
            }}
          >
            <Tooltip title={t("delivery.requirement.quickStatus")}>
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={<SwapOutlined />}
                loading={statusChanging}
                disabled={disabled}
                aria-label={t("delivery.requirement.quickStatus")}
              />
            </Tooltip>
          </Dropdown>
          <Tooltip title={t("delivery.requirement.startTesting")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={<ExperimentOutlined />}
              disabled={disabled}
              aria-label={t("delivery.requirement.startTesting")}
              onClick={(event) => {
                event.stopPropagation();
                onTest(requirement);
              }}
            />
          </Tooltip>
          <Tooltip title={t("delivery.requirement.viewTimeline")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={<HistoryOutlined />}
              aria-label={t("delivery.requirement.viewTimeline")}
              onClick={(event) => {
                event.stopPropagation();
                onTimeline(requirement);
              }}
            />
          </Tooltip>
          <Tooltip title={t("delivery.requirement.shareLink")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={<ShareAltOutlined />}
              aria-label={t("delivery.requirement.shareLink")}
              onClick={(event) => {
                event.stopPropagation();
                onShare(requirement);
              }}
            />
          </Tooltip>
          <Tooltip title={t("delivery.requirement.outline")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={<FileTextOutlined />}
              aria-label={t("delivery.requirement.outline")}
              onClick={(event) => {
                event.stopPropagation();
                onOutline(requirement);
              }}
            />
          </Tooltip>
          <Tooltip title={t("delivery.requirement.edit")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={<EditOutlined />}
              aria-label={t("delivery.requirement.edit")}
              onClick={(event) => {
                event.stopPropagation();
                onEdit(requirement);
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t("delivery.requirement.deleteConfirm")}
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(requirement.requirementKey)}
          >
            <Tooltip title={t("delivery.requirement.delete")}>
              <Button
                danger
                type="text"
                size="small"
                shape="circle"
                icon={<DeleteOutlined />}
                aria-label={t("delivery.requirement.delete")}
                onClick={(event) => event.stopPropagation()}
              />
            </Tooltip>
          </Popconfirm>
        </div>
		<div className="delivery-requirement-card__details" aria-label={t("delivery.requirement.list")}>
		  <span className="delivery-requirement-card__detail delivery-requirement-card__detail--owner" title={`${t("delivery.requirement.owners")}: ${ownerNames}`}>
			<UserOutlined aria-hidden="true" />
			<span className="delivery-requirement-card__detail-copy">
			  <b>{ownerNames}</b>
			</span>
		  </span>
		  <span className={`delivery-requirement-card__detail delivery-requirement-card__detail--status-${requirement.status}`} title={`${t("delivery.requirement.status")}: ${t(`delivery.requirement.status.${requirement.status}`)}`}>
			<span className="delivery-requirement-card__status-dot" aria-hidden="true" />
			<span className="delivery-requirement-card__detail-copy">
			  <b>{t(`delivery.requirement.status.${requirement.status}`)}</b>
			</span>
		  </span>
		  {requirement.createdAt ? (
			<span className="delivery-requirement-card__detail delivery-requirement-card__detail--time" title={`${t("delivery.requirement.createdAt")}: ${dayjs(requirement.createdAt).format("YYYY-MM-DD HH:mm")}`}>
			  <ClockCircleOutlined aria-hidden="true" />
			  <span className="delivery-requirement-card__detail-copy">
				<b>{dayjs(requirement.createdAt).format("MM-DD HH:mm")}</b>
			  </span>
			</span>
		  ) : null}
		  {gitState && requirement.gitBranch ? (
			/* 分支名在胶囊里会被截断，用悬浮框给出完整分支名和当前工作区状态。 */
			<Tooltip
			  title={(
				<span className="delivery-requirement-card__branch-tip">
				  <em>{t("delivery.requirement.gitBranch")}</em>
				  <code className="manager-mono">{requirement.gitBranch}</code>
				  <b>{gitState.label}</b>
				  {/* 分支不一致时，光说「不一致」没用，得指出项目此刻停在哪条分支。 */}
				  {gitState.currentBranch ? (
					<span className="delivery-requirement-card__branch-tip-current">
					  <em>{t("delivery.requirement.gitCurrentBranch")}</em>
					  <code className="manager-mono">{gitState.currentBranch}</code>
					</span>
				  ) : null}
				</span>
			  )}
			>
			  <span className="delivery-requirement-card__detail delivery-requirement-card__detail--branch">
				<BranchesOutlined aria-hidden="true" />
				<span className="delivery-requirement-card__detail-copy">
				  <code className="manager-mono">{requirement.gitBranch}</code>
				</span>
				{gitState.current ? (
				  <Tag color="processing" bordered={false}>{t("delivery.requirement.gitCurrentBranchTag")}</Tag>
				) : null}
				<Tag color={gitState.color} bordered={false}>{gitState.label}</Tag>
			  </span>
			</Tooltip>
		  ) : null}
		</div>
        {boardCard && requirement.detail ? <p className="delivery-requirement-card__brief">{requirementMentionPlainText(requirement.detail, requirementNameByKey)}</p> : null}
      </div>
    );
  };

  return (
    <aside
      className={`delivery-requirement-rail${expanded ? " is-expanded" : ""}`}
      aria-label={t("delivery.requirement.list")}
    >
      <header className="delivery-requirement-rail__header">
        <div>
          <h3>{t("delivery.requirement.list")}</h3>
          {programName ? <small>{programName}</small> : null}
        </div>
        <div className="delivery-requirement-rail__header-actions">
          <Tooltip title={expanded ? t("delivery.requirement.collapseList") : t("delivery.requirement.expandList")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              aria-label={expanded ? t("delivery.requirement.collapseList") : t("delivery.requirement.expandList")}
              aria-pressed={expanded}
              onClick={() => onExpandedChange(!expanded)}
            />
          </Tooltip>
          <Tooltip title={t("delivery.requirement.new")}>
            <Button
              type="primary"
              size="small"
              shape="circle"
              icon={<PlusOutlined />}
              disabled={disabled}
              aria-label={t("delivery.requirement.new")}
              onClick={onCreate}
            />
          </Tooltip>
        </div>
      </header>
      <div className="delivery-requirement-rail__filters">
        <div className="delivery-requirement-rail__filters-base">
          <Segmented
            size="small"
            value={scope}
            onChange={(value) => onScopeChange(value as "mine" | "")}
            options={[
              { label: t("delivery.requirement.mine"), value: "mine" },
              { label: t("delivery.requirement.scopeAll"), value: "" },
            ]}
          />
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder={t("delivery.requirement.search")}
            value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            onPressEnter={() => onKeywordChange(keywordDraft)}
            onBlur={() => onKeywordChange(keywordDraft)}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={resetQueryConditions}
          >
            {t("delivery.requirement.resetQuery")}
          </Button>
        </div>
        {expanded ? (
          <div className="delivery-requirement-rail__expanded-tools">
            <Segmented
              value={expandedView}
              onChange={(value) => setExpandedView(value as RequirementView)}
              options={[
                { label: t("delivery.requirement.view.board"), value: "board" },
                { label: t("delivery.requirement.view.list"), value: "list" },
              ]}
            />
            {expandedView === "board" ? (
              <Segmented
                value={boardGroupBy}
                onChange={(value) => setBoardGroupBy(value as BoardGroupBy)}
                options={[
                  { label: t("delivery.groupBy.status"), value: "status" },
                  { label: t("delivery.groupBy.module"), value: "module" },
                  { label: t("delivery.groupBy.stage"), value: "stage" },
                ]}
              />
            ) : null}
            <Select
              allowClear
              value={statusFilter || undefined}
              placeholder={t("delivery.requirement.filterStatus")}
              onChange={(value) => setStatusFilter((value ?? "") as RequirementStatus | "")}
              options={REQUIREMENT_STATUSES.map((status) => ({ value: status, label: t(`delivery.requirement.status.${status}`) }))}
            />
            <Select
              allowClear
              value={stageFilter || undefined}
              placeholder={t("delivery.requirement.filterStage")}
              onChange={(value) => setStageFilter(value ?? "")}
              options={stages.map((stage) => ({ value: stage.stageKey, label: stage.tag || stage.title || stage.stageKey }))}
            />
            <Select
              allowClear
              value={moduleFilter || undefined}
              placeholder={t("delivery.requirement.filterModule")}
              onChange={(value) => setModuleFilter(value ?? "")}
              options={modules.map((module) => ({ value: module.moduleKey, label: module.name || module.moduleKey }))}
            />
            <Select
              allowClear
              value={modeFilter || undefined}
              placeholder={t("delivery.requirement.filterMode")}
              onChange={(value) => setModeFilter((value ?? "") as RequirementMode | "")}
              options={REQUIREMENT_MODES.map((mode) => ({ value: mode, label: t(`delivery.requirement.mode.${mode}`) }))}
            />
            <Select
              allowClear
              value={ownerFilter || undefined}
              placeholder={t("delivery.requirement.filterOwnerState")}
              onChange={(value) => setOwnerFilter((value ?? "") as OwnerFilter)}
              options={[
                { value: "assigned", label: t("delivery.requirement.ownerAssigned") },
                { value: "unassigned", label: t("delivery.requirement.ownerUnassigned") },
              ]}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              value={ownerIdFilter || undefined}
              placeholder={t("delivery.requirement.filterOwner")}
              onChange={(value) => setOwnerIdFilter(value ?? "")}
              options={ownerOptions}
            />
          </div>
        ) : null}
      </div>
      <Spin spinning={loading}>
        <div className="delivery-requirement-rail__list">
          {expanded ? (
            <div className="delivery-requirement-rail__result-bar">
              <span>{t("delivery.requirement.resultCount").replace("{count}", String(visibleRequirements.length))}</span>
            </div>
          ) : null}
          {(!expanded || expandedView === "list") ? (
            <>
              {visibleRequirements.map((requirement) => renderRequirementCard(requirement))}
            </>
          ) : (
            <div className="delivery-requirement-kanban">
              {requirementBoardColumns.map((column) => {
                const columnRequirements = column.requirements;
                return (
                  <section
                    key={column.key || "unassigned"}
                    className={`delivery-requirement-kanban__column${boardGroupBy === "status" ? ` is-${column.key}` : ""}`}
                  >
                    <header>
                      <span>{column.label}</span>
                      <b>{columnRequirements.length}</b>
                    </header>
                    <div>
                      {columnRequirements.map((requirement) => renderRequirementCard(requirement, true))}
                      {!columnRequirements.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.emptyColumn")} /> : null}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          {!visibleRequirements.length && !loading ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={requirements.length ? t("delivery.requirement.noMatch") : t("delivery.requirement.empty")}
            />
          ) : null}
        </div>
      </Spin>
    </aside>
  );
}
