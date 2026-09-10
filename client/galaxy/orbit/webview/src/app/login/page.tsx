"use client";

/**
 * 登录。左边是「为什么要用它」，右边是账号密码。
 *
 * 桌面应用的登录页只会被看到几次，但每一次都是第一印象 —— 所以左边那半屏
 * 不是装饰：三条卖点回答的是新用户此刻真正在犹豫的事。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
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
      if (result.user?.mustChangePassword) message.warning(t("login.mustChangePassword"));
      else message.success(t("login.success"));
      router.replace(productConfig.home);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gx-login">
      <section className="gx-login__hero">
        <div className="gx-login__tagline">
          {t("login.tagline1")}
          <br />
          {t("login.tagline2")}
        </div>
        <div className="gx-login__points">
          {["1", "2", "3"].map((index) => (
            <div className="gx-login__point" key={index}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  flex: "0 0 auto",
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: "var(--gx-accent-soft)",
                  color: "var(--gx-accent)",
                }}
              >
                <IconCheck size={13} />
              </span>
              <span>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{t(`login.point${index}.title`)}</span>
                <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-faint)", marginTop: 2 }}>
                  {t(`login.point${index}.desc`)}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="gx-login__form">
        <form className="gx-login__panel" onSubmit={submit}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span className="gx-serif" style={{ fontSize: 24 }}>
              {productConfig.name}
            </span>
            <span className="gx-mono" style={{ fontSize: 10.5, letterSpacing: "0.14em", color: "var(--gx-faint)" }}>
              {t("brand.subtitle")}
            </span>
          </div>
          <div style={{ fontSize: 13, color: "var(--gx-faint)", marginBottom: 22 }}>{t("login.welcome")}</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
              <span className="gx-muted">{t("login.forgot")}</span>
            </div>

            <Btn tone="accent" type="submit" loading={busy} icon={<IconArrowRight size={16} />}>
              {t("login.submit")}
            </Btn>

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--gx-faint)" }}>
              <span>
                {t("login.noAccount")} <span style={{ color: "var(--gx-accent-ink)" }}>{t("login.register")}</span>
              </span>
              <button
                type="button"
                className="gx-link"
                onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
              >
                {t(locale === "zh-CN" ? "locale.en-US" : "locale.zh-CN")}
              </button>
            </div>
          </div>

          <p style={{ marginTop: 26, marginBottom: 0, fontSize: 11.5, lineHeight: 1.7, color: "var(--gx-faint)" }}>
            {t("login.foot")}
          </p>
        </form>
      </section>
    </main>
  );
}
