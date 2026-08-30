"use client";

import { getData, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import { isAuthTokenRemembered, setAuthUser, type WorkPersona } from "@/utils/auth";
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

	persona: WorkPersona = "product_research";

	personas: WorkPersona[] = ["product_research"];

  status = "active";

  mustChangePassword = false;

  bizLines: string[] = [];

	writableBizLines: string[] = [];

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

// 授权范围一变（建空间、加入空间），浏览器里缓存的那份 authUser 就过时了。
// 界面上的「我是不是这个空间的管理员」全看它，不同步就得等到下次登录才正确。
export async function refreshAuthUser() {
  try {
    const profile = await fetchCurrentUser();
    setAuthUser(
      {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName,
        role: profile.role,
		persona: profile.persona,
		personas: profile.personas,
        mustChangePassword: profile.mustChangePassword,
        writableBizLines: profile.writableBizLines,
        managedBizLines: profile.managedBizLines,
        managedPrograms: profile.managedPrograms,
      },
      isAuthTokenRemembered(),
    );
  } catch {
    // 同步失败不该阻断刚完成的操作，刷新页面就会补上。
  }
}

export async function changeOwnPassword(currentPassword: string, newPassword: string) {
  const response = await instance.post<ApiResponse<LoginResponse>>("/auth/password", { currentPassword, newPassword });
  return unwrapApiResponse(response.data);
}
