"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResult } from "@/app/login/api/login.api";

export interface RegisterPayload {
  username: string;
  /** 不填就用用户名。 */
  displayName?: string;
  password: string;
  /** 邀请码。大小写不敏感、前后空白服务端也会忽略；没填就不带。填了但不存在，注册直接失败。 */
  inviteCode?: string;
}

/** 注册完直接是登录状态。共享端注册出来一律是散户，工作室由平台运营在管理端开通。 */
export async function register(payload: RegisterPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/galaxy/provider/auth/register", payload);
  return unwrapApiResponse(response.data);
}
