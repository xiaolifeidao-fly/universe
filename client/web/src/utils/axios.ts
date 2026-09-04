"use client";

import axios from "axios";
import { plainToInstance } from "class-transformer";
import { clearAuthToken, getAuthToken } from "@/utils/auth";
import { resolveThreadWriterBusy } from "@/project-workspaces/threadWriterLock";

export interface ApiResponse<T> {
  success: boolean;
  code: number;
  data: T;
  message: string;
  error: string | null;
}

export interface PageResult<T> {
  total: number;
  data: T[];
}

export const instance = axios.create({
  baseURL: "/api",
  timeout: 10000,
});

instance.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.token = token;
  }
  return config;
});

function handleAuthFailure(message?: string | null, error?: string | null) {
  const content = `${error || ""} ${message || ""}`.toLowerCase();
  if (!content.includes("not login") && !content.includes("登录凭证")) {
    return;
  }
  clearAuthToken();
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

/** 桥接类接口（非统一响应）失败时把服务端返回的具体原因顶到 error.message，别让界面只剩一句 HTTP 状态码。 */
function detailOfErrorResponse(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object") {
    const payload = data as { error?: unknown; message?: unknown };
    const detail = payload.error ?? payload.message;
    if (typeof detail === "string") return detail.trim();
  }
  return "";
}

instance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const detail = detailOfErrorResponse((error as { response?: { data?: unknown } })?.response?.data);
    if (detail && error instanceof Error) {
      error.message = detail;
    }
    // Codex 的会话线程被别的进程占着时，先问过用户要不要收掉那个进程；同意了就把刚才
    // 失败的请求原样重发一次，调用方不必知道中间发生过什么。
    const retried = await resolveThreadWriterBusy(instance, error);
    if (retried) return retried;
    return Promise.reject(error);
  },
);

function unwrapResponse<T>(response: ApiResponse<T>): T {
  if (!response.success) {
    handleAuthFailure(response.message, response.error);
    throw new Error(response.error || response.message || "Request failed");
  }
  return response.data;
}

export function unwrapApiResponse<T>(response: ApiResponse<T>): T {
  return unwrapResponse(response);
}

export async function getData<T>(
  cls: new () => T,
  url: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const response = await instance.get<ApiResponse<T>>(url, { params });
  return plainToInstance(cls, unwrapResponse(response.data));
}

export async function getDataList<T>(
  cls: new () => T,
  url: string,
  params?: Record<string, string | number | undefined>,
): Promise<T[]> {
  const response = await instance.get<ApiResponse<T[]>>(url, { params });
  return plainToInstance(cls, unwrapResponse(response.data));
}

export async function getPage<T>(
  cls: new () => T,
  url: string,
  params?: Record<string, string | number | undefined>,
): Promise<PageResult<T>> {
  const response = await instance.get<ApiResponse<PageResult<T>>>(url, { params });
  const page = unwrapResponse(response.data);
  return {
    total: page.total,
    data: plainToInstance(cls, page.data ?? []),
  };
}
