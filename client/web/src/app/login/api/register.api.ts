"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResponse } from "@/app/login/api/login.api";

export interface RegisterPayload {
  username: string;
  displayName: string;
  password: string;
}

// 注册成功后端会直接签发令牌，前端拿到就等于已登录。
export async function register(payload: RegisterPayload) {
  const response = await instance.post<ApiResponse<LoginResponse>>("/auth/register", payload);
  return unwrapApiResponse(response.data);
}
