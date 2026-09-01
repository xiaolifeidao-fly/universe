import { clearSession, currentBizLine, currentToken } from "@/lib/auth";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: HeadersInit;
  authenticated?: boolean;
}

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  message?: string;
  error?: string | null;
};

function apiBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_API_BASE_URL?.trim().replace(/\/$/, "");
  return configured ? `${configured}/api` : "/api";
}

function toApiUrl(path: string) {
  return `${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiUrl(path: string) {
  return toApiUrl(path);
}

export function authenticatedApiHeaders(headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");
  const token = currentToken();
  const bizLine = currentBizLine();
  if (token) requestHeaders.set("token", token);
  if (bizLine) requestHeaders.set("X-Biz-Line", bizLine);
  return requestHeaders;
}

function messageOf(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { error?: unknown; message?: unknown };
  return typeof value.error === "string" && value.error.trim()
    ? value.error
    : typeof value.message === "string" && value.message.trim()
      ? value.message
      : fallback;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, authenticated = true, ...init } = options;
  const requestHeaders = authenticated ? authenticatedApiHeaders(headers) : new Headers(headers);
  requestHeaders.set("Accept", "application/json");

  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(toApiUrl(path), {
      ...init,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
    });
  } catch {
    throw new ApiError("网络不可用，请检查连接后重试。");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      }
    }
    throw new ApiError(messageOf(payload, `请求失败（${response.status}）`), response.status);
  }

  const envelope = payload as ApiEnvelope<T>;
  if (payload && typeof payload === "object" && envelope.success === false) {
    const failureMessage = envelope.error || envelope.message || "请求未完成";
    if (/登录凭证|not login|unauthorized/i.test(failureMessage)) {
      clearSession();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      }
    }
    throw new ApiError(failureMessage, response.status);
  }
  return payload && typeof payload === "object" && "data" in envelope ? (envelope.data as T) : (payload as T);
}

export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const { body, headers, authenticated = true, ...init } = options;
  const requestHeaders = authenticated ? authenticatedApiHeaders(headers) : new Headers(headers);
  requestHeaders.set("Accept", "application/octet-stream, application/json");
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(toApiUrl(path), {
      ...init,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
    });
  } catch {
    throw new ApiError("网络不可用，请检查连接后重试。");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload: unknown = await response.json();
    if (!response.ok) throw new ApiError(messageOf(payload, `请求失败（${response.status}）`), response.status);
    const envelope = payload as ApiEnvelope<unknown>;
    if (payload && typeof payload === "object" && envelope.success === false) {
      const failureMessage = envelope.error || envelope.message || "请求未完成";
      if (/登录凭证|not login|unauthorized/i.test(failureMessage)) {
        clearSession();
        if (typeof window !== "undefined" && window.location.pathname !== "/login") {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        }
      }
      throw new ApiError(failureMessage, response.status);
    }
    throw new ApiError("文档预览返回了无效内容。", response.status);
  }
  if (!response.ok) throw new ApiError(`请求失败（${response.status}）`, response.status);
  return response.blob();
}

export async function upload<T>(path: string, body: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(toApiUrl(path), {
      method: "POST",
      headers: authenticatedApiHeaders(),
      body,
      credentials: "omit",
    });
  } catch {
    throw new ApiError("网络不可用，请检查连接后重试。");
  }
  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new ApiError(messageOf(payload, `上传失败（${response.status}）`), response.status);
  const envelope = payload as ApiEnvelope<T>;
  if (payload && typeof payload === "object" && envelope.success === false) {
    throw new ApiError(envelope.error || envelope.message || "上传未完成", response.status);
  }
  return payload && typeof payload === "object" && "data" in envelope ? (envelope.data as T) : (payload as T);
}
