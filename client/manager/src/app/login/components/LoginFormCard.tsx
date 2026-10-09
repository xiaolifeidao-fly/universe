"use client";

import { GlobalOutlined, LockOutlined, StarFilled, UserOutlined } from "@ant-design/icons";
import { Button, Checkbox, Form, Input, message } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { setAuthToken, setAuthUser } from "@/utils/auth";
import { login } from "../api/login.api";

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
    <div className="manager-login-form">
      <div className="manager-crest" aria-hidden="true">
        <GlobalOutlined className="manager-crest-planet" />
        <StarFilled className="manager-crest-star" />
      </div>
      <h1>{t("login.title")}</h1>
      <p>{t("login.subtitle")}</p>

      <Form<LoginValues>
        layout="vertical"
        requiredMark={false}
        initialValues={{ remember: true }}
        onFinish={(values) => void handleFinish(values)}
      >
        <Form.Item label={t("login.account")} name="account" rules={[{ required: true, message: t("login.accountRequired") }]}>
          <Input prefix={<UserOutlined />} placeholder={t("login.accountPlaceholder")} size="large" autoComplete="username" autoFocus />
        </Form.Item>

        <Form.Item label={t("login.password")} name="password" rules={[{ required: true, message: t("login.passwordRequired") }]}>
          <Input.Password prefix={<LockOutlined />} placeholder={t("login.passwordPlaceholder")} size="large" autoComplete="current-password" />
        </Form.Item>

        <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 24 }}>
          <Checkbox>{t("login.remember")}</Checkbox>
        </Form.Item>

        <Button className="manager-login-submit" type="primary" htmlType="submit" block size="large" loading={submitting}>
          {t("login.submit")}
        </Button>
      </Form>
    </div>
  );
}
