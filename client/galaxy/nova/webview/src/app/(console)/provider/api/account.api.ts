"use client";

import { getData } from "@/utils/axios";
import type { AuthUser } from "@/utils/auth";

/**
 * 当前账号，每次都从库里现取。
 *
 * 登录时存在本地的那份是登录那一刻的快照：运营后来把人改成工作室，那份不会跟着变。
 * 形状和本地存的 AuthUser 一致，取回来可以直接写回去。
 */
export class AccountView implements AuthUser {
  id = "";

  side = "provider" as const;

  username = "";

  displayName = "";

  status: AuthUser["status"] = "active";

  mustChangePassword = false;

  /** 散户 / 工作室。注册出来一律是散户，只有平台运营能改。 */
  providerType?: AuthUser["providerType"];

  lastLoginAt?: string;

  createdAt = "";
}

export async function fetchCurrentAccount() {
  return getData(AccountView, "/galaxy/provider/auth/me");
}
