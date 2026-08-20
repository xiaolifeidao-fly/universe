"use client";

import {
  IdcardOutlined,
  LockOutlined,
  MailOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Form, Input, Modal, Typography, message } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { login } from "@/app/login/api/login.api";
import { register } from "@/app/login/api/register.api";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { isAuthenticated, setAuthToken, setAuthUser, setPasswordChangeRequired } from "@/utils/auth";
import { useLocale } from "@/i18n/LocaleProvider";

const { Title } = Typography;

interface LoginValues {
  account: string;
  password: string;
  remember: boolean;
}

interface RegisterValues {
  username: string;
  displayName: string;
  password: string;
  confirmPassword: string;
}

// 用户名会直接作为个人空间的编码，所以这里的规则要和服务端保持一致。
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function LoginFormCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 邀请链接会先把人踢到登录页，登录完要回到那条链接而不是默认落地页。
  // 只接受站内相对路径，避免变成开放跳转。
  const rawRedirect = searchParams?.get("redirect") ?? "";
  const landingPath = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/delivery";
  const [messageApi, contextHolder] = message.useMessage();
  const [submitting, setSubmitting] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerForm] = Form.useForm<RegisterValues>();
  const { t } = useLocale();
	const { refreshBusinessLines } = useBusinessLine();

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace(landingPath);
    }
  }, [landingPath, router]);

  const handleFinish = async (values: LoginValues) => {
    setSubmitting(true);
    try {
      const response = await login({
        username: values.account.trim(),
        password: values.password,
      });
      setAuthToken(response.token, values.remember);
      setAuthUser(response.user, values.remember);
      setPasswordChangeRequired(response.user.mustChangePassword);
		await refreshBusinessLines().catch(() => undefined);
      messageApi.success(t("login.success"));
      router.replace(landingPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("login.passwordRequired");
      messageApi.error(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (values: RegisterValues) => {
    setRegistering(true);
    try {
      const response = await register({
        username: values.username.trim().toLowerCase(),
        displayName: values.displayName.trim(),
        password: values.password,
      });
      setAuthToken(response.token, true);
      setAuthUser(response.user, true);
      setPasswordChangeRequired(response.user.mustChangePassword);
      await refreshBusinessLines().catch(() => undefined);
      setRegisterOpen(false);
      registerForm.resetFields();
      messageApi.success(t("register.success"));
      router.replace(landingPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("register.failed");
      messageApi.error(errorMessage);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <>
      {contextHolder}
      <div
        className="manager-shell-card manager-stagger-4 manager-form-skin manager-brand-frame"
        style={{
          borderRadius: 10,
          padding: 32,
          background: "var(--manager-surface)",
        }}
      >
        <Title
          level={3}
          className="manager-display-title"
          style={{
            marginTop: 0,
            marginBottom: 24,
            color: "var(--manager-text)",
            textAlign: "center",
          }}
        >
          {t("login.title")}
        </Title>

        <Form<LoginValues>
          layout="vertical"
          initialValues={{
            remember: true,
          }}
          onFinish={handleFinish}
        >
          <Form.Item
            label={t("login.account")}
            name="account"
            rules={[{ required: true, message: t("login.accountRequired") }]}
          >
            <Input
              prefix={<MailOutlined style={{ color: "rgba(16,40,64,0.42)" }} />}
              placeholder={t("login.accountPlaceholder")}
              size="large"
            />
          </Form.Item>

          <Form.Item
            label={t("login.password")}
            name="password"
            rules={[{ required: true, message: t("login.passwordRequired") }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(16,40,64,0.42)" }} />}
              placeholder={t("login.passwordPlaceholder")}
              size="large"
            />
          </Form.Item>

          <div style={{ marginBottom: 24 }}>
            <Form.Item name="remember" valuePropName="checked" noStyle>
              <Checkbox>{t("login.remember")}</Checkbox>
            </Form.Item>
          </div>

          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={submitting}
            style={{
              height: 50,
              color: "#ffffff",
              background: "var(--manager-primary)",
              border: "none",
              fontWeight: 800,
            }}
          >
            {t("login.submit")}
          </Button>

          <Button
            type="link"
            block
            style={{ marginTop: 12, fontWeight: 600 }}
            onClick={() => setRegisterOpen(true)}
          >
            {t("register.entry")}
          </Button>
        </Form>
      </div>

      <Modal
        open={registerOpen}
        title={t("register.title")}
        okText={t("register.submit")}
        cancelText={t("register.cancel")}
        confirmLoading={registering}
        onOk={() => registerForm.submit()}
        onCancel={() => {
          if (registering) {
            return;
          }
          setRegisterOpen(false);
          registerForm.resetFields();
        }}
        destroyOnClose
      >
        <Typography.Paragraph style={{ color: "var(--manager-text-secondary)" }}>
          {t("register.hint")}
        </Typography.Paragraph>
        <Form<RegisterValues> form={registerForm} layout="vertical" onFinish={handleRegister}>
          <Form.Item
            label={t("register.username")}
            name="username"
            rules={[
              { required: true, message: t("register.usernameRequired") },
              {
                validator: (_rule, value?: string) => {
                  const normalized = (value ?? "").trim().toLowerCase();
                  if (!normalized) {
                    return Promise.resolve();
                  }
                  if (normalized.length < 2 || normalized.length > 32) {
                    return Promise.reject(new Error(t("register.usernameLength")));
                  }
                  if (!USERNAME_PATTERN.test(normalized)) {
                    return Promise.reject(new Error(t("register.usernamePattern")));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input
              prefix={<UserOutlined style={{ color: "rgba(16,40,64,0.42)" }} />}
              placeholder={t("register.usernamePlaceholder")}
              size="large"
              autoComplete="off"
            />
          </Form.Item>

          <Form.Item
            label={t("register.displayName")}
            name="displayName"
            rules={[{ required: true, message: t("register.displayNameRequired") }]}
          >
            <Input
              prefix={<IdcardOutlined style={{ color: "rgba(16,40,64,0.42)" }} />}
              placeholder={t("register.displayNamePlaceholder")}
              size="large"
            />
          </Form.Item>

          <Form.Item
            label={t("register.password")}
            name="password"
            rules={[
              { required: true, message: t("register.passwordRequired") },
              { min: 8, message: t("register.passwordLength") },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(16,40,64,0.42)" }} />}
              placeholder={t("register.passwordPlaceholder")}
              size="large"
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item
            label={t("register.confirmPassword")}
            name="confirmPassword"
            dependencies={["password"]}
            rules={[
              { required: true, message: t("register.confirmPasswordRequired") },
              ({ getFieldValue }) => ({
                validator: (_rule, value?: string) =>
                  !value || value === getFieldValue("password")
                    ? Promise.resolve()
                    : Promise.reject(new Error(t("register.passwordMismatch"))),
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(16,40,64,0.42)" }} />}
              placeholder={t("register.confirmPasswordPlaceholder")}
              size="large"
              autoComplete="new-password"
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
