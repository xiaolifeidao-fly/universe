"use client";

/**
 * 注册。注册完直接是登录状态，落到首页。
 *
 * 这里注册的是共享端账号，只能登 Nova：Orbit（使用端）是另一批人，要用得在那边
 * 另注册一个，同一个用户名在两边可以各是一个账号。
 *
 * 身份一律是散户，不给选：散户、工作室的信誉是两种算法（跟着账号走 / 每台机器各算各的），
 * 那张身份表是读分的依据，只有平台运营能在管理端改。
 *
 * 邀请链接落在这一页：<注册页>?invite=<邀请码>，进来就把邀请码填好。邀请码选填 ——
 * 自己找来的人不该被一个空着的框挡住；填错了服务端会说，让人检查链接或者清空再注册。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  // 只在进页面时读一次地址栏：语言挂载后才定下来，t 会跟着变一次，
  // 重跑的话会把人已经改过的邀请码又盖回链接里那个。
  const entered = useRef(false);

  // 同登录页：已经登录就直接回首页。判断只能在挂载后做 —— 令牌在 localStorage 里。
  //
  // 用 window.location 而不是 useSearchParams()：后者在 App Router 里要求外面套一层 <Suspense>，
  // 否则 next build 直接报错 —— 为一个可选的预填值付这个代价不值当（同 Orbit 的商店页）。
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    const invite = new URLSearchParams(window.location.search).get("invite")?.trim() ?? "";
    if (isAuthenticated()) {
      // 邀请只认新注册的账号。不说一声就跳走，点了好友链接的人会以为邀请已经记上了。
      if (invite) message.info(t("register.inviteSignedIn"));
      router.replace(productConfig.home);
      return;
    }
    if (invite) setInviteCode(invite);
  }, [router, t]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const issue = formIssue(username.trim(), displayName.trim(), password, confirm);
    if (issue) {
      message.warning(t(issue));
      return;
    }
    setBusy(true);
    try {
      // 邀请码不分大小写，统一大写再发；空着就不带这个字段，不发一个空串让服务端去猜。
      const code = inviteCode.trim().toUpperCase();
      const result = await register({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password,
        inviteCode: code || undefined,
      });
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
      <Field label={t("register.inviteCode")}>
        <input
          className="gx-input gx-input--mono"
          autoComplete="off"
          spellCheck={false}
          maxLength={32}
          placeholder={t("register.inviteCodePlaceholder")}
          value={inviteCode}
          onChange={(event) => setInviteCode(event.target.value)}
        />
      </Field>

      <Btn tone="accent" type="submit" loading={busy} icon={<IconArrowRight size={16} />}>
        {t("register.submit")}
      </Btn>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--gx-faint)" }}>
        <span>
          {t("register.hasAccount")}{" "}
          <button
            type="button"
            className="gx-link"
            // 邀请码跟着带过去：点错去了登录页再点回来，不该让人回聊天记录里重新找那条链接。
            onClick={() => router.push(inviteCode.trim() ? `/login?invite=${encodeURIComponent(inviteCode.trim())}` : "/login")}
          >
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
