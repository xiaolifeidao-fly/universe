"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export interface LoginPayload {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;

  user: LoggedInUser;
}

export class LoggedInUser {
  id = 0;

  username = "";

  displayName = "";

  role = "member";

  mustChangePassword = false;
}

export async function login(payload: LoginPayload) {
  const response = await instance.post<ApiResponse<LoginResponse>>("/auth/login", payload);
  return unwrapApiResponse(response.data);
}
