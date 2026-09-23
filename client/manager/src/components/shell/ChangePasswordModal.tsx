"use client";

import { Alert, Form, Input, Modal, message } from "antd";
import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { changeOwnPassword } from "./api/profile.api";

/**
 * 改密码。
 *
 * `forced` 为真时不给关闭入口：带着初始密码的账号除了改密什么接口都调不动
 * （后端中间件挡在资源判断之前），关掉这个弹窗只会得到一个点什么都失败的页面。
 *
 * 改完之后该账号的全部会话立即失效（后端 DeleteByUser），所以这里直接跳登录页，
 * 而不是留在原地让下一个请求撞一个「登录凭证已失效」。
 */
export function ChangePasswordModal({
  open,
  forced,
  onClose,
  onChanged,
}: {
  open: boolean;
  forced?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const [form] = Form.useForm<{ oldPassword: string; newPassword: string; confirm: string }>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await changeOwnPassword({ oldPassword: values.oldPassword, newPassword: values.newPassword });
      message.success(t("password.changed"));
      onChanged();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("password.title")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={forced ? undefined : onClose}
      closable={!forced}
      maskClosable={!forced}
      keyboard={!forced}
      cancelButtonProps={forced ? { style: { display: "none" } } : undefined}
      destroyOnClose
    >
      {forced ? <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t("password.forced")} /> : null}
      <Form form={form} layout="vertical">
        <Form.Item name="oldPassword" label={t("password.old")} rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label={t("password.new")}
          rules={[{ required: true, min: 8, message: t("password.tooShort") }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label={t("password.confirm")}
          dependencies={["newPassword"]}
          rules={[
            { required: true },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                return Promise.reject(new Error(t("password.mismatch")));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
