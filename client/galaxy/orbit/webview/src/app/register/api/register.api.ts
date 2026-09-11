"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResult } from "@/app/login/api/login.api";

export interface RegisterPayload {
  username: string;
  /** 不填就用用户名。 */
  displayName?: string;
  password: string;
}

/** 注册完直接是登录状态。新账号名下没有密钥，要先买额度包，支付到账时才签发。 */
export async function register(payload: RegisterPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/galaxy/consumer/auth/register", payload);
  return unwrapApiResponse(response.data);
}
