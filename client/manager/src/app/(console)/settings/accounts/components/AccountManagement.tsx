"use client";

import { DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { getAuthUser } from "@/utils/auth";
import {
  deleteAccount,
  fetchAccounts,
  fetchRoles,
  resetAccountPassword,
  saveAccount,
  setAccountStatus,
  type AccountRecord,
  type RoleRecord,
} from "../../api/console.api";

/**
 * 管理端账号。
 *
 * 这里管的是**登录管理端的人**，不是 /users 那个业务用户列表 —— 两套账号
 * 刻意分开，互不能登录对方。
 */
export function AccountManagement() {
  const { t } = useLocale();
  const canWrite = useCanWrite();
  const currentUser = getAuthUser();

  const [rows, setRows] = useState<AccountRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AccountRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<AccountRecord | null>(null);
  const [form] = Form.useForm();
  const [passwordForm] = Form.useForm<{ password: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [page, roleList] = await Promise.all([
        fetchAccounts({ keyword: keyword.trim() || undefined, pageSize: 200 }),
        fetchRoles(),
      ]);
      setRows(page.list);
      setRoles(roleList);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [keyword, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setCreating(true);
    form.setFieldsValue({ username: "", displayName: "", password: "", remark: "", roleIds: [] });
  };

  const openEdit = (record: AccountRecord) => {
    setEditing(record);
    setCreating(true);
    form.setFieldsValue({
      username: record.username,
      displayName: record.displayName,
      password: "",
      remark: record.remark,
      roleIds: record.roles.map((role) => role.id),
    });
  };

  const submit = async () => {
    const values = await form.validateFields();
    try {
      await saveAccount({ ...values, userId: editing?.userId });
      message.success(t("common.saved"));
      setCreating(false);
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const submitPassword = async () => {
    if (!passwordTarget) return;
    const values = await passwordForm.validateFields();
    try {
      await resetAccountPassword(passwordTarget.userId, values.password);
      message.success(t("common.saved"));
      setPasswordTarget(null);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const toggleStatus = async (record: AccountRecord) => {
    try {
      await setAccountStatus(record.userId, record.status === "disabled" ? "active" : "disabled");
      message.success(t("common.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const remove = async (record: AccountRecord) => {
    try {
      await deleteAccount(record.userId);
      message.success(t("common.saved"));
      void load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const columns: ColumnsType<AccountRecord> = [
    {
      title: t("accounts.username"),
      dataIndex: "username",
      width: 180,
      render: (username: string, record) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{record.displayName || username}</span>
          <span className="manager-mono" style={{ fontSize: 12, color: "var(--manager-text-faint)" }}>
            @{username}
          </span>
        </Space>
      ),
    },
    {
      title: t("accounts.roles"),
      dataIndex: "roles",
      render: (roleRefs: AccountRecord["roles"]) =>
        roleRefs.length === 0 ? "-" : (
          <Space size={[4, 4]} wrap>
            {roleRefs.map((role) => (
              <Tag key={role.id} color={role.code === "super_admin" ? "gold" : "default"}>
                {role.name}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 150,
      render: (status: string, record) => (
        <Space size={4}>
          <Tag color={status === "active" ? "success" : "default"}>{status}</Tag>
          {/* 待改初始密码的账号除了改密什么都干不了，列表上得看得出来。 */}
          {record.mustChangePassword ? <Tag color="warning">{t("accounts.mustChange")}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t("accounts.lastLogin"),
      dataIndex: "lastLoginAt",
      width: 180,
      render: (value: string) => (value ? new Date(value).toLocaleString() : "-"),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 180,
      align: "right",
      render: (_, record) =>
        canWrite ? (
          <Space size={0}>
            <Tooltip title={t("common.edit")}>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
            </Tooltip>
            <Tooltip title={t("accounts.resetPassword")}>
              <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => setPasswordTarget(record)} />
            </Tooltip>
            <Popconfirm title={t("accounts.disableConfirm")} onConfirm={() => void toggleStatus(record)}>
              <Tooltip title={record.status === "disabled" ? t("accounts.enable") : t("accounts.disable")}>
                <Button type="link" size="small" icon={<StopOutlined />} />
              </Tooltip>
            </Popconfirm>
            {/* 不给删自己的入口：删完之后自己手里那个会话指向一个不存在的账号，
                而且如果是最后一个超级管理员，谁也进不来了。 */}
            {currentUser?.id === record.userId ? null : (
              <Popconfirm title={t("accounts.deleteConfirm")} onConfirm={() => void remove(record)}>
                <Tooltip title={t("common.delete")}>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                </Tooltip>
              </Popconfirm>
            )}
          </Space>
        ) : null,
    },
  ];

  return (
    <div className="manager-page-stack">
      <section className="manager-page-heading">
        <div>
          <span className="manager-section-label">CONSOLE ACCOUNTS</span>
          <h1>{t("accounts.title")}</h1>
          <p>{t("accounts.subtitle")}</p>
        </div>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t("accounts.new")}
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
            placeholder={t("accounts.username")}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
        <Table
          rowKey="userId"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{ emptyText: t("accounts.empty") }}
          scroll={{ x: 900 }}
        />
      </section>

      <Modal
        open={creating}
        title={editing ? t("accounts.editTitle") : t("accounts.new")}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        onOk={() => void submit()}
        onCancel={() => setCreating(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label={t("accounts.username")} rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="displayName" label={t("accounts.displayName")}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t("accounts.password")}
            extra={t("accounts.passwordHint")}
            rules={editing ? [] : [{ required: true, min: 8 }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="roleIds" label={t("accounts.roles")}>
            <Select
              mode="multiple"
              options={roles.map((role) => ({ value: role.id, label: `${role.name}（${role.code}）` }))}
            />
          </Form.Item>
          <Form.Item name="remark" label={t("accounts.remark")}>
            <Input.TextArea rows={2} maxLength={256} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={passwordTarget !== null}
        title={t("accounts.resetPasswordTitle")}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        onOk={() => void submitPassword()}
        onCancel={() => setPasswordTarget(null)}
        destroyOnClose
      >
        <Form form={passwordForm} layout="vertical">
          <Form.Item
            name="password"
            label={t("accounts.password")}
            extra={t("accounts.passwordHint")}
            rules={[{ required: true, min: 8 }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
