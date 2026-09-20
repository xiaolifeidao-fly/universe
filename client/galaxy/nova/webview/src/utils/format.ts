"use client";

/** 展示层的格式化。业务口径一律在服务端算好，这里只负责好不好看。 */

/**
 * 计量单位的人话名。
 *
 * 名字要跟界面语言走，所以 t 必须传进来 —— 之前这里硬编码中文，英文界面上
 * 就会冒出「1.00M 输入 token」这种半句中文，而且只有切到英文才看得见。
 *
 * 字典里没有的单位原样显示 unit id：新接一个上游只是还没有译名，
 * 不该在账单里变成空白。
 */
export function unitLabel(unit: string, t: (key: string) => string): string {
  const key = `unit.${unit}`;
  const label = t(key);
  return label === key ? unit : label;
}

/**
 * provider 是节点侧执行模块的名字。账单上写 claude_oauth 没人看得懂，
 * 消费者要知道的是「这笔用量走的是 Claude 还是 Codex」。
 * 认不出来的照原样显示 —— 新接一个上游只是没有中文名，不会在账单里变成空白。
 */
const PROVIDER_LABELS: Record<string, string> = {
  claude_oauth: "Claude",
  codex_chatgpt: "Codex",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
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
 * 金额与积分的小数位：默认两位，两位装不下就给到四位。
 *
 * 一次小调用的扣费常常只有 ¥0.0013、分成只有 0.00095 积分，按两位四舍五入
 * 整列都写着 0，看着像根本没计费 —— 账上记的是精确的微，展示不该把它抹平。
 * 微是整数，所以「两位装得下」就是刚好落在一分（10_000 微）上。
 */
function microDigits(micros: number): number {
  return Math.abs(micros % 10_000) < 0.5 ? 2 : 4;
}

/**
 * 金额。服务端一律用「微分」存，避免 token 这种大基数上的浮点误差；
 * 展示才换成元。
 */
export function formatMoney(micros: number, currency = "CNY"): string {
  const symbol = currency === "CNY" ? "¥" : "";
  return `${symbol}${(micros / 1_000_000).toFixed(microDigits(micros))}`;
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

/* ---------- 桌面端排版用的格式化 ---------- */

/**
 * 带千分位的整数。调用次数、机器台数这类「个数」用它 —— 那些数字要能一眼读出量级，
 * formatNumber 的「1.2k」在账本里会把 1,284 和 1,249 显示成同一个值。
 *
 * 积分不要用它：账上存的是微积分，原样打出来会多六个零，见 formatPoints。
 */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("en-US");
}

/** token 这种大基数用紧凑写法：1.21M / 316k。 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  return formatInt(value);
}

/** 服务端一律用「微分」存钱，展示才换成元。小数位见 microDigits。 */
export function formatCny(micros: number): string {
  if (!Number.isFinite(micros)) return "-";
  return `¥${(micros / 1_000_000).toFixed(microDigits(micros))}`;
}

/**
 * 积分。1 积分 = ¥1，服务端和金额一样存「微」。
 *
 * 和金额同一套小数位（microDigits）：默认两位，不足一分的零头给到四位。
 * 逐笔的分成、返现常常只有 0.00095 积分，两位小数会把它写成 0。
 */
export function formatPoints(micros: number): string {
  if (!Number.isFinite(micros)) return "-";
  const digits = microDigits(micros);
  return (micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 带符号的积分，进来的同样是微积分：+1,284 / −20,000。用真的减号，不是连字符。 */
export function formatSignedPoints(micros: number): string {
  if (!Number.isFinite(micros) || micros === 0) return "0";
  return micros > 0 ? `+${formatPoints(micros)}` : `−${formatPoints(Math.abs(micros))}`;
}

/** 09-10 23:38 —— 桌面窗口宽度有限，年份没有信息量。 */
export function formatDateTime(value?: string): string {
  const parsed = parseDate(value);
  if (!parsed) return "-";
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function formatDay(value?: string): string {
  const parsed = parseDate(value);
  if (!parsed) return "-";
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

export function formatClock(value?: string): string {
  const parsed = parseDate(value);
  if (!parsed) return "-";
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** 11.4s / 1m 12s。毫秒进来，给人看。 */
export function formatMillis(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * 「已连续 6 天 14 小时」。
 *
 * 刻意只到小时：秒级的跳动会让这句话每一秒都在变，而它想说的是「很久了」。
 */
export function formatSince(value: string | undefined, locale: "zh-CN" | "en-US"): string {
  const parsed = parseDate(value);
  if (!parsed) return "-";
  const minutes = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (locale === "en-US") {
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    return hours > 0 ? `${hours}h` : `${minutes}m`;
  }
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  return hours > 0 ? `${hours} 小时` : `${minutes} 分钟`;
}

/** 百分比变化：−21% / +3%。基数为 0 时没有「变化」可言，返回空串。 */
export function formatDelta(current: number, previous: number): string {
  if (!previous) return "";
  const ratio = Math.round(((current - previous) / previous) * 100);
  return ratio >= 0 ? `+${ratio}%` : `−${Math.abs(ratio)}%`;
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
