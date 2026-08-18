"use client";

import { EditOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Spin, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchCodexTaskOutline,
  saveCodexTaskOutline,
  type DeliveryItemRecord,
} from "@/api/delivery.api";
import { SessionDocumentText } from "./DeliverySessionMessage";

interface DeliveryTaskOutlineProps {
  programId: number;
  item: DeliveryItemRecord | null;
  codexBridgeReady: boolean;
}

/**
 * 任务需求大纲面板。正文落在项目工作区 doc/requirements/<需求键>/<任务键>/需求大纲.md，
 * 展示沿用任务详情「需求」页签那套文档组件，只是多了一档可编辑状态。
 */
export function DeliveryTaskOutlinePanel({ programId, item, codexBridgeReady }: DeliveryTaskOutlineProps) {
  const { t } = useLocale();
  const [path, setPath] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!item || !programId || !codexBridgeReady) return;
    setLoading(true);
    try {
      const outline = await fetchCodexTaskOutline(programId, item.itemKey);
      setPath(outline.path);
      setMarkdown(outline.markdown);
      setDraft(outline.markdown);
    } catch (error) {
      setPath("");
      setMarkdown("");
      setDraft("");
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [codexBridgeReady, item, programId]);

  useEffect(() => {
    setEditing(false);
    void load();
  }, [load]);

  const save = async () => {
    if (!item || !programId) return;
    setSaving(true);
    try {
      const outline = await saveCodexTaskOutline(programId, item.itemKey, draft);
      setPath(outline.path);
      setMarkdown(outline.markdown);
      setDraft(outline.markdown);
      setEditing(false);
      message.success(t("delivery.outline.saved"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!codexBridgeReady) {
    return (
      <section className="delivery-document-panel">
        <SessionDocumentText value="" fallback={t("delivery.outline.bridgeOffline")} />
      </section>
    );
  }

  return (
    <section className="delivery-document-panel delivery-outline-panel">
      <header className="delivery-outline-panel__bar">
        {path ? <code className="delivery-document-panel__path">{path}</code> : null}
        <span className="delivery-outline-panel__actions">
          <Button size="small" type="text" icon={<ReloadOutlined />} disabled={loading || saving} onClick={() => void load()} />
          {editing ? (
            <>
              <Button
                size="small"
                onClick={() => {
                  setDraft(markdown);
                  setEditing(false);
                }}
              >
                {t("delivery.outline.cancel")}
              </Button>
              <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
                {t("delivery.outline.save")}
              </Button>
            </>
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled={loading} onClick={() => setEditing(true)}>
              {t("delivery.outline.edit")}
            </Button>
          )}
        </span>
      </header>
      <Spin spinning={loading}>
        {editing ? (
          <Input.TextArea
            autoSize={{ minRows: 12, maxRows: 28 }}
            value={draft}
            placeholder={t("delivery.outline.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <SessionDocumentText value={markdown} fallback={t("delivery.outline.taskEmpty")} />
        )}
      </Spin>
    </section>
  );
}

/** 看板卡片上的「需求大纲」按钮打开的独立弹窗，正文与任务详情里的面板是同一个组件。 */
export function DeliveryTaskOutlineModal({
  open,
  programId,
  item,
  codexBridgeReady,
  onClose,
}: DeliveryTaskOutlineProps & { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <Modal
      className="delivery-outline-modal"
      open={open}
      title={item ? `${t("delivery.outline.task")} · ${item.title}` : t("delivery.outline.task")}
      width={880}
      footer={null}
      destroyOnClose
      onCancel={onClose}
    >
      {open && item ? <DeliveryTaskOutlinePanel programId={programId} item={item} codexBridgeReady={codexBridgeReady} /> : null}
    </Modal>
  );
}
