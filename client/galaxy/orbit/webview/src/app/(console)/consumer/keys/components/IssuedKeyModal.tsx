"use client";

/**
 * 刚拿到一把新密钥（新建或换发）。
 *
 * 明文已经存进这台设备的保险箱（桌面端 SQLite / 浏览器 localStorage），关掉这个框之后
 * 在密钥页还能查看、复制、一键接到本机客户端，所以这里不再是「只显示这一次」的警告框。
 * 但它仍然是一个要手动关的模态框：签发完第一件事就是拿密钥去填客户端，
 * 让它自己消失等于让人再去找一遍 —— 末尾那句话就是把人指到「怎么用这把密钥」那张卡上。
 *
 * 存不下的时候（没登录、浏览器禁了站点数据、桌面端的库打不开）就得说实话：那一刻起
 * 这串明文只在这个框里，关掉就要靠换发。两种情况的文案必须不一样。
 */

import { Modal } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Btn, CopyBtn } from "@/components/ui/kit";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatDay } from "@/utils/format";
import type { IssuedKeyView } from "../../api/consumer.api";
import { keyVaultKind } from "../../api/keyvault.api";

export function IssuedKeyModal({
  issued,
  savedLocally,
  onClose,
}: {
  issued: IssuedKeyView | null;
  /** 明文有没有存进本机保险箱。没存下就是「只有这一次」。 */
  savedLocally: boolean;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const body = savedLocally ? (keyVaultKind() === "sqlite" ? t("issued.savedDesktop") : t("issued.savedBrowser")) : t("issued.notSaved");

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
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: savedLocally ? "var(--gx-soft)" : "var(--gx-warn)" }}>{body}</p>
        <div className="gx-secret">
          <span style={{ flex: 1 }}>{issued?.secret}</span>
          <CopyBtn value={issued?.secret ?? ""} label={t("common.copy")} copied={copied} onCopied={() => setCopied(true)} />
        </div>
        <div style={{ display: "flex", gap: 24, fontSize: 12.5, color: "var(--gx-faint)" }}>
          <span>{t("keys.expiresAt", { value: issued?.expiresAt ? formatDay(issued.expiresAt) : "—" })}</span>
          <span className="gx-mono">{issued?.keyId}</span>
        </div>
        {/* 签发完最先冒出来的问题是「这串东西往哪儿放」。答案整个摆在密钥页那张
            「怎么用这把密钥」上，这里只把人指过去 —— 三条路抄进这个框，
            框就会长到要滚动，而它现在唯一的任务是让人先把明文收好。 */}
        <p style={{ margin: 0, paddingTop: 12, borderTop: "1px solid var(--gx-line)", fontSize: 12.5, lineHeight: 1.7, color: "var(--gx-soft)" }}>
          {t("issued.next")}
        </p>
      </div>
    </Modal>
  );
}
