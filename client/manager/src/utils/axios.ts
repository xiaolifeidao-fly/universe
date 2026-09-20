"use client";

import { createHttpClient } from "@shared/api/createHttpClient";
export type { ApiResponse, PageResult } from "@shared/api/createHttpClient";
import { clearAuthToken, getAuthToken } from "@/utils/auth";
import { basePath } from "@/utils/site";

// 这两处是整个界面里仅有的「自己拼绝对路径」的地方，所以也是仅有的两处要手工
// 带上 basePath 的地方 —— 页面跳转走 next/navigation，它会自己加前缀。
//
// baseURL 少了前缀，请求会打到站点根上的 /api/...，那是门户的地盘（线上）或者
// 无人接管的路径（本机），症状是整个控制台一片 404 而不是某个接口坏了。
const login = `${basePath}/login`;

export const { instance, unwrapApiResponse, getData, getDataList, getPage } = createHttpClient({
  baseURL: `${basePath}/api`,
  getToken: getAuthToken,
  onAuthFailure: () => {
    clearAuthToken();
    if (typeof window !== "undefined" && window.location.pathname !== login) {
      window.location.href = login;
    }
  },
});
