"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { AuthUser } from "@/utils/auth";

export interface LoginPayload {
  username: string;
  password: string;
}

export interface LoginResult {
  token: string;
  user: AuthUser;
}

/**
 * 管理端登录。打的是 manager-api 自己的账号体系（zt_manager_user），
 * 和 web 控制台、App 那套业务账号（zt_identity_user）没有任何关系 ——
 * 业务账号在这里登不进去，这是有意的。
 */
export async function login(payload: LoginPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/auth/login", payload);
  return unwrapApiResponse(response.data);
}

export async function logout() {
  const response = await instance.post<ApiResponse<string>>("/auth/logout", {});
  return unwrapApiResponse(response.data);
}
