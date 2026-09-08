/**
 * 通用 Next.js Pages Router API 代理工厂 —— 从 client/web/src/pages/api/[...all].js
 * 抽出来的核心逻辑（转发到 Go 服务端，GET 走 http-proxy-middleware 流式代理，
 * POST/PUT/DELETE 走 axios 转发并原样透传上游状态码）。
 *
 * 清理点：web 那份文件 import 了 `constants`（node:buffer）、`formidable`、
 * `form-data`、`fs`，但 handler 里实际没用上（应该是历史遗留），这里没有照抄。
 *
 * 用法（各 app 的 pages/api/[...all].ts）：
 * ```ts
 * import { createApiProxyHandler } from "@shared/api/createApiProxyHandler";
 * export default createApiProxyHandler({
 *   target: process.env.SERVER_TARGET ?? "",
 *   prefix: process.env.APP_URL_PREFIX ?? "/api",
 * });
 * ```
 *
 * TODO(shared-api): web 的 src/pages/api/[...all].js 还是它自己那份手写实现，
 * 没有切换成基于这个工厂 —— 这次新建 client/manager 没有动 web 的现有文件，
 * 留给后续单独评估再做。
 *
 * 已知限制：manager 的 pages/api/[...all].ts **没有**实际 import 这个文件——
 * Next.js 的 Pages API 路由走的是另一套更窄的 webpack 编译配置，不认
 * client/shared/** 这种项目目录之外的 TS 源码，`next build` 会报
 * "Module parse failed: Unexpected token"（`next dev` 按需编译不会现形，
 * 容易在本地漏掉，一定要跑一次 `next build` 验证）。manager 那边现在是一份
 * 逻辑相同的独立拷贝，改这个文件时记得同步过去。
 */

import type { IncomingMessage, ServerResponse } from "http";
import axios from "axios";
import { createProxyMiddleware } from "http-proxy-middleware";

export interface ApiProxyHandlerOptions {
  /** 上游 Go 服务端地址，例如 "http://127.0.0.1:8691"。 */
  target: string;
  /** 上游路径前缀，用来把本地 "/api/xxx" 改写成上游的 "{prefix}/xxx"，例如 "/api"。 */
  prefix: string;
}

export function createApiProxyHandler({ target, prefix }: ApiProxyHandlerOptions) {
  function getTargetUrl(url: string) {
    return target + url.replace("/api", prefix);
  }

  function proxyGet(req: IncomingMessage, res: ServerResponse) {
    return new Promise<void>((resolve) => {
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        resolve();
      };
      const fail = (error: unknown) => {
        console.error("Proxy error:", error);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.end("Proxy error");
        }
        complete();
      };

      const proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        pathRewrite: (path) => {
          if (path === "/api/healthz") return "/healthz";
          return path.replace(/^\/api/, prefix);
        },
        headers: req.headers as Record<string, string>,
        on: { error: fail },
      });

      res.once("finish", complete);
      res.once("close", complete);
      void proxy(req, res, (error?: unknown) => fail(error));
    });
  }

  async function forward(url: string, req: IncomingMessage & { body?: unknown }) {
    const { method, headers } = req;
    if (method === "POST") return axios.post(url, req.body, { headers });
    if (method === "PUT") return axios.put(url, req.body, { headers });
    if (method === "DELETE") return axios.delete(url, { params: req.body, headers });
    return null;
  }

  return async function apiProxyHandler(
    req: IncomingMessage & { method?: string; url?: string; body?: unknown },
    res: ServerResponse & { status: (code: number) => ServerResponse & { json: (body: unknown) => void }; json: (body: unknown) => void },
  ) {
    if (req.method === "GET") {
      await proxyGet(req, res);
      return;
    }
    try {
      const url = getTargetUrl(req.url ?? "");
      const response = await forward(url, req);
      res.status(response?.status ?? 200).json(response?.data ?? null);
    } catch (error) {
      console.error("Error forwarding request:", error);
      // axios 对任何非 2xx 都抛异常，原样透传上游状态码和响应体，
      // 避免后端的 404/401/业务错误在浏览器里全长成一句 "Request failed with status code 500"。
      const upstream = (error as { response?: { status: number; data: unknown; statusText?: string } }).response;
      if (upstream) {
        res.status(upstream.status).json(
          typeof upstream.data === "object" && upstream.data !== null
            ? upstream.data
            : { error: String(upstream.data || upstream.statusText || "Upstream error") },
        );
        return;
      }
      res.status(502).json({ error: `Upstream unreachable: ${(error as Error).message}` });
    }
  };
}
