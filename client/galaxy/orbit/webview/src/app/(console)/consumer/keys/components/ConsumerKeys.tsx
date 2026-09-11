"use client";

/**
 * 密钥。额度跟着密钥走，所以这一页是「卡片」而不是「表格」——
 * 一把密钥是一个有余额、有有效期、有范围的实体，表格那种一行一条的排版
 * 会把这三件事压成三个并列的列，读起来像日志而不像资产。
 *
 * 明文只在签发/换发那一次出现。这一页任何时候都拿不到它，卡片上显示的
 * 是掩码 —— 不是「隐藏了真值」，是服务端只存 sha256，真值谁也查不回来。
 */

import { Modal, message } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconKey, IconPlus, IconRefresh } from "@/components/ui/icons";
import { Btn, Card, CardHead, CopyBtn, EmptyState, IconBtn, Loading, Note, Pill, Seg } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatCompact, formatDay, formatInt, unitLabel } from "@/utils/format";
import {
  acceptNotice,
  fetchConsumerEndpoint,
  fetchKeys,
  fetchNotice,
  renewKey,
  revokeKey,
  type ConsumerKeyView,
  type IssuedKeyView,
  type NoticeStatus,
} from "../../api/consumer.api";
import { SecretOnceModal } from "./SecretOnceModal";

const KEY_FREEZE_DAYS = 30;

export function ConsumerKeys() {
  const { t } = useLocale();
  const router = useRouter();
  const [keys, setKeys] = useState<ConsumerKeyView[]>([]);
  const [notice, setNotice] = useState<NoticeStatus | null>(null);
  const [issued, setIssued] = useState<IssuedKeyView | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // SDK 要填的 base_url **由服务端给** —— 消费者路由挂在 galaxy-api 的 /v1 上，
  // 那个地址前端猜不出来（控制台和 API 可能不同域、不同端口）。
  const [baseUrl, setBaseUrl] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, noticeResult] = await Promise.all([fetchKeys(), fetchNotice()]);
      setKeys(list);
      setNotice(noticeResult);
      setSelected((current) => (list.some((key) => key.keyId === current) ? current : (list[0]?.keyId ?? "")));
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    // 取不到就不显示这一块，好过显示一个猜来的、打过去 404 的地址。
    void fetchConsumerEndpoint()
      .then((row) => setBaseUrl(row.baseUrl))
      .catch(() => setBaseUrl(""));
  }, [load]);

  const current = useMemo(() => keys.find((key) => key.keyId === selected) ?? null, [keys, selected]);

  const reissue = (key: ConsumerKeyView) => {
    Modal.confirm({
      title: t("keys.reissue"),
      content: t("keys.reissueConfirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setBusy(true);
        try {
          // 换发返回的新明文只在这一次响应里出现，所以立刻弹出来让用户存走。
          setIssued(await renewKey(key.keyId));
          message.success(t("keys.reissued"));
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
    Modal.confirm({
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

  if (loading) {
    return (
      <>
        <PageHeader title={t("keys.title")} meta={t("keys.subtitle")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("keys.title")}
        meta={t("keys.subtitle")}
        actions={
          <>
            <IconBtn label={t("common.refresh")} onClick={() => void load()}>
              <IconRefresh size={17} />
            </IconBtn>
            <Btn tone="accent" icon={<IconPlus size={16} />} onClick={() => router.push("/consumer/store")}>
              {t("keys.new")}
            </Btn>
          </>
        }
      />
      <div className="gx-body">
        {/* 数据告知是签发密钥的硬前置：没确认过就买不了额度，也发不出密钥（C-13）。 */}
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

        {keys.length === 0 ? (
          <Card className="gx-rise">
            <EmptyState
              title={t("keys.emptyTitle")}
              hint={t("keys.emptyHint")}
              action={
                <Btn tone="accent" onClick={() => router.push("/consumer/store")}>
                  {t("keys.new")}
                </Btn>
              }
            />
          </Card>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
            {keys.map((key) => (
              <KeyCard
                key={key.keyId}
                item={key}
                active={key.keyId === selected}
                onSelect={() => setSelected(key.keyId)}
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
                    <Btn tone="ghost" small disabled={busy} title={t("keys.reissueHint")} onClick={() => reissue(current)}>
                      {t("keys.reissue")}
                    </Btn>
                    <Btn tone="accent" small onClick={() => router.push(`/consumer/store?key=${encodeURIComponent(current.keyId)}`)}>
                      {t("keys.topup")}
                    </Btn>
                  </span>
                }
              />
              <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
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

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {current.status !== "revoked" ? (
                    <Btn tone="danger" small disabled={busy} onClick={() => revoke(current)}>
                      {t("keys.revoke")}
                    </Btn>
                  ) : null}
                </div>
              </div>
            </Card>

            <ConnectCard baseUrl={baseUrl} copied={copied} onCopied={setCopied} />
          </div>
        ) : null}
        {keys.length > 0 ? <Note>{t("keys.newHint")}</Note> : null}
      </div>

      <SecretOnceModal issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

function KeyCard({ item, active, onSelect }: { item: ConsumerKeyView; active: boolean; onSelect: () => void }) {
  const { t } = useLocale();
  // 头条数字只取输出 token：计费按它走，把输入也加进来会得到一个谁都用不上的
  // 大数（输入通常是输出的三五倍），让人以为额度比实际能买到的对话多得多。
  const balance = item.balance ?? {};
  const headline = balance["llm.output_tokens"] ?? Object.values(balance)[0] ?? 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: "left",
        padding: "18px 20px",
        borderRadius: 14,
        border: `1px solid ${active ? "var(--gx-accent)" : "var(--gx-line)"}`,
        background: "var(--gx-surface)",
        boxShadow: active ? "0 0 0 3px var(--gx-accent-soft)" : "none",
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
      <span className="gx-mono" style={{ fontSize: 12, color: "var(--gx-faint)", letterSpacing: "0.02em" }}>
        sk-galaxy-••••••••••••••••••••
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
  );
}

/**
 * 接入方式。三种语言各一段，因为「改哪个变量」在每种语言里都不一样，
 * 而这一步是新用户最容易卡住的地方。
 */
function ConnectCard({ baseUrl, copied, onCopied }: { baseUrl: string; copied: string; onCopied: (key: string) => void }) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"cli" | "python" | "curl">("cli");
  const base = baseUrl || "https://<galaxy>/v1";
  const snippets: Record<typeof tab, string> = {
    cli: `# ~/.zshrc\nexport ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=sk-galaxy-…\n\n# 然后照常用\nclaude`,
    python: `from anthropic import Anthropic\n\nclient = Anthropic(\n    base_url="${base}",\n    api_key="sk-galaxy-…",\n)`,
    curl: `curl ${base}/messages \\\n  -H "authorization: Bearer sk-galaxy-…" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[…]}'`,
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
              { value: "cli" as const, label: "Claude Code" },
              { value: "python" as const, label: "Python" },
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
              {baseUrl}
            </code>
            <CopyBtn value={baseUrl} label={t("common.copy")} copied={copied === "base"} onCopied={() => onCopied("base")} />
          </div>
        ) : null}
        <pre className="gx-code" style={{ margin: 0 }}>
          {snippets[tab]}
        </pre>
        <span className="gx-card__hint">{t("keys.connectHint")}</span>
      </div>
    </Card>
  );
}
