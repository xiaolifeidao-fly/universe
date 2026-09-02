"use client";

import {
  BranchesOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  PullRequestOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Select, Space, Table, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { getUserScopedStorageKey } from "@/utils/auth";
import {
  deleteTimePlan,
  fetchPrograms,
  fetchTimePlanRequirements,
  fetchTimePlans,
  type DeliveryProgramRecord,
  type DeliveryTimePlanRecord,
  type TimePlanMergeKind,
} from "@/api/delivery.api";
import { TimePlanFormModal } from "./TimePlanFormModal";
import { TimePlanMergeModal } from "./TimePlanMergeModal";

// 和看板、全景共用同一个记忆键：几个页面切来切去，选中的项目应该是同一个。
const PROGRAM_KEY = "zb.delivery.programId";

interface MergeContext {
  plan: DeliveryTimePlanRecord;
  kind: TimePlanMergeKind;
  target: string;
  sources: string[];
  emptyHint: string;
}

function formatDate(value?: string) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "—";
}

function formatDateTime(value?: string) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

/**
 * 时间计划页：按项目维护交付时间窗口，每个计划对应一条从基准分支切出的发布分支。
 *
 * 三个合并动作都只在这里发起，实际 Git 操作发生在本机桥接的项目工作目录里：
 *   - 回合基线：基线分支 → 计划分支，把主干最新拉进来
 *   - 合并需求：这个计划下所有需求分支 → 计划分支
 *   - 回推基线：计划分支 → 基线分支，验收完回归主干
 */
export function TimePlanWorkspace() {
  const { t } = useLocale();
  const { activeBusinessLine } = useBusinessLine();
  const bizLine = activeBusinessLine.id;
  const programStorageKey = getUserScopedStorageKey(PROGRAM_KEY);
  const [programs, setPrograms] = useState<DeliveryProgramRecord[]>([]);
  const [programId, setProgramId] = useState(0);
  const [plans, setPlans] = useState<DeliveryTimePlanRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DeliveryTimePlanRecord | null>(null);
  const [merge, setMerge] = useState<MergeContext | null>(null);
  // 正在为哪条计划准备合并：取需求分支要请求服务端，按钮上转一圈再开弹窗。
  const [preparingKey, setPreparingKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchPrograms(bizLine)
      .then((list) => {
        if (cancelled) return;
        setPrograms(list);
        const remembered = Number(programStorageKey ? window.sessionStorage.getItem(programStorageKey) : "");
        setProgramId(list.find((item) => item.programId === remembered)?.programId ?? list[0]?.programId ?? 0);
      })
      .catch((error: Error) => {
        if (!cancelled) message.error(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [bizLine, programStorageKey]);

  const program = useMemo(
    () => programs.find((item) => item.programId === programId) ?? null,
    [programId, programs],
  );

  const refresh = useCallback(async () => {
    if (!programId) {
      setPlans([]);
      return;
    }
    if (programStorageKey) window.sessionStorage.setItem(programStorageKey, String(programId));
    setLoading(true);
    try {
      const page = await fetchTimePlans({ programId });
      setPlans(page.data);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [programId, programStorageKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openMerge = async (plan: DeliveryTimePlanRecord, kind: TimePlanMergeKind) => {
    if (!plan.branch || !plan.baseBranch) {
      message.warning(t("timePlan.merge.noBranch"));
      return;
    }
    if (kind === "base") {
      setMerge({ plan, kind, target: plan.branch, sources: [plan.baseBranch], emptyHint: "" });
      return;
    }
    if (kind === "publish") {
      setMerge({ plan, kind, target: plan.baseBranch, sources: [plan.branch], emptyHint: "" });
      return;
    }
    setPreparingKey(plan.planKey);
    try {
      const requirements = await fetchTimePlanRequirements(plan.programId, plan.planKey);
      // 只有真正带分支的需求才谈得上合并；没开 Git 或还没建分支的需求跳过。
      const sources = Array.from(new Set(
        requirements
          .filter((requirement) => requirement.gitEnabled && requirement.gitBranch)
          .map((requirement) => requirement.gitBranch),
      ));
      setMerge({
        plan,
        kind,
        target: plan.branch,
        sources,
        emptyHint: t("timePlan.merge.noRequirementBranch"),
      });
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPreparingKey("");
    }
  };

  const remove = async (plan: DeliveryTimePlanRecord) => {
    try {
      await deleteTimePlan(plan.programId, plan.planKey);
      message.success(t("timePlan.deleted"));
      void refresh();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const columns = [
    {
      title: t("timePlan.field.name"),
      dataIndex: "name",
      key: "name",
      render: (_: string, record: DeliveryTimePlanRecord) => (
        <div>
          <div>{record.name}</div>
          <div className="manager-table-subline manager-mono">{record.planKey}</div>
        </div>
      ),
    },
    {
      title: t("timePlan.field.range"),
      key: "range",
      width: 210,
      render: (_: unknown, record: DeliveryTimePlanRecord) => (
        <span className="manager-mono">{`${formatDate(record.startAt)} ~ ${formatDate(record.endAt)}`}</span>
      ),
    },
    {
      title: t("timePlan.field.branch"),
      key: "branch",
      width: 260,
      render: (_: unknown, record: DeliveryTimePlanRecord) => (
        record.branch ? (
          <div>
            <div className="manager-mono">{record.branch}</div>
            <div className="manager-table-subline manager-mono">
              {t("timePlan.field.baseBranch")}: {record.baseBranch || "—"}
            </div>
          </div>
        ) : <Tag>{t("timePlan.noBranch")}</Tag>
      ),
    },
    {
      title: t("timePlan.field.requirementCount"),
      dataIndex: "requirementCount",
      key: "requirementCount",
      width: 110,
      render: (value: number) => <span className="manager-mono">{value}</span>,
    },
    {
      title: t("timePlan.field.lastMerges"),
      key: "lastMerges",
      width: 260,
      render: (_: unknown, record: DeliveryTimePlanRecord) => (
        <div className="manager-table-subline">
          <div>{t("timePlan.merge.action.base")}: {formatDateTime(record.baseSyncedAt)}</div>
          <div>{t("timePlan.merge.action.requirement")}: {formatDateTime(record.requirementMergedAt)}</div>
          <div>{t("timePlan.merge.action.publish")}: {formatDateTime(record.basePublishedAt)}</div>
        </div>
      ),
    },
    {
      title: t("timePlan.field.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (value: string) => (
        <Tag color={value === "active" ? "processing" : value === "done" ? "success" : "default"}>
          {t(`timePlan.status.${value}`)}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 250,
      render: (_: unknown, record: DeliveryTimePlanRecord) => (
        <Space size={4}>
          <Tooltip title={t("timePlan.merge.action.base")}>
            <Button
              size="small"
              icon={<MergeCellsOutlined />}
              disabled={!record.branch}
              onClick={() => void openMerge(record, "base")}
              aria-label={t("timePlan.merge.action.base")}
            />
          </Tooltip>
          <Tooltip title={t("timePlan.merge.action.requirement")}>
            <Button
              size="small"
              icon={<PullRequestOutlined />}
              disabled={!record.branch}
              loading={preparingKey === record.planKey}
              onClick={() => void openMerge(record, "requirement")}
              aria-label={t("timePlan.merge.action.requirement")}
            />
          </Tooltip>
          <Tooltip title={t("timePlan.merge.action.publish")}>
            <Button
              size="small"
              icon={<CloudUploadOutlined />}
              disabled={!record.branch}
              onClick={() => void openMerge(record, "publish")}
              aria-label={t("timePlan.merge.action.publish")}
            />
          </Tooltip>
          <Tooltip title={t("common.edit")}>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(record);
                setFormOpen(true);
              }}
              aria-label={t("common.edit")}
            />
          </Tooltip>
          <Popconfirm
            title={t("timePlan.delete.confirm")}
            description={t("timePlan.delete.hint")}
            okText={t("common.confirm")}
            cancelText={t("common.cancel")}
            onConfirm={() => void remove(record)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={t("common.delete")} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="manager-page-stack">
      <section className="manager-page-heading">
        <div>
          <div className="manager-section-label">TIME PLANS</div>
          <h1>{t("timePlan.title")}</h1>
          <p>{t("timePlan.intro")}</p>
        </div>
        <Tag className="manager-count-tag">{activeBusinessLine.code}</Tag>
      </section>

      <section className="manager-data-card">
        <div className="manager-table-heading">
          <div>
            <h2>{program?.name || t("timePlan.title")}</h2>
            <span>{activeBusinessLine.label}</span>
          </div>
          <Space>
            <Select
              style={{ minWidth: 220 }}
              value={programId || undefined}
              placeholder={t("timePlan.selectProgram")}
              onChange={setProgramId}
              options={programs.map((item) => ({ value: item.programId, label: item.name }))}
            />
            <Tooltip title={t("common.refresh")}>
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()} aria-label={t("common.refresh")} />
            </Tooltip>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!programId}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              {t("timePlan.new")}
            </Button>
          </Space>
        </div>
        {!programId ? (
          <Empty className="manager-empty-state" description={t("timePlan.selectProgram")} />
        ) : plans.length === 0 && !loading ? (
          <Empty className="manager-empty-state" description={t("timePlan.empty")} />
        ) : (
          <div className="manager-table">
            <Table<DeliveryTimePlanRecord>
              rowKey="planKey"
              loading={loading}
              columns={columns}
              dataSource={plans}
              pagination={false}
              scroll={{ x: 1280 }}
            />
          </div>
        )}
        {program && !program.gitEnabled ? (
          <div className="manager-table-subline">
            <BranchesOutlined /> {t("timePlan.form.gitDisabled")}
          </div>
        ) : null}
      </section>

      <TimePlanFormModal
        open={formOpen}
        programId={programId}
        plan={editing}
        plans={plans}
        gitEnabled={Boolean(program?.gitEnabled)}
        defaultBaseBranch={program?.gitBaseBranch ?? ""}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSaved={refresh}
      />

      <TimePlanMergeModal
        plan={merge?.plan ?? null}
        kind={merge?.kind ?? "base"}
        target={merge?.target ?? ""}
        sources={merge?.sources ?? []}
        emptyHint={merge?.emptyHint ?? ""}
        onClose={() => setMerge(null)}
        onMerged={refresh}
      />
    </div>
  );
}
