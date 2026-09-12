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
 *
 * 列表分「有效」「已吊销」两栏：吊销是终态，混在一起时，有效的那几把得在一排作废的里面找。
 * 签发收进弹窗；部署命令默认收起 —— 真正拿去用的那份在签发弹窗里，带着刚签出来的密钥，
 * 页面上这份只是占位符版本的说明，摊开就是两大块没人复制的代码。
 */

import { Modal, message } from "antd";
import { useState } from "react";
import { IconChevronDown, IconKey, IconPlus } from "@/components/ui/icons";
import { Btn, Card, CardHead, CopyBtn, Field, Note } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatRelative } from "@/utils/format";
import {
  acceptTerms,
  issueProviderKey,
  revokeProviderKey,
  type IssuedProviderKey,
  type ProviderKeyView,
  type TermsStatus,
} from "../../api/provider.api";
import { unixInstallCommand } from "./BridgeInstallPanel";
import { Blank, CommandBlock, RowList, TabStrip } from "./parts";

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

export function AccessKeyPanel({
  keys,
  terms,
  hubUrl,
  installScript,
  nodeNames,
  issueOpen,
  onIssueOpenChange,
  onChanged,
}: {
  keys: ProviderKeyView[];
  terms: TermsStatus | null;
  /** 平台地址由服务端给，前端不自己拼（见 ProviderEndpoint 的注释）。 */
  hubUrl: string;
  /**
   * Linux / macOS 一行安装脚本的地址。平台发布过这两种系统的安装包才有值，否则空串 ——
   * 脚本找不到包只会装到一半报错，不如不给。
   */
  installScript: string;
  /** 节点 ID → 机器名，在用的和解绑的都在。「最近注册」后面报机器名，比一串 n_… 认得出。 */
  nodeNames: Record<string, string>;
  /** 签发弹窗开没开。「其他机器」那一块的「接入服务器」也打开它，所以由页面管。 */
  issueOpen: boolean;
  onIssueOpenChange: (open: boolean) => void;
  /** 签发、吊销之后让页面重新拉密钥列表。 */
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [tab, setTab] = useState<"active" | "revoked">("active");
  const [showCli, setShowCli] = useState(false);
  const [alias, setAlias] = useState("");
  const [checked, setChecked] = useState(false);
  const [issued, setIssued] = useState<IssuedProviderKey | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // 已经同意过当前版本的条款就不再摆勾选框。
  const agreed = Boolean(terms?.accepted) || checked;
  const active = keys.filter((key) => key.status === "active");
  const revoked = keys.filter((key) => key.status !== "active");
  const rows = tab === "active" ? active : revoked;
  const hub = hubUrl || "https://hub.example.com";

  const issue = async () => {
    if (busy || !agreed) return;
    setBusy(true);
    try {
      // 和配对码同一道闸：没有当前条款版本的同意记录，服务端不签发（P-16）。
      if (!terms?.accepted) await acceptTerms();
      const key = await issueProviderKey({ alias: alias.trim() || undefined });
      setSecretCopied(false);
      // 同一个弹窗接着显示密钥：先摆出 issued 再关表单，弹窗不会闪一下。
      setIssued(key);
      onIssueOpenChange(false);
      setAlias("");
      setTab("active");
      await onChanged();
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
          await onChanged();
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

  const openIssue = () => onIssueOpenChange(true);

  return (
    <Card className="gx-rise gx-rise--2">
      <CardHead
        title={t("account.keys")}
        hint={t("account.keysHint")}
        action={
          <Btn tone="ghost" small icon={<IconPlus size={14} />} onClick={openIssue}>
            {t("account.keyIssueAction")}
          </Btn>
        }
      />
      <TabStrip
        value={tab}
        onChange={setTab}
        options={[
          { value: "active" as const, label: t("account.keyActive"), count: active.length },
          { value: "revoked" as const, label: t("account.keyRevoked"), count: revoked.length },
        ]}
      />
      <RowList>
        {rows.length === 0 ? (
          tab === "active" ? (
            <Blank title={t("account.keysActiveEmpty")} hint={t("account.keysActiveEmptyHint")} />
          ) : (
            <Blank title={t("account.keysRevokedEmpty")} />
          )
        ) : (
          rows.map((key, index) => (
            <KeyRow
              key={key.keyId}
              item={key}
              nodeName={nodeNames[key.lastNodeId] ?? ""}
              first={index === 0}
              onRevoke={tab === "active" ? () => revoke(key) : undefined}
            />
          ))
        )}
      </RowList>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 18px 16px", borderTop: "1px solid var(--gx-line)" }}>
        {/*
          ID 前面必须带标注：它和密钥本身只差一个字符（gpk_ 对 gpk-），
          不标出来，人会照着界面把它当成密钥复制走 —— 这件事真的发生过。
        */}
        {keys.length > 0 ? (
          <span className="gx-card__hint" style={{ lineHeight: 1.6 }}>
            {t("account.keyIdHint")}
          </span>
        ) : null}
        <button
          type="button"
          className="gx-link"
          aria-expanded={showCli}
          style={{ alignSelf: "flex-start" }}
          onClick={() => setShowCli((open) => !open)}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {t("account.cliTitle")}
            <IconChevronDown size={13} style={{ transition: "transform .15s ease", transform: showCli ? "rotate(180deg)" : undefined }} />
          </span>
        </button>
        {showCli ? (
          <>
            <CommandBlock title={t("account.cliPoll")} command={pollCommand(hub, "gpk-…")} />
            <CommandBlock title={t("account.cliExport")} command={exportCommand(hub, "gpk-…")} />
            <Note>{t("account.cliHint")}</Note>
          </>
        ) : null}
      </div>

      <Modal
        open={issueOpen || Boolean(issued)}
        title={issued ? t("account.keyIssued") : t("account.keyIssueTitle")}
        footer={null}
        width={issued ? 640 : 480}
        maskClosable={false}
        onCancel={issued ? closeIssued : () => onIssueOpenChange(false)}
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
            {/* 一行装好再注册排在最前：机器上多半还没装 ai-bridge，下面两条的前提是已经装好了。 */}
            {installScript ? (
              <CommandBlock
                title={t("account.cliInstall")}
                command={unixInstallCommand(installScript, issued.secret)}
                onCopied={() => setSecretCopied(true)}
              />
            ) : null}
            <CommandBlock title={t("account.cliPoll")} command={pollCommand(hub, issued.secret)} onCopied={() => setSecretCopied(true)} />
            <CommandBlock title={t("account.cliExport")} command={exportCommand(hub, issued.secret)} onCopied={() => setSecretCopied(true)} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn tone="accent" onClick={() => setIssued(null)}>
                {t("account.keySaved")}
              </Btn>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--gx-soft)" }}>{t("account.keyIssueIntro")}</span>
            <Field label={t("account.keyAlias")}>
              <input
                className="gx-input"
                value={alias}
                maxLength={64}
                placeholder={t("account.keyAliasPlaceholder")}
                onChange={(event) => setAlias(event.target.value)}
                onKeyDown={(event) => {
                  // 拼音输入法选词那一下回车是在上屏，不是在提交。
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) void issue();
                }}
              />
            </Field>
            {!terms?.accepted ? (
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "var(--gx-soft)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                  style={{ marginTop: 2, accentColor: "var(--gx-accent)" }}
                />
                <span>{t("pair.terms", { version: terms?.version ?? "" })}</span>
              </label>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn tone="ghost" onClick={() => onIssueOpenChange(false)}>
                {t("common.cancel")}
              </Btn>
              <Btn tone="accent" icon={<IconPlus size={15} />} loading={busy} disabled={!agreed} onClick={() => void issue()}>
                {t("account.keyIssue")}
              </Btn>
            </div>
          </div>
        )}
      </Modal>
      {/* 放在上面那个弹窗外面：关弹窗的确认一点「确定」就把 issued 清空，放里面会跟着内容一起被卸载。 */}
      {modalHolder}
    </Card>
  );
}

function KeyRow({
  item,
  nodeName,
  first,
  onRevoke,
}: {
  item: ProviderKeyView;
  nodeName: string;
  first: boolean;
  /** 只有有效的密钥才有。 */
  onRevoke?: () => void;
}) {
  const { t } = useLocale();
  const used = item.lastUsedAt
    ? t("account.keyLastUsed", { time: formatRelative(item.lastUsedAt), node: nodeName || item.lastNodeId || "-" })
    : t("account.keyNeverUsed");
  return (
    <div
      className="gx-row"
      style={{
        gridTemplateColumns: onRevoke ? "30px minmax(0, 1fr) auto" : "30px minmax(0, 1fr)",
        padding: "11px 18px",
        borderTop: first ? 0 : undefined,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          background: "var(--gx-muted)",
          color: "var(--gx-faint)",
        }}
      >
        <IconKey size={16} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: onRevoke ? "var(--gx-ink)" : "var(--gx-soft)", ...ellipsis }}>
          {item.alias || item.keyId}
        </span>
        <span
          // 窄窗口下这一行会被截，悬停给全文；行里用机器名替掉了节点 ID，悬停时把 ID 补回来。
          title={[item.keyId, used, nodeName ? item.lastNodeId : ""].filter(Boolean).join(" · ")}
          style={{ display: "block", marginTop: 2, fontSize: 11.5, color: "var(--gx-faint)", ...ellipsis }}
        >
          {t("account.keyIdLabel")} <span className="gx-mono">{item.keyId}</span> · {used}
        </span>
      </span>
      {/* 一列有效密钥各挂一个红按钮太吵：入口用中性色，确认框才是红的。 */}
      {onRevoke ? (
        <Btn tone="ghost" small onClick={onRevoke}>
          {t("account.keyRevoke")}
        </Btn>
      ) : null}
    </div>
  );
}

function pollCommand(hub: string, key: string) {
  return `ai-bridge register --hub ${hub} --key ${key}\nai-bridge run`;
}

function exportCommand(hub: string, key: string) {
  return `ai-bridge register --hub ${hub} --key ${key} \\\n  --mode export --public-url https://<public-host>:8788\nai-bridge run`;
}
