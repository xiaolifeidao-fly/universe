"use client";

import { createAuthStore } from "@shared/auth/createAuthStore";

/**
 * 控制台登录态。存的是**用户令牌**，不是 `sk-` 算力密钥 —— 两者各有各的存法：
 * 密钥明文归 consumer/api/keyvault.api.ts 管（桌面端进主进程的 SQLite，浏览器才落 localStorage），
 * 键名、分区和清理规则都在那边，别顺手塞到这里来。
 *
 * 账号是 Galaxy 自己的，分共享端（Nova）和使用端（Orbit）两批人：各注册各的，
 * 同一个用户名在两端是两个账号，一端的令牌打到另一端就是 not login。
 * 所以存储键带上端名：两端哪天同源部署也读不到对方的令牌；以前任务宇宙账号留在
 * galaxy_auth_* 下的登录态也跟着作废 —— 那张令牌这边本来就不认，形状也对不上
 * （数字 id、没有端），与其读出来再被踢回登录页，不如直接当没登录。
 */
export interface AuthUser {
  /** 业务键 cu_…。密钥、订单、账单记在谁名下，存的就是它。 */
  id: string;
  side: "consumer";
  /** 服务端统一存小写。 */
  username: string;
  displayName: string;
  status: "active" | "disabled";
  /** 运营重置过密码、本人还没改。为真时服务端只放行「看自己」和「改密码」两个接口。 */
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
}

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
  token: "galaxy_consumer_auth_token",
  passwordChangeRequired: "galaxy_consumer_password_change_required",
  user: "galaxy_consumer_auth_user",
});

/* ---------- 账号规则 ---------- */

// 和服务端 service/galaxy/account 同一套。注册、改密码两页先在前端拦一道，
// 只为少跑一趟、提示来得快；说了算的是服务端。

/** 用户名：字母或数字开头，允许 _ . @ + -，手机号、邮箱都能直接用。不分大小写。 */
export function usernameIssue(username: string): "pattern" | "length" | null {
  if (!/^[a-z0-9][a-z0-9_.@+-]*$/i.test(username)) return "pattern";
  return username.length < 2 || username.length > 64 ? "length" : null;
}

/** 密码按**字节**数算，8 到 72：bcrypt 只看前 72 个字节，再长的部分改了也登得进去，服务端宁可当场拒掉。 */
export function passwordIssue(password: string): "short" | "long" | null {
  const bytes = new TextEncoder().encode(password).length;
  if (bytes < 8) return "short";
  return bytes > 72 ? "long" : null;
}
