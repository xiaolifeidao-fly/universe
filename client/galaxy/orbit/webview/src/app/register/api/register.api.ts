"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResult } from "@/app/login/api/login.api";

export interface RegisterPayload {
  username: string;
  /** 不填就用用户名。 */
  displayName?: string;
  password: string;
  /** 分享链接带来的邀请码。填了就必须有效，服务端不会悄悄忽略一个打错的码。 */
  inviteCode?: string;
}

/** 注册完直接是登录状态。新账号名下没有密钥，要先有积分、再用积分买套餐才签发。 */
export async function register(payload: RegisterPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/galaxy/consumer/auth/register", payload);
  return unwrapApiResponse(response.data);
}
