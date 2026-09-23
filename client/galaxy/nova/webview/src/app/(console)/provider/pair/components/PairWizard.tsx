"use client";

/**
 * 第一次把这台机器接进共享池。
 *
 * 三步是**检查**不是**输入**：前两步只报告本机的事实（bridge 在不在、
 * 能共享什么），第三步才要人做决定。画成三个可勾选的表单会让人以为
 * 「勾上就有了」——那两件事只有那台机器说了算。
 */

import { message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconAlert, IconCheck, IconKey, IconShield } from "@/components/ui/icons";
import { Btn, Card, Field, Loading, Note, Pill } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { isDesktop } from "@/utils/product";
import { fetchBridgeState, pairWithBridge, type BridgeState } from "../../api/bridge.api";
import {
  acceptTerms,
  fetchProviderEndpoint,
  fetchTerms,
  issuePairingCode,
  type PairingCode,
  type TermsStatus,
} from "../../api/provider.api";

export function PairWizard() {
  const { t } = useLocale();
  const router = useRouter();
  const [state, setState] = useState<BridgeState | null>(null);
  const [terms, setTerms] = useState<TermsStatus | null>(null);
  const [hubUrl, setHubUrl] = useState("");
  const [code, setCode] = useState<PairingCode | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [termsStatus, endpoint] = await Promise.all([fetchTerms(), fetchProviderEndpoint()]);
      setTerms(termsStatus);
      setAgreed(termsStatus.accepted);
      setHubUrl(endpoint.hubUrl);
    } catch (loadError) {
      message.error((loadError as Error).message || t("common.loadFailed"));
    }
    if (isDesktop()) {
      try {
        const bridge = await fetchBridgeState();
        setState(bridge);
        setDisplayName((current) => current || bridge.displayName);
        setError("");
      } catch (bridgeError) {
        setError((bridgeError as Error).message);
      }
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = async () => {
    setBusy(true);
    try {
      // 条款同意是配对码的硬前置（P-16）：没有这条记录服务端不签发。
      if (!terms?.accepted) await acceptTerms();
      setCode(await issuePairingCode());
      await load();
    } catch (issueError) {
      message.error((issueError as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const pair = async () => {
    if (!code) return;
    setBusy(true);
    try {
      const result = await pairWithBridge({ hubURL: hubUrl, code: code.code, displayName: displayName.trim() });
      message.success(t("pair.done", { name: result.nodeId }));
      router.push("/provider/share");
    } catch (pairError) {
      message.error((pairError as Error).message || t("common.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <>
        <PageHeader title={t("pair.title")} />
        <div className="gx-body">
          <Loading />
        </div>
      </>
    );
  }

  const capabilities = state?.capabilities ?? [];
  const available = capabilities.filter((item) => item.available);
  const step = !isDesktop() || !state ? 1 : available.length === 0 ? 2 : 3;

  return (
    <>
      <PageHeader title={t("pair.title")} meta={t("pair.step", { value: step })} />
      <div className="gx-body">
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 14, alignItems: "start" }}>
          <Card className="gx-rise" style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <h2 className="gx-serif" style={{ margin: 0, fontSize: 26, fontWeight: 400 }}>
                {t("pair.heroTitle")}
              </h2>
              <p style={{ margin: "10px 0 0", fontSize: 13, lineHeight: 1.7, color: "var(--gx-soft)" }}>{t("pair.heroDesc")}</p>
            </div>

            <Step
              index={1}
              done={Boolean(state)}
              title={t("pair.step1")}
              body={state ? t("pair.step1Ok", { path: state.configPath }) : error || t("pair.step1Fail")}
            />
            <Step
              index={2}
              done={available.length > 0}
              title={t("pair.step2")}
              body={
                available.length > 0
                  ? `${available.map((item) => `${item.provider}`).join("、")} · ${t("pair.step2Hint")}`
                  : t("pair.step2Empty")
              }
              extra={
                capabilities.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    {capabilities.map((item) => (
                      <Pill key={`${item.kind}:${item.provider}`} tone={item.available ? "ok" : "warn"}>
                        {item.provider}
                        <span style={{ opacity: 0.7 }}>{item.available ? t("pair.available") : t("pair.unavailable")}</span>
                      </Pill>
                    ))}
                  </div>
                ) : null
              }
            />
            <Step index={3} done={false} title={t("pair.step3")} body={t("pair.step3Desc")} />

            <Note icon={<IconShield size={15} />}>{t("pair.privacy")}</Note>
            <Note icon={<IconKey size={15} />}>{t("pair.cliHint")}</Note>
          </Card>

          <Card className="gx-rise gx-rise--1" style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 18 }}>
            {!isDesktop() ? (
              <Note tone="warn" icon={<IconAlert size={15} />}>
                {t("pair.desktopOnly")}
              </Note>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span className="gx-label">{t("pair.code")}</span>
                <span className="gx-card__hint">{t("pair.codeHint")}</span>
              </div>
              {code ? (
                <div style={{ display: "flex", gap: 8 }}>
                  {code.code.split("").map((character, index) => (
                    <span
                      key={`${character}-${index}`}
                      className="gx-mono"
                      style={{
                        flex: 1,
                        height: 46,
                        display: "grid",
                        placeItems: "center",
                        borderRadius: 10,
                        border: "1px solid var(--gx-line)",
                        background: "var(--gx-muted)",
                        fontSize: 19,
                        fontWeight: 500,
                      }}
                    >
                      {character}
                    </span>
                  ))}
                </div>
              ) : (
                <Btn tone="ghost" loading={busy} disabled={!agreed} onClick={() => void issue()}>
                  {t("pair.codeIssue")}
                </Btn>
              )}
            </div>

            <Field label={t("pair.deviceName")}>
              <input
                className="gx-input"
                value={displayName}
                placeholder="fly-mbp"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>

            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, color: "var(--gx-soft)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={agreed}
                disabled={terms?.accepted}
                onChange={(event) => setAgreed(event.target.checked)}
                style={{ marginTop: 2, accentColor: "var(--gx-accent)" }}
              />
              <span>{t("pair.terms", { version: terms?.version ?? "" })}</span>
            </label>

            <Btn tone="accent" loading={busy} disabled={!isDesktop() || !code || !agreed} onClick={() => void pair()}>
              {t("pair.submit")}
            </Btn>
            <span className="gx-card__hint" style={{ textAlign: "center" }}>
              {t("pair.foot")}
            </span>
          </Card>
        </div>
      </div>
    </>
  );
}

function Step({
  index,
  done,
  title,
  body,
  extra,
}: {
  index: number;
  done: boolean;
  title: string;
  body: string;
  extra?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 14 }}>
      <span
        style={{
          width: 26,
          height: 26,
          flex: "0 0 auto",
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: done ? "var(--gx-accent)" : "var(--gx-muted)",
          color: done ? "#fff" : "var(--gx-faint)",
          fontFamily: "var(--gx-mono)",
          fontSize: 12,
        }}
      >
        {done ? <IconCheck size={14} /> : index}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--gx-faint)", marginTop: 3 }}>{body}</div>
        {extra}
      </div>
    </div>
  );
}
