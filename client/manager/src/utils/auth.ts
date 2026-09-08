"use client";

import { createAuthStore, type BaseAuthUser } from "@shared/auth/createAuthStore";

/**
 * 管理端账号是**独立于业务用户**的一套（后端 zt_manager_*），所以这里不是
 * BaseAuthUser 原样：主键是字符串 userId 而不是自增 id，另外带上角色。
 *
 * 但 `writable` 刻意**不**存在这里 —— 本地存的东西改得动，把只读开关放在
 * localStorage 里等于给了一个客户端提权的开关。它每次由 /auth/me 现取
 * （见 components/shell/api/profile.api.ts），而且后端才是真正的门。
 */
export interface ManagerRoleRef {
  id: number;
  code: string;
  name: string;
}

export type AuthUser = Omit<BaseAuthUser, "id" | "role"> & {
  /** 后端的业务键，形如 mu_01J…。工厂用它做 per-user 的存储键前缀。 */
  id: string;
  roles: ManagerRoleRef[];
  superAdmin: boolean;
};

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
  token: "manager_auth_token",
  passwordChangeRequired: "manager_password_change_required",
  user: "manager_auth_user",
});
