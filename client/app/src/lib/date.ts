export function dateInputValue(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

export function dateTimeLabel(value: string | null | undefined) {
  if (!value) return "尚未更新";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function dateToIso(value: string) {
  return value ? `${value}T00:00:00.000Z` : null;
}

/**
 * 消息列表用的相对时间。手机上一屏放不下十几个「2026/09/03 14:22:10」，
 * 而且看消息时真正关心的是「多久以前」；超过一周才退回具体日期。
 */
export function relativeTimeLabel(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleDateString("zh-CN");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN");
}
