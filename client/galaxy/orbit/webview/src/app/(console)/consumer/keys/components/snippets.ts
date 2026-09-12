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

export function buildSnippet(tab: SnippetTab, baseUrl: string, secret: string, category: KeyCategory, modelId: string): string {
  const root = hostRoot(baseUrl);
  const base = apiBase(baseUrl);
  if (tab === "claude") {
    return [
      "# 写进 ~/.claude/settings.json，对之后打开的每个终端都生效",
      "{",
      '  "env": {',
      `    "ANTHROPIC_BASE_URL": "${root}",`,
      `    "ANTHROPIC_AUTH_TOKEN": "${secret}"`,
      "  }",
      "}",
      "",
      "# 或者只在当前终端里生效",
      `export ANTHROPIC_BASE_URL=${root}`,
      `export ANTHROPIC_AUTH_TOKEN=${secret}`,
      "claude",
    ].join("\n");
  }
  if (tab === "codex") {
    return [
      "# ~/.codex/config.toml",
      'model_provider = "galaxy"',
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
      `curl ${base}/responses \\`,
      `  -H "authorization: Bearer ${secret}" \\`,
      '  -H "content-type: application/json" \\',
      `  -d '{"model":"${modelId || "gpt-5.6-terra"}","input":"hi"}'`,
    ].join("\n");
  }
  return [
    `curl ${base}/messages \\`,
    `  -H "authorization: Bearer ${secret}" \\`,
    '  -H "anthropic-version: 2023-06-01" \\',
    '  -H "content-type: application/json" \\',
    `  -d '{"model":"${modelId || "claude-sonnet-5"}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`,
  ].join("\n");
}
