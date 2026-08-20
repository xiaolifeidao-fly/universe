"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Button, Input, message, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  deleteUser,
  fetchBizLineOptions,
  resetUserPassword,
  saveUser,
  type BizLineOption,
  type SaveUserPayload,
  type UserRecord,
} from "../api/user.api";
import { UserFormModal } from "./UserFormModal";
import { useUserManagement } from "../hooks/useUserManagement";
import { useLocale } from "@/i18n/LocaleProvider";

export function UserManagementDemo() {
  const { users, total, loading, query, refresh } = useUserManagement();
  const { t } = useLocale();
  const [bizLines, setBizLines] = useState<BizLineOption[]>([]);
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<UserRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadOptions = useCallback(async () => {
    try {
      setBizLines(await fetchBizLineOptions());
    } catch (error) {
      message.error((error as Error).message);
    }
  }, []);

  useEffect(() => { void loadOptions(); }, [loadOptions]);

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
  };

  const handleSave = async (payload: SaveUserPayload) => {
    setSubmitting(true);
    try {
      await saveUser(payload, editing?.id);
      message.success(editing ? "用户已更新" : "用户已创建");
      closeEditor();
      await refresh();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = (user: UserRecord) => {
    let password = "";
    Modal.confirm({
      title: `重置 ${user.displayName || user.username} 的密码`,
      content: <Input.Password style={{ marginTop: 16 }} autoComplete="new-password" onChange={(event) => { password = event.target.value; }} />,
      onOk: async () => {
        const nextPassword = password.trim();
        if (nextPassword.length < 8) {
          message.error(t("account.newPasswordRequired"));
          return;
        }
        try {
          await resetUserPassword(user.id, nextPassword);
          message.success("密码已重置，用户需要重新登录");
        } catch (error) {
          message.error((error as Error).message);
        }
      },
    });
  };

  const columns = useMemo<ColumnsType<UserRecord>>(() => [
    { title: "账号", dataIndex: "username", width: 150, render: (value: string) => <span className="manager-mono">{value}</span> },
    { title: "显示名称", dataIndex: "displayName", width: 150 },
    { title: "角色", dataIndex: "role", width: 100, render: (value: string) => <Tag color={value === "admin" ? "gold" : "blue"}>{value === "admin" ? "管理员" : "成员"}</Tag> },
    { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag color={value === "active" ? "success" : "default"}>{value === "active" ? "启用" : "停用"}</Tag> },
    { title: "空间", dataIndex: "bizLines", width: 220, render: (values: string[]) => values.length ? values.map((value) => <Tag key={value}>{value}</Tag>) : "-" },
    { title: "项目", dataIndex: "programs", width: 220, render: (values: UserRecord["programs"]) => values.length ? values.map((value) => <Tag key={`${value.bizLine}:${value.programId}`}>{value.programId}</Tag>) : "-" },
    { title: "最近登录", dataIndex: "lastLoginAt", width: 175, render: (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-" },
    {
      title: "操作", key: "actions", fixed: "right", align: "right", width: 150,
      render: (_, user) => <Space size={0}>
        <Tooltip title="编辑"><Button type="text" icon={<EditOutlined />} aria-label="编辑用户" onClick={() => { setEditing(user); setEditorOpen(true); }} /></Tooltip>
        <Tooltip title="重置密码"><Button type="text" icon={<KeyOutlined />} aria-label="重置密码" onClick={() => handleResetPassword(user)} /></Tooltip>
        <Popconfirm title="确定删除该用户吗？" okButtonProps={{ danger: true }} onConfirm={async () => {
          try { await deleteUser(user.id); message.success("用户已删除"); await refresh({ pageIndex: 1 }); } catch (error) { message.error((error as Error).message); }
        }}>
          <Tooltip title="删除"><Button type="text" danger icon={<DeleteOutlined />} aria-label="删除用户" /></Tooltip>
        </Popconfirm>
      </Space>,
    },
  ], [refresh, t]);

  return (
    <div className="manager-page-stack">
      <section className="manager-section-title">
        <h2>用户管理</h2>
        <span className="manager-mono" style={{ fontSize: "var(--manager-fs-xs)", color: "var(--manager-text-faint)" }}>IDENTITIES · {total} USERS</span>
        <span className="manager-section-rule" />
        <Button icon={<ReloadOutlined />} aria-label="刷新用户" loading={loading} onClick={() => void Promise.all([refresh(), loadOptions()])} />
      </section>
      <section className="manager-data-card">
        <Space wrap>
          <Input className="manager-filter-input" prefix={<SearchOutlined />} value={search} placeholder="搜索账号或名称" onChange={(event) => setSearch(event.target.value)} onPressEnter={() => void refresh({ pageIndex: 1, keyword: search })} style={{ width: 240 }} />
          <Select value={query.role || undefined} allowClear placeholder="角色" onChange={(value) => void refresh({ pageIndex: 1, role: value ?? "" })} options={[{ value: "admin", label: "管理员" }, { value: "member", label: "成员" }]} style={{ width: 120 }} />
          <Select value={query.status || undefined} allowClear placeholder="状态" onChange={(value) => void refresh({ pageIndex: 1, status: value ?? "" })} options={[{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }]} style={{ width: 120 }} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setEditorOpen(true); }}>新建用户</Button>
        </Space>
      </section>
      <section className="manager-data-card manager-table">
        <Table<UserRecord> rowKey="id" loading={loading} columns={columns} dataSource={users} scroll={{ x: 1215 }} pagination={{ current: query.pageIndex, pageSize: query.pageSize, total, showSizeChanger: false, onChange: (page) => void refresh({ pageIndex: page, keyword: search }) }} />
      </section>
      <UserFormModal open={editorOpen} submitting={submitting} user={editing} bizLines={bizLines} onCancel={closeEditor} onSubmit={handleSave} />
    </div>
  );
}
