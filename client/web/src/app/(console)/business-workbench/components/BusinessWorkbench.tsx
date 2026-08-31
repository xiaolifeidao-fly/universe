"use client";

import { CloseOutlined, FileDoneOutlined, FileTextOutlined, MessageOutlined, PaperClipOutlined, PlusOutlined, SendOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Form, List, Modal, Select, Spin, Tag, Tooltip, message } from "antd";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBusinessLine } from "@/business-lines/BusinessLineProvider";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  createBusinessRequirement,
	fetchBusinessDocumentReferences,
	fetchBusinessPrograms,
  fetchBusinessRequirementConversation,
  fetchBusinessRequirements,
  fetchBusinessRequirementAttachment,
  sendBusinessRequirementMessage,
  uploadBusinessRequirementAttachments,
  type BusinessDocumentReference,
  type BusinessRequirementActivity,
  type BusinessRequirementAttachment,
  type BusinessRequirementConversation,
  type BusinessRequirementMessage,
  type BusinessRequirementRecord,
	type BusinessProgramContext,
} from "../api/businessRequirement.api";
import type { CodexConversationItem } from "@/api/delivery.api";
import { SessionMarkdown, SessionProcessGroup, groupSessionItems } from "../../delivery/components/DeliverySessionMessage";
import { BusinessRequirementDocuments } from "./BusinessRequirementDocuments";
import { BusinessRequirementMentionInput } from "./BusinessRequirementMentionInput";

/** 与服务端和远端桥一致的单条消息附件上限。 */
const MAX_MESSAGE_ATTACHMENTS = 5;

/** 与服务端 maxMessageReferences 一致：@ 进来的文档整篇进提示词，多了会淹没本轮诉求。 */
const MAX_MESSAGE_REFERENCES = 5;

interface NewBusinessRequirementForm {
  programId: number;
}

function formatTime(value: string | undefined, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { hour12: false });
}

/**
 * 远端过程条目转成交付会话用的条目结构，好让这里直接复用需求编辑那套渲染：
 * 推理、命令、读写文件都收进同一个可展开的过程块，展示口径和产研侧完全一致。
 */
function conversationItemsOf(activities: BusinessRequirementActivity[]): CodexConversationItem[] {
  return activities.map((activity, index) => ({
    id: activity.id || `${activity.type}-${index}`,
    type: activity.type,
    text: activity.text,
    status: activity.status,
    phase: activity.phase,
    action: activity.action,
    target: activity.target,
    attachments: [],
    changes: [],
  }));
}

/** 一次消息里的附件：图片直接显示缩略图，其它文件给一个下载入口。 */
function AttachmentList({
  bizLine,
  requirementId,
  attachments,
  onRemove,
}: {
  bizLine: string;
  requirementId: number;
  attachments: BusinessRequirementAttachment[];
  onRemove?: (attachment: BusinessRequirementAttachment) => void;
}) {
  const { t } = useLocale();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // 会话在轮询中每 1.5 秒重建一次数组，按 id 收敛依赖，避免图片被反复重新拉取。
  const imageIds = attachments.filter((item) => item.isImage).map((item) => item.id).join(",");

  useEffect(() => {
    // 附件走本系统鉴权读回，img 标签直接取地址是拿不到的，只能先取 blob。
    let cancelled = false;
    const created: string[] = [];
    const images = imageIds ? imageIds.split(",") : [];
    void Promise.all(
      images.map(async (id) => {
        try {
          const blob = await fetchBusinessRequirementAttachment(bizLine, requirementId, id);
          const url = URL.createObjectURL(blob);
          created.push(url);
          return [id, url] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setPreviews(Object.fromEntries(entries.filter(Boolean) as (readonly [string, string])[]));
    });
    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [bizLine, imageIds, requirementId]);

  const download = async (attachment: BusinessRequirementAttachment) => {
    try {
      const blob = await fetchBusinessRequirementAttachment(bizLine, requirementId, attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  if (!attachments.length) return null;
  return (
    <div className="manager-business-chat__attachments">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="manager-business-chat__attachment" title={attachment.name}>
          {attachment.isImage && previews[attachment.id] ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={previews[attachment.id]} alt={attachment.name} onClick={() => void download(attachment)} />
          ) : (
            <button type="button" onClick={() => void download(attachment)}>
              <PaperClipOutlined />
              <span>{attachment.name}</span>
            </button>
          )}
          {onRemove ? (
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label={t("businessWorkbench.attachment.remove")}
              onClick={() => onRemove(attachment)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
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
  // 已上传、还没随消息发出的附件。发送成功后清空，发送失败时保留，重试不用再传一遍。
  const [pending, setPending] = useState<BusinessRequirementAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // 本轮 @ 引用的历史文档。和附件一样，发送成功后清空、失败时保留可重试。
  const [referenced, setReferenced] = useState<BusinessDocumentReference[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const loadSequenceRef = useRef(0);

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

	// 服务端每次 GET 都会同步转查一次远端 Bridge，快慢不定，响应可能乱序到达。
	// 只让最后发出的那次请求写状态，避免旧快照把新的流式内容顶掉。
	const loadConversation = useCallback(async (requirementId: number, silent = false) => {
		if (!activeBusinessLine.id) return;
		const sequence = ++loadSequenceRef.current;
		if (!silent) setConversationLoading(true);
		try {
			const snapshot = await fetchBusinessRequirementConversation(activeBusinessLine.id, requirementId);
			if (sequence === loadSequenceRef.current) setConversation(snapshot);
    } catch (error) {
			if (sequence === loadSequenceRef.current) setConversation(null);
      message.error((error as Error).message);
    } finally {
		if (!silent) setConversationLoading(false);
		}
	}, [activeBusinessLine.id]);

  useEffect(() => {
    if (businessLinesLoaded) void refreshRequirements();
  }, [businessLinesLoaded, refreshRequirements]);

	useEffect(() => {
		setReferenced([]);
		if (selectedRequirementId) {
			void loadConversation(selectedRequirementId);
    } else {
      setConversation(null);
    }
	}, [loadConversation, selectedRequirementId]);

	// 与本地插件会话一致：POST 只受理一轮，随后由浏览器轮询本系统的
	// 会话快照。本系统再转查远端 Bridge，并把完成的内容沉淀为业务文档。
	// sending 期间不轮询：那时远端会话还没登记成 running，快照会返回 active=false，
	// 既会把等待态闪掉，也会把轮询自己拆掉，直到 POST 返回才重新开始。
	// 用「上一次拿到结果后再排下一次」代替固定间隔，慢响应不会堆叠成并发请求。
	useEffect(() => {
		if (!selectedRequirementId || sending || !conversation?.active) return undefined;
		let stopped = false;
		let timer = 0;
		const tick = async () => {
			await loadConversation(selectedRequirementId, true);
			if (!stopped) timer = window.setTimeout(() => void tick(), 900);
		};
		timer = window.setTimeout(() => void tick(), 900);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, [conversation?.active, loadConversation, selectedRequirementId, sending]);

  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [conversation?.messages?.length, conversation?.streamingReply, conversationLoading]);

  const searchDocumentReferences = useCallback(async (keyword: string) => {
    if (!selectedRequirementId || !activeBusinessLine.id) return [];
    return fetchBusinessDocumentReferences(activeBusinessLine.id, selectedRequirementId, keyword);
  }, [activeBusinessLine.id, selectedRequirementId]);

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
    const attachments = pending;
    const documents = referenced;
    setDraft("");
    setPending([]);
    setReferenced([]);
    setSending(true);
    // 先把这条业务诉求乐观地贴进消息列表并进入等待态：请求还在路上时，
    // 用户就能看到自己说的话和"AI 正在处理"，落库后的快照会覆盖它。
    const optimisticId = -Date.now();
    const optimistic: BusinessRequirementMessage = {
      id: optimisticId,
      role: "user",
      content,
      attachments,
      createdAt: new Date().toISOString(),
    };
    setConversation((current) =>
      current ? { ...current, messages: [...(current.messages ?? []), optimistic], active: true } : current,
    );
    try {
      await sendBusinessRequirementMessage(
        activeBusinessLine.id,
        selectedRequirementId,
        content,
        attachments.map((item) => item.id),
        documents.map((item) => item.documentId),
      );
      await Promise.all([loadConversation(selectedRequirementId, true), refreshRequirements()]);
    } catch (error) {
      // The server records the business user's statement before calling the
      // remote AI, so reloading preserves that statement after a remote error.
      setDraft(content);
      setPending(attachments);
      setReferenced(documents);
      await loadConversation(selectedRequirementId, true);
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  /**
   * 「确认文档」：访谈聊到够用了就在这里收口，让 AI 停止追问、直接把已经说过的
   * 内容整理成一份完整文档。输入框里没写完的话不丢，作为补充说明一起带上。
   *
   * 这里不做乐观气泡：那句「确认文档」的原话由服务端写进消息表，前端再拼一遍
   * 只会在快照回来时闪一下不一致的文案。
   */
  const confirmDocument = async () => {
    if (!selectedRequirementId || !activeBusinessLine.id || sending || conversation?.active) return;
    const supplement = draft.trim();
    const attachments = pending;
    const documents = referenced;
    setSending(true);
    try {
      await sendBusinessRequirementMessage(
        activeBusinessLine.id,
        selectedRequirementId,
        supplement,
        attachments.map((item) => item.id),
        documents.map((item) => item.documentId),
        "document",
      );
      setDraft("");
      setPending([]);
      setReferenced([]);
      await Promise.all([loadConversation(selectedRequirementId, true), refreshRequirements()]);
      message.success(t("businessWorkbench.confirmDocumentStarted"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (!selectedRequirementId || !activeBusinessLine.id || !files.length) return;
    if (pending.length + files.length > MAX_MESSAGE_ATTACHMENTS) {
      message.error(`${t("businessWorkbench.attachment.tooMany")}${MAX_MESSAGE_ATTACHMENTS}`);
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadBusinessRequirementAttachments(activeBusinessLine.id, selectedRequirementId, files);
      setPending((current) => [...current, ...uploaded]);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setUploading(false);
    }
  };

  /** 粘贴板里的图片和文件直接当附件上传，正文里的文字仍按普通粘贴处理。 */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void uploadFiles(files);
  };

  const renderMessage = (item: BusinessRequirementMessage) => {
    const isUser = item.role === "user";
    return (
      <article key={item.id} className={`manager-business-chat__message${isUser ? " manager-business-chat__message--user" : ""}`}>
        <div className="manager-business-chat__message-meta">
          {isUser ? t("businessWorkbench.message.business") : t("businessWorkbench.message.ai")}
          <span>{formatTime(item.createdAt, locale)}</span>
        </div>
        <div className="manager-business-chat__bubble"><SessionMarkdown text={item.content} /></div>
        {item.attachments?.length && selectedRequirementId ? (
          <AttachmentList
            bizLine={activeBusinessLine.id}
            requirementId={selectedRequirementId}
            attachments={item.attachments}
          />
        ) : null}
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

			  {conversation.documents?.length ? (
                <BusinessRequirementDocuments documents={conversation.documents} collapsible defaultOpen={false} />
              ) : null}

			  <div className="manager-business-chat__messages">
				{conversation.remoteError ? <Alert type="error" showIcon message={conversation.remoteError} /> : null}
				{conversation.messages?.length ? conversation.messages.map(renderMessage) : (
                  <div className="manager-business-chat__empty-message">
                    <MessageOutlined />
                    <span>{t("businessWorkbench.conversationEmpty")}</span>
                  </div>
				)}
				{conversation.active && conversation.streamingActivities?.length ? (
				  <section className="manager-business-chat__activity" aria-live="polite">
					{groupSessionItems(conversationItemsOf(conversation.streamingActivities)).map((group) => (group.kind === "process" ? (
					  <SessionProcessGroup items={group.items} key={group.id} />
					) : (
					  <div className="manager-business-chat__bubble" key={group.id}><SessionMarkdown text={group.item.text} /></div>
					)))}
				  </section>
				) : null}
				{conversation.streamingReply ? (
				  <article className="manager-business-chat__message manager-business-chat__message--streaming">
					<div className="manager-business-chat__message-meta">
					  {t("businessWorkbench.message.ai")}
					  <span>{t("businessWorkbench.aiWorking")}</span>
					</div>
					<div className="manager-business-chat__bubble"><SessionMarkdown text={conversation.streamingReply} /></div>
				  </article>
				) : null}
				{conversation.active ? (
				  <div className="manager-business-chat__pending"><Spin size="small" /><span>{t("businessWorkbench.aiWorking")}</span></div>
				) : null}
				<div ref={messagesEndRef} />
              </div>

              <footer className="manager-business-chat__composer">
                {pending.length ? (
                  <AttachmentList
                    bizLine={activeBusinessLine.id}
                    requirementId={selectedRequirementId ?? 0}
                    attachments={pending}
                    onRemove={(item) => setPending((current) => current.filter((entry) => entry.id !== item.id))}
                  />
                ) : null}
                <div className="manager-business-chat__composer-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    void uploadFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <Tooltip title={t("businessWorkbench.attachment.add")}>
                  <Button
                    icon={<PaperClipOutlined />}
                    loading={uploading}
                    disabled={sending || conversation.active}
                    onClick={() => fileInputRef.current?.click()}
                  />
                </Tooltip>
                <BusinessRequirementMentionInput
                  value={draft}
                  onChange={setDraft}
                  disabled={sending || conversation.active}
                  placeholder={t("businessWorkbench.inputPlaceholder")}
                  maxReferences={MAX_MESSAGE_REFERENCES}
                  references={referenced}
                  onReferencesChange={setReferenced}
                  onSearchCandidates={searchDocumentReferences}
                  onPaste={handlePaste}
                  onPressEnter={(event) => {
                    if (event.shiftKey) return;
                    event.preventDefault();
                    void sendMessage();
                  }}
                />
                <Tooltip title={t("businessWorkbench.confirmDocumentTip")}>
                  <Button
                    icon={<FileDoneOutlined />}
                    loading={sending}
                    disabled={conversation.active || !conversation.messages?.length}
                    onClick={() => void confirmDocument()}
                  >
                    {t("businessWorkbench.confirmDocument")}
                  </Button>
                </Tooltip>
				<Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!draft.trim() || conversation.active} onClick={() => void sendMessage()}>
                  {t("businessWorkbench.send")}
                </Button>
                </div>
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
