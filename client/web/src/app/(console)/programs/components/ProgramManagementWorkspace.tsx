"use client";

import {
	AppstoreOutlined,
	DeleteOutlined,
	EditOutlined,
	FlagOutlined,
	PlusOutlined,
	ReloadOutlined,
	SettingOutlined,
	TeamOutlined,
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
import { fetchBizLineMembers } from "@/api/bizline.api";
import { type BusinessLineId, useBusinessLine } from "@/business-lines/BusinessLineProvider";
import {
	deleteModule,
	deleteStage,
	fetchModules,
	fetchModulesPage,
	fetchProgramAssignment,
	fetchPrograms,
	fetchStages,
	migrateProgram,
	saveModule,
	saveProgramAssignment,
	saveProgram,
	saveStage,
	type DeliveryModuleRecord,
	type DeliveryProgramRecord,
	type DeliveryStageRecord,
	type MemberRecord,
	type SaveModulePayload,
	type SaveProgramPayload,
	type SaveStagePayload,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { ProgramWorkspacePreferenceModal } from "./ProgramWorkspacePreferenceModal";

interface ProgramFormValues {
	programCode: string;
	bizLine: BusinessLineId;
	name: string;
	summary?: string;
	status: string;
}

interface ProgramAssignFormValues {
	userIds: number[];
	managerIds: number[];
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
	const [assignForm] = Form.useForm<ProgramAssignFormValues>();
	const [programs, setPrograms] = useState<DeliveryProgramRecord[]>([]);
	const [members, setMembers] = useState<MemberRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<DeliveryProgramRecord | null>(null);
	const [assignProgram, setAssignProgram] = useState<DeliveryProgramRecord | null>(null);
	const [assignLoading, setAssignLoading] = useState(false);
	const [assignSaving, setAssignSaving] = useState(false);
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
	// 只读成员建不了项目也编辑不了项目；系统管理员在空间维度不再有隐式权限。
	// 空间维度的权限跟着业务线列表从服务端下来，不查本地缓存的授权范围 ——
	// 那份缓存在刚建完空间、或别人调整过你的权限之后就不准了。
	const canWriteBizLine = (bizLine: string) => businessLines.some((line) => line.id === bizLine && line.canWrite);
	const canManageBizLine = (bizLine: string) => businessLines.some((line) => line.id === bizLine && line.canManage);
	const canCreateProgram = canWriteBizLine(activeBusinessLine.id);
	// 改项目、分配人员这些动的是项目本身，只有项目管理员和空间管理员能做；
	// 里程碑、模块跟任务同级，空间的写入成员也要能维护。两者都由服务端逐行返回。
	const canAdministerProgram = (program: DeliveryProgramRecord) => program.canAdminister;
	const canWriteProgram = (program: DeliveryProgramRecord) => program.canWrite;

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

	// 项目成员的候选只能来自当前空间已有的成员，不再列出全站账号。
	useEffect(() => {
		if (!activeBusinessLine.id) return;
		void fetchBizLineMembers(activeBusinessLine.id)
			.then((rows) => setMembers(rows.map((row) => ({ id: String(row.id), username: row.username, displayName: row.displayName }))))
			.catch((error: Error) => message.error(error.message));
	}, [activeBusinessLine.id]);

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
			programCode: program.programCode,
			bizLine: program.bizLine as BusinessLineId,
			name: program.name,
			summary: program.summary,
			status: program.status || "active",
		});
		setEditorOpen(true);
	};

	// 人员分配从项目新建/编辑里拆出来单独入口，保存项目时不再连带改动成员。
	const openAssign = useCallback(async (program: DeliveryProgramRecord) => {
		setAssignProgram(program);
		setAssignLoading(true);
		assignForm.resetFields();
		try {
			const assignment = await fetchProgramAssignment(program.programId);
			assignForm.setFieldsValue({ userIds: assignment.userIds, managerIds: assignment.managerIds });
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setAssignLoading(false);
		}
	}, [assignForm]);

	const closeAssign = () => {
		setAssignProgram(null);
		assignForm.resetFields();
	};

	const saveAssign = async () => {
		if (!assignProgram) return;
		try {
			const values = await assignForm.validateFields();
			setAssignSaving(true);
			await saveProgramAssignment(assignProgram.programId, { userIds: values.userIds ?? [], managerIds: values.managerIds ?? [] });
			message.success(t("programs.assign.saved"));
			closeAssign();
		} catch (error) {
			if (error instanceof Error && error.message) message.error(error.message);
		} finally {
			setAssignSaving(false);
		}
	};

	const save = async () => {
		try {
			const values = await form.validateFields();
			setSaving(true);
			const payload: SaveProgramPayload = {
				programId: editing?.programId ?? 0,
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
				width: 408,
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
								onClick={() => setWorkspaceProgram(record)}
							/>
						</Tooltip>
						{canAdministerProgram(record) ? <Tooltip title={t("programs.assign")}>
							<Button type="text" icon={<TeamOutlined />} aria-label={t("programs.assign")} onClick={() => void openAssign(record)} />
						</Tooltip> : null}
						{canAdministerProgram(record) ? <Tooltip title={t("programs.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("programs.edit")} onClick={() => openEdit(record)} />
						</Tooltip> : null}
					</Space>
				),
			},
		],
		[businessLines, locale, openAssign, t],
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
						{moduleProgram && canWriteProgram(moduleProgram) ? <Tooltip title={t("programs.modules.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("programs.modules.edit")} onClick={() => openEditModule(record)} />
						</Tooltip> : null}
						{moduleProgram && canWriteProgram(moduleProgram) ? <Tooltip title={t("programs.modules.delete")}>
							<Button danger type="text" icon={<DeleteOutlined />} aria-label={t("programs.modules.delete")} loading={deletingModuleKey === record.moduleKey} onClick={() => void openModuleDeletion(record)} />
						</Tooltip> : null}
					</Space>
				),
			},
		],
		[activeBusinessLine.id, businessLines, deletingModuleKey, moduleProgram, t],
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
						{stageProgram && canWriteProgram(stageProgram) ? <Tooltip title={t("programs.stages.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("programs.stages.edit")} onClick={() => openEditStage(record)} />
						</Tooltip> : null}
						{stageProgram && canWriteProgram(stageProgram) ? <Popconfirm
							title={t("programs.stages.deleteConfirm")}
							okButtonProps={{ danger: true, loading: deletingStageKey === record.stageKey }}
							onConfirm={() => removeStage(record)}
						>
							<Tooltip title={t("programs.stages.delete")}>
								<Button danger type="text" icon={<DeleteOutlined />} aria-label={t("programs.stages.delete")} loading={deletingStageKey === record.stageKey} />
							</Tooltip>
						</Popconfirm> : null}
					</Space>
				),
			},
		],
		[businessLines, deletingStageKey, stageProgram, t],
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
						{canCreateProgram ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
							{t("programs.new")}
						</Button> : null}
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

			<ProgramWorkspacePreferenceModal
				program={workspaceProgram}
				onClose={() => setWorkspaceProgram(null)}
				onSaved={refresh}
			/>

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
							<Select disabled={Boolean(editing) && !canManageBizLine(editing?.bizLine ?? "")} options={businessLines.map((line) => ({ value: line.id, label: `${line.label} · ${line.code}` }))} />
						</Form.Item>
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

			<Modal
				wrapClassName="manager-form-skin"
				open={Boolean(assignProgram)}
				destroyOnClose
				title={t("programs.assign.title")}
				okText={t("programs.save")}
				cancelText={t("common.cancel")}
				confirmLoading={assignSaving}
				okButtonProps={{ disabled: assignLoading }}
				onCancel={closeAssign}
				onOk={() => void saveAssign()}
			>
				<div className="manager-drawer-intro">
					<strong data-locale-static="false">{assignProgram?.name || assignProgram?.programId}</strong>
				</div>
				<Form form={assignForm} layout="vertical">
					<Form.Item label={t("programs.members")} name="userIds">
						<Select mode="multiple" loading={assignLoading} options={members.map((member) => ({ value: Number(member.id), label: member.displayName || member.username }))} />
					</Form.Item>
					<Form.Item label={t("programs.managers")} name="managerIds" extra={t("programs.managersHint")}>
						<Select mode="multiple" loading={assignLoading} options={members.map((member) => ({ value: Number(member.id), label: member.displayName || member.username }))} />
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
