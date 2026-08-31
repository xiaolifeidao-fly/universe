"use client";

import { BranchesOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Modal, Space, Spin, Table, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  effortForConfig,
  modelForConfig,
  toolDisplayName,
  useAIPreferences,
} from "@/ai-preferences/AIPreferencesProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchCodexGitMergePreview,
  mergeCodexGitBranches,
  recordTimePlanMerge,
  type CodexGitMergeProject,
  type CodexGitMergeResolution,
  type CodexGitMergeResult,
  type DeliveryTimePlanRecord,
  type TimePlanMergeKind,
} from "@/api/delivery.api";

interface TimePlanMergeModalProps {
  /** 为空表示弹窗关闭。 */
  plan: DeliveryTimePlanRecord | null;
  kind: TimePlanMergeKind;
  /** 目标分支：回合基线与合并需求是计划分支，回推基线是基准分支。 */
  target: string;
  /** 来源分支：回合基线是基准分支，合并需求是各需求分支，回推基线是计划分支。 */
  sources: string[];
  /** 来源分支为空时的提示语，例如「这个计划下还没有带分支的需求」。 */
  emptyHint?: string;
  onClose: () => void;
  /** 合并成功后刷新计划列表。 */
  onMerged: () => void;
}

/**
 * 时间计划的分支合并弹窗，三个方向共用：
 *   - base        基线分支 → 计划分支
 *   - requirement 各需求分支 → 计划分支
 *   - publish     计划分支 → 基线分支
 *
 * 先出一份预览：根工作目录和每个子项目各自会动多少文件、有没有这条分支。用户勾选参与的
 * 工程后再真正合并，冲突交给 AI 解决，解决说明留在弹窗里，不用一闪而过的 toast 交代。
 */
export function TimePlanMergeModal({
  plan,
  kind,
  target,
  sources,
  emptyHint = "",
  onClose,
  onMerged,
}: TimePlanMergeModalProps) {
  const { t } = useLocale();
  const { configFor } = useAIPreferences();
  // 解冲突要改代码，按「动作执行」那一档的模型和思考强度走。
  const mergeConfig = configFor("actionExecution");
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [projects, setProjects] = useState<CodexGitMergeProject[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [result, setResult] = useState<CodexGitMergeResult | null>(null);
  const [mergeError, setMergeError] = useState("");

  const open = Boolean(plan) && Boolean(target);

  const loadPreview = useCallback(async () => {
    if (!plan || !target || !sources.length) {
      setProjects([]);
      setSelected([]);
      return;
    }
    setLoading(true);
    setPreviewError("");
    try {
      const preview = await fetchCodexGitMergePreview(plan.programId, target, sources);
      setProjects(preview.projects);
      // 默认勾上真正有东西可合的工程：没有目标分支、读不动或本来就是最新的都不预选。
      setSelected(preview.projects
        .filter((project) => !project.error && project.hasTarget && project.changedFiles > 0)
        .map((project) => project.path));
    } catch (error) {
      setProjects([]);
      setSelected([]);
      setPreviewError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [plan, sources, target]);

  useEffect(() => {
    if (!open) return;
    // 换一个计划或换一个方向重新打开时，上一轮的结果和错误都不该留着。
    setResult(null);
    setMergeError("");
    void loadPreview();
  }, [loadPreview, open]);

  const rootSelected = selected.includes("");
  const subprojectTargets = useMemo(() => selected.filter((path) => path), [selected]);

  const merge = async () => {
    if (!plan || merging || !selected.length) return;
    setMerging(true);
    setMergeError("");
    setResult(null);
    try {
      const outcome = await mergeCodexGitBranches(plan.programId, target, sources, {
        targets: subprojectTargets,
        skipRoot: !rootSelected,
        provider: mergeConfig.tool,
        model: modelForConfig(mergeConfig),
        reasoningEffort: effortForConfig(mergeConfig),
        fastMode: mergeConfig.tool === "claude" && mergeConfig.claudeFastMode,
      });
      setResult(outcome);
      if (outcome.failed.length) {
        // 部分工程失败仍然是 200：把失败的工程名留在弹窗里，别让整体成功掩盖掉。
        setMergeError(
          `${t("timePlan.merge.partialFailed")}：${outcome.failed.join("、")}`,
        );
      } else {
        // 全部成功才记录这次合并事实；记录失败不该让用户以为合并本身没成。
        try {
          await recordTimePlanMerge(plan.programId, plan.planKey, kind);
        } catch (error) {
          message.warning((error as Error).message);
        }
        message.success(t("timePlan.merge.succeeded"));
      }
      onMerged();
      void loadPreview();
    } catch (error) {
      setMergeError((error as Error).message);
    } finally {
      setMerging(false);
    }
  };

  const resolutions = useMemo<CodexGitMergeResolution[]>(
    () => (result?.results ?? []).flatMap((project) => project.resolutions),
    [result],
  );

  const columns = [
    {
      title: t("timePlan.merge.project"),
      dataIndex: "name",
      key: "name",
      render: (_: string, record: CodexGitMergeProject) => (
        <div>
          <div>
            {record.path ? record.name : t("timePlan.merge.rootProject")}
            {record.dirty ? (
              <Tooltip title={t("timePlan.merge.dirtyHint")}>
                <Tag color="warning" style={{ marginLeft: 8 }}>{t("timePlan.merge.dirty")}</Tag>
              </Tooltip>
            ) : null}
          </div>
          <div className="manager-table-subline manager-mono">
            {record.path || record.workspace}
          </div>
        </div>
      ),
    },
    {
      title: t("timePlan.merge.targetBranch"),
      dataIndex: "hasTarget",
      key: "hasTarget",
      width: 200,
      render: (_: boolean, record: CodexGitMergeProject) => (
        record.error
          ? <Tag color="error">{t("timePlan.merge.unreadable")}</Tag>
          : record.hasTarget
            ? <span className="manager-mono">{record.targetRef}</span>
            : <Tag>{t("timePlan.merge.noTargetBranch")}</Tag>
      ),
    },
    {
      title: t("timePlan.merge.changedFiles"),
      dataIndex: "changedFiles",
      key: "changedFiles",
      width: 120,
      render: (value: number) => <span className="manager-mono">{value}</span>,
    },
    {
      title: t("timePlan.merge.sourceBranches"),
      dataIndex: "sources",
      key: "sources",
      render: (_: unknown, record: CodexGitMergeProject) => (
        <Space size={4} wrap>
          {record.sources.map((source) => (
            <Tooltip
              key={source.branch}
              title={source.exists
                ? `${source.branch} · ${t("timePlan.merge.changedFiles")} ${source.changedFiles} · ${t("timePlan.merge.commits")} ${source.commits}`
                : t("timePlan.merge.sourceMissing")}
            >
              <Tag color={source.exists ? (source.commits ? "processing" : "default") : "default"}>
                {source.branch}
                {source.exists ? ` · ${source.changedFiles}` : ""}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
  ];

  const title = t(`timePlan.merge.title.${kind}`).replace("{plan}", plan?.name ?? "");

  return (
    <Modal
      wrapClassName="manager-form-skin"
      open={open}
      destroyOnClose
      width={960}
      title={title}
      onCancel={onClose}
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} disabled={loading || merging} onClick={() => void loadPreview()}>
          {t("timePlan.merge.refresh")}
        </Button>,
        <Button key="close" onClick={onClose}>{t("common.close")}</Button>,
        <Button
          key="merge"
          type="primary"
          icon={<BranchesOutlined />}
          loading={merging}
          disabled={loading || !selected.length}
          onClick={() => void merge()}
        >
          {t("timePlan.merge.confirm")}
        </Button>,
      ]}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message={t(`timePlan.merge.hint.${kind}`)
            .replace("{target}", target)
            .replace("{sources}", sources.join("、"))}
          description={t("timePlan.merge.conflictHint").replace("{tool}", toolDisplayName(mergeConfig.tool))}
        />
        {!sources.length ? (
          <Empty description={emptyHint || t("timePlan.merge.noSources")} />
        ) : previewError ? (
          <Alert type="error" showIcon message={previewError} />
        ) : loading ? (
          <div style={{ display: "grid", placeItems: "center", padding: 32 }}><Spin /></div>
        ) : (
          <div className="manager-table">
            <Table<CodexGitMergeProject>
              rowKey="path"
              size="small"
              columns={columns}
              dataSource={projects}
              pagination={false}
              rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as string[]),
                getCheckboxProps: (record) => ({ disabled: Boolean(record.error) || !record.hasTarget }),
              }}
            />
          </div>
        )}
        {mergeError ? <Alert type="error" showIcon message={mergeError} /> : null}
        {result ? (
          <Alert
            type={result.failed.length ? "warning" : "success"}
            showIcon
            message={t("timePlan.merge.resultTitle")}
            description={(
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                {result.results.map((project) => (
                  <div key={project.path || "__root__"}>
                    <strong>{project.path || t("timePlan.merge.rootProject")}</strong>
                    {": "}
                    {project.error
                      ? project.error
                      : project.skipped
                        ? t("timePlan.merge.projectSkipped")
                        : `${project.merged.filter((entry) => entry.merged).length} ${t("timePlan.merge.mergedCount")}`
                          + (project.pushed ? ` · ${t("timePlan.merge.pushed")}` : "")}
                  </div>
                ))}
              </Space>
            )}
          />
        ) : null}
        {resolutions.length ? (
          <Alert
            type="warning"
            showIcon
            message={t("timePlan.merge.resolutionTitle").replace("{tool}", toolDisplayName(mergeConfig.tool))}
            description={(
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                {resolutions.map((entry, index) => (
                  <div key={`${entry.project}-${entry.branch}-${index}`}>
                    <div>
                      <strong>{entry.project || t("timePlan.merge.rootProject")}</strong>
                      {" ← "}
                      <span className="manager-mono">{entry.branch}</span>
                    </div>
                    <div className="manager-table-subline manager-mono">{entry.files.join("、")}</div>
                    {/* AI 的处理说明是多行文本，保留换行，不折成一段。 */}
                    <div style={{ whiteSpace: "pre-wrap" }}>{entry.summary || t("timePlan.merge.resolutionEmpty")}</div>
                  </div>
                ))}
              </Space>
            )}
          />
        ) : null}
        <div className="manager-table-subline">{t("timePlan.merge.pushNote")}</div>
      </Space>
    </Modal>
  );
}
