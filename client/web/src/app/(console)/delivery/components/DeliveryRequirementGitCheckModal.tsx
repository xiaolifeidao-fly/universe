"use client";

import { Alert, Button, Checkbox, Input, Modal, Spin, message } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  bindRequirementGitBranch,
  fetchCodexGitProjects,
  prepareCodexGitBranch,
  pushCodexGitBranch,
  type CodexGitProjectStatus,
  type CodexGitWorkspaceStatus,
  type DeliveryRequirementRecord,
} from "@/api/delivery.api";

/** 失败原因是当前分支还有没提交的改动时，直接在弹窗里给一个提交并推送的出口。 */
const PREPARE_PUSH_HINTS = ["未提交改动", "未提交", "请先提交"];

interface DeliveryRequirementGitCheckModalProps {
  /** 为空表示弹窗关闭；需求自带目标分支，不再单独传分支名。 */
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  status: CodexGitWorkspaceStatus | null;
  /** 只切工作目录下的某个子项目时传它的绝对路径；空串表示项目根工作目录。 */
  workspace?: string;
  /** 子项目名，只用于标题上标出这轮切的是哪个工程。 */
  projectName?: string;
  statusError: string;
  statusLoading: boolean;
  /** 打开时重新确认一次工作区现状：列表里的快照可能是上一条需求留下的。 */
  onRefreshStatus: () => Promise<CodexGitWorkspaceStatus | null>;
  onClose: () => void;
  /** 分支准备完成，调用方据此刷新需求与工作区状态。 */
  onPrepared: () => void;
}

/**
 * 需求分支的检查与切换：需求列表和工作台共用。
 * 切换动作发生在本机桥接上，成功后才把规范化的分支名写回需求。
 */
export function DeliveryRequirementGitCheckModal({
  requirement,
  programId,
  status,
  workspace = "",
  projectName = "",
  statusError,
  statusLoading,
  onRefreshStatus,
  onClose,
  onPrepared,
}: DeliveryRequirementGitCheckModalProps) {
  const { t } = useLocale();
  // 脏工作区只保留「提交后切换」：暂存不会自动恢复，改动很容易被忘在 stash 里。
  const [strategy, setStrategy] = useState<"switch" | "commit">("switch");
  const [commitMessage, setCommitMessage] = useState("");
  const [preparing, setPreparing] = useState(false);
  // 切换失败的原因常是多行 git 输出，toast 会截断，留在弹窗里用户看完就能接着处理。
  const [prepareError, setPrepareError] = useState("");
  const [pushing, setPushing] = useState(false);
  // 工作目录下的独立子工程：默认把已经有这条需求分支的都勾上，一并切过去。
  const [subprojects, setSubprojects] = useState<CodexGitProjectStatus[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [subprojectsLoading, setSubprojectsLoading] = useState(false);

  useEffect(() => {
    if (!requirement) return;
    // 换一个工程重新打开时，上一次的失败原因和提交说明都不该留着。
    setStrategy(status?.dirty ? "commit" : "switch");
    setCommitMessage(`chore: save work before ${requirement.gitBranch}`);
    setPrepareError("");
    // 打开时的状态可能还是上一次的快照；真正确认的结果回来后再定默认策略。
    void onRefreshStatus().then((next) => setStrategy(next?.dirty ? "commit" : "switch"));
    // 只有切根工作目录时才谈得上带上子项目；单独切某个子项目不牵扯别的工程。
    setSubprojects([]);
    setTargets([]);
    setSubprojectsLoading(false);
    if (!workspace) {
      setSubprojectsLoading(true);
      void fetchCodexGitProjects(programId, requirement.gitBranch)
        .then((catalog) => {
          const children = catalog.projects.filter((project) => project.path && !project.error);
          setSubprojects(children);
          setTargets(children.filter((project) => project.hasBranch).map((project) => project.path));
        })
        // 读不到子项目不该挡住切换：退化成只切根工作目录。
        .catch(() => setSubprojects([]))
        .finally(() => setSubprojectsLoading(false));
    }
    // 只在需求或工程变化时重置，用户改过的提交说明不能被状态刷新覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirement, workspace]);

  const alreadyOnBranch = Boolean(
    status?.currentBranch && requirement?.gitBranch && status.currentBranch === requirement.gitBranch,
  );
  const branchesDiffer = Boolean(
    status?.currentBranch && requirement?.gitBranch && status.currentBranch !== requirement.gitBranch,
  );

  const confirm = async () => {
    if (preparing || !requirement?.gitBranch) return;
    setPreparing(true);
    setPrepareError("");
    try {
      const result = await prepareCodexGitBranch(programId, requirement.gitBranch, strategy, commitMessage.trim(), {
        // 切子项目时只动那一个工程；它下面不再往里找嵌套仓库。
        // 切根工作目录时按弹窗里勾选的子项目一并切，勾选为空就只切根目录。
        ...(workspace ? { workspace, targets: [] } : { targets }),
      });
      // 从 origin/feature 关联时，本机实际分支会变成 feature；把这个规范化名称写回需求。
      // 需求分支的归属记在根工作目录上，切子项目不改这条关联。
      if (!workspace && result.branch && result.branch !== requirement.gitBranch) {
        await bindRequirementGitBranch(programId, requirement.requirementKey, requirement.gitBaseBranch, result.branch);
      }
      // 切换会把已经有这条分支的子项目一起带过去；个别子项目没切成要留在弹窗里说清楚。
      const failed = result.results.filter((entry) => entry.path && entry.error);
      if (failed.length) {
        setPrepareError([
          t("delivery.requirement.gitSubprojectPrepareFailed"),
          ...failed.map((entry) => `${entry.name || entry.path}：${entry.error}`),
        ].join("\n\n"));
        onPrepared();
        return;
      }
      if (alreadyOnBranch) {
        message.success(result.pulled ? t("delivery.requirement.gitPulled") : t("delivery.requirement.gitPrepared"));
      } else {
        message.success(result.committed
          ? t("delivery.requirement.gitPreparedCommitted")
          : t("delivery.requirement.gitPrepared"));
      }
      onPrepared();
      onClose();
    } catch (error) {
      // 拉取或切换失败的原文要原样留给用户：是冲突还是没推送，只有 git 的输出说得清。
      setPrepareError((error as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  /** 拉不动多半是当前分支还有没提交、没推送的改动；就地提交并推送，省得退出去找入口。 */
  const pushCurrentBranch = async () => {
    const branch = status?.currentBranch || "";
    if (pushing || !branch) return;
    setPushing(true);
    try {
      await pushCodexGitBranch(programId, branch, commitMessage.trim() || `chore: ${branch}`, {
        ...(workspace ? { workspace, targets: [] } : {}),
      });
      setPrepareError("");
      await onRefreshStatus();
      message.success(t("delivery.requirement.gitPreparePushed").replace("{branch}", branch));
    } catch (error) {
      setPrepareError((error as Error).message);
    } finally {
      setPushing(false);
    }
  };

  const currentBranch = status?.currentBranch || "HEAD";
  const targetBranch = requirement?.gitBranch || "";
  // 有改动又要换分支：必须先把改动提交到当前分支，提交说明不能留空。
  const needsCommit = Boolean(status?.dirty && branchesDiffer);
  // 失败原因指向本机改动，或者工作区本来就是脏的，才给提交并推送按钮。
  const canPushCurrent = Boolean(
    prepareError
    && status?.currentBranch
    && (status.dirty || PREPARE_PUSH_HINTS.some((hint) => prepareError.includes(hint))),
  );

  return (
    <Modal
      open={Boolean(requirement)}
      title={projectName
        ? `${t("delivery.requirement.gitCheckTitle")} · ${projectName}`
        : t("delivery.requirement.gitCheckTitle")}
      okText={t("delivery.requirement.gitPrepare")}
      confirmLoading={preparing}
      width={520}
      className="git-check-modal"
      /* 已经在需求分支上也留一个拉取入口：分支对了不代表代码是最新的。 */
      footer={alreadyOnBranch ? [
        <Button key="close" disabled={preparing || pushing} onClick={onClose}>
          {t("common.close")}
        </Button>,
        <Button
          key="pull"
          type="primary"
          loading={preparing}
          disabled={Boolean(pushing || statusLoading || subprojectsLoading || status?.dirty)}
          onClick={() => void confirm()}
        >
          {t("delivery.requirement.gitPullLatest")}
        </Button>,
      ] : undefined}
      okButtonProps={{
        disabled: Boolean(
          preparing
          || pushing
          || statusLoading
          || subprojectsLoading
          || statusError
          || !requirement?.gitBranch
          || status?.detached
          || (needsCommit && !commitMessage.trim()),
        ),
      }}
      onCancel={onClose}
      onOk={() => void confirm()}
    >
      <div className="git-check">
        {statusError ? <Alert type="warning" showIcon message={statusError} /> : null}
        {status?.detached ? <Alert type="error" showIcon message={t("delivery.requirement.gitDetached")} /> : null}
        {alreadyOnBranch ? <Alert
          type="success"
          showIcon
          message={t("delivery.requirement.gitAlreadyOnBranch")}
        /> : null}
        {status && !status.detached && branchesDiffer ? <Alert
          type="warning"
          showIcon
          message={t("delivery.requirement.gitBranchMismatchShort")}
        /> : null}

        <div className="git-check__compare">
          <div className="git-check__branch">
            <span className="git-check__branch-label">{t("delivery.requirement.gitCurrentBranch")}</span>
            <span className="git-check__branch-name manager-mono" title={currentBranch}>{currentBranch}</span>
          </div>
          <span className="git-check__arrow" aria-hidden="true" />
          <div className="git-check__branch git-check__branch--target">
            <span className="git-check__branch-label">{t("delivery.requirement.gitTargetBranch")}</span>
            <span className="git-check__branch-name manager-mono" title={targetBranch}>{targetBranch || "—"}</span>
          </div>
        </div>

        {branchesDiffer && status ? <Alert
          type={status.dirty ? "warning" : "info"}
          showIcon
          message={t("delivery.requirement.gitPendingFiles")
            .replace("{changed}", String(status.changed))
            .replace("{staged}", String(status.staged))
            .replace("{unstaged}", String(status.unstaged))
            .replace("{untracked}", String(status.untracked))}
          description={status.dirty ? t("delivery.requirement.gitDirtySwitchHint") : undefined}
        /> : null}
        {status?.dirty && !branchesDiffer ? <Alert
          type="warning"
          showIcon
          message={t("delivery.requirement.gitDirtySummary")
            .replace("{staged}", String(status.staged))
            .replace("{unstaged}", String(status.unstaged))
            .replace("{untracked}", String(status.untracked))}
          description={alreadyOnBranch ? undefined : t("delivery.requirement.gitDirtySwitchHint")}
        /> : null}

        {/* 根项目打开时先稳定展示加载态，避免网络结果回来后子项目列表突然插进弹框。 */}
        {!workspace && (subprojectsLoading || subprojects.length) ? <div className="git-check__field git-check__subprojects">
          <span className="git-check__field-label">
            {t(alreadyOnBranch
              ? "delivery.requirement.gitPullSubprojects"
              : "delivery.requirement.gitCheckSubprojects")}
          </span>
          {subprojectsLoading ? (
            <div className="git-check__subprojects-loading" aria-live="polite">
              <Spin size="small" />
              <span>{t("delivery.requirement.gitLoadingSubprojects")}</span>
            </div>
          ) : (
            <div className="git-check__subprojects-loaded">
              <Checkbox.Group
                className="delivery-requirement-git-targets"
                value={targets}
                onChange={(values) => setTargets(values as string[])}
                options={subprojects.map((project) => ({
                  value: project.path,
                  // 本机没有这条需求分支的工程切不过去，勾了也只会报错。
                  disabled: !project.hasBranch,
                  label: (
                    <span className="delivery-requirement-git-targets__item">
                      <b>{project.name}</b>
                      <code className="manager-mono">
                        {project.currentBranch || t("delivery.requirement.gitCurrentBranchDetached")}
                      </code>
                      {project.hasBranch ? null : <i className="is-clean">{t("delivery.requirement.gitSubprojectNoBranch")}</i>}
                    </span>
                  ),
                }))}
              />
              <small className="git-check__field-hint">
                {t(alreadyOnBranch
                  ? "delivery.requirement.gitPullSubprojectsHint"
                  : "delivery.requirement.gitCheckSubprojectsHint")}
              </small>
            </div>
          )}
        </div> : null}

        {needsCommit ? <div className="git-check__field">
          <span className="git-check__field-label">{t("delivery.requirement.gitCommitMessage")}</span>
          <Input
            value={commitMessage}
            status={commitMessage.trim() ? undefined : "error"}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
        </div> : null}

        {prepareError ? <Alert
          type="error"
          showIcon
          message={t("delivery.requirement.gitPrepareFailed")}
          description={<div className="git-check__failure">
            <pre>{prepareError}</pre>
            {canPushCurrent ? <>
              <p>
                {t("delivery.requirement.gitPrepareFailedPushHint").replace("{branch}", status?.currentBranch || "")}
              </p>
              <Button type="primary" loading={pushing} onClick={() => void pushCurrentBranch()}>
                {t("delivery.requirement.gitPreparePush")}
              </Button>
            </> : null}
          </div>}
        /> : null}
      </div>
    </Modal>
  );
}
