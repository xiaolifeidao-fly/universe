"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/** 官网入口只负责报告“打开”，事件键由服务端固定，浏览器不能自定义。 */
export async function recordPortalOpen(): Promise<void> {
  const response = await instance.post<ApiResponse<null>>("/galaxy/portal/events/open");
  unwrapApiResponse(response.data);
}

/** 官网模型广场的模型点击，与 Orbit 的同名事件汇总到一起。 */
export async function recordPortalModelClick(modelId: string): Promise<void> {
  const response = await instance.post<ApiResponse<null>>("/galaxy/portal/events/model-click", { modelId });
  unwrapApiResponse(response.data);
}
