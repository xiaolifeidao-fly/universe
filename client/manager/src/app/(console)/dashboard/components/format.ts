"use client";

/** 金额在库里是**微元**（1e-6 元）：3,000,000 就是 ¥3。 */
export const MICRO = 1_000_000;

/**
 * 金额转成「元」。
 *
 * 不做四舍五入到整数：这套系统逐笔按微元向下取整，一天下来的合计常常带着零头，
 * 抹掉零头会让界面上的收入减成本对不上毛利那一格。
 */
export function formatYuan(micro: number): string {
  const yuan = micro / MICRO;
  return yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 带币种符号的金额。负号写在符号**前面**：`-¥35.10`，不是 `¥-35.10`。
 *
 * 毛利这一列是会出负数的（结算价高过对外价时平台在倒贴），而 `¥-` 这个形状
 * 第一眼读不出是负数，像是金额里混进了一个破折号。
 */
export function formatMoney(micro: number): string {
  return `${micro < 0 ? "-" : ""}¥${formatYuan(Math.abs(micro))}`;
}

/**
 * 大数字压成 1.2M / 345.6K。
 *
 * token 数动辄七八位，摊开写的话一行卡片里塞不下，而且几个卡片并排时
 * 位数不一样会让人第一眼读错一个数量级。精确值放在 title 里，鼠标停上去能看到。
 */
export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toLocaleString("zh-CN")}`;
}

/** 精确值，给 title 用。 */
export function formatExact(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** 时刻只到分：仪表盘上没有一个数字精确到秒，显示到秒会让人以为它是实时的。 */
export function formatClock(value: string): string {
  if (!value) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
