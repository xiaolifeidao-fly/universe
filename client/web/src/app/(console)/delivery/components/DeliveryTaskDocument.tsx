"use client";

import { EditOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Spin, message } from "antd";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  fetchCodexRequirementDocument,
  saveCodexRequirementDocument,
  type DeliveryItemRecord,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { SessionDocumentText } from "./DeliverySessionMessage";

interface DeliveryTaskDocumentProps {
  programId: number;
  item: DeliveryItemRecord | null;
  codexBridgeReady: boolean;
  title?: ReactNode;
}

/** 任务从需求梳理到动作执行都共用同一份需求文档，面板编辑直接写回该文件。 */
export function DeliveryTaskDocumentPanel({ programId, item, codexBridgeReady, title }: DeliveryTaskDocumentProps) {
  const { t } = useLocale();
  const itemKey = item?.itemKey ?? "";
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!programId || !itemKey || !codexBridgeReady) return;
    setLoading(true);
    try {
      const document = await fetchCodexRequirementDocument(programId, itemKey);
      setPath(document.path);
      setContent(document.content);
      setDraft(document.content);
    } catch (error) {
      setPath("");
      setContent("");
      setDraft("");
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [codexBridgeReady, itemKey, programId]);

  useEffect(() => {
    setEditing(false);
    void reload();
  }, [reload]);

  const submit = async () => {
    if (!programId || !itemKey) return;
    setSaving(true);
    try {
      const document = await saveCodexRequirementDocument(programId, itemKey, draft);
      setPath(document.path);
      setContent(document.content);
      setDraft(document.content);
      setEditing(false);
      message.success(t("delivery.document.saved"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!codexBridgeReady) {
    return <section className={`delivery-document-panel delivery-outline-panel${title ? " has-title" : ""}`}><SessionDocumentText value="" fallback={t("delivery.document.bridgeOffline")} /></section>;
  }

  return (
    <section className={`delivery-document-panel delivery-outline-panel${title ? " has-title" : ""}`}>
      <header className="delivery-outline-panel__bar">
        {title ? <b className="delivery-outline-panel__title">{title}</b> : null}
        {!title && path ? <code className="delivery-document-panel__path">{path}</code> : null}
        <span className="delivery-outline-panel__actions">
          <Button size="small" type="text" icon={<ReloadOutlined />} disabled={loading || saving} onClick={() => void reload()} />
          {editing ? (
            <>
              <Button size="small" onClick={() => { setDraft(content); setEditing(false); }}>{t("delivery.outline.cancel")}</Button>
              <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void submit()}>{t("delivery.outline.save")}</Button>
            </>
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled={loading} onClick={() => setEditing(true)}>{t("delivery.outline.edit")}</Button>
          )}
        </span>
      </header>
      {title && path ? <code className="delivery-document-panel__path">{path}</code> : null}
      <Spin spinning={loading}>
        {editing ? (
          <Input.TextArea autoSize={{ minRows: 12, maxRows: 28 }} value={draft} placeholder={t("delivery.outline.placeholder")} onChange={(event) => setDraft(event.target.value)} />
        ) : (
          <SessionDocumentText value={content} fallback={t("delivery.document.requirementEmpty")} />
        )}
      </Spin>
    </section>
  );
}

export function DeliveryTaskDocumentModal({ open, programId, item, codexBridgeReady, onClose }: DeliveryTaskDocumentProps & { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <Modal className="delivery-outline-modal" open={open} title={null} width={880} footer={null} destroyOnClose onCancel={onClose}>
      {open && item ? (
        <DeliveryTaskDocumentPanel
          programId={programId}
          item={item}
          codexBridgeReady={codexBridgeReady}
          title={<span title={item.title}>{`${t("delivery.detail.document")} · ${item.title}`}</span>}
        />
      ) : null}
    </Modal>
  );
}
