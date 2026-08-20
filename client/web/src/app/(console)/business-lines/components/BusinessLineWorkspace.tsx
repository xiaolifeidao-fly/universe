"use client";

import {
	CheckCircleOutlined,
	CopyOutlined,
	DeleteOutlined,
	EditOutlined,
	EyeInvisibleOutlined,
	PlusOutlined,
	ReloadOutlined,
	ShareAltOutlined,
	TeamOutlined,
	UserDeleteOutlined,
} from "@ant-design/icons";
import {
	Button,
	Empty,
	Form,
	Input,
	Modal,
	Popconfirm,
	Segmented,
	Select,
	Space,
	Switch,
	Table,
	Tag,
	Tooltip,
	Typography,
	message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BizLineMemberRecord,
	BizLineRecord,
	BizLineShareLink,
	createBizLineShareLink,
	deleteBizLine,
	fetchAllBizLines,
	fetchBizLineMembers,
	removeBizLineMember,
	saveBizLine,
	saveBizLineMemberPermission,
	type SaveBizLinePayload,
} from "@/api/bizline.api";
import { refreshAuthUser } from "@/api/auth.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { getAuthUser } from "@/utils/auth";
import { useLocale } from "@/i18n/LocaleProvider";

interface BizLineFormValues {
	code: string;
	name: string;
	description: string;
	enabled: boolean;
	visible: boolean;
}

// 单个用户名下启用空间的上限，与服务端 bizline/dto 的 MaxOwnedBizLines 一致。
// 只算启用项：删除或停用一个就能腾出名额继续建。
const MAX_OWNED_BIZ_LINES = 30;

// 分享链接的有效期档位。默认取第一档，也就是服务端的 1 小时默认值。
const SHARE_TTL_OPTIONS = [
	{ minutes: 60, label: "businessLines.shareTtl60" },
	{ minutes: 1440, label: "businessLines.shareTtl1440" },
	{ minutes: 10080, label: "businessLines.shareTtl10080" },
] as const;

export function BusinessLineWorkspace() {
	const { t } = useLocale();
	const { activeBusinessLine, refreshBusinessLines } = useBusinessLine();
	const [form] = Form.useForm<BizLineFormValues>();
	const [rows, setRows] = useState<BizLineRecord[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<BizLineRecord | null>(null);
	const [deletingCode, setDeletingCode] = useState("");
	const [memberLine, setMemberLine] = useState<BizLineRecord | null>(null);
	const [members, setMembers] = useState<BizLineMemberRecord[]>([]);
	const [membersLoading, setMembersLoading] = useState(false);
	const [shareLine, setShareLine] = useState<BizLineRecord | null>(null);
	const [sharePermission, setSharePermission] = useState<"read" | "write">("read");
	const [shareTtl, setShareTtl] = useState<number>(SHARE_TTL_OPTIONS[0].minutes);
	const [shareLink, setShareLink] = useState<BizLineShareLink | null>(null);
	const [shareCreating, setShareCreating] = useState(false);
	// 能不能管理这条业务线由服务端随行返回，不查本地缓存的授权范围 ——
	// 那份缓存在刚建完空间、或别人调整过你的权限之后就不准了。
	// 这里读缓存的只有「我是谁」，那个不会过时。
	const canManage = useCallback((record: BizLineRecord) => record.canManage, []);
	const currentUserID = getAuthUser()?.id ?? 0;

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const [lines] = await Promise.all([fetchAllBizLines(), refreshBusinessLines()]);
			setRows(lines);
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
		form.setFieldsValue({ code: "", name: "", description: "", enabled: true, visible: true });
		setEditorOpen(true);
	};

	const openEdit = (record: BizLineRecord) => {
		setEditing(record);
		form.resetFields();
		form.setFieldsValue({
			code: record.code,
			name: record.name,
			description: record.description,
			enabled: record.enabled,
			visible: record.visible,
		});
		setEditorOpen(true);
	};

	const save = async () => {
		try {
			const values = await form.validateFields();
			setSaving(true);
			const payload: SaveBizLinePayload = {
				code: values.code.trim().toLowerCase(),
				name: values.name.trim(),
				description: (values.description ?? "").trim(),
				enabled: values.enabled,
				visible: values.visible,
			};
			await saveBizLine(payload);
			// 建完顺手同步一次个人档案。界面上的权限判定已经改成读服务端随行返回的
			// canManage / canWrite，这里同步的是缓存里其余的授权范围，别让它一直是旧的。
			if (!editing) await refreshAuthUser();
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

	// ---------- 成员 ----------

	const loadMembers = useCallback(async (code: string) => {
		setMembersLoading(true);
		try {
			setMembers(await fetchBizLineMembers(code));
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setMembersLoading(false);
		}
	}, []);

	const openMembers = (record: BizLineRecord) => {
		setMemberLine(record);
		setMembers([]);
		void loadMembers(record.code);
	};

	const changePermission = async (member: BizLineMemberRecord, canWrite: boolean) => {
		if (!memberLine) return;
		try {
			await saveBizLineMemberPermission(memberLine.code, member.id, canWrite);
			message.success(t("businessLines.permissionSaved"));
			await loadMembers(memberLine.code);
		} catch (error) {
			message.error((error as Error).message);
		}
	};

	const kickMember = async (member: BizLineMemberRecord) => {
		if (!memberLine) return;
		try {
			await removeBizLineMember(memberLine.code, member.id);
			message.success(t("businessLines.memberRemoved"));
			await loadMembers(memberLine.code);
		} catch (error) {
			message.error((error as Error).message);
		}
	};

	// ---------- 分享链接 ----------

	const openShare = (record: BizLineRecord) => {
		setShareLine(record);
		setSharePermission("read");
		setShareTtl(SHARE_TTL_OPTIONS[0].minutes);
		setShareLink(null);
	};

	const shareUrl = shareLink
		? `${typeof window === "undefined" ? "" : window.location.origin}/invite?token=${encodeURIComponent(shareLink.token)}`
		: "";

	const createShare = async () => {
		if (!shareLine) return;
		setShareCreating(true);
		try {
			setShareLink(await createBizLineShareLink(shareLine.code, sharePermission, shareTtl));
		} catch (error) {
			message.error((error as Error).message);
		} finally {
			setShareCreating(false);
		}
	};

	const copyShareUrl = async () => {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			message.success(t("businessLines.shareCopied"));
		} catch {
			// 剪贴板在非安全上下文里不可用，输入框里的链接仍可手动复制。
			message.warning(shareUrl);
		}
	};

	const permissionLabel = useCallback(
		(permission: BizLineMemberRecord["permission"]) => {
			if (permission === "manager") return t("businessLines.permissionManager");
			return t(permission === "write" ? "businessLines.permissionWrite" : "businessLines.permissionRead");
		},
		[t],
	);

	const ownedCount = rows.filter((row) => row.enabled && canManage(row)).length;
	const quotaReached = ownedCount >= MAX_OWNED_BIZ_LINES;

	const columns = useMemo<ColumnsType<BizLineRecord>>(
		() => [
			{
				title: t("businessLines.name"),
				dataIndex: "name",
				render: (value: string, record) => (
					<div>
						<b data-locale-static="false">{value || record.code}</b>
						<div className="manager-table-subline" data-locale-static="false">
							{record.description || record.code}
						</div>
					</div>
				),
			},
			{
				title: t("businessLines.code"),
				dataIndex: "code",
				width: 160,
				render: (value: string) => <span className="manager-mono" data-locale-static="false">{value}</span>,
			},
			{
				title: t("businessLines.status"),
				dataIndex: "enabled",
				width: 120,
				render: (enabled: boolean) => (
					<Tag color={enabled ? "success" : "default"} icon={enabled ? <CheckCircleOutlined /> : undefined}>
						{t(enabled ? "businessLines.enabled" : "businessLines.disabled")}
					</Tag>
				),
			},
			{
				title: t("businessLines.visible"),
				dataIndex: "visible",
				width: 120,
				render: (visible: boolean) => (
					<Tag color={visible ? "blue" : "warning"} icon={visible ? undefined : <EyeInvisibleOutlined />}>
						{t(visible ? "businessLines.visibleOn" : "businessLines.visibleOff")}
					</Tag>
				),
			},
			{
				title: "",
				key: "actions",
				width: 176,
				align: "right",
				render: (_, record) => (
					<Space size={0}>
						<Tooltip title={t("businessLines.viewMembers")}>
							<Button type="text" icon={<TeamOutlined />} aria-label={t("businessLines.viewMembers")} onClick={() => openMembers(record)} />
						</Tooltip>
						{canManage(record) ? (
							<Tooltip title={t("businessLines.share")}>
								<Button type="text" icon={<ShareAltOutlined />} aria-label={t("businessLines.share")} onClick={() => openShare(record)} />
							</Tooltip>
						) : null}
						{canManage(record) ? (
							<Tooltip title={t("businessLines.edit")}>
								<Button type="text" icon={<EditOutlined />} aria-label={t("businessLines.edit")} onClick={() => openEdit(record)} />
							</Tooltip>
						) : null}
						{canManage(record) ? (
							<Popconfirm
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
							</Popconfirm>
						) : null}
					</Space>
				),
			},
		],
		[canManage, deletingCode, t],
	);

	const memberColumns = useMemo<ColumnsType<BizLineMemberRecord>>(
		() => [
			{
				title: t("businessLines.members"),
				dataIndex: "displayName",
				render: (value: string, record) => (
					<div>
						<b data-locale-static="false">{value || record.username}</b>
						<div className="manager-table-subline manager-mono" data-locale-static="false">{record.username}</div>
					</div>
				),
			},
			{
				title: t("businessLines.permission"),
				dataIndex: "permission",
				width: 160,
				render: (permission: BizLineMemberRecord["permission"], record) =>
					record.isManager || !memberLine || !canManage(memberLine) ? (
						<Tag color={permission === "manager" ? "gold" : permission === "write" ? "blue" : "default"}>
							{permissionLabel(permission)}
						</Tag>
					) : (
						<Select
							value={record.canWrite ? "write" : "read"}
							style={{ width: 120 }}
							options={[
								{ value: "read", label: t("businessLines.permissionRead") },
								{ value: "write", label: t("businessLines.permissionWrite") },
							]}
							onChange={(value) => void changePermission(record, value === "write")}
						/>
					),
			},
			{
				title: t("businessLines.joinedAt"),
				dataIndex: "joinedAt",
				width: 170,
				render: (value?: string) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-"),
			},
			{
				title: "",
				key: "actions",
				width: 56,
				align: "right",
				render: (_, record) =>
					// 自己这一行不给剔除入口：退出空间该由另一位管理员来做，
					// 顺手把自己踢出去就等于交出了这个空间的管理权。
					memberLine && canManage(memberLine) && record.id !== currentUserID ? (
						<Popconfirm
							title={t("businessLines.memberRemoveConfirm")}
							okButtonProps={{ danger: true }}
							onConfirm={() => void kickMember(record)}
						>
							<Tooltip title={t("businessLines.memberRemove")}>
								<Button danger type="text" icon={<UserDeleteOutlined />} aria-label={t("businessLines.memberRemove")} />
							</Tooltip>
						</Popconfirm>
					) : null,
			},
		],
		[canManage, currentUserID, memberLine, permissionLabel, t],
	);

	return (
		<div className="manager-page-stack">
			<section className="manager-page-heading">
				<div>
					<div className="manager-section-label">BUSINESS LINES</div>
					<h1>{t("businessLines.title")}</h1>
					<p>{t("businessLines.intro")}</p>
				</div>
				<Space>
					<Tag className="manager-count-tag" color={quotaReached ? "warning" : undefined}>
						{`${ownedCount} / ${MAX_OWNED_BIZ_LINES}`}
					</Tag>
					<Tag className="manager-count-tag">{rows.length}</Tag>
				</Space>
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
						<Tooltip title={quotaReached ? t("businessLines.quotaReached") : undefined}>
							<Button type="primary" icon={<PlusOutlined />} disabled={quotaReached} onClick={openCreate}>
								{t("businessLines.new")}
							</Button>
						</Tooltip>
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
							scroll={{ x: 760 }}
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
						<Input disabled={Boolean(editing)} autoComplete="off" />
					</Form.Item>
					<Form.Item label={t("businessLines.name")} name="name" rules={[{ required: true, message: t("businessLines.required") }]}>
						<Input autoComplete="off" />
					</Form.Item>
					<Form.Item label={t("businessLines.description")} name="description" extra={t("businessLines.descriptionHint")}>
						<Input.TextArea rows={3} maxLength={200} showCount autoComplete="off" />
					</Form.Item>
					<Form.Item label={t("businessLines.status")} name="enabled" valuePropName="checked">
						<Switch checkedChildren={t("businessLines.enabled")} unCheckedChildren={t("businessLines.disabled")} />
					</Form.Item>
					<Form.Item label={t("businessLines.visible")} name="visible" valuePropName="checked" extra={t("businessLines.visibleHint")}>
						<Switch checkedChildren={t("businessLines.visibleOn")} unCheckedChildren={t("businessLines.visibleOff")} />
					</Form.Item>
					<Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
						{t("businessLines.membersReadOnly")}
					</Typography.Paragraph>
				</Form>
			</Modal>

			<Modal
				wrapClassName="manager-form-skin"
				open={Boolean(memberLine)}
				destroyOnHidden
				width={720}
				title={`${t("businessLines.membersOf")} · ${memberLine?.name || memberLine?.code || ""}`}
				footer={null}
				onCancel={() => setMemberLine(null)}
			>
				<Typography.Paragraph type="secondary">{t("businessLines.permissionHint")}</Typography.Paragraph>
				{members.length === 0 && !membersLoading ? (
					<Empty description={t("businessLines.memberEmpty")} />
				) : (
					<div className="manager-table">
						<Table<BizLineMemberRecord>
							rowKey="id"
							loading={membersLoading}
							columns={memberColumns}
							dataSource={members}
							pagination={false}
							scroll={{ x: 600 }}
						/>
					</div>
				)}
			</Modal>

			<Modal
				wrapClassName="manager-form-skin"
				open={Boolean(shareLine)}
				destroyOnHidden
				title={`${t("businessLines.shareTitle")} · ${shareLine?.name || shareLine?.code || ""}`}
				okText={t("businessLines.shareCreate")}
				cancelText={t("common.cancel")}
				confirmLoading={shareCreating}
				onCancel={() => setShareLine(null)}
				onOk={() => void createShare()}
			>
				<Typography.Paragraph type="secondary">{t("businessLines.shareHint")}</Typography.Paragraph>
				<Space direction="vertical" size="middle" style={{ width: "100%" }}>
					<div>
						<div className="manager-section-label">{t("businessLines.permission")}</div>
						<Segmented
							value={sharePermission}
							onChange={(value) => setSharePermission(value as "read" | "write")}
							options={[
								{ value: "read", label: t("businessLines.permissionRead") },
								{ value: "write", label: t("businessLines.permissionWrite") },
							]}
						/>
					</div>
					<div>
						<div className="manager-section-label">{t("businessLines.shareTtl")}</div>
						<Segmented
							value={shareTtl}
							onChange={(value) => setShareTtl(Number(value))}
							options={SHARE_TTL_OPTIONS.map((option) => ({ value: option.minutes, label: t(option.label) }))}
						/>
					</div>
					{shareLink ? (
						<div>
							<div className="manager-section-label">{t("businessLines.shareExpiresAt")}</div>
							<div data-locale-static="false" style={{ marginBottom: 8 }}>
								{new Date(shareLink.expiresAt).toLocaleString("zh-CN", { hour12: false })}
							</div>
							<Space.Compact style={{ width: "100%" }}>
								<Input readOnly value={shareUrl} data-locale-static="false" />
								<Button icon={<CopyOutlined />} onClick={() => void copyShareUrl()}>
									{t("businessLines.shareCopy")}
								</Button>
							</Space.Compact>
						</div>
					) : null}
				</Space>
			</Modal>
		</div>
	);
}
