"use client";

/**
 * 注册。注册完直接是登录状态，落到首页。
 *
 * 这里注册的是共享端账号，只能登 Nova：Orbit（使用端）是另一批人，要用得在那边
 * 另注册一个，同一个用户名在两边可以各是一个账号。
 *
 * 身份一律是散户，不给选：散户、工作室的信誉是两种算法（跟着账号走 / 每台机器各算各的），
 * 那张身份表是读分的依据，只有平台运营能在管理端改。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoginShell } from "@/components/shell/LoginShell";
import { IconArrowRight } from "@/components/ui/icons";
import { Btn, Field } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import {
  isAuthenticated,
  passwordIssue,
  setAuthToken,
  setAuthUser,
  setPasswordChangeRequired,
  usernameIssue,
} from "@/utils/auth";
import { productConfig } from "@/utils/product";
import { register } from "./api/register.api";

/** 规则见 utils/auth 的「账号规则」。按从上到下的填写顺序报第一处问题。 */
function formIssue(username: string, displayName: string, password: string, confirm: string): TranslationKey | null {
  if (!username) return "register.usernameRequired";
  const name = usernameIssue(username);
  if (name) return name === "pattern" ? "register.usernameInvalid" : "register.usernameLength";
  // 按字算（和服务端一样数 rune），不按 UTF-16 码元：一个 emoji 不该占两个字。
  if (Array.from(displayName).length > 64) return "register.displayNameTooLong";
  const secret = passwordIssue(password);
  if (secret) return secret === "short" ? "password.tooShort" : "password.tooLong";
  return password === confirm ? null : "password.mismatch";
}

export default function RegisterPage() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // 同登录页：已经登录就直接回首页。判断只能在挂载后做 —— 令牌在 localStorage 里。
  useEffect(() => {
    if (isAuthenticated()) router.replace(productConfig.home);
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const issue = formIssue(username.trim(), displayName.trim(), password, confirm);
    if (issue) {
      message.warning(t(issue));
      return;
    }
    setBusy(true);
    try {
      const result = await register({ username: username.trim(), displayName: displayName.trim() || undefined, password });
      // 注册页不摆「保持登录」：刚设好的密码，没理由下次打开就让人再输一遍。
      setAuthToken(result.token, true);
      setAuthUser(result.user, true);
      setPasswordChangeRequired(false);
      message.success(t("register.success"));
      router.replace(productConfig.home);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginShell subtitle={t("register.welcome")} foot={t("register.foot")} onSubmit={submit}>
      <Field label={t("register.username")}>
        <input
          className="gx-input"
          autoComplete="username"
          placeholder={t("register.usernamePlaceholder")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label={t("register.displayName")}>
        <input
          className="gx-input"
          autoComplete="nickname"
          placeholder={t("register.displayNamePlaceholder")}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field label={t("register.password")}>
        <input
          className="gx-input"
          type="password"
          autoComplete="new-password"
          placeholder={t("register.passwordPlaceholder")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label={t("register.confirm")}>
        <input
          className="gx-input"
          type="password"
          autoComplete="new-password"
          placeholder={t("register.confirmPlaceholder")}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>

      <Btn tone="accent" type="submit" loading={busy} icon={<IconArrowRight size={16} />}>
        {t("register.submit")}
      </Btn>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--gx-faint)" }}>
        <span>
          {t("register.hasAccount")}{" "}
          <button type="button" className="gx-link" onClick={() => router.push("/login")}>
            {t("register.login")}
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
