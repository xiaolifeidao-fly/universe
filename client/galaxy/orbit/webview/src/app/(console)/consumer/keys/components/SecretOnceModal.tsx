"use client";

/**
 * 密钥明文只显示这一次。
 *
 * 服务端只存 sha256，关掉这个窗口之后谁也查不回来 —— 包括平台自己。
 * 所以它是一个必须显式关闭的模态框，而不是一条会自己消失的 toast；
 * 关闭按钮的文案也是「我已经保存好了」而不是「关闭」。
 */

import { Modal } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconAlert } from "@/components/ui/icons";
import { Btn, CopyBtn } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDay } from "@/utils/format";
import type { IssuedKeyView } from "../../api/consumer.api";

export function SecretOnceModal({ issued, onClose }: { issued: IssuedKeyView | null; onClose: () => void }) {
  const { t } = useLocale();
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  return (
    <Modal
      open={Boolean(issued)}
      title={t("secret.title", { alias: issued?.alias ?? "" })}
      onCancel={onClose}
      maskClosable={false}
      width={520}
      footer={[
        <Btn
          key="store"
          tone="ghost"
          onClick={() => {
            onClose();
            router.push("/consumer/store");
          }}
        >
          {t("secret.goStore")}
        </Btn>,
        <Btn key="ok" tone="accent" onClick={onClose}>
          {t("secret.saved")}
        </Btn>,
      ]}
      afterClose={() => setCopied(false)}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 4 }}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--gx-soft)" }}>
          {t("secret.body1")}
          <strong style={{ color: "var(--gx-warn-ink)" }}> {t("secret.body2")} </strong>
          {t("secret.body3")}
        </p>
        <div className="gx-secret">
          <span style={{ flex: 1 }}>{issued?.secret}</span>
          <CopyBtn
            value={issued?.secret ?? ""}
            label={t("common.copy")}
            copied={copied}
            onCopied={() => setCopied(true)}
          />
        </div>
        <div style={{ display: "flex", gap: 24, fontSize: 12.5, color: "var(--gx-faint)" }}>
          <span>
            {t("keys.expiresAt", { value: issued?.expiresAt ? formatDay(issued.expiresAt) : "—" })}
          </span>
          <span className="gx-mono">{issued?.keyId}</span>
        </div>
        {!copied ? (
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--gx-warn-ink)" }}>
            <IconAlert size={14} />
            {t("secret.body2")}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
