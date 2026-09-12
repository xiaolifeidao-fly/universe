"use client";

/**
 * 密钥。额度跟着密钥走，所以这一页是「卡片」而不是「表格」——
 * 一把密钥是一个有余额、有有效期、有范围的实体，表格那种一行一条的排版
 * 会把这三件事压成三个并列的列，读起来像日志而不像资产。
 *
 * 默认只摆有效的密钥：过期、冻结、吊销的那些大多只剩「换发」或「看一眼」这两件事，
 * 和能用的混在一起，找能用的那把要先跳过一堆灰卡片。
 *
 * 明文平台取得回（加密存着）。列表里仍然只有掩码 —— 要明文的三件事（桌面端「使用」、
 * 复制密钥、复制带密钥的命令）各自在点下去的那一刻取一次，拿到就用、用完就丢。
 */

import { Dropdown, Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconCopy, IconKey, IconMonitor, IconPlus, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, CopyBtn, EmptyState, IconBtn, Loading, Note, Pill, Seg, Tabs } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText, formatCompact, formatDay, formatInt, unitLabel } from "@/utils/format";
import {
  acceptNotice,
  fetchConsumerEndpoint,
  fetchKeys,
  fetchNotice,
  renewKey,
  revealKey,
  revokeKey,
  type ConsumerKeyView,
  type IssuedKeyView,
  type NoticeStatus,
} from "../../api/consumer.api";
import {
  canApplyLocally,
  clientConfigApi,
  fetchClientStatus,
  TOOL_LABELS,
  type ClientConfigStatus,
  type ClientTool,
} from "../../api/clientconfig.api";
import { IssuedKeyModal } from "./IssuedKeyModal";
import { apiBase, buildSnippet, defaultSnippetTab, hostRoot, SECRET_PLACEHOLDER, type SnippetTab } from "./snippets";

const KEY_FREEZE_DAYS = 30;

type KeyTab = "valid" | "invalid";

/** 服务端的巡检把到期的密钥改成 expired 有延迟，这里按到期时间再判一次，免得一把刚过期的还挂在「有效」里。 */
function isUsable(key: ConsumerKeyView, now: number): boolean {
  if (key.status !== "active") return false;
  const expires = Date.parse(key.expiresAt);
  return Number.isNaN(expires) || expires > now;
}

/** 这把密钥接哪个客户端。视频类不对口任何命令行客户端；范围不限的两个都能接。 */
function toolsFor(key: ConsumerKeyView): ClientTool[] {
  if (key.category === "claude") return ["claude"];
  if (key.category === "codex") return ["codex"];
  if (key.category === "other") return ["claude", "codex"];
  return [];
}

export function ConsumerKeys() {
  const { t } = useLocale();
  const router = useRouter();
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题，按钮会是 antd 默认的蓝色，所以用 hook 版。
  const [modal, modalHolder] = Modal.useModal();
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);
  const [tab, setTab] = useState<KeyTab>("valid");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // SDK 要填的 base_url **由服务端给** —— 消费者路由挂在 galaxy-api 的 /v1 上，
  // 那个地址前端猜不出来（控制台和 API 可能不同域、不同端口）。
  const [baseUrl, setBaseUrl] = useState("");
  // 「使用」只有桌面壳里有。判断依赖 window，挂载之后再定，否则首屏 HTML 和水合结果对不上。
  const [desktop, setDesktop] = useState(false);
  const [clientStatus, setClientStatus] = useState<ClientConfigStatus | null>(null);
  const [applying, setApplying] = useState("");

  const refreshClientStatus = useCallback(async () => {
    setClientStatus(await fetchClientStatus());
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, noticeResult] = await Promise.all([fetchKeys(), fetchNotice()]);
      setKeys(list);
      setNotice(noticeResult);
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
    void refreshClientStatus();
  }, [refreshClientStatus, t]);

  useEffect(() => {
    setDesktop(canApplyLocally());
    void load();
    // 取不到就不显示这一块，好过显示一个猜来的、打过去 404 的地址。
    void fetchConsumerEndpoint()
      .then((row) => setBaseUrl(row.baseUrl))
      .catch(() => setBaseUrl(""));
  }, [load]);

  const { valid, invalid } = useMemo(() => {
    const now = Date.now();
    return {
      valid: keys.filter((key) => isUsable(key, now)),
      invalid: keys.filter((key) => !isUsable(key, now)),
    };
  }, [keys]);
  const shown = tab === "valid" ? valid : invalid;

  // 切页签、刷新之后选中的那把可能已经不在这一栏里了，退回这一栏的第一把。
  useEffect(() => {
    setSelected((current) => (shown.some((key) => key.keyId === current) ? current : (shown[0]?.keyId ?? "")));
  }, [shown]);

  const current = useMemo(() => shown.find((key) => key.keyId === selected) ?? null, [shown, selected]);

  /** 这把密钥此刻接在本机哪几个客户端上。只认 Orbit 自己写进去、而且文件里现在还是它的。 */
  const inUse = useCallback(
    (key: ConsumerKeyView): ClientTool[] =>
      clientStatus ? (["claude", "codex"] as const).filter((tool) => clientStatus[tool].keyId === key.keyId) : [],
    [clientStatus],
  );

  const applyKey = async (key: ConsumerKeyView, tool: ClientTool) => {
    setApplying(key.keyId);
    try {
      const secret = await revealKey(key.keyId);
      if (!secret.baseUrl) throw new Error(t("keys.use.noBaseUrl"));
      // 写哪个文件、写什么由主进程在系统确认框里摆给用户看，页面只递过去这三样。
      const result = await clientConfigApi.applyKey({ tool, baseUrl: secret.baseUrl, secret: secret.secret, keyId: key.keyId });
      if (result.applied) message.success(t("keys.use.applied", { tool: TOOL_LABELS[tool] }));
      await refreshClientStatus();
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    } finally {
      setApplying("");
    }
  };

  const copySecret = async (key: ConsumerKeyView) => {
    try {
      const secret = await revealKey(key.keyId);
      if (await copyText(secret.secret)) message.success(t("keys.secretCopied"));
      else message.error(t("keys.copyFailed"));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  const reissue = (key: ConsumerKeyView) => {
    void modal.confirm({
      title: t("keys.reissue"),
      content: t("keys.reissueConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setBusy(true);
        try {
          setIssued(await renewKey(key.keyId));
          message.success(t("keys.reissued"));
          setTab("valid");
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const revoke = (key: ConsumerKeyView) => {
    void modal.confirm({
      title: t("keys.revoke"),
      content: t("keys.revokeConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await revokeKey(key.keyId);
          message.success(t("keys.revoked"));
          await load();
        } catch (error) {
          message.error((error as Error).message || t("common.actionFailed"));
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const header = (
    <PageHeader
      title={t("keys.title")}
      meta={t("keys.subtitle")}
      actions={
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "valid" as const, label: t("keys.tab.valid", { count: valid.length }) },
              { value: "invalid" as const, label: t("keys.tab.invalid", { count: invalid.length }) },
            ]}
          />
          <IconBtn label={t("common.refresh")} onClick={() => void load()}>
            <IconRefresh size={17} />
          </IconBtn>
          <Btn tone="accent" icon={<IconPlus size={16} />} onClick={() => router.push("/consumer/models")}>
            {t("keys.new")}
          </Btn>
        </>
      }
    />
  );

  if (loading) {
    return (
      <>
        {header}
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  const renderUseButton = (key: ConsumerKeyView, small = true) => (
    <UseButton
      keyView={key}
      desktop={desktop}
      applying={applying === key.keyId}
      disabled={Boolean(applying)}
      small={small}
      onApply={(tool) => void applyKey(key, tool)}
    />
  );

  return (
    <>
      {header}
      {modalHolder}
      <div className="gx-body">
        {/* 数据告知是签发密钥的硬前置：没确认过就买不了，也发不出密钥（C-13）。 */}
        {notice && !notice.accepted ? (
          <Card className="gx-rise" style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
            <IconAlert size={18} style={{ color: "var(--gx-warn)", flex: "0 0 auto" }} />
            <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-soft)" }}>{t("notice.body")}</span>
            <Btn
              tone="accent"
              small
              onClick={async () => {
                try {
                  await acceptNotice();
                  void load();
                } catch (error) {
                  message.error((error as Error).message || t("common.actionFailed"));
                }
              }}
            >
              {t("notice.accept")}
            </Btn>
          </Card>
        ) : null}

        {desktop && clientStatus ? <LocalClients status={clientStatus} keys={keys} /> : null}

        {shown.length === 0 ? (
          <Card className="gx-rise">
            {tab === "valid" ? (
              <EmptyState
                title={t("keys.emptyTitle")}
                hint={t("keys.emptyHint")}
                action={
                  <Btn tone="accent" onClick={() => router.push("/consumer/models")}>
                    {t("keys.new")}
                  </Btn>
                }
              />
            ) : (
              <EmptyState title={t("keys.invalidEmpty")} />
            )}
          </Card>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {shown.map((key) => (
              <KeyCard
                key={key.keyId}
                item={key}
                active={key.keyId === selected}
                inUse={inUse(key)}
                onSelect={() => setSelected(key.keyId)}
                action={tab === "valid" ? renderUseButton(key) : null}
              />
            ))}
          </div>
        )}

        {current ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Card className="gx-rise gx-rise--1">
              <CardHead
                title={current.alias || current.keyId}
                hint={`${current.keyId} · ${t("keys.created", { value: formatDay(current.issuedAt) })}`}
                action={
                  <span style={{ display: "flex", gap: 8 }}>
                    {current.revealable && current.status !== "revoked" ? (
                      <Btn tone="ghost" small icon={<IconCopy size={14} />} onClick={() => void copySecret(current)}>
                        {t("keys.copySecret")}
                      </Btn>
                    ) : null}
                    {current.status !== "revoked" ? (
                      <Btn tone="ghost" small disabled={busy} title={t("keys.reissueHint")} onClick={() => reissue(current)}>
                        {t("keys.reissue")}
                      </Btn>
                    ) : null}
                    {tab === "valid" ? (
                      <Btn tone="accent" small onClick={() => router.push(`/consumer/store?key=${encodeURIComponent(current.keyId)}`)}>
                        {t("keys.topup")}
                      </Btn>
                    ) : null}
                  </span>
                }
              />
              <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
                {!current.revealable && current.status !== "revoked" ? <Note>{t("keys.notRevealable")}</Note> : null}

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{t("keys.quota")}</span>
                    <span className="gx-card__hint">{t("keys.quotaHint")}</span>
                  </div>
                  {Object.entries(current.balance ?? {}).filter(([, value]) => value !== 0).length === 0 ? (
                    <span className="gx-card__hint">{t("common.empty")}</span>
                  ) : (
                    Object.entries(current.balance ?? {})
                      .filter(([, value]) => value !== 0)
                      .map(([unit, value]) => (
                        <div key={unit} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 12.5 }}>
                          <span className="gx-soft">{unitLabel(unit, t)}</span>
                          <span className="gx-mono" style={{ fontWeight: 500 }}>{formatInt(value)}</span>
                        </div>
                      ))
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t("keys.scope")}</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {[...(current.allowedKinds ?? []), ...(current.modelTier ?? [])].length === 0 ? (
                      <span className="gx-card__hint">{t("keys.scopeAll")}</span>
                    ) : (
                      [...(current.allowedKinds ?? []), ...(current.modelTier ?? [])].map((item) => (
                        <span className="gx-chip gx-chip--on" key={item}>
                          {item}
                        </span>
                      ))
                    )}
                  </div>
                  <span className="gx-card__hint">
                    {t("keys.concurrency")} · {current.concurrency} / {current.rpm}
                  </span>
                </div>

                <Note>{t("keys.freezeHint", { days: KEY_FREEZE_DAYS })}</Note>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{tab === "valid" ? renderUseButton(current, false) : null}</span>
                  {current.status !== "revoked" ? (
                    <Btn tone="danger" small disabled={busy} onClick={() => revoke(current)}>
                      {t("keys.revoke")}
                    </Btn>
                  ) : null}
                </div>
              </div>
            </Card>

            <ConnectCard
              key={current.keyId}
              keyView={current}
              baseUrl={baseUrl}
              desktop={desktop}
            />
          </div>
        ) : null}
        {valid.length > 0 && tab === "valid" ? <Note>{t("keys.newHint")}</Note> : null}
      </div>

      <IssuedKeyModal issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

function KeyCard({
  item,
  active,
  inUse,
  onSelect,
  action,
}: {
  item: ConsumerKeyView;
  active: boolean;
  inUse: ClientTool[];
  onSelect: () => void;
  action: React.ReactNode;
}) {
  const { t } = useLocale();
  // 头条数字只取输出 token：计费按它走，把输入也加进来会得到一个谁都用不上的
  // 大数（输入通常是输出的三五倍），让人以为额度比实际能买到的对话多得多。
  const balance = item.balance ?? {};
  const headline = balance["llm.output_tokens"] ?? Object.values(balance)[0] ?? 0;
  return (
    // 选中和「使用」是两件事：外层用 div，选中的热区是里面那个按钮 —— 按钮里再套按钮是非法的 HTML。
    <div
      style={{
        borderRadius: 14,
        border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
        background: "var(--gx-surface)",
        boxShadow: active ? "0 0 0 3px var(--gx-accent-soft)" : "none",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        style={{
          textAlign: "left",
          padding: "18px 20px",
          border: 0,
          background: "transparent",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          font: "inherit",
          color: "inherit",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <IconKey size={16} style={{ color: active ? "var(--gx-accent)" : "var(--gx-faint)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.alias || item.keyId}
          </span>
          <Pill tone={item.status === "active" ? "ok" : item.status === "revoked" ? "err" : "warn"}>
            {t(`keys.status.${item.status}`)}
          </Pill>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="gx-mono" style={{ flex: 1, fontSize: 12, color: "var(--gx-faint)", letterSpacing: "0.02em" }}>
            sk-galaxy-••••••••••••••••
          </span>
          <span className="gx-chip">{t(`keys.category.${item.category}`)}</span>
        </span>
        <span>
          <span className="gx-label" style={{ display: "block" }}>
            {t("keys.balance")}
          </span>
          <span style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
            <span className="gx-serif" style={{ fontSize: 30, lineHeight: 1 }}>
              {formatCompact(headline)}
            </span>
            <span style={{ fontSize: 12, color: "var(--gx-faint)" }}>{unitLabel("llm.output_tokens", t)}</span>
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--gx-faint)" }}>
              {t("keys.expiresAt", { value: formatDay(item.expiresAt) })}
            </span>
          </span>
        </span>
      </button>
      {action || inUse.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "10px 20px",
            borderTop: "1px solid var(--gx-line)",
          }}
        >
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {inUse.map((tool) => (
              <Pill key={tool} tone="accent">
                {t("keys.use.inUse", { tool: TOOL_LABELS[tool] })}
              </Pill>
            ))}
          </span>
          {action}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 「使用」按钮。桌面壳里才画；取不回明文的老密钥给一个灰按钮，悬停说原因 ——
 * 直接不画的话，用户会以为这把密钥和别的不一样是出了什么问题。
 */
function UseButton({
  keyView,
  desktop,
  applying,
  disabled,
  small,
  onApply,
}: {
  keyView: ConsumerKeyView;
  desktop: boolean;
  applying: boolean;
  disabled: boolean;
  small: boolean;
  onApply: (tool: ClientTool) => void;
}) {
  const { t } = useLocale();
  const tools = toolsFor(keyView);
  if (!desktop || tools.length === 0) return null;
  if (!keyView.revealable) {
    return (
      <Btn tone="soft" small={small} disabled title={t("keys.notRevealable")}>
        {t("keys.use.button")}
      </Btn>
    );
  }
  if (tools.length === 1) {
    return (
      <Btn tone="soft" small={small} loading={applying} disabled={disabled} onClick={() => onApply(tools[0])}>
        {t("keys.use.buttonFor", { tool: TOOL_LABELS[tools[0]] })}
      </Btn>
    );
  }
  return (
    <Dropdown
      trigger={["click"]}
      disabled={disabled}
      menu={{
        items: tools.map((tool) => ({ key: tool, label: t("keys.use.buttonFor", { tool: TOOL_LABELS[tool] }) })),
        onClick: ({ key }) => onApply(key as ClientTool),
      }}
    >
      {/* Dropdown 要往子元素上挂 ref 定位弹层，Btn 是函数组件接不住，外面垫一层 span。 */}
      <span>
        <Btn tone="soft" small={small} loading={applying} disabled={disabled}>
          {t("keys.use.button")}
        </Btn>
      </span>
    </Dropdown>
  );
}

/** 这台电脑上的 Claude Code / Codex 现在接的是什么。「使用」改的就是这两个文件。 */
function LocalClients({ status, keys }: { status: ClientConfigStatus; keys: ConsumerKeyView[] }) {
  const { t } = useLocale();
  const alias = new Map(keys.map((key) => [key.keyId, key.alias || key.keyId]));
  return (
    <Card className="gx-rise" style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
        <IconMonitor size={16} style={{ color: "var(--gx-faint)" }} />
        {t("keys.local.title")}
        <span className="gx-card__hint" style={{ fontWeight: 400 }}>
          {t("keys.local.hint")}
        </span>
      </span>
      {(["claude", "codex"] as const).map((tool) => {
        const row = status[tool];
        const text = row.keyId
          ? t("keys.local.usingKey", { alias: alias.get(row.keyId) ?? row.keyId })
          : row.keyTail
            ? t("keys.local.otherKey", { tail: row.keyTail })
            : t("keys.local.notConnected");
        return (
          <span key={tool} style={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr) auto", gap: 12, fontSize: 12.5, alignItems: "baseline" }}>
            <span className="gx-soft">{TOOL_LABELS[tool]}</span>
            <span className="gx-mono gx-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.file}>
              {row.file}
            </span>
            <span style={{ color: row.keyId ? "var(--gx-accent)" : "var(--gx-soft)" }}>{text}</span>
          </span>
        );
      })}
    </Card>
  );
}

/**
 * 手动接入。三段各一份，因为「改哪个文件、填哪个地址」在每个客户端里都不一样，
 * 而这一步是新用户最容易卡住的地方。屏幕上显示的是占位符，「复制（含密钥）」那一下才去取明文。
 */
function ConnectCard({ keyView, baseUrl, desktop }: { keyView: ConsumerKeyView; baseUrl: string; desktop: boolean }) {
  const { t } = useLocale();
  const [tab, setTab] = useState<SnippetTab>(defaultSnippetTab(keyView.category));
  const [copied, setCopied] = useState("");
  const shownBase = tab === "claude" ? hostRoot(baseUrl) : apiBase(baseUrl);

  const copyWithSecret = async () => {
    try {
      const secret = await revealKey(keyView.keyId);
      const ok = await copyText(buildSnippet(tab, secret.baseUrl || baseUrl, secret.secret, keyView.category, keyView.modelId));
      if (ok) message.success(t("keys.snippetCopied"));
      else message.error(t("keys.copyFailed"));
    } catch (error) {
      message.error((error as Error).message || t("common.actionFailed"));
    }
  };

  return (
    <Card className="gx-rise gx-rise--2">
      <CardHead
        title={t("keys.connect")}
        action={
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { value: "claude" as const, label: "Claude Code" },
              { value: "codex" as const, label: "Codex" },
              { value: "curl" as const, label: "cURL" },
            ]}
          />
        }
      />
      <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {baseUrl ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="gx-label" style={{ flex: "0 0 auto" }}>
              {t("keys.baseUrl")}
            </span>
            <code className="gx-mono" style={{ flex: 1, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}>
              {shownBase}
            </code>
            <CopyBtn value={shownBase} label={t("common.copy")} copied={copied === "base"} onCopied={() => setCopied("base")} />
          </div>
        ) : null}
        <pre className="gx-code" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {buildSnippet(tab, baseUrl, SECRET_PLACEHOLDER, keyView.category, keyView.modelId)}
        </pre>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <CopyBtn
            value={buildSnippet(tab, baseUrl, SECRET_PLACEHOLDER, keyView.category, keyView.modelId)}
            label={t("keys.copySnippet")}
            copied={copied === tab}
            onCopied={() => setCopied(tab)}
          />
          {keyView.revealable && keyView.status !== "revoked" ? (
            <Btn tone="ghost" small icon={<IconCopy size={14} />} onClick={() => void copyWithSecret()}>
              {t("keys.copySnippetWithSecret")}
            </Btn>
          ) : null}
        </div>
        <span className="gx-card__hint">
          {tab === "claude" ? t("keys.connectHint.claude") : tab === "codex" ? t("keys.connectHint.codex") : t("keys.connectHint")}
          {desktop && tab !== "curl" ? ` ${t("keys.connectHint.desktop")}` : ""}
        </span>
      </div>
    </Card>
  );
}
