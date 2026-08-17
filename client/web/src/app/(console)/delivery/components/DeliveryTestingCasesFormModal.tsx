"use client";

import { Button, Input, Modal } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";

interface DeliveryTestingCasesFormModalProps {
  open: boolean;
  targetName: string;
  documentPath?: string;
  loading?: boolean;
  onClose: () => void;
  /** 返回 true 代表测试用例生成任务已成功提交。 */
  onSubmit: (message: string) => Promise<boolean>;
}

/**
 * 提交内容会成为测试用例聊天的第一条用户消息；需求、任务和已有产物仍由
 * 各自的桥接流程自动附带，避免让用户重复录入系统已知的信息。
 */
export function DeliveryTestingCasesFormModal({
  open,
  targetName,
  documentPath,
  loading = false,
  onClose,
  onSubmit,
}: DeliveryTestingCasesFormModalProps) {
  const { t } = useLocale();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setInput("");
  }, [open, targetName]);

  const submit = async () => {
    const message = input.trim();
    if (!message) return;
    setSubmitting(true);
    try {
      if (await onSubmit(message)) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const busy = loading || submitting;

  return (
    <Modal
      className="delivery-testing-cases-form-modal"
      open={open}
      title={t("delivery.testingCases.form.title")}
      onCancel={onClose}
      width="min(760px, calc(100vw - 32px))"
      destroyOnClose
      footer={[
        <Button key="cancel" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>,
        <Button key="submit" type="primary" loading={busy} disabled={!input.trim()} onClick={() => void submit()}>
          {t("delivery.testingCases.form.submit")}
        </Button>,
      ]}
    >
      <div className="delivery-testing-cases-form">
        <p>{t("delivery.testingCases.form.description")}</p>
        <div className="delivery-testing-cases-form__source">
          <span>{t("delivery.testingCases.form.source")}</span>
          <b>{targetName}</b>
          <small>{documentPath || t("delivery.testingCases.form.sourceFallback")}</small>
        </div>
        <div className="delivery-testing-cases-form__references">
          <b>{t("delivery.testingCases.form.referencesTitle")}</b>
          <ul>
            <li>{t("delivery.testingCases.form.referenceRequirement")}</li>
            <li>{t("delivery.testingCases.form.referenceTasks")}</li>
            <li>{t("delivery.testingCases.form.referenceInput")}</li>
          </ul>
        </div>
        <label>
          {t("delivery.testingCases.form.input")}
          <Input.TextArea
            autoSize={{ minRows: 8, maxRows: 14 }}
            value={input}
            placeholder={t("delivery.testingCases.form.inputPlaceholder")}
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
