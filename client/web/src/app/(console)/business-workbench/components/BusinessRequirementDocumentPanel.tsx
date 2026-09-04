"use client";

import {
  CheckOutlined,
  CopyOutlined,
  DownOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
} from "@ant-design/icons";
import { Button, Empty, Modal, Tag, Tooltip, message } from "antd";
import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { SessionMarkdown } from "../../delivery/components/DeliverySessionMessage";
import type { BusinessRequirementDocument } from "../api/businessRequirement.api";

/**
 * 一场业务访谈的那份文档。
 *
 * 访谈过程中的每一轮只在对话里回应，不再各自沉淀一版整理：业务方点「确认文档」
 * 之后才产出文档，再次确认是整份重写。所以这里不需要版本步进和历史提示，一场
 * 对话就对应这一份内容，业务方和产研都不用先判断“哪一份才算数”。
 */
export function BusinessRequirementDocumentPanel({
  intakeDocument,
  defaultOpen = true,
  collapsible = false,
}: {
  /** 业务方尚未确认文档时为空。 */
  intakeDocument?: BusinessRequirementDocument;
  defaultOpen?: boolean;
  /** 聊天列内空间紧张时允许整块收起，详情抽屉里则始终展开。 */
  collapsible?: boolean;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!intakeDocument) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("businessDocument.empty")} />;
  }

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(intakeDocument.content);
      setCopied(true);
    } catch {
      message.error(t("businessDocument.copyFailed"));
    }
  };

  const body = (
    <div className="business-document__body">
      <SessionMarkdown text={intakeDocument.content} className="is-document" />
    </div>
  );

  return (
    <section className={`business-document${open ? " is-open" : ""}`}>
      <header className="business-document__head">
        {collapsible ? (
          <button
            type="button"
            className="business-document__toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <FileTextOutlined />
            <b>{intakeDocument.title}</b>
            <DownOutlined className="business-document__chevron" />
          </button>
        ) : (
          <div className="business-document__toggle is-static">
            <FileTextOutlined />
            <b>{intakeDocument.title}</b>
          </div>
        )}
        <div className="business-document__actions">
          {/* 只有业务方确认过的那份才带这个标记；改造前每轮沉淀的旧整理没有。 */}
          {intakeDocument.confirmed ? <Tag color="green">{t("businessDocument.confirmed")}</Tag> : null}
          <Tooltip title={copied ? t("businessDocument.copied") : t("businessDocument.copy")}>
            <Button
              size="small"
              type="text"
              icon={copied ? <CheckOutlined /> : <CopyOutlined />}
              aria-label={t("businessDocument.copy")}
              onClick={() => void copyContent()}
            />
          </Tooltip>
          <Tooltip title={t("businessDocument.fullscreen")}>
            <Button
              size="small"
              type="text"
              icon={<FullscreenOutlined />}
              aria-label={t("businessDocument.fullscreen")}
              onClick={() => setFullscreen(true)}
            />
          </Tooltip>
        </div>
      </header>
      {open || !collapsible ? body : null}
      <Modal
        open={fullscreen}
        onCancel={() => setFullscreen(false)}
        footer={null}
        width="min(1080px, 94vw)"
        wrapClassName="business-document__modal"
        title={
          <div className="business-document__modal-title">
            <FileTextOutlined />
            <b>{intakeDocument.title}</b>
            {intakeDocument.confirmed ? <Tag color="green">{t("businessDocument.confirmed")}</Tag> : null}
          </div>
        }
        closeIcon={<FullscreenExitOutlined />}
      >
        {body}
      </Modal>
    </section>
  );
}
