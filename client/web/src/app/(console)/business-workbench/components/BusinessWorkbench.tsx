"use client";

import { FileTextOutlined, MessageOutlined, PlusOutlined, SendOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, List, Modal, Select, Spin, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  createBusinessRequirement,
	fetchBusinessPrograms,
  fetchBusinessRequirementConversation,
  fetchBusinessRequirements,
  sendBusinessRequirementMessage,
  type BusinessRequirementConversation,
  type BusinessRequirementMessage,
  type BusinessRequirementRecord,
	type BusinessProgramContext,
} from "../api/businessRequirement.api";

interface NewBusinessRequirementForm {
  programId: number;
}

function formatTime(value: string | undefined, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { hour12: false });
}

export function BusinessWorkbench() {
  const { t, locale } = useLocale();
  const { activeBusinessLine, businessLinesLoaded } = useBusinessLine();
  const [newForm] = Form.useForm<NewBusinessRequirementForm>();
  const [requirements, setRequirements] = useState<BusinessRequirementRecord[]>([]);
  const [programs, setPrograms] = useState<BusinessProgramContext[]>([]);
  const [selectedRequirementId, setSelectedRequirementId] = useState<number>();
  const [conversation, setConversation] = useState<BusinessRequirementConversation | null>(null);
  const [loading, setLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [newRequirementOpen, setNewRequirementOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const refreshRequirements = useCallback(async () => {
    if (!activeBusinessLine.id) {
      setPrograms([]);
      setRequirements([]);
      setSelectedRequirementId(undefined);
      setConversation(null);
      return [];
    }
    setLoading(true);
    try {
      const [programRows, page] = await Promise.all([
		fetchBusinessPrograms(activeBusinessLine.id),
        fetchBusinessRequirements(activeBusinessLine.id),
      ]);
      setPrograms(programRows);
      setRequirements(page.data);
      setSelectedRequirementId((current) => current && page.data.some((item) => item.id === current) ? current : page.data[0]?.id);
		return programRows;
    } catch (error) {
      setPrograms([]);
      setRequirements([]);
      setSelectedRequirementId(undefined);
      setConversation(null);
      message.error((error as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [activeBusinessLine.id]);

  const loadConversation = useCallback(async (requirementId: number) => {
    if (!activeBusinessLine.id) return;
    setConversationLoading(true);
    try {
      setConversation(await fetchBusinessRequirementConversation(activeBusinessLine.id, requirementId));
    } catch (error) {
      setConversation(null);
      message.error((error as Error).message);
    } finally {
      setConversationLoading(false);
    }
  }, [activeBusinessLine.id]);

  useEffect(() => {
    if (businessLinesLoaded) void refreshRequirements();
  }, [businessLinesLoaded, refreshRequirements]);

  useEffect(() => {
    if (selectedRequirementId) {
      void loadConversation(selectedRequirementId);
    } else {
      setConversation(null);
    }
  }, [loadConversation, selectedRequirementId]);

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [conversation?.messages.length, conversationLoading]);

  const openNewRequirement = () => {
    newForm.resetFields();
		if (programs.length === 1) newForm.setFieldValue("programId", programs[0].programId);
    setNewRequirementOpen(true);
  };

  const createRequirement = async () => {
    const values = await newForm.validateFields();
    setCreating(true);
    try {
      const requirement = await createBusinessRequirement({ programId: values.programId });
      setNewRequirementOpen(false);
      await refreshRequirements();
      setSelectedRequirementId(requirement.id);
      await loadConversation(requirement.id);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const sendMessage = async () => {
    if (!selectedRequirementId || !activeBusinessLine.id || sending) return;
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    setSending(true);
    try {
      await sendBusinessRequirementMessage(activeBusinessLine.id, selectedRequirementId, content);
      await Promise.all([loadConversation(selectedRequirementId), refreshRequirements()]);
    } catch (error) {
      // The server records the business user's statement before calling the
      // remote AI, so reloading preserves that statement after a remote error.
      setDraft(content);
      await loadConversation(selectedRequirementId);
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const renderMessage = (item: BusinessRequirementMessage) => {
    const isUser = item.role === "user";
    return (
      <article key={item.id} className={`manager-business-chat__message${isUser ? " manager-business-chat__message--user" : ""}`}>
        <div className="manager-business-chat__message-meta">
          {isUser ? t("businessWorkbench.message.business") : t("businessWorkbench.message.ai")}
          <span>{formatTime(item.createdAt, locale)}</span>
        </div>
        <div className="manager-business-chat__bubble">{item.content}</div>
      </article>
    );
  };

  if (!businessLinesLoaded) return null;

  return (
    <div className="manager-page-stack">
      {!activeBusinessLine.id ? <Alert type="info" showIcon message={t("businessWorkbench.noSpace")} /> : null}
      <section className="manager-business-chat">
        <aside className="manager-business-chat__sidebar">
          <div className="manager-business-chat__sidebar-head">
            <div>
              <span className="manager-mono">{t("businessWorkbench.kicker")}</span>
              <h2>{t("businessWorkbench.sessions")}</h2>
            </div>
            <Tooltip title={t("businessWorkbench.newRequirement")}>
				<Button type="primary" icon={<PlusOutlined />} aria-label={t("businessWorkbench.newRequirement")} disabled={!programs.length} onClick={openNewRequirement} />
            </Tooltip>
          </div>
          <div className="manager-business-chat__sidebar-hint">{t("businessWorkbench.definition")}</div>
          <List<BusinessRequirementRecord>
            className="manager-business-chat__session-list"
            loading={loading}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("businessWorkbench.empty")} /> }}
            dataSource={requirements}
            renderItem={(item) => (
              <List.Item
                className={`manager-business-chat__session${selectedRequirementId === item.id ? " manager-business-chat__session--active" : ""}`}
                onClick={() => setSelectedRequirementId(item.id)}
              >
                <div>
                  <strong>{item.title || t("businessWorkbench.untitled")}</strong>
                  <p>{item.detail || t("businessWorkbench.sessionDraft")}</p>
                  <span className="manager-mono">{formatTime(item.updatedAt || item.createdAt, locale)}</span>
                </div>
              </List.Item>
            )}
          />
        </aside>

        <main className="manager-business-chat__main">
          {conversationLoading ? <div className="manager-business-chat__center"><Spin size="large" /></div> : !conversation ? (
            <div className="manager-business-chat__center">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("businessWorkbench.selectSession")} />
            </div>
          ) : (
            <>
              <header className="manager-business-chat__project">
                <div className="manager-business-chat__project-icon"><FileTextOutlined /></div>
                <div>
                  <span>{t("businessWorkbench.currentProject")}</span>
                  <h2>{conversation.program.name || conversation.program.programCode}</h2>
                  <p>{conversation.program.summary || t("businessWorkbench.programNoSummary")}</p>
                </div>
                <Tag className="manager-mono">{conversation.program.programCode}</Tag>
              </header>

              {conversation.documents[0] ? (
                <details className="manager-business-chat__document">
                  <summary>{t("businessWorkbench.document.latest").replace("{version}", String(conversation.documents[0].version))}</summary>
                  <strong>{conversation.documents[0].title}</strong>
                  <div>{conversation.documents[0].content}</div>
                </details>
              ) : null}

              <div className="manager-business-chat__messages">
                {conversation.messages.length ? conversation.messages.map(renderMessage) : (
                  <div className="manager-business-chat__empty-message">
                    <MessageOutlined />
                    <span>{t("businessWorkbench.conversationEmpty")}</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <footer className="manager-business-chat__composer">
                <Input.TextArea
                  value={draft}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  maxLength={16000}
                  disabled={sending}
                  placeholder={t("businessWorkbench.inputPlaceholder")}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!draft.trim()} onClick={() => void sendMessage()}>
                  {t("businessWorkbench.send")}
                </Button>
              </footer>
            </>
          )}
        </main>
      </section>

      <Modal
        wrapClassName="manager-form-skin"
        destroyOnClose
        open={newRequirementOpen}
        title={t("businessWorkbench.newForm.title")}
        okText={t("businessWorkbench.newForm.submit")}
        cancelText={t("businessWorkbench.form.cancel")}
        confirmLoading={creating}
        onOk={() => void createRequirement()}
        onCancel={() => setNewRequirementOpen(false)}
      >
        <p style={{ color: "var(--manager-text-soft)" }}>{t("businessWorkbench.newForm.hint")}</p>
        <Form<NewBusinessRequirementForm> form={newForm} layout="vertical">
          <Form.Item label={t("businessWorkbench.form.program")} name="programId" rules={[{ required: true, message: t("businessWorkbench.form.programRequired") }]}>
				<Select options={programs.map((program) => ({ value: program.programId, label: `${program.name || program.programCode} · ${program.summary || program.programCode}` }))} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
