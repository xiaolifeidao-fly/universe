"use client";

import { BranchesOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useLocale } from "@/i18n/LocaleProvider";
import type { CodexGitWorkspaceStatus } from "@/api/delivery.api";

interface DeliveryGitWorkspaceBadgeProps {
	/** 项目未开启 Git 时整条都不出现，避免顶部出现无意义的分支信息。 */
	enabled: boolean;
	programName: string;
	status: CodexGitWorkspaceStatus | null;
	error: string;
	loading: boolean;
	onRefresh: () => void;
}

/** 顶部栏的项目分支与未提交文件数量，取代原来藏在需求列表栏头里的分支小字。 */
export function DeliveryGitWorkspaceBadge({
	enabled,
	programName,
	status,
	error,
	loading,
	onRefresh,
}: DeliveryGitWorkspaceBadgeProps) {
	const { t } = useLocale();
	if (!enabled) return null;

	const counts = status
		? [
			{ key: "changed", tone: "is-changed", label: t("delivery.gitBadge.changed"), value: status.changed },
			{ key: "staged", tone: "is-staged", label: t("delivery.gitBadge.staged"), value: status.staged },
			{ key: "unstaged", tone: "is-unstaged", label: t("delivery.gitBadge.unstaged"), value: status.unstaged },
			{ key: "untracked", tone: "is-untracked", label: t("delivery.gitBadge.untracked"), value: status.untracked },
		]
		: [];
	const state = (() => {
		if (error) return { tone: "is-error", label: t("delivery.requirement.gitState.unavailable") };
		if (!status) return { tone: "is-pending", label: t("delivery.requirement.gitState.pending") };
		if (status.detached) return { tone: "is-error", label: t("delivery.requirement.gitState.blocked") };
		if (status.dirty) return { tone: "is-dirty", label: t("delivery.requirement.gitState.dirty") };
		return { tone: "is-clean", label: t("delivery.gitBadge.clean") };
	})();

	return (
		<div className={`delivery-git-badge ${state.tone}`}>
			<BranchesOutlined className="delivery-git-badge__icon" />
			<div className="delivery-git-badge__main">
				<span className="delivery-git-badge__label">
					{programName ? <b>{programName}</b> : null}
					{t("delivery.requirement.gitCurrentBranch")}
				</span>
				<span className="delivery-git-badge__branch manager-mono">{status?.currentBranch || "HEAD"}</span>
			</div>
			<span className="delivery-git-badge__state">{state.label}</span>
			{counts.length ? (
				<div className="delivery-git-badge__counts">
					{counts.map((count) => (
						<span
							key={count.key}
							className={`delivery-git-badge__count ${count.tone}${count.value ? " is-active" : ""}`}
						>
							{count.label}
							<b>{count.value}</b>
						</span>
					))}
				</div>
			) : null}
			<Tooltip title={t("delivery.gitBadge.refresh")}>
				<Button
					type="text"
					size="small"
					shape="circle"
					icon={<ReloadOutlined />}
					loading={loading}
					aria-label={t("delivery.gitBadge.refresh")}
					onClick={onRefresh}
				/>
			</Tooltip>
		</div>
	);
}
