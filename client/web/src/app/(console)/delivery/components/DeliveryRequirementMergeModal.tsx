"use client";

import { MergeOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Modal, Select, Space, Spin, Table, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  effortForConfig,
  modelForConfig,
  toolDisplayName,
  useAIPreferences,
} from "@/ai-preferences/AIPreferencesProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchCodexGitBranches,
  fetchCodexGitMergePreview,
  mergeCodexGitBranches,
  type CodexGitMergeProject,
  type CodexGitMergeResolution,
  type CodexGitMergeResult,
} from "@/api/delivery.api";

type Props = {
  open: boolean;
  programId: number;
  /** 要合出去的需求分支；空串时弹窗不做任何事。 */
  sourceBranch: string;
  /** 目标分支的默认值：需求的基线分支，没有就退回项目基线分支。 */
  defaultTarget?: string;
  /**
   * 只合某一个子项目时传它相对根工作目录的目录名；空串表示主项目连同子项目一起选。
   * 用 undefined 和空串区分不了「根目录」，所以用单独的 scoped 标记。
   */
  scopePath?: string;
  /** 限定子项目时它的绝对路径，用来读那个工程自己的分支清单。 */
  scopeWorkspace?: string;
  /** 子项目名，只用于标题上标出这轮合并属于哪个工程。 */
  projectName?: string;
  onClose: () => void;
  /** 合并结束后刷新面板上的 Git 状态。 */
  onMerged?: () => void;
};

/**
 * 需求 Git 面板的「合并到分支」：把这条需求的分支合进目标分支（默认基线分支）并推送。
 *
 * 先出一份预览：根工作目录和每个子项目各自有没有目标分支、会动多少文件，用户勾选参与的工程
 * 后再真正合并。冲突交给 AI 在本机解决，解决说明留在弹窗里，不用一闪而过的 toast 交代。
 * scopePath 传值时这一轮只处理那一个子项目，根工作目录和别的工程都不动。
 */
export function DeliveryRequirementMergeModal({
  open,
  programId,
  sourceBranch,
  defaultTarget = "",
  scopePath,
  scopeWorkspace = "",
  projectName = "",
  onClose,
  onMerged,
}: Props) {
  const { t } = useLocale();
  const { configFor } = useAIPreferences();
  // 解冲突要改代码，按「动作执行」那一档的模型和思考强度走。
  const mergeConfig = configFor("actionExecution");
  const scoped = scopePath !== undefined;
  const [target, setTarget] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [projects, setProjects] = useState<CodexGitMergeProject[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [result, setResult] = useState<CodexGitMergeResult | null>(null);
  const [mergeError, setMergeError] = useState("");

  const loadBranches = useCallback(async () => {
    setBranchesLoading(true);
    try {
      // 限定子项目时读它自己的分支：各工程的分支清单并不一致。
      const catalog = await fetchCodexGitBranches(programId, scoped ? scopeWorkspace : "");
      setBranches(catalog.branches);
      // 需求没记基线分支时退回工程的默认分支，别让用户对着空下拉框猜。
      setTarget((current) => current || catalog.defaultBranch || "");
    } catch (error) {
      setBranches([]);
      message.warning((error as Error).message);
    } finally {
      setBranchesLoading(false);
    }
  }, [programId, scoped, scopeWorkspace]);

  const loadPreview = useCallback(async () => {
    if (!target || !sourceBranch || target === sourceBranch) {
      setProjects([]);
      setSelected([]);
      return;
    }
    setLoading(true);
    setPreviewError("");
    try {
      // 预览始终按根工作目录读，再按 scopePath 挑出这一轮要处理的工程。
      const preview = await fetchCodexGitMergePreview(programId, target, [sourceBranch]);
      const visible = scoped
        ? preview.projects.filter((project) => project.path === scopePath)
        : preview.projects;
      setProjects(visible);
      // 默认勾上真正有东西可合的工程：没有目标分支、读不动或本来就是最新的都不预选。
      setSelected(visible
        .filter((project) => !project.error && project.hasTarget && project.changedFiles > 0)
        .map((project) => project.path));
    } catch (error) {
      setProjects([]);
      setSelected([]);
      setPreviewError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [programId, scoped, scopePath, sourceBranch, target]);

  useEffect(() => {
    if (!open) return;
    // 重新打开时上一轮的结果和错误都不该留着；目标分支回到需求的基线分支。
    setResult(null);
    setMergeError("");
    setPreviewError("");
    setProjects([]);
    setSelected([]);
    setTarget(defaultTarget);
    void loadBranches();
  }, [defaultTarget, loadBranches, open]);

  useEffect(() => {
    if (!open) return;
    void loadPreview();
  }, [loadPreview, open]);

  const rootSelected = selected.includes("");
  const subprojectTargets = useMemo(() => selected.filter((path) => path), [selected]);
  const sameBranch = Boolean(target) && target === sourceBranch;

  const merge = async () => {
    if (merging || !selected.length || sameBranch) return;
    setMerging(true);
    setMergeError("");
    setResult(null);
    try {
      const outcome = await mergeCodexGitBranches(programId, target, [sourceBranch], {
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
        setMergeError(`${t("delivery.requirement.gitMerge.partialFailed")}：${outcome.failed.join("、")}`);
      } else {
        message.success(t("delivery.requirement.gitMerge.succeeded"));
      }
      onMerged?.();
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
      title: t("delivery.requirement.gitMerge.project"),
      dataIndex: "name",
      key: "name",
      render: (_: string, record: CodexGitMergeProject) => (
        <div>
          <div>
            {record.path ? record.name : t("delivery.requirement.gitMerge.rootProject")}
            {record.dirty ? (
              <Tooltip title={t("delivery.requirement.gitMerge.dirtyHint")}>
                <Tag color="warning" style={{ marginLeft: 8 }}>{t("delivery.requirement.gitMerge.dirty")}</Tag>
              </Tooltip>
            ) : null}
          </div>
          <div className="manager-table-subline manager-mono">{record.path || record.workspace}</div>
        </div>
      ),
    },
    {
      title: t("delivery.requirement.gitMerge.targetBranch"),
      dataIndex: "hasTarget",
      key: "hasTarget",
      width: 200,
      render: (_: boolean, record: CodexGitMergeProject) => (
        record.error
          ? <Tooltip title={record.error}><Tag color="error">{t("delivery.requirement.gitMerge.unreadable")}</Tag></Tooltip>
          : record.hasTarget
            ? <span className="manager-mono">{record.targetRef}</span>
            : <Tag>{t("delivery.requirement.gitMerge.noTargetBranch")}</Tag>
      ),
    },
    {
      title: t("delivery.requirement.gitMerge.changedFiles"),
      dataIndex: "changedFiles",
      key: "changedFiles",
      width: 110,
      render: (value: number) => <span className="manager-mono">{value}</span>,
    },
    {
      title: t("delivery.requirement.gitMerge.sourceBranch"),
      dataIndex: "sources",
      key: "sources",
      width: 260,
      render: (_: unknown, record: CodexGitMergeProject) => (
        <Space size={4} wrap>
          {record.sources.map((source) => (
            <Tooltip
              key={source.branch}
              title={source.exists
                ? `${source.branch} · ${t("delivery.requirement.gitMerge.changedFiles")} ${source.changedFiles} · ${t("delivery.requirement.gitMerge.commits")} ${source.commits}`
                : t("delivery.requirement.gitMerge.sourceMissing")}
            >
              <Tag color={source.exists ? (source.commits ? "processing" : "default") : "default"}>
                {source.branch}
                {source.exists ? ` · ${source.commits}` : ""}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <Modal
      wrapClassName="manager-form-skin"
      open={open}
      destroyOnClose
      width={960}
      title={projectName
        ? `${t("delivery.requirement.gitMerge.title")} · ${projectName}`
        : t("delivery.requirement.gitMerge.title")}
      onCancel={onClose}
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} disabled={loading || merging} onClick={() => void loadPreview()}>
          {t("delivery.requirement.gitMerge.refresh")}
        </Button>,
        <Button key="close" onClick={onClose}>{t("common.close")}</Button>,
        <Button
          key="merge"
          type="primary"
          icon={<MergeOutlined />}
          loading={merging}
          disabled={loading || sameBranch || !selected.length}
          onClick={() => void merge()}
        >
          {t("delivery.requirement.gitMerge.confirm")}
        </Button>,
      ]}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div className="delivery-requirement-git-push">
          <label>
            {t("delivery.requirement.gitMerge.targetBranch")}
            <Select
              showSearch
              optionFilterProp="label"
              loading={branchesLoading}
              disabled={merging}
              value={target || undefined}
              placeholder={t("delivery.requirement.gitMerge.targetPlaceholder")}
              onChange={setTarget}
              // 需求的基线分支可能还没出现在清单里（远端刚建），也要能选中。
              options={(branches.includes(target) || !target ? branches : [target, ...branches])
                .map((branch) => ({ value: branch, label: branch }))}
            />
            <small>{t("delivery.requirement.gitMerge.targetHint")}</small>
          </label>
        </div>
        <Alert
          type="info"
          showIcon
          message={t("delivery.requirement.gitMerge.hint")
            .replace("{source}", sourceBranch)
            .replace("{target}", target || t("delivery.requirement.gitMerge.targetPlaceholder"))}
          description={t("delivery.requirement.gitMerge.conflictHint").replace("{tool}", toolDisplayName(mergeConfig.tool))}
        />
        {sameBranch ? (
          <Alert type="warning" showIcon message={t("delivery.requirement.gitMerge.sameBranch")} />
        ) : !target ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.gitMerge.targetPlaceholder")} />
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
              locale={{ emptyText: t("delivery.requirement.gitMerge.noProjects") }}
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
            message={t("delivery.requirement.gitMerge.resultTitle")}
            description={(
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                {result.results.map((project) => (
                  <div key={project.path || "__root__"}>
                    <strong>{project.path || t("delivery.requirement.gitMerge.rootProject")}</strong>
                    {": "}
                    {project.error
                      ? project.error
                      : project.skipped
                        ? t("delivery.requirement.gitMerge.projectSkipped")
                        : `${project.merged.filter((entry) => entry.merged).length} ${t("delivery.requirement.gitMerge.mergedCount")}`
                          + (project.pushed ? ` · ${t("delivery.requirement.gitMerge.pushed")}` : "")}
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
            message={t("delivery.requirement.gitMerge.resolutionTitle").replace("{tool}", toolDisplayName(mergeConfig.tool))}
            description={(
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                {resolutions.map((entry, index) => (
                  <div key={`${entry.project}-${entry.branch}-${index}`}>
                    <div>
                      <strong>{entry.project || t("delivery.requirement.gitMerge.rootProject")}</strong>
                      {" ← "}
                      <span className="manager-mono">{entry.branch}</span>
                    </div>
                    <div className="manager-table-subline manager-mono">{entry.files.join("、")}</div>
                    {/* AI 的处理说明是多行文本，保留换行，不折成一段。 */}
                    <div style={{ whiteSpace: "pre-wrap" }}>{entry.summary || t("delivery.requirement.gitMerge.resolutionEmpty")}</div>
                  </div>
                ))}
              </Space>
            )}
          />
        ) : null}
        <div className="manager-table-subline">{t("delivery.requirement.gitMerge.pushNote")}</div>
      </Space>
    </Modal>
  );
}
