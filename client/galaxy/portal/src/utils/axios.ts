"use client";

/**
 * 浏览器侧的 HTTP 封装。门户只用它做一件事：提交「联系我们」。
 *
 * 读接口全在服务端取（见 utils/portal.server.ts）—— 门户的内容要进 HTML，
 * 不能是一圈转菊花。所以这里没有 token，也没有跳登录：门户上没有登录态，
 * 一条需要身份的接口都不该出现。
 */

import { createHttpClient } from "@shared/api/createHttpClient";
export type { ApiResponse } from "@shared/api/createHttpClient";

export const { instance, unwrapApiResponse } = createHttpClient({
  baseURL: "/api",
  getToken: () => "",
  onAuthFailure: () => {
    // 门户没有登录态。真收到「未登录」只可能是接口挂错了组，
    // 让它照常抛出去，比悄悄跳到一个不存在的登录页好排查。
  },
});
