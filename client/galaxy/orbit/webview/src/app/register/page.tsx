"use client";

/**
 * 注册。注册完直接是登录状态，落到首页（密钥页）。
 *
 * 这里注册的是使用端账号，只能登 Orbit：Nova（共享端）是另一批人，要出算力得在那边
 * 另注册一个，同一个用户名在两边可以各是一个账号。
 *
 * 新账号**默认带一把算力密钥**：服务端在注册那一步就签好，明文跟着注册响应回来一次，
 * 这里立刻存进本机保险箱 —— 之后密钥页的查看、复制、一键接客户端都从那儿取。
 * 存不下的时候（浏览器禁了站点数据、桌面端的库打不开）必须当场把明文摆出来：
 * 服务端那份密文未必取得回（部署方没配加密密钥就解不开），这一页关掉它就没了。
 *
 * 从分享链接（/register?invite=…）进来的，邀请码自动填上。码不对服务端会拒 ——
 * 悄悄忽略的话注册是成了，邀请人的返现却无声无息地没了。
 */

import { Modal, message } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
// 本机保险箱借的是密钥页那一份：存进去的格式要和它读出来的完全一致，
// 在这儿另写一份迟早会对不上号，那时密钥页只会显示「本机没有这一把」。
import { rememberKeySecret } from "@/app/(console)/consumer/api/keyvault.api";
import { LoginShell } from "@/components/shell/LoginShell";
import { IconArrowRight } from "@/components/ui/icons";
import { Btn, CopyBtn, Field } from "@/components/ui/kit";
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
import { register, type RegisteredKey } from "./api/register.api";

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

/**
 * 明文没能存进本机时，把它摆一次。
 *
 * 和密钥页的 IssuedKeyModal 是同一套说法（复用同几条文案），只是这里还没进控制台，
 * 没有「去密钥页」那条路可走。
 */
function SecretOnce({ secret }: { secret: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--gx-warn)" }}>{t("issued.notSaved")}</p>
      <div className="gx-secret">
        <span style={{ flex: 1 }}>{secret}</span>
        <CopyBtn value={secret} label={t("common.copy")} copied={copied} onCopied={() => setCopied(true)} />
      </div>
    </div>
  );
}

export default function RegisterPage() {
  const { t, locale, setLocale } = useLocale();
  const router = useRouter();
  // 静态 Modal 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [fromLink, setFromLink] = useState(false);
  const [busy, setBusy] = useState(false);

  // 同登录页：已经登录就直接回首页。判断只能在挂载后做 —— 令牌在 localStorage 里。
  useEffect(() => {
    if (isAuthenticated()) router.replace(productConfig.home);
  }, [router]);

  // 分享链接带来的邀请码。用 window.location 而不是 useSearchParams：后者要求外面套 <Suspense>，
  // 为一个预填值让整页构建多一层约束不值当。
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite")?.trim() ?? "";
    if (code) {
      setInviteCode(code);
      setFromLink(true);
    }
  }, []);

  // 存不下的那一次：明文摆出来，人点了「知道了」才进控制台 ——
  // 一跳转它就没了，而服务端那份未必取得回。
  const showSecretOnce = (key: RegisteredKey) => {
    modal.warning({
      title: t("issued.title", { alias: key.alias }),
      content: <SecretOnce secret={key.secret} />,
      okText: t("issued.done"),
      maskClosable: false,
      width: 520,
      onOk: () => router.replace(productConfig.home),
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const issue = formIssue(username.trim(), displayName.trim(), password, confirm);
    if (issue) {
      message.warning(t(issue));
      return;
    }
    setBusy(true);
    try {
      const result = await register({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        password,
        inviteCode: inviteCode.trim() || undefined,
      });
      // 注册页不摆「保持登录」：刚设好的密码，没理由下次打开就让人再输一遍。
      setAuthToken(result.token, true);
      setAuthUser(result.user, true);
      setPasswordChangeRequired(false);
      // 默认密钥的明文存本机。保险箱按账号分区，所以必须在 setAuthUser 之后存。
      const key = result.key;
      if (key?.secret && !(await rememberKeySecret(key.keyId, key.alias, key.secret))) {
        // 存不下：人点了「知道了」再进控制台，别让这串东西被一次跳转带走。
        showSecretOnce(key);
        return;
      }
      message.success(t(key?.secret ? "register.successWithKey" : "register.success"));
      router.replace(productConfig.home);
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoginShell subtitle={t("register.welcome")} foot={t("register.foot")} onSubmit={submit}>
      {modalHolder}
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

      <Field label={t("register.inviteCode")} hint={fromLink ? t("register.inviteFromLink") : t("register.inviteHint")}>
        <input
          className="gx-input gx-input--mono"
          autoComplete="off"
          placeholder={t("register.invitePlaceholder")}
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
