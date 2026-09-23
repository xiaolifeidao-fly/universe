"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/** 官网入口只负责报告“打开”，事件键由服务端固定，浏览器不能自定义。 */
export async function recordPortalOpen(): Promise<void> {
  const response = await instance.post<ApiResponse<null>>("/galaxy/portal/events/open");
  unwrapApiResponse(response.data);
}
