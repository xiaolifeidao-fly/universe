"use client";

import { useParams, useRouter } from "next/navigation";
import { AtSign, ArrowLeft, ChevronLeft, ChevronRight, FileCheck2, FileText, LoaderCircle, Paperclip, RotateCw, Search, SendHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import {
  getBusinessAttachment,
  getBusinessConversation,
  listBusinessDocumentReferences,
  sendBusinessMessage,
  uploadBusinessAttachments,
  type BusinessAttachment,
  type BusinessConversation,
  type BusinessDocument,
  type BusinessDocumentReference,
} from "@/api/business.api";
import { EmptyState } from "@/components/empty-state";
import { Sheet } from "@/components/sheet";
import { useSpace } from "@/components/space-provider";
import { ConversationItemStream } from "@/components/workbench/conversation-turns";
import { VoiceInputButton } from "@/components/workbench/voice-input-button";
import { RichText } from "@/components/workbench/rich-text";
import type { ConversationItem } from "@/features/workbench/types";
import { hasPersona } from "@/lib/auth";

/** 与服务端和远端桥一致的单条消息附件上限。 */
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 与服务端 maxMessageReferences 一致：@ 进来的文档整篇进提示词，多了会淹没本轮诉求。 */
const MAX_REFERENCES = 5;
/** 远端一轮访谈的回读节奏。上一次拿到结果后再排下一次，慢响应不会堆成并发请求。 */
const POLL_DELAY_MS = 900;

export function BusinessConversationScreen() {
  const router = useRouter();
  const { requirementId: rawRequirementId } = useParams<{ requirementId: string }>();
  const requirementId = Number(rawRequirementId);
  const { bizLine } = useSpace();
  const [conversation, setConversation] = useState<BusinessConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // 已上传、还没随消息发出的附件。发送成功后清空，发送失败时保留，重试不用再传一遍。
  const [pending, setPending] = useState<BusinessAttachment[]>([]);
  // 本轮 @ 引用的历史文档。和附件一样，发送成功后清空、失败时保留可重试。
  const [referenced, setReferenced] = useState<BusinessDocumentReference[]>([]);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documentIndex, setDocumentIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // 服务端每次 GET 都会同步转查一次远端 Bridge，快慢不定，响应可能乱序到达。
  // 只让最后发出的那次请求写状态，避免旧快照把新的流式内容顶掉。
  const loadSequenceRef = useRef(0);
  const allowed = hasPersona("business");
  const validRequirement = Number.isInteger(requirementId) && requirementId > 0;

  const load = useCallback(async (silent = false) => {
    if (!allowed || !validRequirement) {
      setError("业务诉求标识无效。");
      setLoading(false);
      return;
    }
    const sequence = ++loadSequenceRef.current;
    if (!silent) setLoading(true);
    try {
      const snapshot = await getBusinessConversation(bizLine, requirementId);
      if (sequence !== loadSequenceRef.current) return;
      setConversation(snapshot);
    } catch (reason) {
      if (sequence !== loadSequenceRef.current || silent) return;
      setError(reason instanceof ApiError ? reason.message : "无法读取业务会话。");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [allowed, bizLine, requirementId, validRequirement]);

  useEffect(() => { void load(); }, [load]);

  // 与控制台一致：POST 只受理一轮，随后由前端轮询本系统的会话快照，本系统再转查
  // 远端 Bridge。sending 期间不轮询：那时远端会话还没登记成 running，快照会返回
  // active=false，既会把等待态闪掉，也会把轮询自己拆掉，直到 POST 返回才重新开始。
  useEffect(() => {
    if (!validRequirement || sending || !conversation?.active) return undefined;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      await load(true);
      if (!stopped) timer = window.setTimeout(() => void tick(), POLL_DELAY_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_DELAY_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [conversation?.active, load, sending, validRequirement]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [conversation?.messages.length, conversation?.streamingReply, sending]);

  // 输入框跟着内容长高。语音听写是程序化写入，不会触发 onInput，所以统一放在这里做。
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 148)}px`;
  }, [message]);

  // 轮询每秒都会换一份快照，版本指针只在真的多出一版时才跟到最新，
  // 否则正在翻旧版本的人会被不断弹回最后一版。
  const documentCount = conversation?.documents?.length ?? 0;
  useEffect(() => { setDocumentIndex(Math.max(0, documentCount - 1)); }, [documentCount]);

  const uploadFiles = async (files: File[]) => {
    if (!validRequirement || !files.length) return;
    if (pending.length + files.length > MAX_ATTACHMENTS) {
      setError(`一条消息最多携带 ${MAX_ATTACHMENTS} 个附件。`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setError(`附件 ${oversized.name} 超过 20 MB。`);
      return;
    }
    setUploading(true);
    setError("");
    try {
      const uploaded = await uploadBusinessAttachments(bizLine, requirementId, files);
      setPending((current) => [...current, ...uploaded]);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "附件上传失败。");
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const content = message.trim();
    if (!validRequirement || sending || conversation?.active || !content) return;
    const attachments = pending;
    const documents = referenced;
    setMessage("");
    setPending([]);
    setReferenced([]);
    setSending(true);
    setError("");
    // 先把这条业务诉求乐观地贴进消息列表并进入等待态：请求还在路上时，
    // 用户就能看到自己说的话和「AI 正在处理」，落库后的快照会覆盖它。
    const optimistic = {
      id: -Date.now(),
      role: "user" as const,
      content,
      attachments,
      createdAt: new Date().toISOString(),
    };
    setConversation((current) => (current ? { ...current, messages: [...(current.messages ?? []), optimistic], active: true } : current));
    try {
      await sendBusinessMessage(bizLine, requirementId, content, attachments.map((item) => item.id), documents.map((item) => item.documentId));
      await load(true);
    } catch (reason) {
      // 服务端在调用远端 AI 之前就把这句原话落了库，重新读一次快照即可保住它，
      // 输入框里的内容和已上传附件原样退回，重试不用再写一遍、也不用再传一遍。
      setMessage(content);
      setPending(attachments);
      setReferenced(documents);
      await load(true);
      setError(reason instanceof ApiError ? reason.message : "这条消息没有发送成功。");
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
    if (!validRequirement || sending || conversation?.active || !conversation?.messages.length) return;
    const supplement = message.trim();
    const attachments = pending;
    const documents = referenced;
    setSending(true);
    setError("");
    try {
      await sendBusinessMessage(bizLine, requirementId, supplement, attachments.map((item) => item.id), documents.map((item) => item.documentId), "document");
      setMessage("");
      setPending([]);
      setReferenced([]);
      await load(true);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "确认文档没有发起成功。");
    } finally {
      setSending(false);
    }
  };

  const searchReferences = useCallback((keyword: string) => {
    if (!validRequirement) return Promise.resolve<BusinessDocumentReference[]>([]);
    return listBusinessDocumentReferences(bizLine, requirementId, keyword);
  }, [bizLine, requirementId, validRequirement]);

  if (!allowed) {
    return <div className="chat-screen"><EmptyState icon={<FileText size={24} />} title="当前账号没有业务方身份" description="无法进入业务诉求会话。" /></div>;
  }

  const documents = conversation?.documents ?? [];
  const activeDocument = documents[documentIndex] ?? documents[documents.length - 1];
  const composerLocked = sending || Boolean(conversation?.active);

  return (
    <div className="chat-screen business-chat">
      <header className="chat-header">
        <button className="icon-button" type="button" onClick={() => router.push("/business/workbench")} aria-label="返回业务工作台" title="返回"><ArrowLeft size={22} /></button>
        <div className="chat-header__title"><small>业务工作台</small><strong>{conversation?.requirement.title || "新的业务诉求"}</strong></div>
        <div className="chat-header__actions">
          <button className="icon-button" type="button" onClick={() => setDocumentsOpen(true)} aria-label="查看整理文档" title="整理文档"><FileText size={21} /></button>
          <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新会话" title="刷新" disabled={loading}><RotateCw size={21} className={loading ? "spin-icon" : ""} /></button>
        </div>
      </header>

      <div className="chat-body">
        {loading && !conversation ? <EmptyState icon={<LoaderCircle size={24} className="spin-icon" />} title="正在读取业务会话" description="正在恢复访谈记录和整理文档。" /> : null}
        {!loading && !conversation ? <EmptyState tone="error" icon={<X size={24} />} title="无法读取业务会话" description={error || "请稍后重试。"} action={<button className="button button-primary" type="button" onClick={() => void load()}>重新读取</button>} /> : null}
        {conversation ? (
          <div className="business-message-list">
            {documents.length ? (
              <button className="business-document-banner" type="button" onClick={() => setDocumentsOpen(true)}>
                <span><FileCheck2 size={20} /><strong>AI 最新整理 · 第 {documents[documents.length - 1].version} 版</strong></span>
                <small>{documents[documents.length - 1].confirmed ? "已确认业务诉求文档" : "点击查看本轮整理内容"}</small>
              </button>
            ) : null}
            {conversation.remoteError ? <p className="form-message is-error" role="alert">{conversation.remoteError}</p> : null}
            {!conversation.messages.length ? <EmptyState icon={<SendHorizontal size={23} />} title="从第一条业务想法开始" description={`已关联项目“${conversation.program.name || conversation.program.programCode}”，直接说清你遇到的问题和期望。`} /> : null}
            {conversation.messages.map((item) => (
              <article className={`message ${item.role === "user" ? "message--user" : "message--agent is-final"}`} key={item.id}>
                <RichText text={item.content} />
                <AttachmentList bizLine={bizLine} requirementId={requirementId} attachments={item.attachments ?? []} onError={setError} />
              </article>
            ))}
            {conversation.active && conversation.streamingActivities?.length ? (
              <ConversationItemStream items={conversationItemsOf(conversation)} />
            ) : null}
            {conversation.streamingReply ? <article className="message message--agent"><RichText text={conversation.streamingReply} /></article> : null}
            {conversation.active ? <p className="chat-running" role="status"><LoaderCircle size={17} className="spin-icon" />业务访谈 AI 正在整理这一轮</p> : null}
          </div>
        ) : null}
        {error && conversation ? <p className="form-message is-error" role="alert">{error}</p> : null}
        <div ref={bottomRef} />
      </div>

      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        {referenced.length ? (
          <ul className="business-reference-chips" aria-label="本轮引用的文档">
            {referenced.map((item) => (
              <li key={item.documentId}>
                <AtSign size={14} aria-hidden="true" />
                <span>{item.title || item.requirementTitle}</span>
                <button type="button" onClick={() => setReferenced((current) => current.filter((entry) => entry.documentId !== item.documentId))} aria-label={`移除引用 ${item.title}`}>×</button>
              </li>
            ))}
          </ul>
        ) : null}
        {pending.length ? (
          <div className="business-pending-attachments">
            <AttachmentList
              bizLine={bizLine}
              requirementId={requirementId}
              attachments={pending}
              onError={setError}
              onRemove={(item) => setPending((current) => current.filter((entry) => entry.id !== item.id))}
            />
          </div>
        ) : null}
        <div className="business-confirm-row">
          <button className="button button-quiet" type="button" onClick={() => void confirmDocument()} disabled={composerLocked || !conversation?.messages.length}><FileCheck2 size={18} />确认文档</button>
          <small>聊清楚后让 AI 停止追问并形成正式文档</small>
        </div>
        {/* 附件、引用、语音三个入口挤在一行会把输入框压到不足一半宽，这里让输入框独占一行。 */}
        <div className="chat-composer__row chat-composer__row--stacked">
          <textarea ref={composerRef} value={message} onChange={(event) => setMessage(event.target.value)} rows={1} placeholder="继续描述你的业务想法" aria-label="业务想法" enterKeyHint="send" disabled={composerLocked} />
          <div className="chat-composer__tools">
            <label className="icon-button" title="添加附件">
              {uploading ? <LoaderCircle size={21} className="spin-icon" /> : <Paperclip size={21} />}
              <input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx" disabled={composerLocked || uploading} onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <span className="visually-hidden">添加附件</span>
            </label>
            <button className="icon-button" type="button" onClick={() => setReferencesOpen(true)} disabled={composerLocked} aria-label="引用历史文档" title="引用历史文档"><AtSign size={21} /></button>
            <VoiceInputButton value={message} onChange={setMessage} onNotice={setError} disabled={composerLocked} />
            <button className="chat-send" type="submit" disabled={composerLocked || !message.trim()} aria-label="发送">{sending ? <LoaderCircle size={21} className="spin-icon" /> : <SendHorizontal size={21} />}</button>
          </div>
        </div>
      </form>

      <Sheet open={documentsOpen} title="AI 整理文档" subtitle={documents.length ? `共 ${documents.length} 个版本` : "尚未生成"} onClose={() => setDocumentsOpen(false)}>
        {documents.length && activeDocument ? (
          <BusinessDocumentViewer document={activeDocument} documents={documents} index={documentIndex} onSelect={setDocumentIndex} />
        ) : <EmptyState icon={<FileText size={23} />} title="暂时没有整理文档" description="完成一轮业务访谈后，AI 会在这里沉淀整理结果。" />}
      </Sheet>

      <ReferencePickerSheet
        open={referencesOpen}
        selected={referenced}
        onClose={() => setReferencesOpen(false)}
        onSelect={setReferenced}
        onSearch={searchReferences}
      />
    </div>
  );
}

/**
 * 远端过程条目转成工作台会话用的条目结构，直接复用那套渲染：推理、命令、读写
 * 文件都收进同一种折叠行，展示口径和产研侧完全一致。
 */
function conversationItemsOf(conversation: BusinessConversation): ConversationItem[] {
  return (conversation.streamingActivities ?? []).map((activity, index) => ({
    id: activity.id || `${activity.type}-${index}`,
    type: activity.type,
    text: activity.text,
    action: activity.action,
    target: activity.target,
    status: activity.status,
    phase: activity.phase,
    attachments: [],
    changes: [],
  }));
}

/** 一条消息里的附件：图片直接显示缩略图，其它文件给一个下载入口。 */
function AttachmentList({
  bizLine,
  requirementId,
  attachments,
  onError,
  onRemove,
}: {
  bizLine: string;
  requirementId: number;
  attachments: BusinessAttachment[];
  onError: (message: string) => void;
  onRemove?: (attachment: BusinessAttachment) => void;
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // 会话在轮询中每秒重建一次数组，按 id 收敛依赖，避免图片被反复重新拉取。
  const imageIds = attachments.filter((item) => item.isImage).map((item) => item.id).join(",");

  useEffect(() => {
    // 附件走本系统鉴权读回，img 标签直接取地址是拿不到的，只能先取 blob。
    let cancelled = false;
    const created: string[] = [];
    const ids = imageIds ? imageIds.split(",") : [];
    if (!ids.length) {
      setPreviews({});
      return () => { cancelled = true; };
    }
    void Promise.all(ids.map(async (id) => {
      try {
        const blob = await getBusinessAttachment(bizLine, requirementId, id);
        const url = URL.createObjectURL(blob);
        created.push(url);
        return [id, url] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      setPreviews(Object.fromEntries(entries.filter(Boolean) as (readonly [string, string])[]));
    });
    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [bizLine, imageIds, requirementId]);

  const download = async (attachment: BusinessAttachment) => {
    try {
      const blob = await getBusinessAttachment(bizLine, requirementId, attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      onError(reason instanceof ApiError ? reason.message : "附件读取失败。");
    }
  };

  if (!attachments.length) return null;
  return (
    <div className="business-message-attachments">
      {attachments.map((attachment) => (
        <span className="business-attachment" key={attachment.id} title={attachment.name}>
          {attachment.isImage && previews[attachment.id] ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={previews[attachment.id]} alt={attachment.name} onClick={() => void download(attachment)} />
          ) : (
            <button type="button" onClick={() => void download(attachment)}><Paperclip size={15} />{attachment.name}</button>
          )}
          {onRemove ? <button className="business-attachment__remove" type="button" onClick={() => onRemove(attachment)} aria-label={`移除附件 ${attachment.name}`}>×</button> : null}
        </span>
      ))}
    </div>
  );
}

/** @ 引用面板：同项目其它访谈已经沉淀的整理文档，选中的作为本轮只读上下文发出。 */
function ReferencePickerSheet({
  open,
  selected,
  onClose,
  onSelect,
  onSearch,
}: {
  open: boolean;
  selected: BusinessDocumentReference[];
  onClose: () => void;
  onSelect: (next: BusinessDocumentReference[]) => void;
  onSearch: (keyword: string) => Promise<BusinessDocumentReference[]>;
}) {
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState<BusinessDocumentReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const selectedIds = useMemo(() => new Set(selected.map((item) => item.documentId)), [selected]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    // 输入时不逐字打服务端：停下来再查一次，手机上的弱网也不会排队。
    const timer = window.setTimeout(() => {
      void onSearch(keyword.trim()).then((rows) => {
        if (cancelled) return;
        setCandidates(rows ?? []);
        setError("");
      }).catch((reason: unknown) => {
        if (cancelled) return;
        setCandidates([]);
        setError(reason instanceof ApiError ? reason.message : "无法读取可引用的文档。");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [keyword, onSearch, open]);

  const toggle = (item: BusinessDocumentReference) => {
    if (selectedIds.has(item.documentId)) {
      onSelect(selected.filter((entry) => entry.documentId !== item.documentId));
      return;
    }
    if (selected.length >= MAX_REFERENCES) {
      setError(`一条消息最多引用 ${MAX_REFERENCES} 份文档。`);
      return;
    }
    setError("");
    onSelect([...selected, item]);
  };

  return (
    <Sheet open={open} title="引用历史文档" subtitle={`已选 ${selected.length}/${MAX_REFERENCES} 份`} onClose={onClose}>
      <label className="workbench-search"><Search size={19} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按标题搜索本项目的整理文档" aria-label="搜索可引用的文档" /></label>
      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
      {loading && !candidates.length ? <p className="muted">正在读取可引用的文档…</p> : null}
      {!loading && !candidates.length && !error ? <EmptyState icon={<FileText size={23} />} title="没有可引用的文档" description="同一个项目的其它访谈产出整理文档后，可以在这里引用。" /> : null}
      <div className="option-list">
        {candidates.map((item) => (
          <button className={`option-row${selectedIds.has(item.documentId) ? " is-selected" : ""}`} type="button" key={item.documentId} onClick={() => toggle(item)}>
            <span>
              <strong>{item.title || "业务诉求整理"}</strong>
              <small>{item.requirementTitle || "未命名业务诉求"} · 第 {item.version} 版</small>
            </span>
            {selectedIds.has(item.documentId) ? <span className="status is-active">已引用</span> : null}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function BusinessDocumentViewer({ document, documents, index, onSelect }: { document: BusinessDocument; documents: BusinessDocument[]; index: number; onSelect: (index: number) => void }) {
  return (
    <div className="business-document-viewer">
      <div className="business-document-toolbar">
        <button className="icon-button" type="button" disabled={index <= 0} onClick={() => onSelect(index - 1)} aria-label="上一版" title="上一版"><ChevronLeft size={21} aria-hidden="true" /></button>
        <span>第 {document.version} 版{document.confirmed ? " · 已确认" : ""}</span>
        <button className="icon-button" type="button" disabled={index >= documents.length - 1} onClick={() => onSelect(index + 1)} aria-label="下一版" title="下一版"><ChevronRight size={21} aria-hidden="true" /></button>
      </div>
      <h2>{document.title || "业务诉求整理"}</h2>
      <RichText text={document.content} />
    </div>
  );
}
