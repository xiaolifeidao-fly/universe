"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Empty } from "antd";
import { useLocale } from "@/i18n/LocaleProvider";
import type { CodexConversationChange, CodexConversationItem } from "@/api/delivery.api";

/**
 * 执行器的回复本身就是 Markdown（标题、列表、代码块、文件链接），
 * 直接当纯文本塞进 div 会挤成一坨，和在 Codex / Claude 里看到的完全不是一回事。
 */
export function SessionMarkdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`delivery-session-markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          // 表格可能很宽，让它自己横向滚动，别把整个聊天区撑出滚动条。
          table: ({ children }) => (
            <div className="delivery-session-markdown__table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 聊天右侧文档面板的统一正文组件。任务编辑预览、任务文档与会话文档都复用它，
 * 避免 Markdown 元素在不同入口出现不同字号、间距或空态。
 */
export function SessionDocumentText({ value, fallback }: { value: string; fallback: string }) {
  const source = value.trim();
  if (!source) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={fallback} />;

  return (
    <div className="delivery-session-document__body">
      <SessionMarkdown text={source} className="is-document" />
    </div>
  );
}

/** 一个回合里所有文件变更条目的并集，后写的改动类型覆盖先写的。 */
export function changesOfTurn(items: CodexConversationItem[]): CodexConversationChange[] {
  const merged = new Map<string, CodexConversationChange>();
  for (const item of items) {
    if (item.type !== "fileChange" && item.type !== "fileEdit") continue;
    for (const change of item.changes ?? []) {
      if (change.path) merged.set(change.path, change);
    }
  }
  return Array.from(merged.values());
}

/**
 * 回合末尾的「本次改动」清单。
 *
 * Codex / Claude 的命令行界面里这块是客户端自己按 diff 事件画的，不在模型回复正文里，
 * 面板不补一份的话，看完最终回复也不知道到底动了哪些文件。
 */
export function SessionChangeSummary({ changes }: { changes: CodexConversationChange[] }) {
  const { t } = useLocale();
  if (!changes.length) return null;
  return (
    <section className="delivery-session-changes" aria-label={t("delivery.session.changes")}>
      <header>
        {t("delivery.session.changes")}
        <span>{t("delivery.session.changesCount").replace("{count}", String(changes.length))}</span>
      </header>
      <ul>
        {changes.map((change) => (
          <li key={change.path}>
            <i className={`delivery-session-changes__kind is-${change.kind || "modify"}`}>
              {t(`delivery.session.change.${change.kind || "modify"}`)}
            </i>
            <span className="manager-mono" title={change.path}>{change.path}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
