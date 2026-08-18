"use client";

import { EditOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { Button, Input, Modal, Spin, message } from "antd";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchCodexRequirementOutline,
  saveCodexRequirementOutline,
  type DeliveryRequirementRecord,
} from "@/api/delivery.api";
import { SessionDocumentText } from "./DeliverySessionMessage";

interface OutlineEditorProps {
  /** 变了就重新拉一次：任务用任务键，需求用需求键。 */
  subjectKey: string;
  /** 弹窗形态下把名称放进面板自己的横条，编辑和刷新就固定跟在名称后面。 */
  title?: ReactNode;
  codexBridgeReady: boolean;
  emptyText: string;
  load: () => Promise<{ path: string; markdown: string }>;
  save: (markdown: string) => Promise<{ path: string; markdown: string }>;
}

/**
 * 需求级大纲编辑面板。需求大纲落在 doc/requirements/<需求键>/需求大纲.md。
 */
function OutlineEditor({ subjectKey, title, codexBridgeReady, emptyText, load, save }: OutlineEditorProps) {
  const { t } = useLocale();
  const [path, setPath] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!subjectKey || !codexBridgeReady) return;
    setLoading(true);
    try {
      const outline = await load();
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
    // load 每次渲染都是新函数，靠 subjectKey 控制重新拉取的时机。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codexBridgeReady, subjectKey]);

  useEffect(() => {
    setEditing(false);
    void reload();
  }, [reload]);

  const submit = async () => {
    if (!subjectKey) return;
    setSaving(true);
    try {
      const outline = await save(draft);
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
      <section className={`delivery-document-panel delivery-outline-panel${title ? " has-title" : ""}`}>
        {title ? (
          <header className="delivery-outline-panel__bar">
            <b className="delivery-outline-panel__title">{title}</b>
          </header>
        ) : null}
        <SessionDocumentText value="" fallback={t("delivery.outline.bridgeOffline")} />
      </section>
    );
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
              <Button
                size="small"
                onClick={() => {
                  setDraft(markdown);
                  setEditing(false);
                }}
              >
                {t("delivery.outline.cancel")}
              </Button>
              <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void submit()}>
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
      {title && path ? <code className="delivery-document-panel__path">{path}</code> : null}
      <Spin spinning={loading}>
        {editing ? (
          <Input.TextArea
            autoSize={{ minRows: 12, maxRows: 28 }}
            value={draft}
            placeholder={t("delivery.outline.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <SessionDocumentText value={markdown} fallback={emptyText} />
        )}
      </Spin>
    </section>
  );
}

/** 需求级需求大纲面板，读写需求拆解沉淀下来的那份大纲。 */
export function DeliveryRequirementOutlinePanel({
  programId,
  requirement,
  codexBridgeReady,
  title,
}: {
  programId: number;
  requirement: DeliveryRequirementRecord | null;
  codexBridgeReady: boolean;
  title?: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <OutlineEditor
      subjectKey={requirement && programId ? requirement.requirementKey : ""}
      title={title}
      codexBridgeReady={codexBridgeReady}
      emptyText={t("delivery.outline.requirementEmpty")}
      load={() => fetchCodexRequirementOutline(programId, requirement!.requirementKey)}
      save={(markdown) => saveCodexRequirementOutline(programId, requirement!.requirementKey, markdown)}
    />
  );
}

/** 需求列表上的「需求大纲」按钮打开的独立编辑弹窗。 */
export function DeliveryRequirementOutlineModal({
  open,
  programId,
  requirement,
  codexBridgeReady,
  onClose,
}: {
  open: boolean;
  programId: number;
  requirement: DeliveryRequirementRecord | null;
  codexBridgeReady: boolean;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <Modal
      className="delivery-outline-modal"
      open={open}
      title={null}
      width={880}
      footer={null}
      destroyOnClose
      onCancel={onClose}
    >
      {open && requirement ? (
        <DeliveryRequirementOutlinePanel
          programId={programId}
          requirement={requirement}
          codexBridgeReady={codexBridgeReady}
          title={(
            <span title={requirement.name || requirement.requirementKey}>
              {`${t("delivery.outline.tab")} · ${requirement.name || requirement.requirementKey}`}
            </span>
          )}
        />
      ) : null}
    </Modal>
  );
}
