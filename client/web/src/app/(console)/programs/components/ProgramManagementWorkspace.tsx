"use client";

import {
	AppstoreOutlined,
	DeleteOutlined,
	EditOutlined,
	FlagOutlined,
	FolderOpenOutlined,
	PlusOutlined,
	ReloadOutlined,
	SettingOutlined,
} from "@ant-design/icons";
import {
	Alert,
	Button,
	Drawer,
	Empty,
	Form,
	Input,
	InputNumber,
	Modal,
	Popconfirm,
	Select,
	Space,
	Table,
	Tag,
	Tooltip,
	message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type BusinessLineId, useBusinessLine } from "@/business-lines/BusinessLineProvider";
import {
	deleteModule,
	deleteStage,
	fetchModules,
	fetchModulesPage,
	fetchCodexLocalProjects,
	fetchPrograms,
	fetchStages,
	migrateProgram,
	saveModule,
	saveProgram,
	saveStage,
	validateCodexWorkspace,
	type CodexLocalProjectRecord,
	type DeliveryModuleRecord,
	type DeliveryProgramRecord,
	type DeliveryStageRecord,
	type SaveModulePayload,
	type SaveProgramPayload,
	type SaveStagePayload,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import {
	getProjectWorkspacePreference,
	saveProjectWorkspacePreference,
} from "@/project-workspaces/projectWorkspacePreferences";

interface ProgramFormValues {
	programId: number;
	programCode: string;
	bizLine: BusinessLineId;
	name: string;
	summary?: string;
	status: string;
}

interface ModuleFormValues {
	moduleKey: string;
	name: string;
	seq: number;
	weight: number;
	kind: string;
}

interface StageFormValues {
	stageKey: string;
	seq: number;
	tag: string;
	timeWindow: string;
	maturityLevel: string;
	title: string;
}

const MODULE_KINDS = ["link", "tool", "center"] as const;
const MODULE_PAGE_SIZE = 10;

export function ProgramManagementWorkspace() {
	const { t, locale } = useLocale();
	const { activeBusinessLine, businessLines, setActiveBusinessLine } = useBusinessLine();
	const [form] = Form.useForm<ProgramFormValues>();
	const [moduleForm] = Form.useForm<ModuleFormValues>();
	const [stageForm] = Form.useForm<StageFormValues>();
	const [programs, setPrograms] = useState<DeliveryProgramRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<DeliveryProgramRecord | null>(null);
	const [stageProgram, setStageProgram] = useState<DeliveryProgramRecord | null>(null);
	const [stages, setStages] = useState<DeliveryStageRecord[]>([]);
	const [stagesLoading, setStagesLoading] = useState(false);
	const [stageEditorOpen, setStageEditorOpen] = useState(false);
	const [editingStage, setEditingStage] = useState<DeliveryStageRecord | null>(null);
	const [stageSaving, setStageSaving] = useState(false);
	const [deletingStageKey, setDeletingStageKey] = useState("");
	const [moduleProgram, setModuleProgram] = useState<DeliveryProgramRecord | null>(null);
	const [modules, setModules] = useState<DeliveryModuleRecord[]>([]);
	const [modulesTotal, setModulesTotal] = useState(0);
	const [modulesLoading, setModulesLoading] = useState(false);
	const [modulePageIndex, setModulePageIndex] = useState(1);
	const [modulePageSize, setModulePageSize] = useState(MODULE_PAGE_SIZE);
	const [moduleEditorOpen, setModuleEditorOpen] = useState(false);
	const [editingModule, setEditingModule] = useState<DeliveryModuleRecord | null>(null);
	const [moduleSaving, setModuleSaving] = useState(false);
	const [deletingModuleKey, setDeletingModuleKey] = useState("");
	const [modulePendingDeletion, setModulePendingDeletion] = useState<DeliveryModuleRecord | null>(null);
	const [moduleDeleteCandidates, setModuleDeleteCandidates] = useState<DeliveryModuleRecord[]>([]);
	const [moduleDeleteTargetKey, setModuleDeleteTargetKey] = useState("");
	const [moduleDeleteCandidatesLoading, setModuleDeleteCandidatesLoading] = useState(false);
	const [workspaceProgram, setWorkspaceProgram] = useState<DeliveryProgramRecord | null>(null);
	const [workspacePath, setWorkspacePath] = useState("");
	const [workspaceProjects, setWorkspaceProjects] = useState<CodexLocalProjectRecord[]>([]);
	const [workspaceLoading, setWorkspaceLoading] = useState(false);
	const [workspaceSaving, setWorkspaceSaving] = useState(false);
	const [workspaceSource, setWorkspaceSource] = useState<"saved" | "matched" | "manual" | "unmatched">("unmatched");

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setPrograms(await fetchPrograms(activeBusinessLine.id));
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, [activeBusinessLine.id]);

	const refreshModules = useCallback(async (pageIndex: number, pageSize = modulePageSize) => {
		if (!moduleProgram) return;
		setModulesLoading(true);
		try {
			const page = await fetchModulesPage({
				programId: moduleProgram.programId,
				pageIndex,
				pageSize,
			});
			setModules(page.data);
			setModulesTotal(page.total);
		} catch (error) {
			setModules([]);
			setModulesTotal(0);
			message.error((error as Error).message);
		} finally {
			setModulesLoading(false);
		}
	}, [activeBusinessLine.id, modulePageSize, moduleProgram]);

	const refreshStages = useCallback(async () => {
		if (!stageProgram) return;
		setStagesLoading(true);
		try {
			setStages(await fetchStages(stageProgram.programId));
		} catch (error) {
			setStages([]);
			message.error((error as Error).message);
		} finally {
			setStagesLoading(false);
		}
	}, [activeBusinessLine.id, stageProgram]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (moduleProgram) void refreshModules(modulePageIndex);
	}, [modulePageIndex, moduleProgram, refreshModules]);

	useEffect(() => {
		if (stageProgram) void refreshStages();
	}, [refreshStages, stageProgram]);

	useEffect(() => {
		setStageProgram(null);
		setStageEditorOpen(false);
		setEditingStage(null);
		setModuleProgram(null);
		setModuleEditorOpen(false);
		setEditingModule(null);
		setModulePendingDeletion(null);
		setModuleDeleteCandidates([]);
		setModuleDeleteTargetKey("");
		setModulePageIndex(1);
	}, [activeBusinessLine.id]);

	const closeProgramEditor = () => {
		setEditorOpen(false);
		setEditing(null);
		form.resetFields();
	};

	const openCreate = () => {
		setEditing(null);
		form.resetFields();
		form.setFieldsValue({
			programId: 0,
			programCode: "",
			bizLine: activeBusinessLine.id,
			name: "",
			summary: "",
			status: "active",
		});
		setEditorOpen(true);
	};

	const openEdit = (program: DeliveryProgramRecord) => {
		setEditing(program);
		form.resetFields();
		form.setFieldsValue({
			programId: program.programId,
			programCode: program.programCode,
			bizLine: program.bizLine as BusinessLineId,
			name: program.name,
			summary: program.summary,
			status: program.status || "active",
		});
		setEditorOpen(true);
	};

	const save = async () => {
		try {
			const values = await form.validateFields();
			setSaving(true);
			const payload: SaveProgramPayload = {
				programId: values.programId,
				programCode: values.programCode.trim() || undefined,
				name: values.name.trim(),
				summary: values.summary?.trim(),
				status: values.status,
			};
			const targetBizLine = values.bizLine;
			if (editing && targetBizLine !== activeBusinessLine.id) {
				await migrateProgram(activeBusinessLine.id, { ...payload, targetBizLine });
				message.success(t("programs.migrated"));
			} else {
				await saveProgram(targetBizLine, payload);
				message.success(t(editing ? "programs.saved" : "programs.created"));
			}
			closeProgramEditor();
			if (targetBizLine === activeBusinessLine.id) {
				await refresh();
			} else {
				setActiveBusinessLine(targetBizLine);
			}
		} catch (error) {
			if (error instanceof Error && error.message) message.error(error.message);
		} finally {
			setSaving(false);
		}
	};

	const openModules = (program: DeliveryProgramRecord) => {
		setModuleProgram(program);
		setModulePageIndex(1);
		setModulePageSize(MODULE_PAGE_SIZE);
	};

	const openStages = (program: DeliveryProgramRecord) => {
		setStageProgram(program);
	};

	const closeStageEditor = () => {
		setStageEditorOpen(false);
		setEditingStage(null);
		stageForm.resetFields();
	};

	const openCreateStage = () => {
		setEditingStage(null);
		stageForm.resetFields();
		stageForm.setFieldsValue({
			stageKey: "",
			seq: stages.length,
			tag: "",
			timeWindow: "",
			maturityLevel: "",
			title: "",
		});
		setStageEditorOpen(true);
	};

	const openEditStage = (stage: DeliveryStageRecord) => {
		setEditingStage(stage);
		stageForm.resetFields();
		stageForm.setFieldsValue({
			stageKey: stage.stageKey,
			seq: stage.seq,
			tag: stage.tag,
			timeWindow: stage.timeWindow,
			maturityLevel: stage.maturityLevel,
			title: stage.title,
		});
		setStageEditorOpen(true);
	};

	const saveCurrentStage = async () => {
		if (!stageProgram) return;
		try {
			const values = await stageForm.validateFields();
			setStageSaving(true);
			const payload: SaveStagePayload = {
				programId: stageProgram.programId,
				stageKey: values.stageKey.trim(),
				seq: values.seq,
				tag: values.tag.trim(),
				timeWindow: values.timeWindow.trim(),
				maturityLevel: values.maturityLevel.trim(),
				title: values.title.trim(),
			};
			await saveStage(payload);
			message.success(t(editingStage ? "programs.stages.saved" : "programs.stages.created"));
			closeStageEditor();
			await refreshStages();
		} catch (error) {
			if (error instanceof Error && error.message) message.error(error.message);
		} finally {
			setStageSaving(false);
		}
	};

	const removeStage = async (stage: DeliveryStageRecord) => {
		if (!stageProgram) return;
		setDeletingStageKey(stage.stageKey);
		try {
			await deleteStage(stageProgram.programId, stage.stageKey);
			message.success(t("programs.stages.deleted"));
			await refreshStages();
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setDeletingStageKey("");
		}
	};

	const closeModuleEditor = () => {
		setModuleEditorOpen(false);
		setEditingModule(null);
		moduleForm.resetFields();
	};

	const openCreateModule = () => {
		setEditingModule(null);
		moduleForm.resetFields();
		moduleForm.setFieldsValue({ moduleKey: "", name: "", seq: modulesTotal, weight: 0, kind: "link" });
		setModuleEditorOpen(true);
	};

	const openEditModule = (module: DeliveryModuleRecord) => {
		setEditingModule(module);
		moduleForm.resetFields();
		moduleForm.setFieldsValue({
			moduleKey: module.moduleKey,
			name: module.name,
			seq: module.seq,
			weight: module.weight,
			kind: module.kind || "link",
		});
		setModuleEditorOpen(true);
	};

	const saveCurrentModule = async () => {
		if (!moduleProgram) return;
		try {
			const values = await moduleForm.validateFields();
			setModuleSaving(true);
			const payload: SaveModulePayload = {
				programId: moduleProgram.programId,
				moduleKey: values.moduleKey.trim(),
				name: values.name.trim(),
				seq: values.seq,
				weight: values.weight,
				kind: values.kind,
			};
			await saveModule(payload);
			message.success(t(editingModule ? "programs.modules.saved" : "programs.modules.created"));
			closeModuleEditor();
			await refreshModules(modulePageIndex);
		} catch (error) {
			if (error instanceof Error && error.message) message.error(error.message);
		} finally {
			setModuleSaving(false);
		}
	};

	const openModuleDeletion = async (module: DeliveryModuleRecord) => {
		if (!moduleProgram) return;
		setModulePendingDeletion(module);
		setModuleDeleteTargetKey("");
		setModuleDeleteCandidatesLoading(true);
		try {
			setModuleDeleteCandidates(await fetchModules(moduleProgram.programId));
		} catch (error) {
			setModulePendingDeletion(null);
			message.error((error as Error).message);
		} finally {
			setModuleDeleteCandidatesLoading(false);
		}
	};

	const closeModuleDeletion = () => {
		if (deletingModuleKey) return;
		setModulePendingDeletion(null);
		setModuleDeleteCandidates([]);
		setModuleDeleteTargetKey("");
	};

	const removeModule = async () => {
		const module = modulePendingDeletion;
		if (!moduleProgram || !module) return;
		if (module.itemCount > 0 && !moduleDeleteTargetKey) {
			message.error(t("programs.modules.targetRequired"));
			return;
		}
		setDeletingModuleKey(module.moduleKey);
		try {
			await deleteModule({
				programId: moduleProgram.programId,
				moduleKey: module.moduleKey,
				targetModuleKey: module.itemCount > 0 ? moduleDeleteTargetKey : undefined,
			});
			message.success(t("programs.modules.deleted"));
			setModulePendingDeletion(null);
			setModuleDeleteCandidates([]);
			setModuleDeleteTargetKey("");
			const nextPage = modules.length === 1 && modulePageIndex > 1 ? modulePageIndex - 1 : modulePageIndex;
			if (nextPage !== modulePageIndex) setModulePageIndex(nextPage);
			else await refreshModules(nextPage);
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setDeletingModuleKey("");
		}
	};

	const openWorkspacePreference = useCallback(async (program: DeliveryProgramRecord) => {
		setWorkspaceProgram(program);
		setWorkspaceProjects([]);
		setWorkspaceLoading(true);
		const saved = getProjectWorkspacePreference(program.programId);
		setWorkspacePath(saved?.workspace || "");
		setWorkspaceSource(saved ? "saved" : "unmatched");
		try {
			const catalog = await fetchCodexLocalProjects(program.programId);
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
			message.error((error as Error).message);
		} finally {
			setWorkspaceLoading(false);
		}
	}, []);

	const saveWorkspacePreference = async () => {
		if (!workspaceProgram) return;
		const candidate = workspacePath.trim();
		if (!candidate) {
			message.error(t("programs.workspace.required"));
			return;
		}
		setWorkspaceSaving(true);
		try {
			const result = await validateCodexWorkspace(workspaceProgram.programId, candidate);
			saveProjectWorkspacePreference(workspaceProgram.programId, result.workspace);
			message.success(t("programs.workspace.saved"));
			setWorkspaceProgram(null);
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setWorkspaceSaving(false);
		}
	};

	const workspaceOptions = useMemo(
		() => workspaceProjects.flatMap((project) => project.rootPaths.map((rootPath) => ({
			value: rootPath,
			label: `${project.name} · ${rootPath}`,
		}))),
		[workspaceProjects],
	);

	const columns = useMemo<ColumnsType<DeliveryProgramRecord>>(
		() => [
			{
				title: t("programs.name"),
				dataIndex: "name",
				render: (_, record) => (
					<div>
						<b data-locale-static="false">{record.name || record.programId}</b>
						<div className="manager-table-subline" data-locale-static="false">{record.summary || "-"}</div>
					</div>
				),
			},
			{
				title: t("programs.id"),
				dataIndex: "programId",
				width: 200,
				render: (value: number) => <span className="manager-mono">{value}</span>,
			},
			{
				title: t("programs.status"),
				dataIndex: "status",
				width: 120,
				render: (value: string) => (
					<Tag color={value === "archived" ? "default" : "success"}>
						{t(value === "archived" ? "programs.status.archived" : "programs.status.active")}
					</Tag>
				),
			},
			{
				title: t("programs.updated"),
				dataIndex: "updatedAt",
				width: 180,
				render: (value?: string) => value ? new Date(value).toLocaleString(locale, { hour12: false }) : "-",
			},
			{
				title: "",
				key: "actions",
				width: 366,
				align: "right",
				render: (_, record) => (
					<Space size={2}>
						<Button type="text" icon={<FlagOutlined />} onClick={() => openStages(record)}>
							{t("programs.stages.manage")}
						</Button>
						<Button type="text" icon={<AppstoreOutlined />} onClick={() => openModules(record)}>
							{t("programs.modules.manage")}
						</Button>
						<Tooltip title={t("programs.workspace.manage")}>
							<Button
								type="text"
								icon={<SettingOutlined />}
								aria-label={t("programs.workspace.manage")}
								onClick={() => void openWorkspacePreference(record)}
							/>
						</Tooltip>
						<Tooltip title={t("programs.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("programs.edit")} onClick={() => openEdit(record)} />
						</Tooltip>
					</Space>
				),
			},
		],
		[locale, openWorkspacePreference, t],
	);

	const moduleColumns = useMemo<ColumnsType<DeliveryModuleRecord>>(
		() => [
			{
				title: t("programs.modules.name"),
				dataIndex: "name",
				render: (_, record) => (
					<div>
						<b data-locale-static="false">{record.name || record.moduleKey}</b>
						<div className="manager-table-subline manager-mono">{record.moduleKey}</div>
					</div>
				),
			},
			{
				title: t("programs.modules.seq"),
				dataIndex: "seq",
				width: 68,
				align: "right",
				render: (value: number) => <span className="manager-mono">{value}</span>,
			},
			{
				title: t("programs.modules.weight"),
				dataIndex: "weight",
				width: 88,
				align: "right",
				render: (value: number) => <span className="manager-mono">{value}%</span>,
			},
			{
				title: t("programs.modules.kind"),
				dataIndex: "kind",
				width: 88,
				render: (value: string) => <Tag>{t(`programs.modules.kind.${value}`)}</Tag>,
			},
			{
				title: t("programs.modules.itemCount"),
				dataIndex: "itemCount",
				width: 88,
				align: "right",
				render: (value: number) => <span className="manager-mono">{value}</span>,
			},
			{
				title: "",
				key: "actions",
				width: 88,
				align: "right",
				render: (_, record) => (
					<Space size={0}>
						<Tooltip title={t("programs.modules.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("programs.modules.edit")} onClick={() => openEditModule(record)} />
						</Tooltip>
						<Tooltip title={t("programs.modules.delete")}>
							<Button danger type="text" icon={<DeleteOutlined />} aria-label={t("programs.modules.delete")} loading={deletingModuleKey === record.moduleKey} onClick={() => void openModuleDeletion(record)} />
						</Tooltip>
					</Space>
				),
			},
		],
		[activeBusinessLine.id, deletingModuleKey, moduleProgram, t],
	);

	const stageColumns = useMemo<ColumnsType<DeliveryStageRecord>>(
		() => [
			{
				title: t("programs.stages.name"),
				dataIndex: "tag",
				render: (_, record) => (
					<div>
						<b data-locale-static="false">{record.tag || record.stageKey}</b>
						<div className="manager-table-subline" data-locale-static="false">{record.title || "-"}</div>
					</div>
				),
			},
			{
				title: t("programs.stages.seq"),
				dataIndex: "seq",
				width: 66,
				align: "right",
				render: (value: number) => <span className="manager-mono">{value}</span>,
			},
			{
				title: t("programs.stages.window"),
				dataIndex: "timeWindow",
				width: 122,
				render: (value: string) => <span data-locale-static="false">{value || "-"}</span>,
			},
			{
				title: t("programs.stages.level"),
				dataIndex: "maturityLevel",
				width: 94,
				render: (value: string) => <Tag data-locale-static="false">{value || "-"}</Tag>,
			},
			{
				title: "",
				key: "actions",
				width: 88,
				align: "right",
				render: (_, record) => (
					<Space size={0}>
						<Tooltip title={t("programs.stages.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("programs.stages.edit")} onClick={() => openEditStage(record)} />
						</Tooltip>
						<Popconfirm
							title={t("programs.stages.deleteConfirm")}
							okButtonProps={{ danger: true, loading: deletingStageKey === record.stageKey }}
							onConfirm={() => removeStage(record)}
						>
							<Tooltip title={t("programs.stages.delete")}>
								<Button danger type="text" icon={<DeleteOutlined />} aria-label={t("programs.stages.delete")} loading={deletingStageKey === record.stageKey} />
							</Tooltip>
						</Popconfirm>
					</Space>
				),
			},
		],
		[deletingStageKey, t],
	);

	return (
		<div className="manager-page-stack">
			<section className="manager-page-heading">
				<div>
					<div className="manager-section-label">PROGRAMS</div>
					<h1>{t("programs.title")}</h1>
					<p>{t("programs.intro")}</p>
				</div>
				<Tag className="manager-count-tag">{activeBusinessLine.code}</Tag>
			</section>

			<section className="manager-data-card">
				<div className="manager-table-heading">
					<div>
						<h2>{t("programs.title")}</h2>
						<span>{activeBusinessLine.label}</span>
					</div>
					<Space>
						<Tooltip title={t("programs.refresh")}>
							<Button icon={<ReloadOutlined />} aria-label={t("programs.refresh")} loading={loading} onClick={() => void refresh()} />
						</Tooltip>
						<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
							{t("programs.new")}
						</Button>
					</Space>
				</div>
				{programs.length === 0 && !loading ? (
					<Empty description={t("programs.empty")} />
				) : (
					<div className="manager-table">
						<Table<DeliveryProgramRecord>
							rowKey="programId"
							loading={loading}
							columns={columns}
							dataSource={programs}
							pagination={false}
							scroll={{ x: 980 }}
						/>
					</div>
				)}
			</section>

			<Modal
				wrapClassName="manager-form-skin"
				open={Boolean(workspaceProgram)}
				destroyOnClose
				title={t("programs.workspace.title")}
				okText={t("programs.workspace.confirm")}
				cancelText={t("common.cancel")}
				confirmLoading={workspaceSaving}
				onCancel={() => setWorkspaceProgram(null)}
				onOk={() => void saveWorkspacePreference()}
			>
				<Space direction="vertical" size={16} style={{ width: "100%" }}>
					<div>
						<div className="manager-table-subline">{t("programs.workspace.program")}</div>
						<strong data-locale-static="false">{workspaceProgram?.name}</strong>
						<div className="manager-table-subline">
							{t("programs.workspace.programCode")} · <span className="manager-mono" data-locale-static="false">{workspaceProgram?.programCode || "-"}</span>
						</div>
					</div>
					<Alert
						showIcon
						type={workspaceSource === "unmatched" ? "warning" : "info"}
						message={t(workspaceSource === "saved" ? "programs.workspace.savedStatus" : `programs.workspace.${workspaceSource}`)}
						description={t("programs.workspace.localHint")}
					/>
					<Form layout="vertical" style={{ width: "100%" }}>
						<Form.Item label={t("programs.workspace.detected")}>
							<Select
								allowClear
								showSearch
								loading={workspaceLoading}
								placeholder={t("programs.workspace.detectedPlaceholder")}
								options={workspaceOptions}
								value={workspaceOptions.some((option) => option.value === workspacePath) ? workspacePath : undefined}
								onChange={(value) => {
									setWorkspacePath(value || "");
									setWorkspaceSource("matched");
								}}
							/>
						</Form.Item>
						<Form.Item label={t("programs.workspace.path")} required extra={t("programs.workspace.pathHint")}>
							<Input
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
				</Space>
			</Modal>

			<Modal
				wrapClassName="manager-form-skin"
				open={editorOpen}
				destroyOnClose
				title={t(editing ? "programs.edit" : "programs.new")}
				okText={t("programs.save")}
				cancelText={t("common.cancel")}
				confirmLoading={saving}
				onCancel={closeProgramEditor}
				onOk={() => void save()}
			>
					<Form form={form} layout="vertical">
						<Form.Item label={t("programs.businessLine")} name="bizLine" rules={[{ required: true, message: t("programs.businessLine.required") }]}>
							<Select options={businessLines.map((line) => ({ value: line.id, label: `${line.label} · ${line.code}` }))} />
						</Form.Item>
					{editing ? (
						<Form.Item label={t("programs.id")} name="programId">
							<InputNumber disabled style={{ width: "100%" }} />
						</Form.Item>
					) : null}
					<Form.Item
						label="项目编码"
						name="programCode"
						rules={editing ? [] : [{ required: true, message: "请填写项目编码" }]}
						extra={editing ? "留空保持原编码" : "用于展示和导入幂等，不作为项目关联标识"}
					>
						<Input />
					</Form.Item>
					<Form.Item label={t("programs.name")} name="name" rules={[{ required: true, message: t("programs.required") }]}>
						<Input />
					</Form.Item>
					<Form.Item label={t("programs.summary")} name="summary">
						<Input.TextArea rows={3} />
					</Form.Item>
					<Form.Item label={t("programs.status")} name="status">
						<Select
							options={[
								{ value: "active", label: t("programs.status.active") },
								{ value: "archived", label: t("programs.status.archived") },
							]}
						/>
					</Form.Item>
				</Form>
			</Modal>

			<Drawer
				rootClassName="manager-form-skin"
				placement="left"
				width={600}
				open={Boolean(stageProgram)}
				onClose={() => setStageProgram(null)}
				title={t("programs.stages.title")}
				extra={
					<Button type="primary" icon={<PlusOutlined />} disabled={!stageProgram} onClick={openCreateStage}>
						{t("programs.stages.new")}
					</Button>
				}
			>
				{stageProgram ? (
					<>
						<div className="manager-drawer-intro">
							<span>{t("programs.stages.program")}</span>
							<strong data-locale-static="false">{stageProgram.name || stageProgram.programId}</strong>
							<span className="manager-mono">{stageProgram.programId}</span>
						</div>
						<div className="manager-module-toolbar">
							<span className="manager-table-subline">{t("programs.stages.title")}</span>
							<Tooltip title={t("programs.refresh")}>
								<Button icon={<ReloadOutlined />} aria-label={t("programs.refresh")} loading={stagesLoading} onClick={() => void refreshStages()} />
							</Tooltip>
						</div>
						{stages.length === 0 && !stagesLoading ? (
							<Empty description={t("programs.stages.empty")} />
						) : (
							<div className="manager-table">
								<Table<DeliveryStageRecord>
									rowKey="stageKey"
									loading={stagesLoading}
									columns={stageColumns}
									dataSource={stages}
									size="small"
									scroll={{ x: 540 }}
									pagination={false}
								/>
							</div>
						)}
					</>
				) : null}
			</Drawer>

			<Drawer
				rootClassName="manager-form-skin"
				placement="left"
				width={600}
				open={Boolean(moduleProgram)}
				onClose={() => setModuleProgram(null)}
				title={t("programs.modules.title")}
				extra={
					<Button type="primary" icon={<PlusOutlined />} disabled={!moduleProgram} onClick={openCreateModule}>
						{t("programs.modules.new")}
					</Button>
				}
			>
				{moduleProgram ? (
					<>
						<div className="manager-drawer-intro">
							<span>{t("programs.modules.program")}</span>
							<strong data-locale-static="false">{moduleProgram.name || moduleProgram.programId}</strong>
							<span className="manager-mono">{moduleProgram.programId}</span>
						</div>
						<div className="manager-module-toolbar">
							<span className="manager-table-subline">{t("programs.modules.title")}</span>
							<Tooltip title={t("programs.refresh")}>
								<Button icon={<ReloadOutlined />} aria-label={t("programs.refresh")} loading={modulesLoading} onClick={() => void refreshModules(modulePageIndex)} />
							</Tooltip>
						</div>
						{modules.length === 0 && !modulesLoading ? (
							<Empty description={t("programs.modules.empty")} />
						) : (
							<div className="manager-table">
								<Table<DeliveryModuleRecord>
									rowKey="moduleKey"
									loading={modulesLoading}
									columns={moduleColumns}
									dataSource={modules}
									size="small"
									scroll={{ x: 520 }}
									pagination={{
										current: modulePageIndex,
										pageSize: modulePageSize,
										total: modulesTotal,
										showSizeChanger: true,
										onChange: (page, pageSize) => {
											setModulePageIndex(page);
											setModulePageSize(pageSize);
										},
									}}
								/>
							</div>
						)}
					</>
				) : null}
			</Drawer>

			<Modal
				wrapClassName="manager-form-skin"
				open={Boolean(modulePendingDeletion)}
				destroyOnClose
				title={t("programs.modules.deleteTitle")}
				okText={t("programs.modules.delete")}
				cancelText={t("common.cancel")}
				okButtonProps={{
					danger: true,
					disabled: Boolean(
						modulePendingDeletion
						&& modulePendingDeletion.itemCount > 0
						&& (moduleDeleteCandidatesLoading || moduleDeleteCandidates.filter((candidate) => candidate.moduleKey !== modulePendingDeletion.moduleKey).length === 0),
					),
				}}
				confirmLoading={Boolean(modulePendingDeletion && deletingModuleKey === modulePendingDeletion.moduleKey)}
				onCancel={closeModuleDeletion}
				onOk={() => void removeModule()}
			>
				{modulePendingDeletion ? (
					<>
						<p>
							<strong data-locale-static="false">{modulePendingDeletion.name || modulePendingDeletion.moduleKey}</strong>
							<span> ({modulePendingDeletion.moduleKey})</span>
						</p>
						{modulePendingDeletion.itemCount > 0 ? (
							<Form layout="vertical">
								<p>
									{t("programs.modules.deleteMoveHint")}
									<strong className="manager-mono"> {modulePendingDeletion.itemCount} </strong>
									{t("programs.modules.deleteMoveTasks")}
								</p>
								<Form.Item label={t("programs.modules.target")} required>
									<Select
										loading={moduleDeleteCandidatesLoading}
										value={moduleDeleteTargetKey || undefined}
										placeholder={t("programs.modules.targetPlaceholder")}
										onChange={setModuleDeleteTargetKey}
										options={moduleDeleteCandidates
											.filter((candidate) => candidate.moduleKey !== modulePendingDeletion.moduleKey)
											.map((candidate) => ({
												value: candidate.moduleKey,
												label: `${candidate.name || candidate.moduleKey} (${candidate.moduleKey})`,
											}))}
									/>
								</Form.Item>
								{!moduleDeleteCandidatesLoading && moduleDeleteCandidates.filter((candidate) => candidate.moduleKey !== modulePendingDeletion.moduleKey).length === 0 ? (
									<p>{t("programs.modules.targetEmpty")}</p>
								) : null}
							</Form>
						) : (
							<p>{t("programs.modules.deleteEmptyHint")}</p>
						)}
					</>
				) : null}
			</Modal>

			<Modal
				wrapClassName="manager-form-skin"
				open={moduleEditorOpen}
				destroyOnClose
				title={t(editingModule ? "programs.modules.edit" : "programs.modules.new")}
				okText={t("programs.modules.save")}
				cancelText={t("common.cancel")}
				confirmLoading={moduleSaving}
				onCancel={closeModuleEditor}
				onOk={() => void saveCurrentModule()}
			>
				<Form form={moduleForm} layout="vertical">
					<Form.Item
						label={t("programs.modules.key")}
						name="moduleKey"
						rules={[{ required: true, message: t("programs.modules.required") }]}
						extra={editingModule ? t("programs.modules.keyHint") : undefined}
					>
						<Input disabled={Boolean(editingModule)} />
					</Form.Item>
					<Form.Item label={t("programs.modules.name")} name="name" rules={[{ required: true, message: t("programs.modules.required") }]}>
						<Input />
					</Form.Item>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
						<Form.Item label={t("programs.modules.seq")} name="seq" rules={[{ required: true, message: t("programs.modules.required") }]}>
							<InputNumber min={0} precision={0} />
						</Form.Item>
						<Form.Item label={t("programs.modules.weight")} name="weight" rules={[{ required: true, message: t("programs.modules.required") }]}>
							<InputNumber min={0} precision={0} addonAfter="%" />
						</Form.Item>
					</div>
					<Form.Item label={t("programs.modules.kind")} name="kind" rules={[{ required: true, message: t("programs.modules.required") }]}>
						<Select options={MODULE_KINDS.map((kind) => ({ value: kind, label: t(`programs.modules.kind.${kind}`) }))} />
					</Form.Item>
				</Form>
			</Modal>

			<Modal
				wrapClassName="manager-form-skin"
				open={stageEditorOpen}
				destroyOnClose
				title={t(editingStage ? "programs.stages.edit" : "programs.stages.new")}
				okText={t("programs.stages.save")}
				cancelText={t("common.cancel")}
				confirmLoading={stageSaving}
				onCancel={closeStageEditor}
				onOk={() => void saveCurrentStage()}
			>
				<Form form={stageForm} layout="vertical">
					<Form.Item
						label={t("programs.stages.key")}
						name="stageKey"
						rules={[{ required: true, message: t("programs.stages.required") }]}
						extra={editingStage ? t("programs.stages.keyHint") : undefined}
					>
						<Input disabled={Boolean(editingStage)} />
					</Form.Item>
					<div style={{ display: "grid", gridTemplateColumns: "1fr minmax(0, 2fr)", gap: 12 }}>
						<Form.Item label={t("programs.stages.seq")} name="seq" rules={[{ required: true, message: t("programs.stages.required") }]}>
							<InputNumber min={0} precision={0} />
						</Form.Item>
						<Form.Item label={t("programs.stages.name")} name="tag" rules={[{ required: true, message: t("programs.stages.required") }]}>
							<Input />
						</Form.Item>
					</div>
					<Form.Item label={t("programs.stages.titleField")} name="title" rules={[{ required: true, message: t("programs.stages.required") }]}>
						<Input />
					</Form.Item>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
						<Form.Item label={t("programs.stages.window")} name="timeWindow">
							<Input />
						</Form.Item>
						<Form.Item label={t("programs.stages.level")} name="maturityLevel">
							<Input />
						</Form.Item>
					</div>
				</Form>
			</Modal>
		</div>
	);
}
