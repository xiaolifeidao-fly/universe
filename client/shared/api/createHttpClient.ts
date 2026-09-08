/**
 * 通用 HTTP 封装工厂 —— 从 client/web/src/utils/axios.ts 抽出来的可复用核心：
 * token 注入、{success,code,data} 信封解包、class-transformer 反序列化、
 * "not login" 自动跳登录。
 *
 * 没有带上 web 那份 axios.ts 里 `resolveThreadWriterBusy` 的响应拦截器 ——
 * 那是 web 的 Codex/Claude 会话线程锁重试逻辑，是 delivery 模块的专属业务钩子，
 * 不是通用 HTTP 封装该管的事。
 *
 * TODO(shared-api): web 的 src/utils/axios.ts 还是它自己那份手写实现（多了上面
 * 那个业务钩子），没有改造成基于这个工厂 —— 这次新建 client/manager 没有动 web
 * 的现有文件，留给后续单独评估再做（比如给这个工厂加一个可选的
 * `responseInterceptor` 扩展点，web 把线程锁重试逻辑接进去）。
 */

"use client";

import axios, { type AxiosInstance } from "axios";
import { plainToInstance } from "class-transformer";

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

export interface CreateHttpClientOptions {
  /** 走 Next.js 的 pages/api/[...all].js 代理，通常就是 "/api"。 */
  baseURL: string;
  timeout?: number;
  getToken: () => string;
  /** 服务端返回 "not login" 类错误时调用；典型实现是清 token 后跳 /login。 */
  onAuthFailure: (message?: string | null, error?: string | null) => void;
}

export function createHttpClient(options: CreateHttpClientOptions) {
  const instance: AxiosInstance = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeout ?? 10000,
  });

  instance.interceptors.request.use((config) => {
    const token = options.getToken();
    if (token) {
      config.headers = config.headers ?? {};
      config.headers.token = token;
    }
    return config;
  });

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
    (error) => {
      const detail = detailOfErrorResponse((error as { response?: { data?: unknown } })?.response?.data);
      if (detail && error instanceof Error) {
        error.message = detail;
      }
      return Promise.reject(error);
    },
  );

  function unwrapResponse<T>(response: ApiResponse<T>): T {
    if (!response.success) {
      const content = `${response.error || ""} ${response.message || ""}`.toLowerCase();
      if (content.includes("not login") || content.includes("登录凭证")) {
        options.onAuthFailure(response.message, response.error);
      }
      throw new Error(response.error || response.message || "Request failed");
    }
    return response.data;
  }

  function unwrapApiResponse<T>(response: ApiResponse<T>): T {
    return unwrapResponse(response);
  }

  async function getData<T>(
    cls: new () => T,
    url: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const response = await instance.get<ApiResponse<T>>(url, { params });
    return plainToInstance(cls, unwrapResponse(response.data));
  }

  async function getDataList<T>(
    cls: new () => T,
    url: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const response = await instance.get<ApiResponse<T[]>>(url, { params });
    return plainToInstance(cls, unwrapResponse(response.data));
  }

  async function getPage<T>(
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

  return { instance, unwrapApiResponse, getData, getDataList, getPage };
}
