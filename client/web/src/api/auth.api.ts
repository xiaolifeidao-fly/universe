"use client";

import { getData, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResponse } from "@/app/login/api/login.api";

export class CurrentUserProgramScope {
  bizLine = "";

  programId = 0;
}

// 个人中心展示的是 /auth/me 的完整档案，比登录时缓存在浏览器里的那份多出
// 授权范围和时间信息，所以单独取一次而不是复用 getAuthUser()。
export class CurrentUserProfile {
  id = 0;

  username = "";

  displayName = "";

  role = "member";

  status = "active";

  mustChangePassword = false;

  bizLines: string[] = [];

	managedBizLines: string[] = [];

  programs: CurrentUserProgramScope[] = [];

	managedPrograms: CurrentUserProgramScope[] = [];

  lastLoginAt?: string;

  updatedAt?: string;

  createdAt?: string;
}

export async function fetchCurrentUser() {
  return getData(CurrentUserProfile, "/auth/me");
}

export async function changeOwnPassword(currentPassword: string, newPassword: string) {
  const response = await instance.post<ApiResponse<LoginResponse>>("/auth/password", { currentPassword, newPassword });
  return unwrapApiResponse(response.data);
}
