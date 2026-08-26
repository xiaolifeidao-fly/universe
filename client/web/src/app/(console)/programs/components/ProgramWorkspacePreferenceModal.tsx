"use client";

import {
	BranchesOutlined,
	CheckCircleOutlined,
	CloudDownloadOutlined,
	CloudUploadOutlined,
	ExclamationCircleOutlined,
	FolderOpenOutlined,
	InfoCircleOutlined,
	LoadingOutlined,
} from "@ant-design/icons";
import {
	AutoComplete,
	Button,
	Checkbox,
	Form,
	Input,
	Modal,
	Select,
	Switch,
	Tabs,
	message,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import {
	checkCodexGitWorkspace,
	CLOUD_SYNC_SCOPES,
	fetchCodexGitBranches,
	fetchCodexLocalProjects,
	initializeCodexGitWorkspace,
	initializeCodexGitSubmodules,
	saveProgramCloudSyncConfig,
	saveProgramGitConfig,
	syncCodexCloudWorkspace,
	validateCodexWorkspace,
	type CloudSyncScope,
	type CodexGitWorkspaceCheck,
	type CodexLocalProjectRecord,
	type DeliveryProgramRecord,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import {
	getProjectWorkspacePreference,
	saveProjectWorkspacePreference,
} from "@/project-workspaces/projectWorkspacePreferences";

export type ProgramWorkspacePreferenceTab = "workspace" | "git" | "cloud";

interface ProgramWorkspacePreferenceModalProps {
	/** 传 null 表示关闭；每次传入新项目都会重新读取本机工作目录。 */
	program: DeliveryProgramRecord | null;
	/** 打开时停在哪个页签：从需求卡片的「去设置 Git」进来时直接落到 Git。 */
	initialTab?: ProgramWorkspacePreferenceTab;
	onClose: () => void;
	/** 保存成功后的回调：调用方据此刷新项目列表或 Git 状态。 */
	onSaved?: () => void | Promise<void>;
}

/**
 * 项目偏好设置（工作目录 / Git / 云端同步）弹窗。
 * 从项目管理页和需求卡片的「去设置 Git」共用，后者不必再跳转到项目管理。
 */
export function ProgramWorkspacePreferenceModal({
	program,
	initialTab = "workspace",
	onClose,
	onSaved,
}: ProgramWorkspacePreferenceModalProps) {
	const { t } = useLocale();
	const [workspacePath, setWorkspacePath] = useState("");
	const [workspaceProjects, setWorkspaceProjects] = useState<CodexLocalProjectRecord[]>([]);
	const [workspaceLoading, setWorkspaceLoading] = useState(false);
	const [workspaceSaving, setWorkspaceSaving] = useState(false);
	const [workspaceSource, setWorkspaceSource] = useState<"saved" | "matched" | "manual" | "unmatched">("unmatched");
	const [gitEnabled, setGitEnabled] = useState(false);
	const [gitRepositoryUrl, setGitRepositoryUrl] = useState("");
	const [gitBaseBranch, setGitBaseBranch] = useState("");
	const [gitChatSyncEnabled, setGitChatSyncEnabled] = useState(false);
	const [workspaceTab, setWorkspaceTab] = useState<"workspace" | "git" | "cloud">("workspace");
	const [gitBranches, setGitBranches] = useState<string[]>([]);
	const [gitBranchesLoading, setGitBranchesLoading] = useState(false);
	const [gitWorkspaceCheck, setGitWorkspaceCheck] = useState<CodexGitWorkspaceCheck | null>(null);
	const [gitWorkspaceChecking, setGitWorkspaceChecking] = useState(false);
	const [gitInitializing, setGitInitializing] = useState(false);
	const [cloudSyncEnabled, setCloudSyncEnabled] = useState(false);
	const [cloudSyncScopes, setCloudSyncScopes] = useState<CloudSyncScope[]>([]);
	const [cloudSyncing, setCloudSyncing] = useState(false);
	/** 初始化完仓库后自增，让下面的 Git 状态 effect 重跑一遍。 */
	const [gitStateVersion, setGitStateVersion] = useState(0);

	// 每次打开（或换到另一个项目）都重新读一遍本机工作目录，弹窗自身不缓存上一次的结果。
	useEffect(() => {
		if (!program) return;
		let cancelled = false;
		setWorkspaceProjects([]);
		setWorkspaceLoading(true);
		setWorkspaceTab(initialTab);
		setGitBranches([]);
		setGitWorkspaceCheck(null);
		const saved = getProjectWorkspacePreference(program.programId);
		setWorkspacePath(saved?.workspace || "");
		setWorkspaceSource(saved ? "saved" : "unmatched");
		setGitEnabled(program.gitEnabled);
		setGitRepositoryUrl(program.gitRepositoryUrl || "");
		setGitBaseBranch(program.gitBaseBranch || "");
		setGitChatSyncEnabled(program.gitChatSyncEnabled);
		setCloudSyncEnabled(program.cloudSyncEnabled);
		setCloudSyncScopes(program.cloudSyncScopes.filter((scope): scope is CloudSyncScope => CLOUD_SYNC_SCOPES.includes(scope)));
		void (async () => {
			try {
				const catalog = await fetchCodexLocalProjects(program.programId);
				if (cancelled) return;
				setWorkspaceProjects(catalog.projects);
				if (!saved) {
					const normalizedCode = program.programCode.trim().toLocaleLowerCase();
					const matches = normalizedCode
						? catalog.projects.filter((project) => project.name.trim().toLocaleLowerCase() === normalizedCode)
						: [];
					const roots = Array.from(new Set(matches.flatMap((project) => project.rootPaths).filter(Boolean)));
					if (roots.length === 1) {
						setWorkspacePath(roots[0]);
						setWorkspaceSource("matched");
					}
				}
			} catch (error) {
				if (!cancelled) message.error((error as Error).message);
			} finally {
				if (!cancelled) setWorkspaceLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [initialTab, program]);

	const saveWorkspacePreference = async () => {
		if (!program) return;
		const candidate = workspacePath.trim();
		const gitConfigChanged = program.canAdminister && (
			gitEnabled !== program.gitEnabled
			|| gitChatSyncEnabled !== program.gitChatSyncEnabled
			|| (gitEnabled && (
				gitRepositoryUrl.trim() !== (program.gitRepositoryUrl || "")
				|| gitBaseBranch.trim() !== (program.gitBaseBranch || "")
			))
		);
		const cloudConfigChanged = program.canAdminister && (
			cloudSyncEnabled !== program.cloudSyncEnabled
			|| CLOUD_SYNC_SCOPES.some((scope) => cloudSyncScopes.includes(scope) !== program.cloudSyncScopes.includes(scope))
		);
		if (!candidate && !gitConfigChanged && !cloudConfigChanged) {
			setWorkspaceTab("workspace");
			message.error(t("programs.workspace.required"));
			return;
		}
		if (gitEnabled && !gitBaseBranch.trim()) {
			setWorkspaceTab("git");
			message.error(t("programs.git.baseBranchRequired"));
			return;
		}
		if (cloudSyncEnabled && cloudSyncScopes.length === 0) {
			setWorkspaceTab("cloud");
			message.error(t("programs.cloud.scopeRequired"));
			return;
		}
		setWorkspaceSaving(true);
		try {
			if (candidate) {
				const result = await validateCodexWorkspace(program.programId, candidate);
				saveProjectWorkspacePreference(program.programId, result.workspace);
			}
			if (gitConfigChanged) {
				await saveProgramGitConfig({
					programId: program.programId,
					gitEnabled,
					gitRepositoryUrl: gitRepositoryUrl.trim(),
					gitRemoteName: program.gitRemoteName || "origin",
					gitBaseBranch: gitBaseBranch.trim(),
					gitChatSyncEnabled,
				});
			}
			if (cloudConfigChanged) {
				await saveProgramCloudSyncConfig({
					programId: program.programId,
					cloudSyncEnabled,
					cloudSyncScopes,
				});
			}
			// 工作目录本身也可能变了，所以不区分改了哪一项，保存成功就通知调用方刷新。
			await onSaved?.();
			message.success(t("programs.workspace.saved"));
			onClose();
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setWorkspaceSaving(false);
		}
	};

	const syncCloudWorkspace = async () => {
		if (!program) return;
		if (!workspacePath.trim()) {
			setWorkspaceTab("workspace");
			message.error(t("programs.workspace.required"));
			return;
		}
		const changed = cloudSyncEnabled !== program.cloudSyncEnabled
			|| CLOUD_SYNC_SCOPES.some((scope) => cloudSyncScopes.includes(scope) !== program.cloudSyncScopes.includes(scope));
		if (changed) {
			message.error(t("programs.cloud.saveBeforeSync"));
			return;
		}
		if (!cloudSyncEnabled || cloudSyncScopes.length === 0) {
			message.error(t("programs.cloud.enableBeforeSync"));
			return;
		}
		setCloudSyncing(true);
		try {
			const result = await syncCodexCloudWorkspace(program.programId);
			message.success(t("programs.cloud.synced").replace("{count}", String(result.uploaded)));
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setCloudSyncing(false);
		}
	};

	// 先看目录是不是 Git 仓库：不是就只留初始化入口，读分支没有意义。
	useEffect(() => {
		if (!program || workspaceTab !== "git" || !gitEnabled) return;
		const workspace = workspacePath.trim();
		if (!workspace) {
			setGitWorkspaceCheck(null);
			return;
		}
		let cancelled = false;
		const programId = program.programId;
		setGitWorkspaceChecking(true);
		void (async () => {
			let repository = false;
			try {
				const check = await checkCodexGitWorkspace(programId, workspace);
				if (cancelled) return;
				setGitWorkspaceCheck(check);
				repository = check.isGitRepository;
			} catch {
				if (cancelled) return;
				// 桥接不可用时不显示初始化入口，避免把连不上本机误判成没有仓库。
				setGitWorkspaceCheck(null);
				repository = true;
			} finally {
				if (!cancelled) setGitWorkspaceChecking(false);
			}
			if (!repository) {
				setGitBranches([]);
				return;
			}
			setGitBranchesLoading(true);
			try {
				const catalog = await fetchCodexGitBranches(programId, workspace);
				if (cancelled) return;
				setGitBranches(catalog.branches);
				setGitBaseBranch((current) => current || catalog.defaultBranch || "");
			} catch {
				if (!cancelled) setGitBranches([]);
			} finally {
				if (!cancelled) setGitBranchesLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [gitEnabled, gitStateVersion, workspacePath, program, workspaceTab]);

	/** 把当前工作目录关联到远端仓库：init + remote + fetch + 检出基准分支，本地已有文件不会被覆盖。 */
	const initializeWorkspaceGit = async () => {
		if (!program) return;
		const workspace = workspacePath.trim();
		if (!workspace) {
			setWorkspaceTab("workspace");
			message.error(t("programs.workspace.required"));
			return;
		}
		const repositoryUrl = gitRepositoryUrl.trim();
		if (!repositoryUrl) {
			message.error(t("programs.git.repositoryUrlRequired"));
			return;
		}
		setGitInitializing(true);
		try {
			const result = await initializeCodexGitWorkspace({
				programId: program.programId,
				workspace,
				repositoryUrl,
				baseBranch: gitBaseBranch.trim(),
			});
			setGitBaseBranch((current) => current || result.branch);
			message.success(
				t(result.adopted ? "programs.git.initializedAdopted" : "programs.git.initialized").replace("{branch}", result.branch),
			);
			if (result.submoduleError) {
				message.warning(t("programs.git.submodulesPartial").replace("{error}", result.submoduleError));
			} else if (result.submodules.length) {
				message.success(t("programs.git.submodulesInitialized").replace("{count}", String(result.submodules.length)));
			}
			setGitStateVersion((version) => version + 1);
			// 仓库刚建好，调用方的需求卡片提示要立刻跟着消失，不能等到保存弹窗才刷新。
			await onSaved?.();
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setGitInitializing(false);
		}
	};

	/** 主仓库已经可用、但 .gitmodules 里的目录还没检出时，单独补初始化子模块。 */
	const initializeWorkspaceSubmodules = async () => {
		if (!program || !workspacePath.trim()) return;
		setGitInitializing(true);
		try {
			const result = await initializeCodexGitSubmodules(program.programId, workspacePath);
			if (result.submoduleError) {
				message.warning(t("programs.git.submodulesPartial").replace("{error}", result.submoduleError));
			} else {
				message.success(t("programs.git.submodulesInitialized").replace("{count}", String(result.submodules.length)));
			}
			setGitStateVersion((version) => version + 1);
			await onSaved?.();
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setGitInitializing(false);
		}
	};

	const gitBranchOptions = useMemo(
		() => gitBranches.map((branch) => ({ value: branch, label: branch })),
		[gitBranches],
	);

	const workspaceOptions = useMemo(
		() => workspaceProjects.flatMap((project) => project.rootPaths.map((rootPath) => ({
			value: rootPath,
			name: project.name,
			label: (
				<span className="manager-codex-option">
					<b data-locale-static="false">{project.name}</b>
					<span data-locale-static="false">{rootPath}</span>
				</span>
			),
		}))),
		[workspaceProjects],
	);

	const workspaceNote = useMemo(() => {
		if (workspaceSource === "unmatched") {
			return { tone: "warn", icon: <ExclamationCircleOutlined />, key: "programs.workspace.unmatched" };
		}
		if (workspaceSource === "manual") {
			return { tone: "info", icon: <InfoCircleOutlined />, key: "programs.workspace.manual" };
		}
		return {
			tone: "ok",
			icon: <CheckCircleOutlined />,
			key: workspaceSource === "saved" ? "programs.workspace.savedStatus" : "programs.workspace.matched",
		};
	}, [workspaceSource]);


	return (
			<Modal
				wrapClassName="manager-form-skin"
				open={Boolean(program)}
				destroyOnClose
				title={t("programs.workspace.title")}
				okText={t("programs.workspace.confirm")}
				cancelText={t("common.cancel")}
				confirmLoading={workspaceSaving}
				onCancel={onClose}
				onOk={() => void saveWorkspacePreference()}
			>
				<div className="manager-codex-modal">
					<div className="manager-codex-head">
						<span className="manager-codex-head-avatar" aria-hidden="true">
							{(program?.name || program?.programCode || "?").trim().slice(0, 1)}
						</span>
						<div className="manager-codex-head-copy">
							<span className="manager-section-label">{t("programs.workspace.program")}</span>
							<strong data-locale-static="false">{program?.name}</strong>
							<div className="manager-table-subline manager-mono" data-locale-static="false">
								{program?.programCode || "-"}
							</div>
						</div>
					</div>
					<Tabs
						className="manager-codex-tabs"
						activeKey={workspaceTab}
						onChange={(key) => setWorkspaceTab(key as "workspace" | "git" | "cloud")}
						items={[
							{
								key: "workspace",
								label: <><FolderOpenOutlined />{t("programs.workspace.tabWorkspace")}</>,
								children: (
									<div className="manager-codex-pane">
										<div className={`manager-codex-note manager-codex-note--${workspaceNote.tone}`}>
											{workspaceNote.icon}
											<div>
												<strong>{t(workspaceNote.key)}</strong>
												<p>{t("programs.workspace.localHint")}</p>
											</div>
										</div>
										<Form layout="vertical" style={{ width: "100%" }}>
											<Form.Item label={t("programs.workspace.detected")}>
												<Select
													allowClear
													showSearch
													loading={workspaceLoading}
													placeholder={t("programs.workspace.detectedPlaceholder")}
													options={workspaceOptions}
													optionLabelProp="value"
													filterOption={(input, option) => {
														const keyword = input.trim().toLocaleLowerCase();
														if (!keyword) return true;
														return `${option?.name || ""} ${option?.value || ""}`.toLocaleLowerCase().includes(keyword);
													}}
													value={workspaceOptions.some((option) => option.value === workspacePath) ? workspacePath : undefined}
													onChange={(value) => {
														setWorkspacePath(value || "");
														setWorkspaceSource("matched");
													}}
												/>
											</Form.Item>
											<Form.Item label={t("programs.workspace.path")} required extra={t("programs.workspace.pathHint")}>
												<Input
													className="manager-codex-path"
													prefix={<FolderOpenOutlined />}
													value={workspacePath}
													placeholder={t("programs.workspace.pathPlaceholder")}
													onChange={(event) => {
														setWorkspacePath(event.target.value);
														setWorkspaceSource("manual");
													}}
												/>
											</Form.Item>
										</Form>
									</div>
								),
							},
							{
								key: "git",
								label: <><BranchesOutlined />{t("programs.workspace.tabGit")}</>,
								children: (
									<div className="manager-codex-pane">
										<div className={`manager-codex-toggle${gitEnabled ? " manager-codex-toggle--on" : ""}`}>
											<div>
												<strong>{t("programs.git.enabled")}</strong>
												<p>{t("programs.git.enabledHint")}</p>
											</div>
											<Switch
												checked={gitEnabled}
												disabled={!program?.canAdminister}
												aria-label={t("programs.git.enabled")}
												onChange={(enabled) => {
													setGitEnabled(enabled);
													if (!enabled) setGitChatSyncEnabled(false);
												}}
											/>
										</div>
										{gitEnabled ? (
											<Form layout="vertical" style={{ width: "100%" }}>
												<Form.Item label={t("programs.git.repositoryUrl")} extra={t("programs.git.repositoryUrlHint")}>
													<Input
														className="manager-codex-path"
														disabled={!program?.canAdminister}
														value={gitRepositoryUrl}
														placeholder={t("programs.git.repositoryUrlPlaceholder")}
														onChange={(event) => setGitRepositoryUrl(event.target.value)}
													/>
												</Form.Item>
												<Form.Item label={t("programs.git.baseBranch")} required extra={t("programs.git.baseBranchHint")}>
													<AutoComplete
														allowClear
														disabled={!program?.canAdminister}
														value={gitBaseBranch}
														options={gitBranchOptions}
														placeholder={t("programs.git.baseBranchPlaceholder")}
														filterOption={(input, option) => String(option?.value || "").toLocaleLowerCase().includes(input.trim().toLocaleLowerCase())}
														onChange={(value) => setGitBaseBranch(value || "")}
													>
														<Input
															className="manager-codex-path"
															prefix={<BranchesOutlined />}
															suffix={gitBranchesLoading ? <LoadingOutlined /> : undefined}
														/>
													</AutoComplete>
											</Form.Item>
											<div className={`manager-codex-toggle${gitChatSyncEnabled ? " manager-codex-toggle--on" : ""}`}>
												<div>
													<strong>{t("programs.git.chatSync")}</strong>
													<p>{t("programs.git.chatSyncHint")}</p>
												</div>
												<Switch
													checked={gitChatSyncEnabled}
													disabled={!program?.canAdminister}
													aria-label={t("programs.git.chatSync")}
													onChange={setGitChatSyncEnabled}
												/>
											</div>
										</Form>
										) : (
											<div className="manager-codex-empty">{t("programs.git.disabledHint")}</div>
										)}
										{gitEnabled && gitWorkspaceCheck && !gitWorkspaceCheck.isGitRepository ? (
											<div className="manager-codex-note manager-codex-note--warn">
												<ExclamationCircleOutlined />
												<div>
													<strong>{t(gitWorkspaceCheck.exists ? "programs.git.notRepository" : "programs.git.workspaceMissing")}</strong>
													<p>{t("programs.git.notRepositoryHint").replace("{workspace}", gitWorkspaceCheck.workspace)}</p>
													<Button
														className="manager-codex-note__action"
														type="primary"
														size="small"
														icon={<CloudDownloadOutlined />}
														loading={gitInitializing}
														disabled={gitWorkspaceChecking || !gitRepositoryUrl.trim()}
														onClick={() => void initializeWorkspaceGit()}
													>
														{t("programs.git.initialize")}
													</Button>
												</div>
											</div>
										) : null}
										{gitEnabled && gitWorkspaceCheck?.isGitRepository && gitWorkspaceCheck.pendingSubmodules.length ? (
											<div className="manager-codex-note manager-codex-note--warn">
												<ExclamationCircleOutlined />
												<div>
													<strong>{t("programs.git.submodulesPending")}</strong>
													<p>{t("programs.git.submodulesPendingHint").replace("{projects}", gitWorkspaceCheck.pendingSubmodules.join("、"))}</p>
													<Button
														className="manager-codex-note__action"
														type="primary"
														size="small"
														icon={<CloudDownloadOutlined />}
														loading={gitInitializing}
														disabled={gitWorkspaceChecking}
														onClick={() => void initializeWorkspaceSubmodules()}
													>
														{t("programs.git.initializeSubmodules")}
													</Button>
												</div>
											</div>
										) : null}
										{gitEnabled ? <p className="manager-codex-foot">{t("programs.git.hint")}</p> : null}
										{!program?.canAdminister ? (
											<p className="manager-codex-foot">{t("programs.git.readonly")}</p>
										) : null}
									</div>
								),
							},
							{
								key: "cloud",
								label: <><CloudUploadOutlined />{t("programs.workspace.tabCloud")}</>,
								children: (
									<div className="manager-codex-pane">
										<div className={`manager-codex-toggle${cloudSyncEnabled ? " manager-codex-toggle--on" : ""}`}>
											<div>
												<strong>{t("programs.cloud.enabled")}</strong>
												<p>{t("programs.cloud.enabledHint")}</p>
											</div>
											<Switch
												checked={cloudSyncEnabled}
												disabled={!program?.canAdminister}
												aria-label={t("programs.cloud.enabled")}
												onChange={setCloudSyncEnabled}
											/>
										</div>
										{cloudSyncEnabled ? <>
											<Form layout="vertical" style={{ width: "100%" }}>
												<Form.Item label={t("programs.cloud.scopes")} required extra={t("programs.cloud.scopesHint")}>
													<Checkbox.Group
														disabled={!program?.canAdminister}
														value={cloudSyncScopes}
														options={CLOUD_SYNC_SCOPES.map((scope) => ({ value: scope, label: t(`programs.cloud.scope.${scope}`) }))}
														onChange={(values) => setCloudSyncScopes(values.filter((scope): scope is CloudSyncScope => CLOUD_SYNC_SCOPES.includes(scope as CloudSyncScope)))}
													/>
												</Form.Item>
											</Form>
											<div className="manager-codex-note manager-codex-note--info">
												<CloudUploadOutlined />
												<div>
													<strong>{t("programs.cloud.syncNow")}</strong>
													<p>{t("programs.cloud.syncNowHint")}</p>
													<Button
														className="manager-codex-note__action"
														type="primary"
														size="small"
														loading={cloudSyncing}
														disabled={!program?.canWrite || !cloudSyncEnabled || cloudSyncScopes.length === 0}
														onClick={() => void syncCloudWorkspace()}
													>
														{t("programs.cloud.syncNow")}
													</Button>
												</div>
											</div>
										</> : <div className="manager-codex-empty">{t("programs.cloud.disabledHint")}</div>}
										{!program?.canAdminister ? <p className="manager-codex-foot">{t("programs.cloud.readonly")}</p> : null}
									</div>
								),
							},
						]}
					/>
				</div>
			</Modal>
	);
}
