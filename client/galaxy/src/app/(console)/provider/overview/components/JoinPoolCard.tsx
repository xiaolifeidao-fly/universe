"use client";

import { CheckCircleFilled, CopyOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Tag, Typography, message } from "antd";
import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText, formatTime } from "@/utils/format";
import { acceptTerms, issuePairingCode, type PairingCode, type TermsStatus } from "../../api/provider.api";
import { InstallGuide } from "./InstallGuide";

const { Paragraph } = Typography;

/**
 * 加入共享池，分三步：装插件 → 同意条款 → 配对并勾选要共享的能力。
 *
 * 三步的顺序是被约束逼出来的：
 *
 * - **条款原文摆在最上面**，不折叠、不藏在链接后面。被封的是主人自己的账号，
 *   这件事必须在他动手之前就看见 —— 所以它在三步之前，而不是第二步里面。
 * - **同意是配对码的硬前置**（P-16）：服务端在签发和 pair 两处各校验一次，
 *   没同意记录时按钮就是禁用的，省得用户拿到一个必然被拒的码。
 * - **勾选共享什么发生在那台机器上，不在这里**。控制台在 hello 之前对那台机器
 *   一无所知，而探测能力要读本机的订阅登录态 —— 那件事只能在本机做。
 *   所以这一步给的是配对码，不是一个勾选框。
 */
export function JoinPoolCard({ terms, onAccepted }: { terms: TermsStatus | null; onAccepted: () => void }) {
  const { t } = useLocale();
  const [accepting, setAccepting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);

  const accept = async () => {
    setAccepting(true);
    try {
      await acceptTerms();
      onAccepted();
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setAccepting(false);
    }
  };

  const pair = async () => {
    setPairing(true);
    try {
      setCode(await issuePairingCode());
    } catch (error) {
      message.error((error as Error).message || t("common.loadFailed"));
    } finally {
      setPairing(false);
    }
  };

  const copy = async (value: string) => {
    const ok = await copyText(value);
    if (ok) message.success(t("common.copied"));
    else message.warning(t("common.copyFailed"));
  };

  return (
    <section className="galaxy-card">
      <div className="galaxy-card__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{t("provider.join.title")}</h2>
          <p>{t("provider.join.terms")}</p>
        </div>
        {terms?.accepted ? (
          <Tag icon={<CheckCircleFilled />} color="success">
            {t("provider.join.accepted").replace("{version}", terms.version)}
          </Tag>
        ) : null}
      </div>

      {/* 条款原文摆在所有步骤上面，而不是折叠在一个链接后面：被封的是主人自己的账号，
          这件事必须在点「同意」之前就看见。 */}
      <Alert type="warning" showIcon message={t("provider.join.termsBody")} style={{ marginBottom: 18 }} />

      <Step index={1} title={t("provider.install.title")} hint={t("provider.install.hint")}>
        <InstallGuide />
      </Step>

      <Step index={2} title={t("provider.join.accept")} hint={t("provider.join.acceptHint")}>
        <Space wrap>
          <Button type="primary" loading={accepting} disabled={terms?.accepted} onClick={() => void accept()}>
            {terms?.accepted ? t("provider.join.acceptDone") : t("provider.join.accept")}
          </Button>
        </Space>
      </Step>

      <Step index={3} title={t("provider.join.pair")} hint={t("provider.join.pairHint")} last>
        <Space wrap>
          <Button type="primary" loading={pairing} disabled={!terms?.accepted} onClick={() => void pair()}>
            {t("provider.join.pairAction")}
          </Button>
          {!terms?.accepted ? (
            <span style={{ color: "var(--manager-text-muted)" }}>{t("provider.join.acceptFirst")}</span>
          ) : null}
        </Space>

        {code ? (
          <div style={{ marginTop: 14 }}>
            {/* 配对码是粘进本机那个配置向导页面的，不是敲在命令行上的 ——
                所以复制按钮复制的是**码本身**，不是一整条命令。 */}
            <Paragraph style={{ marginBottom: 6, color: "var(--manager-text-muted)" }}>
              {t("provider.join.codeLabel")}
            </Paragraph>
            <div className="galaxy-secret">
              <code style={{ flex: 1, fontSize: 16, letterSpacing: 1 }}>{code.code}</code>
              <Button size="small" icon={<CopyOutlined />} onClick={() => void copy(code.code)}>
                {t("common.copy")}
              </Button>
            </div>
            <Paragraph style={{ marginTop: 6, marginBottom: 12, color: "var(--manager-text-muted)" }}>
              {t("provider.join.pairExpires").replace("{time}", formatTime(code.expiresAt))}
            </Paragraph>

            <Paragraph style={{ marginBottom: 6, color: "var(--manager-text-muted)" }}>
              {t("provider.join.setupHint")}
            </Paragraph>
            <div className="galaxy-secret">
              <code style={{ flex: 1 }}>ai-bridge pool setup</code>
              <Button size="small" icon={<CopyOutlined />} onClick={() => void copy("ai-bridge pool setup")}>
                {t("common.copy")}
              </Button>
            </div>
          </div>
        ) : null}
      </Step>
    </section>
  );
}

/** 带序号的一步。三步共用一套排版，免得每一步各写一份标题样式。 */
function Step({
  index,
  title,
  hint,
  last,
  children,
}: {
  index: number;
  title: string;
  hint: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 12, paddingBottom: last ? 0 : 20 }}>
      <span
        style={{
          flex: "none",
          width: 24,
          height: 24,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: "var(--manager-primary, #4f46e5)",
          color: "#fff",
          fontSize: 12,
          marginTop: 2,
        }}
      >
        {index}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
        <Paragraph style={{ marginBottom: 10, color: "var(--manager-text-muted)" }}>{hint}</Paragraph>
        {children}
      </div>
    </div>
  );
}
