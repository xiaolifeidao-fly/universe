"use client";

import type { BusinessLineId } from "@/business-lines/BusinessLineProvider";

/**
 * 服务端每张表都带 biz_line；未显式传入时会落到默认业务线。
 * 只有需要显式切换数据域的调用才从这里拼业务线参数。
 */
export function withBizLine<T extends object>(
  bizLine: BusinessLineId,
  params?: T,
): Record<string, string | number | undefined> {
  return { bizLine, ...(params ?? {}) } as Record<string, string | number | undefined>;
}
