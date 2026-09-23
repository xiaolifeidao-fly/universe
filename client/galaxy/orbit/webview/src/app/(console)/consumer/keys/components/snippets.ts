/**
 * 手动接入的命令参考。「使用」按钮只有桌面壳里有，浏览器里、或者想接到别的机器上时照着这里填。
 *
 * 两个客户端要的 base_url 不一样，这是最容易填错的一步：
 *   Claude Code  ANTHROPIC_BASE_URL 填主机根，SDK 自己拼 /v1/messages —— 带着 /v1 会打到 /v1/v1/messages，404。
 *   Codex        base_url 要带 /v1，它只拼 /responses。
 * 和桌面壳写配置用的是同一套口径（orbit/electron/src/modules/clientconfig/files.ts）。
 */

import type { KeyCategory } from "../../api/consumer.api";

export type SnippetTab = "claude" | "codex" | "curl";

export const SECRET_PLACEHOLDER = "sk-galaxy-…";

/** 服务端给的地址带 /v1；没配地址时给一个一眼能看出要替换的占位。 */
export function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "https://<galaxy>/v1";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function hostRoot(baseUrl: string): string {
  return apiBase(baseUrl).replace(/\/v1$/, "");
}

export function defaultSnippetTab(category: KeyCategory): SnippetTab {
  return category === "codex" ? "codex" : "claude";
}

/**
 * 这把密钥被限定在哪几个模型上。
 *
 * 模型档里可能是通配（`claude-*`），那不是一个能写进配置的模型名 ——
 * 只有**恰好一个具体模型名**时才值得替人把它填进配置里。
 */
export function pinnedModel(modelTier: string[] | undefined, fallback: string): string {
  const concrete = (modelTier ?? []).filter((item) => item && !item.includes("*"));
  if (concrete.length === 1) return concrete[0];
  return fallback;
}

/**
 * 接入片段。
 *
 * `modelTier` 不是可有可无的装饰：额度按模型卖之后，一份 Opus 的额度签出来的密钥
 * 就**只允许调 Opus**（服务端的 AuthorizeRoute 会挡住别的）。而 Claude Code 默认
 * 调 Sonnet —— 照着一份不写模型的配置接上去，每一句话都被拒，报错说的是「模型不允许」，
 * 而人刚刚明明买的就是这个模型。所以：只锁了一个具体模型时，替他把 ANTHROPIC_MODEL
 * 一起写好；锁了好几个就把名单列出来，让他自己挑。
 */
export function buildSnippet(
  tab: SnippetTab,
  baseUrl: string,
  secret: string,
  category: KeyCategory,
  modelId: string,
  modelTier: string[] = [],
): string {
  const root = hostRoot(baseUrl);
  const base = apiBase(baseUrl);
  const scoped = (modelTier ?? []).filter(Boolean);
  const pinned = pinnedModel(modelTier, modelId);
  // 锁了好几个（或者锁的是通配）：填不出唯一一个名字，那就把能用的列出来。
  const listHint = scoped.length > 0 && !pinnedModel(modelTier, "") ? [`# 这把密钥只能调：${scoped.join("、")}`] : [];

  if (tab === "claude") {
    return [
      ...listHint,
      "# 写进 ~/.claude/settings.json，对之后打开的每个终端都生效",
      "{",
      '  "env": {',
      `    "ANTHROPIC_BASE_URL": "${root}",`,
      `    "ANTHROPIC_AUTH_TOKEN": "${secret}"${pinned ? "," : ""}`,
      // 密钥锁了模型就必须一起写死，否则 Claude Code 按它自己的默认模型发请求，
      // 而那个模型这把密钥调不了。
      ...(pinned ? [`    "ANTHROPIC_MODEL": "${pinned}"`] : []),
      "  }",
      "}",
      "",
      "# 或者只在当前终端里生效",
      `export ANTHROPIC_BASE_URL=${root}`,
      `export ANTHROPIC_AUTH_TOKEN=${secret}`,
      ...(pinned ? [`export ANTHROPIC_MODEL=${pinned}`] : []),
      "claude",
    ].join("\n");
  }
  if (tab === "codex") {
    return [
      ...listHint,
      "# ~/.codex/config.toml",
      'model_provider = "galaxy"',
      ...(pinned ? [`model = "${pinned}"`] : []),
      "",
      "[model_providers.galaxy]",
      'name = "Galaxy"',
      `base_url = "${base}"`,
      'wire_api = "responses"',
      `experimental_bearer_token = "${secret}"`,
    ].join("\n");
  }
  if (category === "codex") {
    return [
      ...listHint,
      `curl ${base}/responses \\`,
      `  -H "authorization: Bearer ${secret}" \\`,
      '  -H "content-type: application/json" \\',
      `  -d '{"model":"${pinned || "gpt-5.6-terra"}","input":"hi"}'`,
    ].join("\n");
  }
  return [
    ...listHint,
    `curl ${base}/messages \\`,
    `  -H "authorization: Bearer ${secret}" \\`,
    '  -H "anthropic-version: 2023-06-01" \\',
    '  -H "content-type: application/json" \\',
    `  -d '{"model":"${pinned || "claude-sonnet-5"}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`,
  ].join("\n");
}
