"use client";

/** 展示层的格式化。业务口径一律在服务端算好，这里只负责好不好看。 */

const UNIT_LABELS: Record<string, string> = {
  "llm.input_tokens": "输入 token",
  "llm.output_tokens": "输出 token",
  "llm.cache_read_tokens": "缓存读取 token",
  "llm.cache_write_tokens": "缓存写入 token",
  "llm.calls": "请求次数",
  "time.seconds": "占用时长",
  "video.output_seconds": "输出时长",
  "video.input_seconds": "输入时长",
  "cpu.seconds": "CPU 秒",
  "gpu.seconds": "GPU 秒",
  "storage.bytes": "存储",
  "egress.bytes": "出网流量",
};

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

/** 计量单位各有各的量纲：token 是个数，time.seconds 是时长，bytes 是体积。 */
export function formatUnitValue(unit: string, value: number): string {
  if (unit.endsWith(".seconds")) return formatDuration(value);
  if (unit.endsWith(".bytes")) return formatBytes(value);
  return formatNumber(value);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)}${units[index]}`;
}

/**
 * 金额。服务端一律用「微分」存，避免 token 这种大基数上的浮点误差；
 * 展示才换成元。
 */
export function formatMoney(micros: number, currency = "CNY"): string {
  const symbol = currency === "CNY" ? "¥" : "";
  return `${symbol}${(micros / 1_000_000).toFixed(2)}`;
}

/** 单价是「每百万单位」的价格，直接显示微分没人看得懂。 */
export function formatUnitPrice(micros: number, currency = "CNY"): string {
  if (micros <= 0) return "-";
  return `${formatMoney(micros, currency)} / 1M`;
}

export function formatTime(value?: string): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

export function formatRelative(value?: string): string {
  if (!value) return "-";
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return "-";
  const delta = Math.round((Date.now() - parsed) / 1000);
  if (delta < 60) return `${Math.max(delta, 0)}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

/** 复制到剪贴板。密钥明文只显示一次，复制失败必须让用户知道。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
