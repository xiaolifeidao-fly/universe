"use client";

import { DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useCanWrite } from "@/components/permission/WritePermission";
import { fetchUser, fetchUsers, resetUserPassword, saveUser, deleteUser, type SaveUserPayload, UserRecord } from "../api/user.api";

const PERSONA_OPTIONS = ["business", "product_research"] as const;

function formatTime(value?: string, locale = "zh-CN") {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale, { hour12: false });
}

export function UserManagement() {
  const { t, locale } = useLocale();
  // 只读角色不显示写入口。用条件渲染而不是 disabled：一个永远点不动的按钮
  // 只是在告诉用户「这里本来有个功能」，不如干脆不出现。
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<UserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageIndex, setPageIndex] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState<"" | "admin" | "member">("");
  const [status, setStatus] = useState<"" | "active" | "disabled">("");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SaveUserPayload>();

  const [passwordTarget, setPasswordTarget] = useState<UserRecord | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await fetchUsers({ pageIndex, pageSize, keyword, role, status });
      setRows(page.data);
      setTotal(page.total);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pageIndex, pageSize, keyword, role, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ role: "member", personas: ["product_research"], status: "active" });
    setFormOpen(true);
  };

  const openEdit = async (record: UserRecord) => {
    try {
      const view = await fetchUser(record.id);
      setEditing(view);
      form.setFieldsValue({
        username: view.username,
        displayName: view.displayName,
        role: view.role,
        personas: view.personas,
        status: view.status,
      });
      setFormOpen(true);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const submitForm = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await saveUser(values, editing?.id);
      message.success(t("users.saved"));
      setFormOpen(false);
      void load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitPassword = async () => {
    if (!passwordTarget) return;
    if (passwordValue.trim().length < 8) {
      message.error(t("users.passwordTooShort"));
      return;
    }
    setPasswordSubmitting(true);
    try {
      await resetUserPassword(passwordTarget.id, passwordValue.trim());
      message.success(t("users.passwordReset"));
      setPasswordTarget(null);
      setPasswordValue("");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const remove = async (record: UserRecord) => {
    try {
      await deleteUser(record.id);
      message.success(t("users.deleted"));
      void load();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const columns = useMemo<ColumnsType<UserRecord>>(
    () => [
      {
        title: t("users.field.username"),
        dataIndex: "username",
        width: 160,
        render: (value: string) => <span className="manager-mono">{value}</span>,
      },
      { title: t("users.field.displayName"), dataIndex: "displayName", width: 160 },
      {
        title: t("users.field.role"),
        dataIndex: "role",
        width: 110,
        render: (value: string) => <Tag color={value === "admin" ? "gold" : "blue"}>{t(value === "admin" ? "users.role.admin" : "users.role.member")}</Tag>,
      },
      {
        title: t("users.field.personas"),
        dataIndex: "personas",
        width: 220,
        render: (value: string[]) => (
          <Space size={[4, 4]} wrap>
            {(value ?? []).map((persona) => (
              <Tag key={persona} color={persona === "business" ? "green" : "purple"}>
                {t(persona === "business" ? "users.persona.business" : "users.persona.productResearch")}
              </Tag>
            ))}
          </Space>
        ),
      },
      {
        title: t("users.field.status"),
        dataIndex: "status",
        width: 100,
        render: (value: string) => <Tag color={value === "disabled" ? "red" : "green"}>{t(value === "disabled" ? "users.status.disabled" : "users.status.active")}</Tag>,
      },
      {
        title: t("users.field.bizLines"),
        dataIndex: "bizLines",
        width: 100,
        render: (value: string[]) => <span className="manager-mono">{value?.length ?? 0}</span>,
      },
      {
        title: t("users.field.lastLoginAt"),
        dataIndex: "lastLoginAt",
        width: 170,
        render: (value?: string) => <span className="manager-mono">{formatTime(value, locale)}</span>,
      },
      {
        title: t("common.actions"),
        key: "actions",
        width: 190,
        fixed: "right",
        align: "right",
        render: (_, record) => (
          <Space size={0}>
            {canWrite ? (
              <>
                <Tooltip title={t("common.edit")}>
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => void openEdit(record)} />
                </Tooltip>
                <Tooltip title={t("users.resetPassword")}>
                  <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => setPasswordTarget(record)} />
                </Tooltip>
                <Popconfirm title={t("users.deleteConfirm")} onConfirm={() => void remove(record)}>
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
    [t, locale, canWrite],
  );

  return (
    <div className="manager-page-stack">
      <section className="manager-page-heading">
        <div>
          <span className="manager-section-label">USER MANAGEMENT</span>
          <h1>{t("users.title")}</h1>
          <p>{t("users.subtitle")}</p>
        </div>
        {canWrite ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t("users.new")}
          </Button>
        ) : null}
      </section>

      <section className="manager-data-card manager-table">
        <div className="manager-toolbar" style={{ marginBottom: 14 }}>
          <Input
            allowClear
            className="manager-filter-input"
            style={{ maxWidth: 220 }}
            prefix={<SearchOutlined />}
            placeholder={t("users.filter.keyword")}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onPressEnter={() => setPageIndex(1)}
          />
          <Select
            allowClear
            className="manager-filter-input"
            style={{ minWidth: 130 }}
            placeholder={t("users.field.role")}
            value={role || undefined}
            onChange={(value) => { setRole((value as typeof role) ?? ""); setPageIndex(1); }}
            options={[
              { value: "admin", label: t("users.role.admin") },
              { value: "member", label: t("users.role.member") },
            ]}
          />
          <Select
            allowClear
            className="manager-filter-input"
            style={{ minWidth: 130 }}
            placeholder={t("users.field.status")}
            value={status || undefined}
            onChange={(value) => { setStatus((value as typeof status) ?? ""); setPageIndex(1); }}
            options={[
              { value: "active", label: t("users.status.active") },
              { value: "disabled", label: t("users.status.disabled") },
            ]}
          />
          <Tooltip title={t("common.refresh")}>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
          </Tooltip>
        </div>
        <Table<UserRecord>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1230 }}
          pagination={{
            current: pageIndex,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (nextPage, nextSize) => {
              setPageIndex(nextPage);
              setPageSize(nextSize);
            },
          }}
        />
      </section>

      <Modal
        wrapClassName="manager-form-skin"
        open={formOpen}
        title={editing ? t("users.editTitle") : t("users.newTitle")}
        confirmLoading={submitting}
        onOk={() => void submitForm()}
        onCancel={() => setFormOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label={t("users.field.username")} name="username" rules={[{ required: true, message: t("users.usernameRequired") }]}>
            <Input disabled={Boolean(editing)} autoComplete="off" />
          </Form.Item>
          <Form.Item label={t("users.field.displayName")} name="displayName" rules={[{ required: true, message: t("users.displayNameRequired") }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("users.field.role")} name="role" rules={[{ required: true }]}>
            <Select options={[{ value: "member", label: t("users.role.member") }, { value: "admin", label: t("users.role.admin") }]} />
          </Form.Item>
          <Form.Item label={t("users.field.personas")} name="personas" rules={[{ required: true, message: t("users.personasRequired") }]}>
            <Checkbox.Group
              options={PERSONA_OPTIONS.map((persona) => ({
                value: persona,
                label: t(persona === "business" ? "users.persona.business" : "users.persona.productResearch"),
              }))}
            />
          </Form.Item>
          <Form.Item label={t("users.field.status")} name="status" rules={[{ required: true }]}>
            <Select options={[{ value: "active", label: t("users.status.active") }, { value: "disabled", label: t("users.status.disabled") }]} />
          </Form.Item>
          {!editing ? (
            <Form.Item label={t("users.field.password")} name="password" rules={[{ required: true, min: 8, message: t("users.passwordTooShort") }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        wrapClassName="manager-form-skin"
        open={Boolean(passwordTarget)}
        title={t("users.resetPassword")}
        confirmLoading={passwordSubmitting}
        onOk={() => void submitPassword()}
        onCancel={() => { setPasswordTarget(null); setPasswordValue(""); }}
        destroyOnClose
      >
        <p style={{ color: "var(--manager-text-soft)" }}>{t("users.resetPasswordHint").replace("{username}", passwordTarget?.username ?? "")}</p>
        <Input.Password
          autoComplete="new-password"
          placeholder={t("users.newPasswordPlaceholder")}
          value={passwordValue}
          onChange={(event) => setPasswordValue(event.target.value)}
        />
      </Modal>
    </div>
  );
}
