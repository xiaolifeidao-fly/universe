// pages/api/[...all].js（Pages Router 残留，专做到 Go 服务端的代理，和 client/web 的
// src/pages/api/[...all].js 是同一个原因存在——App Router 没有等价的"通配转发"能力）。
//
// 这里是自己的一份拷贝，没有 import @shared/api/createApiProxyHandler：
// Next.js 的 Pages API 路由用的是另一套（比常规页面更窄的）webpack 编译配置，
// 不认 client/shared/** 这种项目目录之外的 TS 源码（`next build` 会报
// "Module parse failed: Unexpected token"，`next dev` 因为按需编译反而不会现形，
// 属于一个不容易在本地发现的坑）。逻辑和 @shared/api/createApiProxyHandler.ts
// 完全一致，改动时两边一起改；真要去重，要么等 Next 支持，要么把这个路由换成
// App Router 的 route handler 再重新验证一遍。
import type { IncomingMessage, ServerResponse } from "http";
import axios from "axios";
import { createProxyMiddleware } from "http-proxy-middleware";

const target = process.env.SERVER_TARGET ?? "";
const prefix = process.env.APP_URL_PREFIX ?? "/api";

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

export default async function handler(
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
}
