"use client";

import { createHttpClient } from "@shared/api/createHttpClient";
export type { ApiResponse, PageResult } from "@shared/api/createHttpClient";
import { clearAuthToken, getAuthToken } from "@/utils/auth";

export const { instance, unwrapApiResponse, getData, getDataList, getPage } = createHttpClient({
  baseURL: "/api",
  getToken: getAuthToken,
  onAuthFailure: () => {
    clearAuthToken();
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
  },
});
