"use client";

import {
  CheckOutlined,
  CopyOutlined,
  DownOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  LeftOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Empty, Modal, Select, Tag, Tooltip, message } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { SessionMarkdown } from "../../delivery/components/DeliverySessionMessage";
import type { BusinessRequirementDocument } from "../api/businessRequirement.api";

function formatTime(value: string | undefined, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { hour12: false });
}

/**
 * AI 整理文档的版本浏览器。
 *
 * 每一轮访谈都会沉淀一版文档，版本只增不改。业务方和产研看这份文档时关心的
 * 是两件事：最新一版说了什么，以及某句话是哪一轮补上的。所以这里不把历史版本
 * 平铺成一串折叠块（版本一多就翻不动），而是按成熟文档产品的做法：一次只呈现
 * 一版，用「上一版 / 下一版」步进 + 版本下拉在其间跳转，并在离开最新版时用一条
 * 醒目的提示条兜住上下文，避免把历史内容误当成当前结论。
 */
export function BusinessRequirementDocuments({
  documents,
  defaultOpen = true,
  collapsible = false,
}: {
  /** 服务端按 version desc 返回，索引 0 即最新版。 */
  documents: BusinessRequirementDocument[];
  defaultOpen?: boolean;
  /** 聊天列内空间紧张时允许整块收起，详情抽屉里则始终展开。 */
  collapsible?: boolean;
}) {
  const { t, locale } = useLocale();
  const [selectedId, setSelectedId] = useState<number>();
  const [open, setOpen] = useState(defaultOpen);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const ordered = useMemo(
    () => [...documents].sort((left, right) => right.version - left.version),
    [documents],
  );
  const latest = ordered[0];
  const index = Math.max(0, ordered.findIndex((item) => item.id === selectedId));
  const current = ordered[index] ?? latest;

  // 新一版落库后自动跟到最新：轮询期间用户没有主动翻历史，就不该停在旧版本上。
  useEffect(() => {
    setSelectedId(latest?.id);
  }, [latest?.id]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!ordered.length || !current) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("businessDocument.empty")} />;
  }

  const isLatest = current.id === latest.id;
  // ordered 是从新到旧：往后一格是更旧的版本，往前一格是更新的版本。
  const older = ordered[index + 1];
  const newer = ordered[index - 1];

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
    } catch {
      message.error(t("businessDocument.copyFailed"));
    }
  };

  const versionPicker = (
    <div className="business-document__versions">
      <Tooltip title={t("businessDocument.older")}>
        <Button
          size="small"
          type="text"
          icon={<LeftOutlined />}
          disabled={!older}
          aria-label={t("businessDocument.older")}
          onClick={() => setSelectedId(older?.id)}
        />
      </Tooltip>
      <Select<number>
        size="small"
        value={current.id}
        popupMatchSelectWidth={false}
        onChange={setSelectedId}
        options={ordered.map((item, position) => ({
          value: item.id,
          label: t("businessDocument.version").replace("{version}", String(item.version)),
          title: item.title,
          time: formatTime(item.createdAt, locale),
          isLatest: position === 0,
          confirmed: item.confirmed,
        }))}
        optionRender={(option) => (
          <div className="business-document__option">
            <b>{option.label}</b>
            {/* 确认文档和每轮的访谈整理共用一条版本线，下拉里不标出来就只能逐版点开认。 */}
            {option.data.confirmed ? <Tag color="green">{t("businessDocument.confirmed")}</Tag> : null}
            {option.data.isLatest ? <Tag color="blue">{t("businessDocument.latest")}</Tag> : null}
            <span className="manager-mono">{option.data.time}</span>
          </div>
        )}
      />
      <Tooltip title={t("businessDocument.newer")}>
        <Button
          size="small"
          type="text"
          icon={<RightOutlined />}
          disabled={!newer}
          aria-label={t("businessDocument.newer")}
          onClick={() => setSelectedId(newer?.id)}
        />
      </Tooltip>
      <span className="business-document__count manager-mono">
        {t("businessDocument.count").replace("{total}", String(ordered.length))}
      </span>
    </div>
  );

  const body = (
    <>
      {isLatest ? null : (
        <div className="business-document__history" role="status">
          <span>
            {t("businessDocument.historyNotice")
              .replace("{version}", String(current.version))
              .replace("{total}", String(ordered.length))}
          </span>
          <Button size="small" type="link" onClick={() => setSelectedId(latest.id)}>
            {t("businessDocument.backToLatest")}
          </Button>
        </div>
      )}
      <div className="business-document__body">
        <SessionMarkdown text={current.content} className="is-document" />
      </div>
    </>
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
            <b>{current.title}</b>
            <DownOutlined className="business-document__chevron" />
          </button>
        ) : (
          <div className="business-document__toggle is-static">
            <FileTextOutlined />
            <b>{current.title}</b>
          </div>
        )}
        <div className="business-document__actions">
          {current.confirmed ? <Tag color="green">{t("businessDocument.confirmed")}</Tag> : null}
          {isLatest ? <Tag color="blue">{t("businessDocument.latest")}</Tag> : null}
          {versionPicker}
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
            <b>{current.title}</b>
            {current.confirmed ? <Tag color="green">{t("businessDocument.confirmed")}</Tag> : null}
            {isLatest ? <Tag color="blue">{t("businessDocument.latest")}</Tag> : null}
            {versionPicker}
          </div>
        }
        closeIcon={<FullscreenExitOutlined />}
      >
        {body}
      </Modal>
    </section>
  );
}
