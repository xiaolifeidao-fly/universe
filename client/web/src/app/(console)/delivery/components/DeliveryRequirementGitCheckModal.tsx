"use client";

import { Alert, Button, Input, Modal, message } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  bindRequirementGitBranch,
  prepareCodexGitBranch,
  type CodexGitWorkspaceStatus,
  type DeliveryRequirementRecord,
} from "@/api/delivery.api";

interface DeliveryRequirementGitCheckModalProps {
  /** 为空表示弹窗关闭；需求自带目标分支，不再单独传分支名。 */
  requirement: DeliveryRequirementRecord | null;
  programId: number;
  status: CodexGitWorkspaceStatus | null;
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

  useEffect(() => {
    if (!requirement) return;
    setStrategy(status?.dirty ? "commit" : "switch");
    setCommitMessage(`chore: save work before ${requirement.gitBranch}`);
    // 打开时的状态可能还是上一次的快照；真正确认的结果回来后再定默认策略。
    void onRefreshStatus().then((next) => setStrategy(next?.dirty ? "commit" : "switch"));
    // 只在需求变化时重置，用户改过的提交说明不能被状态刷新覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirement]);

  const alreadyOnBranch = Boolean(
    status?.currentBranch && requirement?.gitBranch && status.currentBranch === requirement.gitBranch,
  );
  const branchesDiffer = Boolean(
    status?.currentBranch && requirement?.gitBranch && status.currentBranch !== requirement.gitBranch,
  );

  const confirm = async () => {
    if (preparing || !requirement?.gitBranch) return;
    setPreparing(true);
    try {
      const result = await prepareCodexGitBranch(programId, requirement.gitBranch, strategy, commitMessage.trim());
      // 从 origin/feature 关联时，本机实际分支会变成 feature；把这个规范化名称写回需求。
      if (result.branch && result.branch !== requirement.gitBranch) {
        await bindRequirementGitBranch(programId, requirement.requirementKey, requirement.gitBaseBranch, result.branch);
      }
      message.success(result.committed
        ? t("delivery.requirement.gitPreparedCommitted")
        : t("delivery.requirement.gitPrepared"));
      onPrepared();
      onClose();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const currentBranch = status?.currentBranch || "HEAD";
  const targetBranch = requirement?.gitBranch || "";
  // 有改动又要换分支：必须先把改动提交到当前分支，提交说明不能留空。
  const needsCommit = Boolean(status?.dirty && branchesDiffer);

  return (
    <Modal
      open={Boolean(requirement)}
      title={t("delivery.requirement.gitCheckTitle")}
      okText={t("delivery.requirement.gitPrepare")}
      confirmLoading={preparing}
      width={520}
      className="git-check-modal"
      footer={alreadyOnBranch ? (
        <Button type="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      ) : undefined}
      okButtonProps={{
        disabled: Boolean(
          preparing
          || statusLoading
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

        {needsCommit ? <div className="git-check__field">
          <span className="git-check__field-label">{t("delivery.requirement.gitCommitMessage")}</span>
          <Input
            value={commitMessage}
            status={commitMessage.trim() ? undefined : "error"}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
        </div> : null}
      </div>
    </Modal>
  );
}
