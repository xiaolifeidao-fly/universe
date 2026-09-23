"use client";

import { LockOutlined, MailOutlined } from "@ant-design/icons";
import { Button, Checkbox, Form, Input, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { setAuthToken, setAuthUser } from "@/utils/auth";
import { login } from "../api/login.api";

const { Title } = Typography;

interface LoginValues {
  account: string;
  password: string;
  remember: boolean;
}

export function LoginFormCard() {
  const router = useRouter();
  const { t } = useLocale();
  const [submitting, setSubmitting] = useState(false);

  const handleFinish = async (values: LoginValues) => {
    setSubmitting(true);
    try {
      const result = await login({ username: values.account.trim(), password: values.password });
      setAuthToken(result.token, values.remember);
      setAuthUser(result.user, values.remember);
      if (result.user.mustChangePassword) {
        message.warning(t("login.mustChangePassword"));
      } else {
        message.success(t("login.success"));
      }
      router.replace("/dashboard");
    } catch (error) {
      message.error((error as Error).message || t("login.passwordRequired"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="manager-shell-card manager-stagger-4 manager-brand-frame"
      style={{ borderRadius: 10, padding: 32, background: "var(--manager-surface)" }}
    >
      <Title
        level={3}
        style={{ marginTop: 0, marginBottom: 24, color: "var(--manager-text)", textAlign: "center" }}
      >
        {t("login.title")}
      </Title>

      <Form<LoginValues> layout="vertical" initialValues={{ remember: true }} onFinish={(values) => void handleFinish(values)}>
        <Form.Item label={t("login.account")} name="account" rules={[{ required: true, message: t("login.accountRequired") }]}>
          <Input prefix={<MailOutlined style={{ color: "rgba(16,40,64,0.42)" }} />} placeholder={t("login.accountPlaceholder")} size="large" />
        </Form.Item>

        <Form.Item label={t("login.password")} name="password" rules={[{ required: true, message: t("login.passwordRequired") }]}>
          <Input.Password prefix={<LockOutlined style={{ color: "rgba(16,40,64,0.42)" }} />} placeholder={t("login.passwordPlaceholder")} size="large" />
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
          style={{ height: 50, color: "#ffffff", background: "var(--manager-primary)", border: "none", fontWeight: 800 }}
        >
          {t("login.submit")}
        </Button>
      </Form>
    </div>
  );
}
