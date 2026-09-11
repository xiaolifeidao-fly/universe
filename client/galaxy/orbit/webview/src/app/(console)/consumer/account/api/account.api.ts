"use client";

import { getData } from "@/utils/axios";
import type { AuthUser } from "@/utils/auth";

/**
 * 当前账号，每次都从库里现取。
 *
 * 登录时存在本地的那份是登录那一刻的快照：运营后来停用、重置过，那份不会跟着变。
 * 形状和本地存的 AuthUser 一致，取回来可以直接写回去。
 */
export class AccountView implements AuthUser {
  id = "";

  side = "consumer" as const;

  username = "";

  displayName = "";

  status: AuthUser["status"] = "active";

  mustChangePassword = false;

  lastLoginAt?: string;

  createdAt = "";
}

export async function fetchCurrentAccount() {
  return getData(AccountView, "/galaxy/consumer/auth/me");
}
