"use client";

import { CopyOutlined, WarningFilled } from "@ant-design/icons";
import { Alert, Button, Modal, message } from "antd";
import { useLocale } from "@/i18n/LocaleProvider";
import { copyText } from "@/utils/format";
import type { IssuedKeyView } from "../../api/consumer.api";

/**
 * 密钥明文只显示这一次。
 *
 * 服务端只存 sha256，关掉这个窗口之后谁也查不回来 —— 包括平台自己。
 * 所以这里刻意做成必须显式关闭的模态框，而不是一条会自己消失的 toast。
 */
export function SecretOnceModal({ issued, onClose }: { issued: IssuedKeyView | null; onClose: () => void }) {
  const { t } = useLocale();

  const copy = async () => {
    if (!issued) return;
    const ok = await copyText(issued.secret);
    if (ok) message.success(t("common.copied"));
    else message.warning(t("common.copyFailed"));
  };

  return (
    <Modal
      open={Boolean(issued)}
      title={
        <span>
          <WarningFilled style={{ color: "#d97706", marginRight: 8 }} />
          {t("consumer.keys.secretTitle")}
        </span>
      }
      onCancel={onClose}
      maskClosable={false}
      footer={[
        <Button key="copy" icon={<CopyOutlined />} onClick={() => void copy()}>
          {t("common.copy")}
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          {t("common.close")}
        </Button>,
      ]}
    >
      <Alert type="warning" showIcon message={t("consumer.keys.secretHint")} style={{ marginBottom: 12 }} />
      <div className="galaxy-code">{issued?.secret}</div>
      <p style={{ marginTop: 12, marginBottom: 0, color: "var(--manager-text-muted)" }}>
        {issued?.alias} · {t("consumer.keys.expiresAt")} {issued?.expiresAt?.slice(0, 10)}
      </p>
    </Modal>
  );
}
