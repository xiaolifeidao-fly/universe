"use client";

/**
 * 接入密钥：给服务器上独立部署的 ai-bridge 用。
 *
 * 它和配对码是两条接入路径，服务的是两种人：
 *   · 配对码 —— Nova 客户端。人同时看着两块屏幕，十分钟有效、只能用一次。
 *   · 接入密钥 —— 机房里的 ai-bridge。没人值守，机器重启之后要能自己重新注册，
 *     所以它是长期的。
 *
 * 它比配对码值钱得多：拿到它的人能以你的名义往池子里加机器，别人跑在那台机器上
 * 产生的积分会记在你头上。所以这一块只做三件事 —— 签发（明文只显示一次）、
 * 看它最近被谁用过、随时吊销。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { IconKey, IconPlus } from "@/components/ui/icons";
import { Btn, Card, CardHead, CopyBtn, Field, Loading, Note, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelative } from "@/utils/format";
import {
  acceptTerms,
  fetchProviderEndpoint,
  fetchProviderKeys,
  fetchTerms,
  issueProviderKey,
  revokeProviderKey,
  type IssuedProviderKey,
  type ProviderKeyView,
  type TermsStatus,
} from "../../api/provider.api";

export function AccessKeyPanel() {
  const { t } = useLocale();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [keys, setKeys] = useState<ProviderKeyView[]>([]);
  const [terms, setTerms] = useState<TermsStatus | null>(null);
  const [hubUrl, setHubUrl] = useState("");
  const [alias, setAlias] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [issued, setIssued] = useState<IssuedProviderKey | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, termsStatus, endpoint] = await Promise.all([
        fetchProviderKeys(),
        fetchTerms(),
        fetchProviderEndpoint(),
      ]);
      setKeys(list);
      setTerms(termsStatus);
      setAgreed(termsStatus.accepted);
      setHubUrl(endpoint.hubUrl);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async () => {
    setBusy(true);
    try {
      // 和配对码同一道闸：没有当前条款版本的同意记录，服务端不签发（P-16）。
      if (!terms?.accepted) await acceptTerms();
      const key = await issueProviderKey({ alias: alias.trim() || undefined });
      setSecretCopied(false);
      setIssued(key);
      setAlias("");
      await load();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = (key: ProviderKeyView) => {
    void modal.confirm({
      title: t("account.keyRevoke"),
      content: t("account.keyRevokeConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await revokeProviderKey(key.keyId);
          message.success(t("account.keyRevoked"));
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        }
      },
    });
  };

  // 关弹窗之前拦一下：密钥只在这里出现一次，没复制就关掉，唯一的出路是重新签发。
  // 复制密钥本身、或复制任何一条带着密钥的命令，都算已经保存。
  const closeIssued = () => {
    if (secretCopied) {
      setIssued(null);
      return;
    }
    void modal.confirm({
      title: t("account.keyCloseTitle"),
      content: t("account.keyCloseConfirm"),
      okText: t("account.keyCloseOk"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: () => setIssued(null),
    });
  };

  // 平台地址由服务端给，前端不自己拼（见 ProviderEndpoint 的注释）。
  const hub = hubUrl || "https://hub.example.com";

  return (
    <Card className="gx-rise gx-rise--2">
      <CardHead title={t("account.keys")} hint={t("account.keysHint")} />
      {loading ? (
        <Loading />
      ) : (
        <div style={{ padding: "0 22px 18px" }}>
          {keys.length === 0 ? (
            <div style={{ padding: "14px 0", borderTop: "1px solid var(--gx-line)", fontSize: 13.5, color: "var(--gx-faint)" }}>
              {t("account.keysNone")}
            </div>
          ) : (
            keys.map((key) => (
              <div
                key={key.keyId}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderTop: "1px solid var(--gx-line)" }}
              >
                <IconKey size={18} style={{ color: "var(--gx-faint)" }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{key.alias || key.keyId}</span>
                  {/*
                    ID 前面必须带标注：它和密钥本身只差一个字符（gpk_ 对 gpk-），
                    不标出来，人会照着界面把它当成密钥复制走 —— 这件事真的发生过。
                  */}
                  <span style={{ display: "block", fontSize: 11, color: "var(--gx-faint)", marginTop: 2 }}>
                    {t("account.keyIdLabel")} <span className="gx-mono">{key.keyId}</span> ·{" "}
                    {key.lastUsedAt
                      ? t("account.keyLastUsed", { time: formatRelative(key.lastUsedAt), node: key.lastNodeId || "-" })
                      : t("account.keyNeverUsed")}
                  </span>
                </span>
                <Pill tone={key.status === "active" ? "ok" : "default"}>
                  {key.status === "active" ? t("account.keyActive") : t("account.keyRevoked")}
                </Pill>
                {key.status === "active" ? (
                  <Btn tone="danger" small onClick={() => revoke(key)}>
                    {t("account.keyRevoke")}
                  </Btn>
                ) : null}
              </div>
            ))
          )}
          {keys.length > 0 ? (
            <div className="gx-card__hint" style={{ padding: "0 0 12px 30px" }}>
              {t("account.keyIdHint")}
            </div>
          ) : null}

          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, paddingTop: 14, borderTop: "1px solid var(--gx-line)" }}>
            <div style={{ flex: 1 }}>
              <Field label={t("account.keyAlias")}>
                <input
                  className="gx-input"
                  value={alias}
                  maxLength={64}
                  placeholder={t("account.keyAliasPlaceholder")}
                  onChange={(event) => setAlias(event.target.value)}
                />
              </Field>
            </div>
            <Btn tone="accent" icon={<IconPlus size={15} />} loading={busy} disabled={!agreed} onClick={() => void issue()}>
              {t("account.keyIssue")}
            </Btn>
          </div>
          {!terms?.accepted ? (
            <label
              style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "var(--gx-soft)", cursor: "pointer", marginTop: 10 }}
            >
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
                style={{ marginTop: 2, accentColor: "var(--gx-accent)" }}
              />
              <span>{t("pair.terms", { version: terms?.version ?? "" })}</span>
            </label>
          ) : null}

          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="gx-label">{t("account.cliTitle")}</span>
            <CommandBlock title={t("account.cliPoll")} command={pollCommand(hub, "gpk-…")} />
            <CommandBlock title={t("account.cliExport")} command={exportCommand(hub, "gpk-…")} />
            <Note>{t("account.cliHint")}</Note>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(issued)}
        title={t("account.keyIssued")}
        footer={null}
        width={640}
        maskClosable={false}
        onCancel={closeIssued}
      >
        {issued ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Note tone="warn">{t("account.keyOnce")}</Note>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <code
                className="gx-mono"
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--gx-line)",
                  background: "var(--gx-muted)",
                  fontSize: 13,
                  overflowWrap: "anywhere",
                }}
              >
                {issued.secret}
              </code>
              <CopyBtn
                value={issued.secret}
                label={secretCopied ? t("account.keyCopied") : t("account.keyCopy")}
                copied={secretCopied}
                onCopied={() => setSecretCopied(true)}
              />
            </div>
            <CommandBlock
              title={t("account.cliPoll")}
              command={pollCommand(hub, issued.secret)}
              onCopied={() => setSecretCopied(true)}
            />
            <CommandBlock
              title={t("account.cliExport")}
              command={exportCommand(hub, issued.secret)}
              onCopied={() => setSecretCopied(true)}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn tone="accent" onClick={() => setIssued(null)}>
                {t("account.keySaved")}
              </Btn>
            </div>
          </div>
        ) : null}
      </Modal>
      {/* 放在上面那个弹窗外面：关弹窗的确认一点「确定」就把 issued 清空，放里面会跟着内容一起被卸载。 */}
      {modalHolder}
    </Card>
  );
}

function pollCommand(hub: string, key: string) {
  return `ai-bridge register --hub ${hub} --key ${key}\nai-bridge run`;
}

function exportCommand(hub: string, key: string) {
  return `ai-bridge register --hub ${hub} --key ${key} \\\n  --mode export --public-url https://<public-host>:8788\nai-bridge run`;
}

function CommandBlock({ title, command, onCopied }: { title: string; command: string; onCopied?: () => void }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 12.5, color: "var(--gx-soft)" }}>{title}</span>
        <CopyBtn
          value={command}
          label={copied ? t("account.keyCopied") : t("account.cliCopy")}
          copied={copied}
          onCopied={() => {
            setCopied(true);
            onCopied?.();
          }}
        />
      </div>
      <pre
        className="gx-mono"
        style={{
          margin: 0,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--gx-line)",
          background: "var(--gx-muted)",
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {command}
      </pre>
    </div>
  );
}
