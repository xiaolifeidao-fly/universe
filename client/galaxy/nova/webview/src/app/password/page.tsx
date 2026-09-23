"use client";

/**
 * 改密码。两种人会来：
 *   · 运营重置过密码的人 —— 拿临时密码登进来，服务端除了「看自己」和「改密码」什么都不放行，
 *     控制台的守卫会把他挡到这里。所以这一页不挂在控制台外壳里，而且必须留一个退出登录的口子：
 *     不想现在改、或者登错了号的人不能被困在这一页。
 *   · 自己想换密码的人 —— 从账户页点进来。
 *
 * 改完之后这个账号之前发出去的令牌全部作废，服务端同时回一张新的：拿它换掉本地那张，
 * 这台电脑接着用，不用重新登录。「保持登录」沿用登录时的选择。
 */

import { message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoginShell } from "@/components/shell/LoginShell";
import { IconArrowRight } from "@/components/ui/icons";
import { Btn, Field, Note } from "@/components/ui/kit";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import {
  clearAuthToken,
  getAuthUser,
  isAuthenticated,
  isAuthTokenRemembered,
  isPasswordChangeRequired,
  passwordIssue,
  setAuthToken,
  setAuthUser,
  setPasswordChangeRequired,
} from "@/utils/auth";
import { productConfig } from "@/utils/product";
import { changePassword } from "./api/password.api";

/** 规则见 utils/auth 的「账号规则」。「当前密码对不对」只有服务端知道。 */
function formIssue(currentPassword: string, newPassword: string, confirm: string): TranslationKey | null {
  if (!currentPassword) return "password.currentRequired";
  const secret = passwordIssue(newPassword);
  if (secret) return secret === "short" ? "password.tooShort" : "password.tooLong";
  if (newPassword === currentPassword) return "password.same";
  return newPassword === confirm ? null : "password.mismatch";
}

export default function PasswordPage() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [forced, setForced] = useState(false);
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // 登录态在 localStorage 里，只能挂载后判断；判断完再画，免得先闪一下「返回账户」再换成警告。
  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace("/login");
      return;
    }
    setForced(isPasswordChangeRequired());
    setUsername(getAuthUser()?.username ?? "");
    setReady(true);
  }, [router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const issue = formIssue(currentPassword, newPassword, confirm);
    if (issue) {
      message.warning(t(issue));
      return;
    }
    setBusy(true);
    // 先记下登录时选的「保持登录」：setAuthToken 会先清掉旧令牌，清完就读不出来了。
    const remember = isAuthTokenRemembered();
    try {
      const result = await changePassword({ currentPassword, newPassword });
      setAuthToken(result.token, remember);
      setAuthUser(result.user, remember);
      setPasswordChangeRequired(false);
      message.success(t("password.success"));
      router.replace(productConfig.home);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return null;

  return (
    <LoginShell
      subtitle={
        <>
          {t("password.title")}
          {username ? <span className="gx-mono"> · {username}</span> : null}
        </>
      }
      foot={t("password.foot")}
      onSubmit={submit}
    >
      {forced ? <Note tone="warn">{t("password.forced")}</Note> : null}
      <Field label={t("password.current")}>
        <input
          className="gx-input"
          type="password"
          autoComplete="current-password"
          placeholder={forced ? t("password.tempPlaceholder") : t("password.currentPlaceholder")}
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </Field>
      <Field label={t("password.new")}>
        <input
          className="gx-input"
          type="password"
          autoComplete="new-password"
          placeholder={t("password.newPlaceholder")}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </Field>
      <Field label={t("password.confirm")}>
        <input
          className="gx-input"
          type="password"
          autoComplete="new-password"
          placeholder={t("password.confirmPlaceholder")}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>

      <Btn tone="accent" type="submit" loading={busy} icon={<IconArrowRight size={16} />}>
        {t("password.submit")}
      </Btn>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
        {forced ? (
          <button
            type="button"
            className="gx-link"
            onClick={() => {
              clearAuthToken();
              router.replace("/login");
            }}
          >
            {t("password.logout")}
          </button>
        ) : (
          <button type="button" className="gx-link" onClick={() => router.replace("/provider/account")}>
            {t("password.back")}
          </button>
        )}
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
