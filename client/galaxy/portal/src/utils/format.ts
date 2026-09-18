/**
 * 门户的展示层格式化。业务口径都在服务端算好，这里只管好不好看。
 *
 * 金额一律以「微分」进来（1 元 = 1_000_000 微分，与账单同口径），展示才换成元 ——
 * token 是大基数，在前端做除法再四舍五入，页面上写的和账单上扣的会差几分钱，
 * 而这类差额永远是用户先发现。
 */

const MICRO = 1_000_000;

/**
 * 币种符号。认不出来的回落成「代码 + 空格」，不回落成空串 ——
 * 一个部署把币种配成 USD 之后，首页那格会光秃秃写一个「99」，
 * 而它到底是九十九块还是九十九美元，页面上再也没有第二处能说明。
 */
const SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€", JPY: "¥", HKD: "HK$" };

function symbolOf(currency: string): string {
  return SYMBOLS[currency] ?? `${currency} `;
}

export function formatMoney(micros: number, currency = "CNY"): string {
  if (!Number.isFinite(micros)) return "-";
  return `${symbolOf(currency)}${(micros / MICRO).toFixed(2)}`;
}

/**
 * 单价是「每百万单位」的价格。
 *
 * 两位小数，只有小于一分的才补到四位 —— 那种量级上四舍五入到分就成了 ¥0.00，
 * 看起来像免费。反过来，¥0.30 硬写成 ¥0.3000 会在一列价格里显得刺眼。
 */
export function formatUnitPrice(micros: number, currency = "CNY"): string {
  if (!Number.isFinite(micros) || micros <= 0) return "-";
  const value = micros / MICRO;
  return `${symbolOf(currency)}${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** 万分之一 → 百分数：8500 → 85%。折扣与返现比例都存这个口径。 */
export function formatBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0%";
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** 整数金额：¥99。额度包价目用它，后面两个零没有信息量。 */
export function formatAmount(micros: number, currency = "CNY"): string {
  if (!Number.isFinite(micros)) return "-";
  const value = micros / MICRO;
  return `${symbolOf(currency)}${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/**
 * token 这种大基数用紧凑写法：5M / 1.50M / 300k。
 *
 * 一律**向下**取整。这些数字标的是「这个包给你多少额度」，四舍五入会把
 * 1,500 写成 2k、1,900,000 写成 2.00M —— 在一个卖额度的页面上多报，
 * 是用户付完钱才会发现的那种错。
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= MICRO) {
    const millions = value / MICRO;
    return `${value % MICRO === 0 ? millions : Math.floor(millions * 100) / 100}M`;
  }
  if (value >= 1000) return `${Math.floor(value / 1000)}k`;
  return String(Math.floor(value));
}

/**
 * 上下文窗口：200K。这里是 1000 进制，因为厂商都是这么标的。
 *
 * 不足 1000 的原样写数字 —— 除以 1000 再取整会让 400 变成「0K」。
 */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.round(tokens));
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("en-US");
}

/** 秒 → 1h / 30m。视频那一族的额度用它。 */
/**
 * 时长：1h30m / 12m / 45s。
 *
 * 分钟以下的余数在不到一小时时要留着：一个给 90 秒输出时长的包，
 * 写成「1m」等于把三分之一的额度写没了。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
  return `${whole}s`;
}

/**
 * 计量单位各有各的量纲：token 是个数，秒是时长。
 *
 * 判定用 endsWith("seconds") 而不是 endsWith(".seconds")：单位里既有 cpu.seconds
 * 这种点分的，也有 video.output_seconds 这种下划线的。只认点分的话，
 * 「输出时长 3600 秒」会被当成个数显示成「4k」—— 一个不会报错、只会读起来
 * 莫名其妙的错。
 */
export function formatUnitValue(unit: string, value: number): string {
  if (unit.endsWith("seconds")) return formatDuration(value);
  return formatTokens(value);
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
