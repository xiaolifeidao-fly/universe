"use client";

import {
	CheckCircleOutlined,
	DeleteOutlined,
	EditOutlined,
	PlusOutlined,
	ReloadOutlined,
} from "@ant-design/icons";
import {
	Button,
	Empty,
	Form,
	Input,
	Modal,
	Popconfirm,
	Select,
	Space,
	Switch,
	Table,
	Tag,
	Tooltip,
	message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BizLineRecord,
	deleteBizLine,
	fetchBizLineAssignment,
	fetchAllBizLines,
	saveBizLineAssignment,
	saveBizLine,
	type SaveBizLinePayload,
} from "@/api/bizline.api";
import { fetchMembers, type MemberRecord } from "@/api/delivery.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import { getAuthUser } from "@/utils/auth";

interface BizLineFormValues {
	code: string;
	name: string;
	enabled: boolean;
	userIds: number[];
	managerIds: number[];
}

export function BusinessLineWorkspace() {
	const { t } = useLocale();
	const { activeBusinessLine, refreshBusinessLines } = useBusinessLine();
	const [form] = Form.useForm<BizLineFormValues>();
	const [rows, setRows] = useState<BizLineRecord[]>([]);
	const [members, setMembers] = useState<MemberRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<BizLineRecord | null>(null);
	const [deletingCode, setDeletingCode] = useState("");
	const authUser = getAuthUser();
	const isSuperAdmin = authUser?.role === "admin";
	const managedBizLines = authUser?.managedBizLines ?? [];

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const [lines, availableMembers] = await Promise.all([fetchAllBizLines(), fetchMembers(), refreshBusinessLines()]);
			setRows(lines);
			setMembers(availableMembers);
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setLoading(false);
		}
	}, [refreshBusinessLines]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const closeEditor = () => {
		setEditorOpen(false);
		setEditing(null);
		form.resetFields();
	};

	const openCreate = () => {
		setEditing(null);
		form.resetFields();
		form.setFieldsValue({ code: "", name: "", enabled: true, userIds: [], managerIds: [] });
		setEditorOpen(true);
	};

	const canManage = (record: BizLineRecord) => isSuperAdmin || managedBizLines.includes(record.code);

	const openEdit = async (record: BizLineRecord) => {
		try {
			const assignment = await fetchBizLineAssignment(record.code);
		setEditing(record);
		form.resetFields();
		form.setFieldsValue({ code: record.code, name: record.name, enabled: record.enabled, userIds: assignment.userIds, managerIds: assignment.managerIds });
		setEditorOpen(true);
		} catch (error) {
			message.error((error as Error).message);
		}
	};

	const save = async () => {
		try {
			const values = await form.validateFields();
			setSaving(true);
			const payload: SaveBizLinePayload = {
				code: values.code.trim().toLowerCase(),
				name: values.name.trim(),
				enabled: values.enabled,
			};
			if (isSuperAdmin) {
				await saveBizLine(payload);
			}
			await saveBizLineAssignment(payload.code, { userIds: values.userIds ?? [], managerIds: values.managerIds ?? [] });
			message.success(t(editing ? "businessLines.saved" : "businessLines.created"));
			closeEditor();
			await refresh();
		} catch (error) {
			if (error instanceof Error && error.message) message.error(error.message);
		} finally {
			setSaving(false);
		}
	};

	const remove = async (record: BizLineRecord) => {
		setDeletingCode(record.code);
		try {
			await deleteBizLine(record.code);
			message.success(t("businessLines.deleted"));
			await refresh();
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setDeletingCode("");
		}
	};

	const columns = useMemo<ColumnsType<BizLineRecord>>(
		() => [
			{
				title: t("businessLines.name"),
				dataIndex: "name",
				render: (value: string, record) => (
					<div>
						<b data-locale-static="false">{value || record.code}</b>
						<div className="manager-table-subline" data-locale-static="false">{record.code}</div>
					</div>
				),
			},
			{
				title: t("businessLines.code"),
				dataIndex: "code",
				width: 180,
				render: (value: string) => <span className="manager-mono" data-locale-static="false">{value}</span>,
			},
			{
				title: t("businessLines.status"),
				dataIndex: "enabled",
				width: 130,
				render: (enabled: boolean) => (
					<Tag color={enabled ? "success" : "default"} icon={enabled ? <CheckCircleOutlined /> : undefined}>
						{t(enabled ? "businessLines.enabled" : "businessLines.disabled")}
					</Tag>
				),
			},
			{
				title: "",
				key: "actions",
				width: 104,
				align: "right",
				render: (_, record) => (
					<Space size={0}>
						{canManage(record) ? <Tooltip title={t("businessLines.edit")}>
							<Button type="text" icon={<EditOutlined />} aria-label={t("businessLines.edit")} onClick={() => void openEdit(record)} />
						</Tooltip> : null}
						{isSuperAdmin ? <Popconfirm
							title={t("businessLines.deleteConfirm")}
							okButtonProps={{ danger: true, loading: deletingCode === record.code }}
							onConfirm={() => remove(record)}
						>
							<Tooltip title={t("businessLines.delete")}>
								<Button
									danger
									type="text"
									icon={<DeleteOutlined />}
									aria-label={t("businessLines.delete")}
									loading={deletingCode === record.code}
								/>
							</Tooltip>
						</Popconfirm> : null}
					</Space>
				),
			},
		],
		[deletingCode, isSuperAdmin, managedBizLines, t],
	);

	return (
		<div className="manager-page-stack">
			<section className="manager-page-heading">
				<div>
					<div className="manager-section-label">BUSINESS LINES</div>
					<h1>{t("businessLines.title")}</h1>
					<p>{t("businessLines.intro")}</p>
				</div>
				<Tag className="manager-count-tag">{rows.length}</Tag>
			</section>

			<section className="manager-data-card">
				<div className="manager-table-heading">
					<div>
						<h2>{t("businessLines.title")}</h2>
						<span data-locale-static="false">{activeBusinessLine.label}</span>
					</div>
					<Space>
						<Tooltip title={t("businessLines.refresh")}>
							<Button icon={<ReloadOutlined />} aria-label={t("businessLines.refresh")} loading={loading} onClick={() => void refresh()} />
						</Tooltip>
						{isSuperAdmin ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
							{t("businessLines.new")}
						</Button> : null}
					</Space>
				</div>
				{rows.length === 0 && !loading ? (
					<Empty description={t("businessLines.empty")} />
				) : (
					<div className="manager-table">
						<Table<BizLineRecord>
							rowKey="code"
							loading={loading}
							columns={columns}
							dataSource={rows}
							pagination={false}
							scroll={{ x: 620 }}
						/>
					</div>
				)}
			</section>

			<Modal
				wrapClassName="manager-form-skin"
				open={editorOpen}
				destroyOnHidden
				forceRender
				title={t(editing ? "businessLines.edit" : "businessLines.new")}
				okText={t("businessLines.save")}
				cancelText={t("common.cancel")}
				confirmLoading={saving}
				onCancel={closeEditor}
				onOk={() => void save()}
			>
				<Form form={form} layout="vertical">
					<Form.Item
						label={t("businessLines.code")}
						name="code"
						rules={[
							{ required: true, message: t("businessLines.required") },
							{ pattern: /^[a-z0-9][a-z0-9_-]*$/i, message: t("businessLines.codeInvalid") },
						]}
						extra={editing ? t("businessLines.codeHint") : undefined}
					>
						<Input disabled={Boolean(editing) || !isSuperAdmin} autoComplete="off" />
					</Form.Item>
					<Form.Item label={t("businessLines.name")} name="name" rules={[{ required: true, message: t("businessLines.required") }]}>
						<Input disabled={!isSuperAdmin} autoComplete="off" />
					</Form.Item>
					<Form.Item label={t("businessLines.status")} name="enabled" valuePropName="checked">
						<Switch disabled={!isSuperAdmin} checkedChildren={t("businessLines.enabled")} unCheckedChildren={t("businessLines.disabled")} />
					</Form.Item>
					<Form.Item label={t("businessLines.members")} name="userIds">
						<Select mode="multiple" options={members.map((member) => ({ value: Number(member.id), label: member.displayName || member.username }))} />
					</Form.Item>
					<Form.Item label={t("businessLines.managers")} name="managerIds" extra={t("businessLines.managersHint")}>
						<Select disabled={!isSuperAdmin} mode="multiple" options={members.map((member) => ({ value: Number(member.id), label: member.displayName || member.username }))} />
					</Form.Item>
				</Form>
			</Modal>
		</div>
	);
}
