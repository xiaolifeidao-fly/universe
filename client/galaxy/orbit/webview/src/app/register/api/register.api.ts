"use client";

import { instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import type { LoginResult } from "@/app/login/api/login.api";

export interface RegisterPayload {
  username: string;
  /** 不填就用用户名。 */
  displayName?: string;
  password: string;
  /** 分享链接带来的邀请码。填了就必须有效，服务端不会悄悄忽略一个打错的码。 */
  inviteCode?: string;
}

/**
 * 注册送的那把密钥。
 *
 * 明文**只在注册这一次响应里出现**：拿到就存进本机保险箱（consumer/api/keyvault.api.ts），
 * 之后要用走密钥页的取回接口。服务端没签出来时整个字段是空的 —— 注册照常算成，
 * 人在密钥页点一下「新建」就有。
 */
export interface RegisteredKey {
  keyId: string;
  secret: string;
  alias: string;
  expiresAt: string;
}

export interface RegisterResult extends LoginResult {
  key?: RegisteredKey;
}

/** 注册完直接是登录状态，名下已经有一把默认密钥。积分由平台运营充值，调模型时逐笔扣。 */
export async function register(payload: RegisterPayload) {
  const response = await instance.post<ApiResponse<RegisterResult>>("/galaxy/consumer/auth/register", payload);
  return unwrapApiResponse(response.data);
}
