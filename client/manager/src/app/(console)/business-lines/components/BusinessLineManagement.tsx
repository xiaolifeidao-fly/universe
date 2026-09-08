"use client";

import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, TeamOutlined, UserOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import {
  BizLineMemberRecord,
  BizLineRecord,
  deleteBizLine,
  fetchBizLineMembers,
  fetchBizLines,
  removeBizLineMember,
  saveBizLine,
  saveBizLineMemberPermission,
  type SaveBizLinePayload,
} from "../api/bizline.api";

export function BusinessLineManagement() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<BizLineRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BizLineRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SaveBizLinePayload>();

  const [membersTarget, setMembersTarget] = useState<BizLineRecord | null>(null);
  const [members, setMembers] = useState<BizLineMemberRecord[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchBizLines());
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.code.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle));
  }, [rows, keyword]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, visible: true });
    setFormOpen(true);
  };

  const openEdit = (record: BizLineRecord) => {
    setEditing(record);
    form.setFieldsValue({
      code: record.code,
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      visible: record.visible,
    });
    setFormOpen(true);
  };

  const submitForm = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await saveBizLine(values);
      message.success(t("bizLines.saved"));
      setFormOpen(false);
      void load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (record: BizLineRecord) => {
    try {
      await deleteBizLine(record.code);
      message.success(t("bizLines.deleted"));
      void load();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const openMembers = async (record: BizLineRecord) => {
    setMembersTarget(record);
    setMembersLoading(true);
    try {
      setMembers(await fetchBizLineMembers(record.code));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setMembersLoading(false);
    }
  };

  const toggleMemberWrite = async (member: BizLineMemberRecord, canWrite: boolean) => {
    if (!membersTarget) return;
    try {
      await saveBizLineMemberPermission(membersTarget.code, member.id, canWrite, member.isManager);
      setMembers((current) => current.map((row) => (row.id === member.id ? { ...row, canWrite } : row)));
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const removeMember = async (member: BizLineMemberRecord) => {
    if (!membersTarget) return;
    try {
      await removeBizLineMember(membersTarget.code, member.id);
      setMembers((current) => current.filter((row) => row.id !== member.id));
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const columns = useMemo<ColumnsType<BizLineRecord>>(
    () => [
      { title: t("bizLines.field.code"), dataIndex: "code", width: 160, render: (value: string) => <span className="manager-mono">{value}</span> },
      { title: t("bizLines.field.name"), dataIndex: "name", width: 180 },
      { title: t("bizLines.field.description"), dataIndex: "description", ellipsis: true },
      {
        title: t("bizLines.field.enabled"),
        dataIndex: "enabled",
        width: 100,
        render: (value: boolean) => <Tag color={value ? "green" : "default"}>{t(value ? "bizLines.enabled" : "bizLines.disabled")}</Tag>,
      },
      {
        title: t("bizLines.field.visible"),
        dataIndex: "visible",
        width: 100,
        render: (value: boolean) => <Tag color={value ? "blue" : "default"}>{t(value ? "bizLines.visible" : "bizLines.hidden")}</Tag>,
      },
      { title: t("bizLines.field.createdBy"), dataIndex: "createdBy", width: 100, render: (value: number) => <span className="manager-mono">{value || "-"}</span> },
      {
        title: t("common.actions"),
        key: "actions",
        width: 170,
        fixed: "right",
        align: "right",
        render: (_, record) => (
          <Space size={0}>
            <Tooltip title={t("bizLines.members")}>
              <Button type="link" size="small" icon={<TeamOutlined />} onClick={() => void openMembers(record)} />
            </Tooltip>
            {canWrite ? (
              <>
                <Tooltip title={t("common.edit")}>
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
                </Tooltip>
                <Popconfirm title={t("bizLines.deleteConfirm")} onConfirm={() => void remove(record)}>
                  <Tooltip title={t("common.delete")}>
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              </>
            ) : null}
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canWrite],
  );

  return (
    <div className="manager-page-stack">
      <section className="manager-page-heading">
        <div>
          <span className="manager-section-label">BUSINESS LINE MANAGEMENT</span>
          <h1>{t("bizLines.title")}</h1>
          <p>{t("bizLines.subtitle")}</p>
        </div>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t("bizLines.new")}
          </Button>
        ) : null}
      </section>

      <section className="manager-data-card manager-table">
        <div className="manager-toolbar" style={{ marginBottom: 14 }}>
          <Input
            allowClear
            className="manager-filter-input"
            style={{ maxWidth: 240 }}
            prefix={<SearchOutlined />}
            placeholder={t("bizLines.filter.keyword")}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <Tooltip title={t("common.refresh")}>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
          </Tooltip>
        </div>
        <Table<BizLineRecord> rowKey="code" loading={loading} columns={columns} dataSource={filtered} scroll={{ x: 970 }} pagination={{ pageSize: 20, showSizeChanger: false }} />
      </section>

      <Modal
        wrapClassName="manager-form-skin"
        open={formOpen}
        title={editing ? t("bizLines.editTitle") : t("bizLines.newTitle")}
        confirmLoading={submitting}
        onOk={() => void submitForm()}
        onCancel={() => setFormOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label={t("bizLines.field.code")} name="code" rules={[{ required: true, message: t("bizLines.codeRequired") }]}>
            <Input disabled={Boolean(editing)} autoComplete="off" />
          </Form.Item>
          <Form.Item label={t("bizLines.field.name")} name="name" rules={[{ required: true, message: t("bizLines.nameRequired") }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("bizLines.field.description")} name="description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label={t("bizLines.field.enabled")} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label={t("bizLines.field.visible")} name="visible" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        className="manager-form-skin"
        open={Boolean(membersTarget)}
        onClose={() => setMembersTarget(null)}
        width={480}
        title={membersTarget ? `${t("bizLines.members")} · ${membersTarget.name}` : t("bizLines.members")}
      >
        {membersLoading ? null : members.length === 0 ? (
          <Empty className="manager-empty-state manager-empty-state--compact" description={t("bizLines.membersEmpty")} />
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size={10}>
            {members.map((member) => (
              <div
                key={member.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  border: "1px solid var(--manager-border)",
                  borderRadius: "var(--manager-r)",
                }}
              >
                <UserOutlined style={{ color: "var(--manager-text-faint)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{member.displayName || member.username}</div>
                  <div className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
                    @{member.username}
                  </div>
                </div>
                {member.isManager ? <Tag color="gold">{t("bizLines.manager")}</Tag> : null}
                {/* 这两个写控件藏在成员抽屉里，不在表格主区 —— 只读角色同样要挡住。 */}
                <Tooltip title={t("bizLines.canWrite")}>
                  <Switch
                    size="small"
                    checked={member.canWrite}
                    disabled={member.isManager || !canWrite}
                    onChange={(checked) => void toggleMemberWrite(member, checked)}
                  />
                </Tooltip>
                {canWrite ? (
                  <Popconfirm title={t("bizLines.removeMemberConfirm")} onConfirm={() => void removeMember(member)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ) : null}
              </div>
            ))}
          </Space>
        )}
      </Drawer>
    </div>
  );
}
