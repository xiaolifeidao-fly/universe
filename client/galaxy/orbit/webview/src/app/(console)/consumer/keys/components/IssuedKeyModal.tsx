"use client";

/**
 * 刚买到一把新密钥。
 *
 * 明文现在平台取得回（加密存着），关掉这个框之后在密钥页还能复制、还能一键接到本机客户端，
 * 所以这里不再是「只显示这一次，务必存好」的警告框。但它仍然是一个要手动关的模态框：
 * 买完第一件事就是拿密钥，让它自己消失等于让人再去找一遍。
 */

import { Modal } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Btn, CopyBtn } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDay } from "@/utils/format";
import type { IssuedKeyView } from "../../api/consumer.api";

export function IssuedKeyModal({ issued, onClose }: { issued: IssuedKeyView | null; onClose: () => void }) {
  const { t } = useLocale();
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      open={Boolean(issued)}
      title={t("issued.title", { alias: issued?.alias ?? "" })}
      onCancel={onClose}
      maskClosable={false}
      width={520}
      footer={[
        <Btn
          key="keys"
          tone="ghost"
          onClick={() => {
            onClose();
            router.push("/consumer/keys");
          }}
        >
          {t("issued.goKeys")}
        </Btn>,
        <Btn key="ok" tone="accent" onClick={onClose}>
          {t("issued.done")}
        </Btn>,
      ]}
      afterClose={() => setCopied(false)}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 4 }}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--gx-soft)" }}>{t("issued.body")}</p>
        <div className="gx-secret">
          <span style={{ flex: 1 }}>{issued?.secret}</span>
          <CopyBtn value={issued?.secret ?? ""} label={t("common.copy")} copied={copied} onCopied={() => setCopied(true)} />
        </div>
        <div style={{ display: "flex", gap: 24, fontSize: 12.5, color: "var(--gx-faint)" }}>
          <span>{t("keys.expiresAt", { value: issued?.expiresAt ? formatDay(issued.expiresAt) : "—" })}</span>
          <span className="gx-mono">{issued?.keyId}</span>
        </div>
      </div>
    </Modal>
  );
}
