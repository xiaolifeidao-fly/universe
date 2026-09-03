"use client";

import { useState } from "react";
import {
  Brain,
  ChevronRight,
  Coins,
  FileDiff,
  FilePlus2,
  FileX2,
  Paperclip,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { ConversationChange, ConversationItem, ConversationTurn, TokenUsage } from "@/features/workbench/types";
import { RichText } from "@/components/workbench/rich-text";

/**
 * 一轮对话的渲染。
 *
 * 思考、命令、工具调用这些过程条目默认收起，只留一行标题；真正要读的是用户消息
 * 和最终回复，它们始终展开。这样在手机上一屏能看到的是结论，而不是过程日志。
 *
 * 连着跑的命令和工具调用再合成一组，只占一行「N 个命令」，展开才铺开逐条看。
 * 一轮里几十条命令平铺出来会把结论顶出屏幕，手机上尤其如此。
 */
export function ConversationTurns({ turns }: { turns: ConversationTurn[] }) {
  return (
    <div className="conversation-turns">
      {turns.map((turn) => <TurnBlock key={turn.id || turn.createdAt} turn={turn} />)}
    </div>
  );
}

/**
 * 还没收束成一轮的过程条目：远端正在跑时回传的推理、命令、读写文件。
 * 和整轮渲染共用同一套条目样式，业务访谈和交付会话的展示口径保持一致。
 */
export function ConversationItemStream({ items }: { items: ConversationItem[] }) {
  if (!items.length) return null;
  return (
    <section className="turn-block" aria-label="正在进行的过程" aria-live="polite">
      {renderItems(items, "activity")}
    </section>
  );
}

function TurnBlock({ turn }: { turn: ConversationTurn }) {
  const changes = collectChanges(turn.items);
  return (
    <section className="turn-block" aria-label="一轮对话">
      {renderItems(turn.items, turn.id)}
      {changes.length ? <ChangeSummary changes={changes} /> : null}
      {turn.usage ? <UsageLine usage={turn.usage} /> : null}
    </section>
  );
}

/**
 * 连续跑的执行过程条目：合成一组收起来，不一条条铺在正文里。
 * 文件改动本身不渲染（回合末尾统一汇总），但也归进来，免得它把一串命令切断。
 */
const ACTIVITY_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "reasoning",
  "fileChange",
  "fileEdit",
]);

/** 组标题只报数：几个命令、几次工具调用、几段思考，没有的那类不出现。 */
function activityLabel(items: ConversationItem[]) {
  const commands = items.filter((item) => item.type === "commandExecution").length;
  const tools = items.filter((item) => item.type === "mcpToolCall" || item.type === "dynamicToolCall").length;
  const thoughts = items.filter((item) => item.type === "reasoning").length;
  return [
    commands ? `${commands} 个命令` : "",
    tools ? `${tools} 次工具调用` : "",
    thoughts ? `${thoughts} 段思考` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * 把相邻的命令、工具调用、思考并成一组渲染，其余条目原样输出。
 * 攒够两条才套壳，免得为单独一个命令多出一层「1 个命令」。
 */
function renderItems(items: ConversationItem[], keyPrefix: string) {
  const nodes: React.ReactNode[] = [];
  let batch: ConversationItem[] = [];
  const flush = (index: number) => {
    if (!batch.length) return;
    const group = batch;
    batch = [];
    if (group.length > 1 && activityLabel(group)) {
      nodes.push(<ActivityGroup items={group} key={group[0].id || `${keyPrefix}-group-${index}`} />);
      return;
    }
    group.forEach((item, offset) => {
      nodes.push(<ItemBlock item={item} key={item.id || `${keyPrefix}-${index}-${offset}`} />);
    });
  };
  items.forEach((item, index) => {
    if (ACTIVITY_TYPES.has(item.type)) {
      batch.push(item);
      return;
    }
    flush(index);
    nodes.push(<ItemBlock item={item} key={item.id || `${keyPrefix}-${index}`} />);
  });
  flush(items.length);
  return nodes;
}

function ActivityGroup({ items }: { items: ConversationItem[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((item) => item.type === "commandExecution"
    && typeof item.exitCode === "number" && item.exitCode !== 0).length;
  return (
    <div className={`activity-group${failed ? " is-danger" : ""}`}>
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="fold-item__icon" aria-hidden="true"><SquareTerminal size={17} /></span>
        <span className="fold-item__label">{activityLabel(items)}</span>
        {failed ? <span className="fold-item__note">{failed} 个失败</span> : null}
        <ChevronRight size={17} className={`fold-item__chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div className="activity-group__list">
          {items.map((item, index) => <ItemBlock item={item} key={item.id || `activity-item-${index}`} />)}
        </div>
      ) : null}
    </div>
  );
}

function ItemBlock({ item }: { item: ConversationItem }) {
  if (item.type === "userMessage") {
    return (
      <div className="message message--user">
        {item.text ? <p>{item.text}</p> : null}
        <Attachments item={item} />
      </div>
    );
  }
  if (item.type === "agentMessage" || item.type === "plan") {
    return (
      <div className={`message message--agent${item.phase === "final_answer" ? " is-final" : ""}`}>
        <RichText text={item.text} />
        <Attachments item={item} />
      </div>
    );
  }
  if (item.type === "reasoning") {
    return <FoldableItem icon={<Brain size={17} />} label="思考过程" body={item.text} />;
  }
  if (item.type === "commandExecution") {
    const failed = typeof item.exitCode === "number" && item.exitCode !== 0;
    return (
      <FoldableItem
        icon={<SquareTerminal size={17} />}
        label={firstLine(item.text) || "执行命令"}
        body={item.text}
        mono
        tone={failed ? "danger" : ""}
        note={failed ? `退出码 ${item.exitCode}` : ""}
      />
    );
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const label = item.action === "read"
      ? `已读取 ${item.target || item.text}`
      : item.action === "search"
        ? `已检索 ${item.target || item.text}`
        : `调用 ${item.text || "工具"}`;
    return (
      <p className="tool-line">
        <span aria-hidden="true">{item.action === "search" ? <Search size={16} /> : <Wrench size={16} />}</span>
        {label}
      </p>
    );
  }
  if (item.type === "fileChange" || item.type === "fileEdit") {
    // 改动在回合末尾统一汇总，这里不再重复铺一遍文件清单。
    return null;
  }
  return item.text ? <p className="tool-line">{item.text}</p> : null;
}

function FoldableItem({
  icon,
  label,
  body,
  mono,
  tone,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  body: string;
  mono?: boolean;
  tone?: string;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`fold-item${tone ? ` is-${tone}` : ""}`}>
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="fold-item__icon" aria-hidden="true">{icon}</span>
        <span className="fold-item__label">{label}</span>
        {note ? <span className="fold-item__note">{note}</span> : null}
        <ChevronRight size={17} className={`fold-item__chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open ? <pre className={mono ? "fold-item__body is-mono" : "fold-item__body"}>{body}</pre> : null}
    </div>
  );
}

function Attachments({ item }: { item: ConversationItem }) {
  if (!item.attachments?.length) return null;
  return (
    <div className="attachment-chips">
      {item.attachments.map((attachment) => (
        <span className="attachment-chip" key={attachment.id || attachment.relativePath}>
          <Paperclip size={15} aria-hidden="true" />
          {attachment.name || attachment.relativePath}
        </span>
      ))}
    </div>
  );
}

function ChangeSummary({ changes }: { changes: ConversationChange[] }) {
  const [open, setOpen] = useState(false);
  if (!changes.length) return null;
  const added = changes.reduce((total, change) => total + (change.added || 0), 0);
  const removed = changes.reduce((total, change) => total + (change.removed || 0), 0);
  return (
    <div className="change-summary">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="change-summary__icon" aria-hidden="true"><FileDiff size={17} /></span>
        <span>本次改动 {changes.length} 个文件</span>
        <span className="change-summary__counts"><em>+{added}</em><i>-{removed}</i></span>
        <ChevronRight size={17} className={`fold-item__chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="change-summary__list">
          {changes.map((change) => (
            <li key={change.path}>
              <span aria-hidden="true">{changeIcon(change.kind)}</span>
              <span className="change-summary__path">{change.path}</span>
              <span className="change-summary__counts"><em>+{change.added || 0}</em><i>-{change.removed || 0}</i></span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 一轮烧掉多少 token。
 *
 * 只给三个数：进去多少、其中多少是缓存命中（便宜一个数量级）、出来多少。
 * 缓存命中不单独占一行，跟在输入后面，一眼能看出这轮是真读了新东西还是在吃缓存。
 * 手机一行放不下「标签 + 三个数 + 金额」，金额跟标签走第一行，三个数落第二行。
 */
export function UsageLine({ usage, label = "本轮消耗" }: { usage: TokenUsage; label?: string }) {
  if (!usage.totalTokens) return null;
  return (
    <p className="usage-line">
      <span className="usage-line__head">
        <Coins size={15} aria-hidden="true" />
        <span>{label}</span>
        {typeof usage.costUsd === "number" ? <i>${usage.costUsd.toFixed(2)}</i> : null}
      </span>
      <span className="usage-line__nums">
        <em>入 {formatTokens(usage.inputTokens)}</em>
        {usage.cachedInputTokens ? <i>缓存 {formatTokens(usage.cachedInputTokens)}</i> : null}
        <em>出 {formatTokens(usage.outputTokens)}</em>
      </span>
    </p>
  );
}

/** 面板上要的是量级，不是精确到个位：上万就按 k 显示。 */
function formatTokens(value: number) {
  const count = Math.max(0, Math.round(value || 0));
  return count >= 10000 ? `${(count / 1000).toFixed(0)}k` : count.toLocaleString("zh-CN");
}

function changeIcon(kind: string) {
  if (kind === "add") return <FilePlus2 size={16} />;
  if (kind === "delete") return <FileX2 size={16} />;
  return <FileDiff size={16} />;
}

function collectChanges(items: ConversationItem[]) {
  const merged = new Map<string, ConversationChange>();
  for (const item of items) {
    for (const change of item.changes ?? []) {
      const existing = merged.get(change.path);
      merged.set(change.path, existing
        ? { ...existing, added: (existing.added || 0) + (change.added || 0), removed: (existing.removed || 0) + (change.removed || 0) }
        : change);
    }
  }
  return Array.from(merged.values());
}

function firstLine(value: string) {
  return String(value ?? "").split("\n")[0]?.trim() ?? "";
}
