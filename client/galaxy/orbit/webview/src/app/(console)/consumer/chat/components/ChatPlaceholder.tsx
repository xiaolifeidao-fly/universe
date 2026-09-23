"use client";

/**
 * 对话页。
 *
 * 原型里画的是一个完整的聊天界面（会话列表 + 消息流 + 每条的扣费脚注）。
 * 它没有实现，因为要真的能聊，控制台就得拿着 `sk-` 明文去打 /v1/messages ——
 * 而明文只在签发那一刻出现，控制台手里没有、也不该有。让它有，等于把一把
 * 能直接花钱的密钥常驻在浏览器里。
 *
 * 正确的做法是加一条「以用户令牌代发」的服务端通道（服务端按 owner 解析出密钥，
 * 前端永远碰不到明文）。那是一件独立的事，不该顺手塞进这次改版。
 * 所以这里如实说明现状，并把人引到真的能用的路上，而不是摆一个发不出消息的输入框。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/shell/GalaxyShell";
import { IconChat } from "@/components/ui/icons";
import { Btn, Card, CopyBtn } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchConsumerEndpoint } from "../../api/consumer.api";

export function ChatPlaceholder() {
  const { t } = useLocale();
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetchConsumerEndpoint()
      .then((row) => setBaseUrl(row.baseUrl))
      .catch(() => setBaseUrl(""));
  }, []);

  return (
    <>
      <PageHeader title={t("chat.title")} meta={t("chat.subtitle")} />
      <div className="gx-body">
        <Card className="gx-rise" style={{ padding: "56px 40px", display: "grid", placeItems: "center" }}>
          <div style={{ maxWidth: 460, display: "flex", flexDirection: "column", gap: 18, textAlign: "center", alignItems: "center" }}>
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                display: "grid",
                placeItems: "center",
                background: "var(--gx-accent-soft)",
                color: "var(--gx-accent)",
              }}
            >
              <IconChat size={24} />
            </span>
            <span className="gx-serif" style={{ fontSize: 24 }}>
              {t("chat.soonTitle")}
            </span>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.75, color: "var(--gx-soft)" }}>{t("chat.soonHint")}</p>
            {baseUrl ? (
              <div className="gx-secret" style={{ width: "100%", justifyContent: "space-between" }}>
                <span>{baseUrl}</span>
                <CopyBtn value={baseUrl} label={t("common.copy")} copied={copied} onCopied={() => setCopied(true)} />
              </div>
            ) : null}
            <Btn tone="accent" onClick={() => router.push("/consumer/keys")}>
              {t("chat.goKeys")}
            </Btn>
          </div>
        </Card>
      </div>
    </>
  );
}
