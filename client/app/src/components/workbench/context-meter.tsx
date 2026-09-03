"use client";

import { useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import type { SessionContextWindow } from "@/features/workbench/types";

/**
 * 执行器没报窗口时按执行器兜底的窗口大小，和桥接里的那份保持一致。
 *
 * 只在「这条会话还一轮都没跑过」时用得上：跑过之后一律以执行器报的为准，
 * 它才知道那一轮实际用的模型开了多大的窗口。
 */
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;
// 能选的两档（opus / sonnet）实测都开着 1M；还停在 200K 的是 haiku 这类选不到、
// 但起标题和子代理会用上的小模型。带 [1m] 标记的长上下文档位一定是 1M。
const CLAUDE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_SMALL_CONTEXT_WINDOW = 200_000;
const CLAUDE_SMALL_CONTEXT_MODELS = ["haiku"];
const CLAUDE_LONG_CONTEXT_MARKER = "[1m]";

/** 快用满时换色：到这两档就该考虑另起一条对话了。 */
const CONTEXT_WARN_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

const providerLabels: Record<string, string> = { codex: "Codex", claude: "Claude" };

function fallbackContextWindow(provider: string, model: string) {
  if (provider !== "claude") return CODEX_DEFAULT_CONTEXT_WINDOW;
  const name = model.toLowerCase();
  if (!name.includes(CLAUDE_LONG_CONTEXT_MARKER) && CLAUDE_SMALL_CONTEXT_MODELS.some((small) => name.includes(small))) {
    return CLAUDE_SMALL_CONTEXT_WINDOW;
  }
  return CLAUDE_DEFAULT_CONTEXT_WINDOW;
}

/** Claude 报回来的是完整模型号（claude-opus-5-20260101），手机上只留识别得出的那截。 */
function modelLabel(model: string) {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function formatTokens(value: number) {
  return Math.max(0, Math.round(value || 0)).toLocaleString("zh-CN");
}

/**
 * 这条对话现在占了多少上下文：已用、剩余、总共。
 *
 * 平时只占一行：标签、一条细横条、一个百分比。点开才给三个具体的数——手机上
 * 屏幕本来就窄，聊天正文比这三个数重要，但「还能聊多久」得随时看得见。
 *
 * 窗口大小优先用执行器报的（Codex 在用量通知里给，Claude 在回合末尾给）；
 * 一轮都还没跑过的新对话没有读数，才按这条会话的执行器兜一个。
 */
export function ContextMeter({
  context,
  executorType = "",
}: {
  context?: SessionContextWindow | null;
  /** 这条会话属于哪个执行器：还没有读数时，「总共多少」由它决定。 */
  executorType?: string;
}) {
  const [open, setOpen] = useState(false);
  const provider = context?.provider || executorType || "codex";
  const model = context?.model || "";
  const used = Math.max(0, Math.round(context?.usedTokens ?? 0));
  const windowTokens = Math.max(0, Math.round(context?.windowTokens ?? 0)) || fallbackContextWindow(provider, model);
  const remaining = Math.max(0, windowTokens - used);
  const percent = windowTokens ? Math.min(100, (used * 100) / windowTokens) : 0;
  const level = percent >= CONTEXT_DANGER_PERCENT ? "danger" : percent >= CONTEXT_WARN_PERCENT ? "warn" : "normal";

  return (
    <section className={`context-meter is-${level}`} aria-label="上下文窗口">
      <button className="context-meter__bar" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span>上下文</span>
        <i className="context-meter__track" style={{ "--context-share": `${percent.toFixed(1)}%` } as CSSProperties} aria-hidden="true" />
        <b>{Math.round(percent)}%</b>
        <ChevronDown size={16} className={open ? "context-meter__caret is-open" : "context-meter__caret"} aria-hidden="true" />
      </button>
      {open ? (
        <div className="context-meter__detail">
          <dl>
            <div><dt>已用</dt><dd>{formatTokens(used)}</dd></div>
            <div><dt>剩余</dt><dd>{formatTokens(remaining)}</dd></div>
            <div><dt>总共</dt><dd>{formatTokens(windowTokens)}</dd></div>
          </dl>
          <p>
            {providerLabels[provider] || provider}
            {model ? ` · ${modelLabel(model)}` : ""}
            {used ? "" : " · 这条对话还没跑过，总量按这条会话的执行器给"}
          </p>
        </div>
      ) : null}
    </section>
  );
}
