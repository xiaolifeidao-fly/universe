"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResult } from "@/app/login/api/login.api";

export interface RegisterPayload {
  username: string;
  /** 不填就用用户名。 */
  displayName?: string;
  password: string;
}

/** 注册完直接是登录状态。共享端注册出来一律是散户，工作室由平台运营在管理端开通。 */
export async function register(payload: RegisterPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/galaxy/provider/auth/register", payload);
  return unwrapApiResponse(response.data);
}
