"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { AuthUser } from "@/utils/auth";

export interface LoginPayload {
  username: string;
  password: string;
}

/** 登录、注册、改密码回的都是这个形状：注册即登录，改密码作废旧令牌、同时发一张新的。 */
export interface LoginResult {
  token: string;
  user: AuthUser;
}

/** 共享端账号。和 Orbit（使用端）是两批人，那边注册的账号在这里登不上。 */
export async function login(payload: LoginPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/galaxy/provider/auth/login", payload);
  return unwrapApiResponse(response.data);
}
