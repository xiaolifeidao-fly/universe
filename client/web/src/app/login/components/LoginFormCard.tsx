"use client";

import {
  LockOutlined,
  MailOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Form, Input, Typography, message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { login } from "@/app/login/api/login.api";
import { isAuthenticated, setAuthToken, setAuthUser, setPasswordChangeRequired } from "@/utils/auth";
import { useLocale } from "@/i18n/LocaleProvider";

const { Title } = Typography;

interface LoginValues {
  account: string;
  password: string;
  remember: boolean;
}

export function LoginFormCard() {
  const router = useRouter();
  const [messageApi, contextHolder] = message.useMessage();
  const [submitting, setSubmitting] = useState(false);
  const { t } = useLocale();

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace("/delivery");
    }
  }, [router]);

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
      messageApi.success(t("login.success"));
      router.replace("/delivery");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("login.passwordRequired");
      messageApi.error(errorMessage);
    } finally {
      setSubmitting(false);
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
        </Form>
      </div>
    </>
  );
}
