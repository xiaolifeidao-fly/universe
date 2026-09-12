"use client";

import { ClientConfigApi } from "@galaxy/common/eleapi/clientconfig.api";
import type { ClientTool } from "@galaxy/common/eleapi/clientconfig.model";

export type * from "@galaxy/common/eleapi/clientconfig.model";

/**
 * 「使用」按钮背后的本机能力，只在 Orbit 桌面壳里有。浏览器里 isAvailable() 为假，
 * 页面据此不画按钮，只给手动命令。
 */
export const clientConfigApi = new ClientConfigApi();

export function canApplyLocally(): boolean {
  return clientConfigApi.isAvailable();
}

export async function fetchClientStatus() {
  if (!clientConfigApi.isAvailable()) return null;
  try {
    return await clientConfigApi.getStatus();
  } catch {
    return null;
  }
}

export const TOOL_LABELS: Record<ClientTool, string> = { claude: "Claude Code", codex: "Codex" };
