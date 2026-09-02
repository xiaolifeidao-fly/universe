"use client";

import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, ClipboardList, MessageSquareText, ShieldCheck } from "lucide-react";
import { getSession, hasPersona } from "@/lib/auth";

export function BusinessHomeScreen() {
  const session = getSession();
  const business = hasPersona("business", session);
  const productResearch = hasPersona("product_research", session);

  return (
    <main className="screen business-home">
      <header className="business-home__hero">
        <div className="business-home__mark"><BriefcaseBusiness size={22} aria-hidden="true" /></div>
        <p className="eyebrow">业务</p>
        <h1>业务诉求</h1>
        <p>提出一线业务想法，或查看当前空间已经收集的诉求。</p>
        <div className="business-personas" aria-label="当前工作身份">
          {business ? <span><MessageSquareText size={14} />业务方</span> : null}
          {productResearch ? <span><ShieldCheck size={14} />产品产研</span> : null}
        </div>
      </header>

      <section className="business-entry-list" aria-label="业务栏目入口">
        {business ? (
          <Link className="business-entry" href="/business/workbench">
            <span className="business-entry__icon is-green"><MessageSquareText size={21} /></span>
            <span className="business-entry__copy"><strong>业务工作台</strong><small>和业务访谈 AI 交流，持续整理并确认诉求文档。</small></span>
            <ArrowRight size={19} aria-hidden="true" />
          </Link>
        ) : null}
        {productResearch ? (
          <Link className="business-entry" href="/business/intake">
            <span className="business-entry__icon"><ClipboardList size={21} /></span>
            <span className="business-entry__copy"><strong>诉求采集</strong><small>查看业务方原始观点、访谈过程和 AI 整理文档。</small></span>
            <ArrowRight size={19} aria-hidden="true" />
          </Link>
        ) : null}
      </section>
    </main>
  );
}
