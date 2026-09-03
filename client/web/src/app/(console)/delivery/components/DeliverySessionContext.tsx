"use client";

import { Popover } from "antd";
import type { CSSProperties } from "react";
import { CodexSessionContext } from "@/api/delivery.api";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, toolDisplayName, type AITool } from "@/ai-preferences/AIPreferencesProvider";
import { useLocale } from "@/i18n/LocaleProvider";

/**
 * 执行器没报窗口时按模型兜底的窗口大小，和桥接里的那份保持一致。
 *
 * 只在「这条会话还一轮都没跑过」时用得上：跑过之后窗口一律以执行器报的为准，
 * 它才知道当前这个模型实际开了多大。
 */
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;
// 能选的两档（opus / sonnet）实测都开着 1M；还停在 200K 的是 haiku 这类选不到、
// 但起标题和子代理会用上的小模型。带 [1m] 标记的长上下文档位一定是 1M。
const CLAUDE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_SMALL_CONTEXT_WINDOW = 200_000;
const CLAUDE_SMALL_CONTEXT_MODELS = ["haiku"];
const CLAUDE_LONG_CONTEXT_MARKER = "[1m]";

/** 快用满时换色：到这两档就该考虑另起一条会话了。 */
const CONTEXT_WARN_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

function fallbackContextWindow(tool: AITool, model: string) {
  if (tool !== "claude") return CODEX_DEFAULT_CONTEXT_WINDOW;
  const name = model.toLowerCase();
  if (!name.includes(CLAUDE_LONG_CONTEXT_MARKER) && CLAUDE_SMALL_CONTEXT_MODELS.some((small) => name.includes(small))) {
    return CLAUDE_SMALL_CONTEXT_WINDOW;
  }
  return CLAUDE_DEFAULT_CONTEXT_WINDOW;
}

/** Claude 报回来的是完整模型号（claude-opus-5-20260101），面板上只留识别得出的那截。 */
function modelLabel(tool: AITool, model: string) {
  const options = tool === "claude" ? CLAUDE_MODEL_OPTIONS : CODEX_MODEL_OPTIONS;
  const matched = options.find((option) => model === option.value || model.includes(option.value));
  if (matched) return matched.label;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function formatContextTokens(value: number) {
  return Math.max(0, Math.round(value || 0)).toLocaleString("zh-CN");
}

/**
 * 一条会话现在占了多少上下文：已用、剩余、总共。
 *
 * 这三个数和「消耗」那本账不是一回事——消耗是整条会话累加的花费，只增不减；
 * 上下文是此刻送进模型的那份提示词有多长，压缩之后会掉回去。会话跑久了要不要
 * 另起一条，看的是这里而不是那里。
 *
 * 窗口大小优先用执行器报的（Codex 在用量通知里给 modelContextWindow，Claude 在回合
 * 末尾的 modelUsage 里给 contextWindow）；一轮都还没跑过的新会话没有读数，才按
 * 当前选中的模型兜一个，好歹先把「总共多少」显示出来。
 */
export function SessionContextMeter({
  context,
  tool,
  model,
  className = "",
}: {
  context?: CodexSessionContext | null;
  /** 当前选中的执行器与模型：新会话还没有读数时，「总共多少」由它决定。 */
  tool: AITool;
  model: string;
  className?: string;
}) {
  const { t } = useLocale();
  const used = Math.max(0, Math.round(context?.usedTokens ?? 0));
  const providerTool: AITool = context?.provider === "claude" || context?.provider === "codex" ? context.provider : tool;
  const modelName = context?.model || model;
  const windowTokens = Math.max(0, Math.round(context?.windowTokens ?? 0)) || fallbackContextWindow(providerTool, modelName);
  const remaining = Math.max(0, windowTokens - used);
  const percent = windowTokens ? Math.min(100, (used * 100) / windowTokens) : 0;
  const level = percent >= CONTEXT_DANGER_PERCENT ? "danger" : percent >= CONTEXT_WARN_PERCENT ? "warn" : "normal";
  const barStyle = { "--context-share": `${percent.toFixed(1)}%` } as CSSProperties;

  const detail = (
    <div className="delivery-session-context__detail">
      <div className="delivery-session-context__detail-head">
        <span>{t("delivery.context.title")}</span>
        <b className="manager-mono">{Math.round(percent)}%</b>
      </div>
      <i className={`delivery-session-context__bar is-${level}`} style={barStyle} aria-hidden="true" />
      <dl className="delivery-session-context__rows manager-mono">
        <div><dt>{t("delivery.context.used")}</dt><dd>{formatContextTokens(used)}</dd></div>
        <div><dt>{t("delivery.context.remaining")}</dt><dd>{formatContextTokens(remaining)}</dd></div>
        <div><dt>{t("delivery.context.window")}</dt><dd>{formatContextTokens(windowTokens)}</dd></div>
      </dl>
      <p className="delivery-session-context__note">
        {toolDisplayName(providerTool)}{modelName ? ` · ${modelLabel(providerTool, modelName)}` : ""}
      </p>
      <p className="delivery-session-context__note">{used ? t("delivery.context.hint") : t("delivery.context.empty")}</p>
    </div>
  );

  return (
    <Popover content={detail} trigger="click" placement="bottomRight" overlayClassName="delivery-session-context-popover">
      <button
        type="button"
        className={`delivery-session-context is-${level}${className ? ` ${className}` : ""}`}
        aria-label={t("delivery.context.title")}
      >
        <span>{t("delivery.context.label")}</span>
        <i className={`delivery-session-context__bar is-${level}`} style={barStyle} aria-hidden="true" />
        <b className="manager-mono">{Math.round(percent)}%</b>
      </button>
    </Popover>
  );
}
