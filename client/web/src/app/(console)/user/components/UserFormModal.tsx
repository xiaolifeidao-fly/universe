"use client";

import { Button, Form, Input, Modal, Select, Space, Tag } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchProgramOptions,
  type BizLineOption,
  type ProgramOption,
  type ProgramScope,
  type SaveUserPayload,
  type UserRecord,
} from "../api/user.api";

interface UserFormModalProps {
  open: boolean;
  submitting: boolean;
  user: UserRecord | null;
  bizLines: BizLineOption[];
  onCancel: () => void;
  onSubmit: (payload: SaveUserPayload) => Promise<void>;
}

interface UserFormValues {
  username: string;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  password?: string;
  bizLines: string[];
  programKeys: string[];
}

const scopeKey = (scope: ProgramScope) => `${scope.bizLine}:${scope.programId}`;

export function UserFormModal({ open, submitting, user, bizLines, onCancel, onSubmit }: UserFormModalProps) {
  const [form] = Form.useForm<UserFormValues>();
  const { t } = useLocale();
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const selectedBizLines = Form.useWatch("bizLines", form) ?? [];
  const isEdit = Boolean(user);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      username: user?.username ?? "",
      displayName: user?.displayName ?? "",
      role: user?.role ?? "member",
      status: user?.status ?? "active",
      password: "",
      bizLines: user?.bizLines ?? [],
      programKeys: (user?.programs ?? []).map(scopeKey),
    });
  }, [form, open, user]);

  useEffect(() => {
    if (!open || selectedBizLines.length === 0) {
      setPrograms([]);
      return;
    }
    let active = true;
    Promise.all(selectedBizLines.map((bizLine) => fetchProgramOptions(bizLine)))
      .then((lists) => {
        if (active) setPrograms(lists.flat());
      })
      .catch(() => {
        if (active) setPrograms([]);
      });
    return () => { active = false; };
  }, [open, selectedBizLines.join(",")]);

  const programOptions = useMemo(() => programs.map((program) => ({
    value: `${program.bizLine}:${program.programId}`,
    label: `${program.name || program.programId} (${program.bizLine})`,
  })), [programs]);

  const submit = async () => {
    const values = await form.validateFields();
    const programsByKey = new Map(programs.map((program) => [`${program.bizLine}:${program.programId}`, program]));
    const assignedPrograms = (values.programKeys ?? []).map((key) => {
      const program = programsByKey.get(key);
      const [bizLine, programId] = key.split(":", 2);
		return { bizLine: program?.bizLine ?? bizLine, programId: program?.programId ?? Number(programId) };
    });
    await onSubmit({
      username: values.username.trim(),
      displayName: values.displayName.trim(),
      role: values.role,
      status: values.status,
      password: values.password?.trim() || undefined,
      bizLines: values.bizLines ?? [],
      programs: assignedPrograms,
    });
  };

  return (
    <Modal
      wrapClassName="manager-form-skin"
      destroyOnClose
      open={open}
      title={isEdit ? "编辑用户" : "新建用户"}
      okText={isEdit ? "保存" : "创建"}
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => void submit()}
    >
      <Form<UserFormValues> form={form} layout="vertical">
        <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
          <Input autoComplete="off" disabled={isEdit} />
        </Form.Item>
        <Form.Item label="显示名称" name="displayName" rules={[{ required: true, message: "请输入显示名称" }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Space style={{ display: "flex" }} size={12} align="start">
          <Form.Item label="角色" name="role" style={{ minWidth: 180 }}>
            <Select options={[{ value: "member", label: "成员" }, { value: "admin", label: "管理员" }]} />
          </Form.Item>
          <Form.Item label="状态" name="status" style={{ minWidth: 180 }}>
            <Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }]} />
          </Form.Item>
        </Space>
        <Form.Item
          label={isEdit ? "更新密码" : "初始密码"}
          name="password"
          rules={[
            ...(isEdit ? [] : [{ required: true, whitespace: true, message: "请输入初始密码" }]),
            {
              min: 8,
              transform: (value) => typeof value === "string" ? value.trim() : value,
              message: t("account.newPasswordRequired"),
            },
          ]}
          extra={isEdit ? "留空保持当前密码" : "首次登录后用户需要修改密码"}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="可见空间" name="bizLines" extra="未分配空间的成员无法访问对应数据。">
          <Select mode="multiple" options={bizLines.filter((line) => line.enabled).map((line) => ({ value: line.code, label: line.name || line.code }))} />
        </Form.Item>
        <Form.Item label="可见项目" name="programKeys" extra="成员还需被分配具体项目才能查看项目内容。">
          <Select mode="multiple" options={programOptions} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
