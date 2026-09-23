"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResult } from "@/app/login/api/login.api";

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

/**
 * 改自己的密码。这个账号之前发出去的令牌**全部作废**（别的电脑上的登录一起失效），
 * 回来的是一张新令牌 —— 调用方得拿它换掉本地那张，不然下一个请求就是 not login。
 */
export async function changePassword(payload: ChangePasswordPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/galaxy/consumer/auth/password", payload);
  return unwrapApiResponse(response.data);
}
