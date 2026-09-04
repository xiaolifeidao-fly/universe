"use client";

import { AlertTriangle, ClipboardList, FileText, LoaderCircle, Paperclip, RotateCw, Search, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import {
  getCollectedBusinessConversation,
  listCollectedBusinessRequirements,
  type BusinessConversation,
  type BusinessDocument,
  type BusinessRequirement,
} from "@/api/business.api";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { Sheet } from "@/components/sheet";
import { useSpace } from "@/components/space-provider";
import { RichText } from "@/components/workbench/rich-text";
import { hasPersona } from "@/lib/auth";

export function BusinessIntakeScreen() {
  const { bizLine, spaceName } = useSpace();
  const [requirements, setRequirements] = useState<BusinessRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<BusinessConversation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const allowed = hasPersona("product_research");

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError("");
    try {
      const page = await listCollectedBusinessRequirements(bizLine);
      setRequirements(page.data ?? []);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取诉求采集列表。");
    } finally {
      setLoading(false);
    }
  }, [allowed, bizLine]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return requirements.filter((item) => !query || item.title.toLowerCase().includes(query)
      || item.detail.toLowerCase().includes(query) || item.programName.toLowerCase().includes(query)
      || item.createdByName.toLowerCase().includes(query));
  }, [keyword, requirements]);

  const openDetail = async (requirement: BusinessRequirement) => {
    setDetailLoading(true);
    setError("");
    try {
      setSelected(await getCollectedBusinessConversation(bizLine, requirement.id));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取诉求详情。");
    } finally {
      setDetailLoading(false);
    }
  };

  if (!allowed) {
    return <main className="screen"><EmptyState icon={<ClipboardList size={24} />} title="当前账号没有产品产研身份" description="诉求采集只向产品产研身份开放。" /></main>;
  }

  return (
    <main className="screen business-intake">
      <div className="screen-title-row">
        <div><p className="eyebrow">{spaceName}</p><h1>诉求采集</h1><p>业务方原始观点、访谈记录和 AI 整理文档。</p></div>
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新诉求采集" title="刷新" disabled={loading}><RotateCw size={21} className={loading ? "spin-icon" : ""} /></button>
      </div>

      <p className="business-intake__notice"><AlertTriangle size={18} />这里只收集业务诉求，不会自动进入交付需求或任务看板。</p>
      <label className="workbench-search business-intake__search"><Search size={19} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索诉求、项目或提出人" aria-label="搜索业务诉求" /></label>

      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}
      {loading ? <LoadingState title="正在读取业务诉求" /> : null}
      {!loading && !error && !rows.length ? <EmptyState icon={<ClipboardList size={24} />} title="没有匹配的业务诉求" description="业务方完成提交后会显示在这里。" /> : null}

      <section className="business-intake-list" aria-label="业务诉求采集列表">
        {rows.map((requirement) => (
          <button className="business-intake-row" type="button" onClick={() => void openDetail(requirement)} key={requirement.id}>
            <span className="business-intake-row__top"><span className="tag">{requirement.programName || requirement.programCode || `项目 #${requirement.programId}`}</span><time>{formatDate(requirement.updatedAt || requirement.createdAt)}</time></span>
            <strong>{requirement.title || "未命名业务诉求"}</strong>
            <p>{requirement.detail || "业务方尚未发送第一条想法"}</p>
            <span className="business-intake-row__footer"><span><UserRound size={16} />{requirement.createdByName || requirement.createdBy}</span><span>查看详情</span></span>
          </button>
        ))}
      </section>

      <Sheet open={Boolean(selected) || detailLoading} title="业务诉求详情" subtitle={selected?.requirement.title || "正在读取"} onClose={() => { if (!detailLoading) setSelected(null); }}>
        {detailLoading ? <div className="business-detail-loading"><LoaderCircle size={24} className="spin-icon" /><span>正在读取访谈记录</span></div> : null}
        {selected && !detailLoading ? <BusinessIntakeDetail conversation={selected} /> : null}
      </Sheet>
    </main>
  );
}

function BusinessIntakeDetail({ conversation }: { conversation: BusinessConversation }) {
  // 一场访谈只有一份文档：业务方点「确认文档」之后才产出，服务端只回这一份。
  const intakeDocument = conversation.documents?.[0];
  return (
    <div className="business-intake-detail">
      <dl className="business-detail-grid">
        <div><dt>关联项目</dt><dd>{conversation.program.name || conversation.program.programCode}</dd></div>
        <div><dt>提出人</dt><dd>{conversation.requirement.createdByName || conversation.requirement.createdBy}</dd></div>
        <div><dt>提交时间</dt><dd>{formatDate(conversation.requirement.createdAt)}</dd></div>
        <div><dt>当前状态</dt><dd>{conversation.active ? "交流中" : intakeDocument ? "已整理" : "已提交"}</dd></div>
      </dl>
      <section className="business-detail-section">
        <div className="section-heading"><span>业务诉求文档</span><FileText size={20} /></div>
        {intakeDocument ? <CollectedDocument intakeDocument={intakeDocument} /> : <p className="muted">业务方还没有确认业务诉求文档。</p>}
      </section>
      <section className="business-detail-section">
        <div className="section-heading"><span>访谈记录</span><span className="muted">{conversation.messages.length} 条</span></div>
        <div className="business-collected-messages">
          {conversation.messages.map((message) => (
            <article className={message.role === "user" ? "is-user" : ""} key={message.id}>
              <small>{message.role === "user" ? conversation.requirement.createdByName || "业务方" : "业务访谈 AI"}</small>
              <RichText text={message.content} />
              {/* 采集是只读视角：附件本体只对提出人本人开放，这里只列清单不给下载。 */}
              {message.attachments?.length ? (
                <ul className="business-collected-attachments">
                  {message.attachments.map((attachment) => <li key={attachment.id}><Paperclip size={14} aria-hidden="true" />{attachment.name}</li>)}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * 产研看到的那份业务诉求文档。访谈过程中不再逐轮沉淀整理，一场对话就这一份，
 * 所以这里没有版本步进，和控制台的文档面板一个口径。
 */
function CollectedDocument({ intakeDocument }: { intakeDocument: BusinessDocument }) {
  return (
    <div className="business-collected-document">
      {intakeDocument.confirmed ? <span className="status is-success">已确认</span> : null}
      <h3>{intakeDocument.title}</h3>
      <RichText text={intakeDocument.content} />
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "-" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
