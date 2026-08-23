"use client";

import { Alert, Button, Input, Modal, Segmented, message } from "antd";
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
  const [strategy, setStrategy] = useState<"switch" | "commit" | "stash">("switch");
  const [commitMessage, setCommitMessage] = useState("");
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!requirement) return;
    setStrategy(status?.dirty ? "stash" : "switch");
    setCommitMessage(`chore: save work before ${requirement.gitBranch}`);
    // 打开时的状态可能还是上一次的快照；真正确认的结果回来后再定默认策略。
    void onRefreshStatus().then((next) => setStrategy(next?.dirty ? "stash" : "switch"));
    // 只在需求变化时重置，用户改过的策略不能被状态刷新覆盖。
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
      message.success(result.stashed
        ? t("delivery.requirement.gitPreparedStashed")
        : result.committed
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

  return (
    <Modal
      open={Boolean(requirement)}
      title={t("delivery.requirement.gitCheckTitle")}
      okText={t("delivery.requirement.gitPrepare")}
      confirmLoading={preparing}
      footer={alreadyOnBranch ? (
        <Button type="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      ) : undefined}
      okButtonProps={{
        disabled: Boolean(preparing || statusLoading || statusError || !requirement?.gitBranch || status?.detached),
      }}
      onCancel={onClose}
      onOk={() => void confirm()}
    >
      <div className="delivery-drawer">
        {statusError ? <Alert type="warning" showIcon message={statusError} /> : null}
        {status?.detached ? <Alert type="error" showIcon message={t("delivery.requirement.gitDetached")} /> : null}
        {alreadyOnBranch ? <Alert
          type="success"
          showIcon
          message={t("delivery.requirement.gitAlreadyOnBranch")}
        /> : null}
        {status && !status.detached && status.currentBranch !== requirement?.gitBranch ? <Alert
          type="warning"
          showIcon
          message={t("delivery.requirement.gitBranchMismatch")
            .replace("{current}", status.currentBranch || "HEAD")
            .replace("{target}", requirement?.gitBranch || "")}
        /> : null}
        <label>
          {t("delivery.requirement.gitCurrentBranch")}
          <Input readOnly value={status?.currentBranch || "HEAD"} className="manager-mono" />
        </label>
        <label>
          {t("delivery.requirement.gitTargetBranch")}
          <Input readOnly value={requirement?.gitBranch || ""} className="manager-mono" />
        </label>
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
        {status?.dirty && branchesDiffer ? <>
          <label>
            {t("delivery.requirement.gitDirtyStrategy")}
            <Segmented
              value={strategy}
              onChange={(value) => setStrategy(value as "commit" | "stash")}
              options={[
                { value: "stash", label: t("delivery.requirement.gitStrategy.stash") },
                { value: "commit", label: t("delivery.requirement.gitStrategy.commit") },
              ]}
            />
          </label>
          {strategy === "commit" ? <label>
            {t("delivery.requirement.gitCommitMessage")}
            <Input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} />
          </label> : null}
        </> : null}
      </div>
    </Modal>
  );
}
