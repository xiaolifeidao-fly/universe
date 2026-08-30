"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Empty, message } from "antd";
import { BulbOutlined, CodeOutlined, DownOutlined, EditOutlined, EyeOutlined, FileTextOutlined, SearchOutlined, ToolOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import type { CodexConversationAttachment, CodexConversationChange, CodexConversationItem } from "@/api/delivery.api";
import {
  SessionAttachments,
  SessionFilePreviewModal,
  attachmentForMarkdownLink,
  canPreviewConversationAttachment,
  downloadConversationAttachment,
  workspacePathOfMarkdownLink,
} from "./DeliverySessionAttachments";

/**
 * 执行器的回复本身就是 Markdown（标题、列表、代码块、文件链接），
 * 直接当纯文本塞进 div 会挤成一坨，和在 Codex / Claude 里看到的完全不是一回事。
 */
export function SessionMarkdown({
  text,
  className = "",
  onFileLink,
}: {
  text: string;
  className?: string;
  /** 返回 true 时说明这是当前消息已登记的文件，链接改为在预览抽屉中打开。 */
  onFileLink?: (href: string) => boolean;
}) {
  return (
    <div className={`delivery-session-markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => {
                if (href && onFileLink?.(href)) event.preventDefault();
              }}
            >
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
 * 聊天消息统一走这里：除命令执行外都按 Markdown 渲染，避免流式的 plan、reasoning
 * 或用户追加内容落到纯文本分支而直接露出 Markdown 语法。
 */
export function SessionMessageContent({
  item,
  programId,
  fallback = "",
}: {
  item: CodexConversationItem;
  programId: number;
  fallback?: string;
}) {
  const { t } = useLocale();
  const [previewAttachment, setPreviewAttachment] = useState<null | typeof item.attachments[number]>(null);
  const text = item.text || fallback;
  const openFileLink = (href: string) => {
    const attachment = attachmentForMarkdownLink(href, item.attachments);
    if (!attachment) {
      // 指向项目文件的链接在浏览器里点开只会是一个 404 新标签页：
      // 拦下来说清楚它不在工作区，比让人白跳一次强。
      if (!workspacePathOfMarkdownLink(href)) return false;
      message.info(t("delivery.session.filePreviewMissing"));
      return true;
    }
    if (!canPreviewConversationAttachment(attachment)) {
      void downloadConversationAttachment(programId, attachment).catch((error) => message.error((error as Error).message));
      return true;
    }
    setPreviewAttachment(attachment);
    return true;
  };

  return (
    <>
      {item.type === "commandExecution" ? <pre>{text}</pre> : <SessionMarkdown text={text} onFileLink={openFileLink} />}
      <SessionAttachments attachments={item.attachments} programId={programId} onPreview={setPreviewAttachment} />
      <SessionFilePreviewModal
        attachment={previewAttachment}
        programId={programId}
        open={Boolean(previewAttachment)}
        onClose={() => setPreviewAttachment(null)}
      />
    </>
  );
}

/**
 * 过程条目：推理摘要、命令、文件改动、工具调用。
 *
 * 推理摘要也算过程：一轮里它和命令是交替出现的（想一下、跑一条、再想一下），
 * 分成两种块就会一行一块地铺满整屏，谁也没被收起来。它们本来就是同一件事的两面。
 */
const SESSION_PROCESS_TYPES = new Set(["reasoning", "commandExecution", "fileChange", "fileEdit", "mcpToolCall", "dynamicToolCall"]);

export type SessionItemGroup =
  | { kind: "message"; id: string; item: CodexConversationItem }
  | { kind: "process"; id: string; items: CodexConversationItem[] };

/** 把连续的过程条目并成一组，其余条目原样保留，顺序不变。 */
export function groupSessionItems(items: CodexConversationItem[]): SessionItemGroup[] {
  const groups: SessionItemGroup[] = [];
  for (const item of items) {
    if (!SESSION_PROCESS_TYPES.has(item.type)) {
      groups.push({ kind: "message", id: `${item.id}-${item.type}`, item });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === "process") last.items.push(item);
    else groups.push({ kind: "process", id: `process-${item.id}`, items: [item] });
  }
  return groups;
}

/**
 * 一条推理摘要拆成段并去重。
 *
 * 同一份摘要会来自两条通道：实时流按分片攒，`thread/read` 事后又给一份合在一起的全文。
 * 桥接已经按段去过一次重，这里再兜一次，免得同一段在一条条目里出现两遍。
 */
export function reasoningSegments(text: string): string[] {
  const segments: string[] = [];
  const seen = new Set<string>();
  for (const segment of (text || "").split(/\n{2,}/)) {
    const value = segment.trim();
    if (!value) continue;
    const key = value.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(value);
  }
  return segments;
}

/** 摘要每段的头一行就是它的小标题（Codex 会加粗），拿来当过程行的一句话。 */
export function reasoningHeadline(text: string): string {
  const line = (text || "").split("\n").find((value) => value.trim()) || "";
  return line.replace(/[*_`#>]/g, "").trim();
}

/** 执行器跑的命令外面裹着一层 shell（`/bin/zsh -lc "…"`），展示时要把真正的命令剥出来。 */
function shellPayload(command: string): string {
  let text = command.trim();
  const wrapper = text.match(/^(?:\S*\/)?(?:ba|z|)sh\s+-[a-z]*c\s+/);
  if (wrapper) text = text.slice(wrapper[0].length).trim();
  const quote = text.charAt(0);
  if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length > 1) text = text.slice(1, -1).trim();
  // 外层引号剥掉后，里层被转义的引号要还原，否则展示出来全是反斜杠。
  return text.replace(/\\(["'`$])/g, "$1");
}

const READ_COMMANDS = new Set(["cat", "sed", "head", "tail", "nl", "bat", "less", "more"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);

/** 命令行里像路径的那个词：带斜杠或带扩展名，且不是选项或纯数字。 */
function pathToken(tokens: string[]): string {
  const candidates = tokens.filter((token) => !token.startsWith("-") && /[\/.]/.test(token) && !/^[\d,.]+$/.test(token));
  return candidates.at(-1) || "";
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) || path;
}

/** `body` 只有推理摘要有：它是唯一值得在块里就地展开看全文的过程条目。 */
export type SessionProcessRow = { icon: ReactNode; label: string; detail: string; title: string; failed: boolean; body?: string };

/** 一条过程条目在折叠块里显示成什么样：一行摘要 + 悬停可见的完整内容。 */
export function describeProcessItem(item: CodexConversationItem, t: (key: string) => string): SessionProcessRow {
  const failed = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
  if (item.type === "reasoning") {
    const segments = reasoningSegments(item.text);
    const body = segments.join("\n\n");
    const label = reasoningHeadline(segments[0] || "") || t("delivery.session.process.reason");
    // 摘要只有一行小标题时，展开也看不到新东西，就不给它展开态。
    return { icon: <BulbOutlined />, label, detail: "", title: body, failed, body: body === label ? "" : body };
  }
  if (item.type === "fileChange" || item.type === "fileEdit") {
    const changes = item.changes ?? [];
    const added = changes.reduce((total, change) => total + (change.added || 0), 0);
    const removed = changes.reduce((total, change) => total + (change.removed || 0), 0);
    const paths = changes.map((change) => change.path);
    const label = t("delivery.session.process.rowEdit").replace(
      "{target}",
      paths.length === 1 ? basename(paths[0]) : t("delivery.session.process.files").replace("{count}", String(paths.length)),
    );
    const detail = added || removed ? `+${added} -${removed}` : "";
    return { icon: <EditOutlined />, label, detail, title: paths.join("\n") || item.text, failed };
  }
  // Claude 的读文件和检索是具名工具，桥接层把语义放在 action/target 上；
  // Codex 那边是 shell 命令，走下面的命令解析。
  if (item.action === "read") {
    return { icon: <FileTextOutlined />, label: t("delivery.session.process.rowRead").replace("{target}", basename(item.target)), detail: "", title: item.target, failed };
  }
  if (item.action === "search") {
    return {
      icon: <SearchOutlined />,
      label: t("delivery.session.process.rowSearch")
        .replace("{target}", item.target ? basename(item.target) : t("delivery.session.process.workspace"))
        .replace("{pattern}", item.text),
      detail: "",
      title: `${item.text} · ${item.target}`,
      failed,
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return {
      icon: <ToolOutlined />,
      label: t("delivery.session.process.rowTool").replace("{tool}", item.text || t("delivery.session.item.mcpToolCall")),
      detail: "",
      title: item.text,
      failed,
    };
  }
  const payload = shellPayload(item.text);
  // 只看第一段：`cmd && cmd2` 这种连写的，前面那条才代表这一步在干什么。
  const head = payload.split(/&&|\|\||[|;]/)[0].trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  const program = basename(tokens[0] || "");
  if (READ_COMMANDS.has(program)) {
    const target = pathToken(tokens.slice(1));
    if (target) {
      return { icon: <FileTextOutlined />, label: t("delivery.session.process.rowRead").replace("{target}", basename(target)), detail: "", title: payload, failed };
    }
  }
  if (SEARCH_COMMANDS.has(program)) {
    const pattern = head.match(/"([^"]+)"|'([^']+)'/);
    const target = pathToken(tokens.slice(1));
    return {
      icon: <SearchOutlined />,
      label: t("delivery.session.process.rowSearch")
        .replace("{target}", target ? basename(target) : t("delivery.session.process.workspace"))
        .replace("{pattern}", pattern ? pattern[1] || pattern[2] : tokens.at(-1) || ""),
      detail: "",
      title: payload,
      failed,
    };
  }
  return { icon: <CodeOutlined />, label: t("delivery.session.process.rowCommand").replace("{command}", payload), detail: "", title: payload, failed };
}

/** 这一组过程条目做了哪几类事，用来写折叠块的标题。 */
function processSummary(items: CodexConversationItem[], t: (key: string) => string): string {
  const labels: string[] = [];
  const add = (key: string) => {
    const label = t(key);
    if (!labels.includes(label)) labels.push(label);
  };
  for (const item of items) {
    if (item.type === "reasoning") add("delivery.session.process.reason");
    else if (item.type === "fileChange" || item.type === "fileEdit") add("delivery.session.process.edit");
    else if (item.action === "read") add("delivery.session.process.read");
    else if (item.action === "search") add("delivery.session.process.search");
    else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") add("delivery.session.process.tool");
    else {
      const program = basename(shellPayload(item.text).split(/\s+/)[0] || "");
      if (READ_COMMANDS.has(program)) add("delivery.session.process.read");
      else if (SEARCH_COMMANDS.has(program)) add("delivery.session.process.search");
      else add("delivery.session.process.command");
    }
  }
  return labels.join(t("delivery.session.process.separator"));
}

/**
 * 连续的推理、读取、搜索、命令和文件改动收进一个可折叠块。
 *
 * 这些条目单条价值不高，但连起来就是「它在想什么、看了什么、改了什么」，
 * 铺开会把正文冲散，藏起来又等于没有过程，所以按 Codex 桌面版的做法收成一行行摘要。
 * 推理摘要那几行还能就地点开看全文 —— 它是这里唯一有正文可读的条目。
 */
export function SessionProcessGroup({ items }: { items: CodexConversationItem[] }) {
  const { t } = useLocale();
  // 过程日志（运行命令、读写文件和工具调用）通常很长；默认不打断 Claude / Codex 的正文，
  // 但仍可通过标题栏随时展开查看完整过程。
  const [open, setOpen] = useState(false);
  // 展开看全文的只有推理摘要，按行记：一块里可能有好几段摘要，各自开合。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = items.map((item) => ({ key: `${item.id}-${item.type}`, ...describeProcessItem(item, t) }));
  return (
    <section className={`delivery-session-process${open ? " is-open" : ""}`}>
      <button type="button" className="delivery-session-process__header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="delivery-session-process__icon"><ToolOutlined /></span>
        <b>{processSummary(items, t)}</b>
        <small>{t("delivery.session.process.count").replace("{count}", String(items.length))}</small>
        <DownOutlined className="delivery-session-process__chevron" />
      </button>
      {open ? (
        <ul className="delivery-session-process__rows">
          {rows.map((row) => (
            <li key={row.key} className={`${row.failed ? "is-failed" : ""}${row.body ? " is-expandable" : ""}`.trim()}>
              {row.body ? (
                <>
                  <button
                    type="button"
                    className="delivery-session-process__row-toggle"
                    onClick={() => setExpanded({ ...expanded, [row.key]: !expanded[row.key] })}
                    aria-expanded={Boolean(expanded[row.key])}
                  >
                    <span className="delivery-session-process__row-icon">{row.icon}</span>
                    <span className="delivery-session-process__row-label">{row.label}</span>
                    <DownOutlined className="delivery-session-process__row-chevron" />
                  </button>
                  {expanded[row.key] ? (
                    <div className="delivery-session-process__row-body"><SessionMarkdown text={row.body} /></div>
                  ) : null}
                </>
              ) : (
                <div className="delivery-session-process__row" title={row.title}>
                  <span className="delivery-session-process__row-icon">{row.icon}</span>
                  <span className="delivery-session-process__row-label">{row.label}</span>
                  {row.detail ? <em className="manager-mono">{row.detail}</em> : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
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
 * 改动路径可能是绝对路径，登记下来的产物只有工作区相对路径：按路径尾部对齐。
 * 同名不同目录时只认唯一命中，宁可不给预览，也不能点开另一份文件。
 */
function artifactForChange(path: string, artifacts: CodexConversationAttachment[]) {
  const normalized = path.replaceAll("\\", "/");
  const exact = artifacts.find((artifact) => {
    const relative = (artifact.relativePath || "").replaceAll("\\", "/");
    return Boolean(relative) && (normalized === relative || normalized.endsWith(`/${relative}`));
  });
  if (exact) return exact;
  const fileName = normalized.split("/").at(-1);
  const sameName = artifacts.filter((artifact) => artifact.name === fileName);
  return sameName.length === 1 ? sameName[0] : null;
}

/**
 * 回合末尾的「本次改动」清单。
 *
 * Codex / Claude 的命令行界面里这块是客户端自己按 diff 事件画的，不在模型回复正文里，
 * 面板不补一份的话，看完最终回复也不知道到底动了哪些文件。
 *
 * 改动项里能对上已登记产物的，点一下就在预览弹窗里打开：HTML、Markdown 可以在效果和
 * 源码之间切，其余源文件按源码看。删掉的文件没有产物可读，保持不可点。
 */
export function SessionChangeSummary({
  items,
  programId,
}: {
  items: CodexConversationItem[];
  programId: number;
}) {
  const { t } = useLocale();
  const [previewAttachment, setPreviewAttachment] = useState<CodexConversationAttachment | null>(null);
  const changes = useMemo(() => changesOfTurn(items), [items]);
  const artifacts = useMemo(
    () => items.flatMap((item) => (item.type === "fileChange" || item.type === "fileEdit" ? item.attachments : [])),
    [items],
  );
  if (!changes.length) return null;
  return (
    <section className="delivery-session-changes" aria-label={t("delivery.session.changes")}>
      <header>
        {t("delivery.session.changes")}
        <span>{t("delivery.session.changesCount").replace("{count}", String(changes.length))}</span>
      </header>
      <ul>
        {changes.map((change) => {
          const artifact = artifactForChange(change.path, artifacts);
          const previewable = Boolean(artifact) && canPreviewConversationAttachment(artifact!);
          return (
            <li key={change.path}>
              <i className={`delivery-session-changes__kind is-${change.kind || "modify"}`}>
                {t(`delivery.session.change.${change.kind || "modify"}`)}
              </i>
              {previewable ? (
                <button
                  className="delivery-session-changes__path manager-mono"
                  type="button"
                  title={t("delivery.session.changePreview").replace("{path}", change.path)}
                  onClick={() => setPreviewAttachment(artifact)}
                >
                  <span>{change.path}</span>
                  <EyeOutlined />
                </button>
              ) : <span className="manager-mono" title={change.path}>{change.path}</span>}
            </li>
          );
        })}
      </ul>
      <SessionFilePreviewModal
        attachment={previewAttachment}
        programId={programId}
        open={Boolean(previewAttachment)}
        onClose={() => setPreviewAttachment(null)}
      />
    </section>
  );
}
