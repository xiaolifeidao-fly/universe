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
