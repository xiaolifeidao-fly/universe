"use client";

/**
 * 远端机器上那一次登录的全程，摊在机器行展开的那一格里。
 *
 * 为什么要有这个面板：在它之前，一台没有图形界面的机器要登录 claude 或 codex，
 * 只能 ssh 上去手敲；而机器在机房里、主人的浏览器在手边，中间那一段（打开地址、
 * 授权、把码带回去）正是平台能替他们接上的。
 *
 * 两条路的形状不一样，这个面板的分岔全部来自它：
 *
 *   · codex 走设备码 —— 机器给一串短码和一个地址，主人在任意一台有浏览器的设备上
 *     输完码，机器自己轮询换 token。**界面只管显示**，没有任何东西要送回去。
 *   · claude 没有设备码流程 —— 机器只给一条授权地址，主人在浏览器里授权完会拿到
 *     一串码，那台机器上的进程正卡在 stdin 上等它。所以这里要有一个输入框，
 *     把码交回平台，再由心跳送回那台机器。
 *
 * 短码用大号等宽字：主人是对着另一台设备的屏幕一个一个字符敲进去的，
 * O 和 0、I 和 1 在正文字号下分不清，敲错换来的是一句含糊的「码无效」。
 */

import { useEffect, useState } from "react";
import { Btn, CopyBtn } from "@/components/ui/kit";
import { openExternal } from "@/utils/shell";
import type { NodeLogin } from "../../api/provider.api";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 还在路上：等机器领、正在起、或者在等主人。 */
export function isLoginBusy(login: NodeLogin | undefined): boolean {
  return login?.state === "pending" || login?.state === "running" || login?.state === "waiting";
}

/**
 * 把刚拿到的那条登录就地并进机器的列表里。
 *
 * 要 upsert 不能只 map：一台从没登录过这个工具的机器，logins 里根本没有它那一条 ——
 * 只做替换的话，点完「登录」到下一次刷新之间界面上什么都不会出现，看起来就像没点上。
 */
export function upsertLogin(logins: NodeLogin[], next: NodeLogin): NodeLogin[] {
  const found = logins.some((item) => item.tool === next.tool);
  return found ? logins.map((item) => (item.tool === next.tool ? { ...item, ...next } : item)) : [...logins, next];
}

/** 这一格现在该说什么。分成一句话，好让下面的布局只管排版。 */
function headline(login: NodeLogin, t: Translate): { text: string; tone: "soft" | "ok" | "danger" } {
  switch (login.state) {
    case "pending":
      return { text: t("account.loginPending"), tone: "soft" };
    case "running":
      return { text: t("account.loginStarting"), tone: "soft" };
    case "waiting":
      return login.phase === "verifying"
        ? { text: t("account.loginVerifying"), tone: "soft" }
        : { text: t(login.needsCode ? "account.loginAwaitCode" : "account.loginAwaitDevice"), tone: "soft" };
    case "succeeded":
      return { text: t("account.loginSucceeded", { tool: login.tool }), tone: "ok" };
    default:
      return { text: login.detail || t("account.loginFailed"), tone: "danger" };
  }
}

const TONE_COLOR = {
  soft: "var(--gx-faint)",
  ok: "var(--gx-ok-ink)",
  danger: "var(--gx-danger)",
} as const;

export function LoginPanel({
  login,
  busy,
  onSubmitCode,
  onRestart,
  t,
}: {
  login: NodeLogin;
  busy: boolean;
  onSubmitCode: (code: string) => void;
  /** 这次不要了，重来一次。 */
  onRestart: () => void;
  t: Translate;
}) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const said = headline(login, t);
  const waiting = login.state === "waiting";
  // 码提交完就清掉输入框：机器说「无效」时主人要重新粘一串，
  // 留着上一串只会让他以为自己粘的那次没生效。
  useEffect(() => {
    if (login.phase === "verifying") setCode("");
  }, [login.phase]);

  return (
    <div
      style={{
        marginTop: 10,
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--gx-line)",
        background: "var(--gx-muted)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 600 }}>{t("account.loginTitle", { tool: login.tool })}</b>
        <span style={{ flex: 1, minWidth: 0, color: TONE_COLOR[said.tone], overflowWrap: "anywhere" }}>{said.text}</span>
        {waiting ? (
          // 走开太久、码过期了、或者想换个账号 —— 没有这一下的话，这个工具会被
          // 卡在「正在登录」里十五分钟，而上面那个「登录」按钮点了只会被拒回来。
          <Btn tone="ghost" small loading={busy} onClick={onRestart}>
            {t("account.loginRestart")}
          </Btn>
        ) : null}
      </span>

      {waiting && login.verificationUri ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--gx-faint)", whiteSpace: "nowrap" }}>{t("account.loginOpenHere")}</span>
          {/* 地址很长（claude 那条有 400 多字符），所以不整条铺出来：
              一个「打开」加一个「复制」—— 主人要么就在这台设备上开，
              要么把它发到手边那台有浏览器的机器上。 */}
          <Btn tone="soft" small onClick={() => void openExternal(login.verificationUri)}>
            {t("account.loginOpen")}
          </Btn>
          <CopyBtn
            value={login.verificationUri}
            label={t("account.loginCopyLink")}
            copied={copied}
            onCopied={() => setCopied(true)}
          />
        </span>
      ) : null}

      {waiting && login.userCode ? (
        <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: "var(--gx-faint)", whiteSpace: "nowrap" }}>{t("account.loginEnterCode")}</span>
          <b
            className="gx-mono"
            style={{ fontSize: 20, letterSpacing: 2, color: "var(--gx-ink)", userSelect: "all" }}
          >
            {login.userCode}
          </b>
        </span>
      ) : null}

      {waiting && login.needsCode ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--gx-faint)", whiteSpace: "nowrap" }}>{t("account.loginPasteCode")}</span>
          <input
            className="gx-input gx-input--mono"
            style={{ flex: "1 1 260px", minWidth: 0 }}
            value={code}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("account.loginCodePlaceholder")}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && code.trim()) onSubmitCode(code.trim());
            }}
          />
          <Btn tone="accent" small disabled={!code.trim()} loading={busy} onClick={() => onSubmitCode(code.trim())}>
            {t("account.loginSubmitCode")}
          </Btn>
        </span>
      ) : null}

      {login.state === "failed" && login.command ? (
        // 失败时把那条命令摆出来：平台这边能说的都说完了，再往下只能人自己上去看。
        <span className="gx-mono" style={{ fontSize: 11, color: "var(--gx-faint)", overflowWrap: "anywhere" }}>
          {login.command}
        </span>
      ) : null}
    </div>
  );
}
