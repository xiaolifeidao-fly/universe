import type { Logger } from "../../core/logger.js";

/** 保留路径差异；尾斜杠、主机大小写和默认端口不构成地址变化。 */
function normalize(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_hub_url");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** 每次心跳校验，仅状态变化时输出日志，不向公布的新地址发送节点凭据。 */
export function createHubAddressCheck(configured: string, logger: Pick<Logger, "info" | "warn">) {
  let previous = "";
  return (advertised: unknown): void => {
    if (advertised === undefined || advertised === "") {
      previous = ""; // 老版本或未配置：未知，不当成一致。
      return;
    }
    let actual: string;
    let expected: string;
    try {
      if (typeof advertised !== "string") throw new Error("invalid_hub_url");
      actual = normalize(configured);
      expected = normalize(advertised);
    } catch {
      if (previous !== "invalid") logger.warn("pool_hub_address_invalid", { hint: "平台地址格式无效，无法校验，请检查 Hub 地址配置" });
      previous = "invalid";
      return;
    }
    const state = actual === expected ? "matched" : `mismatch:${expected}`;
    if (state === previous) return;
    previous = state;
    if (actual === expected) {
      logger.info("pool_hub_address_matched", { hub: actual });
    } else {
      logger.warn("pool_hub_address_mismatch", {
        configuredHub: actual, platformHub: expected,
        hint: "本机 Hub 地址与平台公布地址不一致，请核实后运行 ai-bridge pool setup --hub <平台地址>",
      });
    }
  };
}
