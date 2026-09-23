"use client";

/**
 * 登录。骨架（左边卖点、右边表单）在 LoginShell，注册、改密码两页共用。
 *
 * 运营重置过密码的人拿临时密码登进来，服务端除了「看自己」和「改密码」什么都不放行，
 * 所以这种账号登录后直接去改密码页，不进控制台。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoginShell } from "@/components/shell/LoginShell";
import { IconArrowRight } from "@/components/ui/icons";
import { Btn, Field } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { isAuthenticated, setAuthToken, setAuthUser, setPasswordChangeRequired } from "@/utils/auth";
import { productConfig } from "@/utils/product";
import { login } from "./api/login.api";

export default function LoginPage() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  // 已经登录过就别再让人看一次登录页。判断只能在挂载后做 —— 令牌在
  // localStorage 里，服务端读不到。
  useEffect(() => {
    if (isAuthenticated()) router.replace(productConfig.home);
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim()) {
      message.warning(t("login.accountRequired"));
      return;
    }
    if (!password) {
      message.warning(t("login.passwordRequired"));
      return;
    }
    setBusy(true);
    try {
      const result = await login({ username: username.trim(), password });
      setAuthToken(result.token, remember);
      setAuthUser(result.user, remember);
      setPasswordChangeRequired(Boolean(result.user?.mustChangePassword));
      if (result.user?.mustChangePassword) {
        message.warning(t("login.mustChangePassword"));
        router.replace("/password");
        return;
      }
      message.success(t("login.success"));
      router.replace(productConfig.home);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginShell subtitle={t("login.welcome")} foot={t("login.foot")} onSubmit={submit}>
      <Field label={t("login.account")}>
        <input
          className="gx-input"
          autoComplete="username"
          placeholder={t("login.accountPlaceholder")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label={t("login.password")}>
        <input
          className="gx-input"
          type="password"
          autoComplete="current-password"
          placeholder={t("login.passwordPlaceholder")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12.5 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--gx-soft)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            style={{ accentColor: "var(--gx-accent)" }}
          />
          {t("login.remember")}
        </label>
        {/* 没有自助找回，重置只能由平台运营在管理端做。点了告诉人该找谁，比一个点不动的字强。 */}
        <button type="button" className="gx-link" onClick={() => message.info(t("login.forgotHint"))}>
          {t("login.forgot")}
        </button>
      </div>

      <Btn tone="accent" type="submit" loading={busy} icon={<IconArrowRight size={16} />}>
        {t("login.submit")}
      </Btn>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--gx-faint)" }}>
        <span>
          {t("login.noAccount")}{" "}
          <button type="button" className="gx-link" onClick={() => router.push("/register")}>
            {t("login.register")}
          </button>
        </span>
        <button
          type="button"
          className="gx-link"
          onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
        >
          {t(locale === "zh-CN" ? "locale.en-US" : "locale.zh-CN")}
        </button>
      </div>
    </LoginShell>
  );
}
