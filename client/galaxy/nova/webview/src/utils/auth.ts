"use client";

import { createAuthStore, type BaseAuthUser } from "@shared/auth/createAuthStore";

/**
 * 控制台登录态。存的是**用户令牌**，不是 `sk-` 算力密钥 ——
 * 后者是给 SDK 用的，它带着余额、能直接花钱，不该进浏览器 localStorage。
 * 密钥明文只在签发那一刻显示一次，之后控制台也只看得到匿名标识与余额。
 */
export type AuthUser = BaseAuthUser;

export const {
  getAuthToken,
  setAuthToken,
  clearAuthToken,
  isAuthenticated,
  isAuthTokenRemembered,
  setAuthUser,
  getAuthUser,
  getUserScopedStorageKey,
  setPasswordChangeRequired,
  isPasswordChangeRequired,
} = createAuthStore<AuthUser>({
  token: "galaxy_auth_token",
  passwordChangeRequired: "galaxy_password_change_required",
  user: "galaxy_auth_user",
});
