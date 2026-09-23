"use client";

import { createHttpClient } from "@shared/api/createHttpClient";
export type { ApiResponse, PageResult } from "@shared/api/createHttpClient";
import { clearAuthToken, getAuthToken } from "@/utils/auth";
import { productConfig } from "@/utils/product";

// 这两处是整个界面里仅有的「自己拼绝对路径」的地方，所以也是仅有的两处要手工
// 带上 basePath 的地方 —— 页面跳转走 next/navigation，它会自己加前缀。
const login = `${productConfig.basePath}/login`;

export const { instance, unwrapApiResponse, getData, getDataList, getPage } = createHttpClient({
  baseURL: `${productConfig.basePath}/api`,
  getToken: getAuthToken,
  onAuthFailure: () => {
    clearAuthToken();
    if (typeof window !== "undefined" && window.location.pathname !== login) {
      window.location.href = login;
    }
  },
});
