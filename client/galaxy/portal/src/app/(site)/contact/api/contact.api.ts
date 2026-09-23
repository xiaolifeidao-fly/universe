"use client";

/**
 * 「联系我们」的接口层。按仓库惯例，页面自带自己的 api/ ——
 * 留资只归这一页；官网打开埋点属于整个站点，放在路由组共用的 api/ 下。
 *
 * 打的是 /api/galaxy/portal/leads：它会写入来访者填写的内容，
 * 所以限流、蜜罐与字段截断都在服务端做，这里只负责把话说清楚地送过去。
 */

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export interface SubmitLeadRequest {
  name?: string;
  contact: string;
  company?: string;
  topic?: string;
  scale?: string;
  message?: string;
  source?: string;
  /** 蜜罐。真人看不见这个字段，脚本会顺手填 —— 服务端见到非空就当成功打发走。 */
  website?: string;
}

export interface LeadView {
  leadId: string;
  createdAt: string;
}

export async function submitLead(payload: SubmitLeadRequest): Promise<LeadView> {
  const response = await instance.post<ApiResponse<LeadView>>("/galaxy/portal/leads", {
    ...payload,
    source: payload.source ?? "portal",
  });
  return unwrapApiResponse(response.data);
}
