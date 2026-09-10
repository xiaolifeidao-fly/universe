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

export async function login(payload: LoginPayload) {
  const response = await instance.post<ApiResponse<LoginResult>>("/auth/login", payload);
  return unwrapApiResponse(response.data);
}
