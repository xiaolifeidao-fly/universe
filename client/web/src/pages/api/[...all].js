// pages/api/[...all].js
import axios from "axios";
import { constants } from "buffer";
import { createProxyMiddleware } from "http-proxy-middleware";
import { headers } from "next/headers";
import formidable from 'formidable';
import FormData from 'form-data';
import fs from 'fs';

require('dotenv').config();

const prefix = process.env.APP_URL_PREFIX;
const target = process.env.SERVER_TARGET;


export default async function handler(req, res) {
  if (req.method === "GET") {
    await proxyGet(req, res);
    return;
  }
  try {
    const url = getTargetUrl(req.url);
    const response = await request(url, req)
    // 获取目标服务器的响应
    const data = response.data;
    // 将目标服务器的响应返回给客户端
    res.status(response.status).json(data);
  } catch (error) {
      console.error('Error forwarding request:', error);
      // axios 对任何非 2xx 都抛异常。以前这里一律回 500，后端的 404、401、
      // 业务错误在浏览器里全长成「Request failed with status code 500」，
      // 排查时看不出到底是哪一层出的问题，所以原样透传上游状态码和响应体。
      const upstream = error.response;
      if (upstream) {
        res.status(upstream.status).json(
          typeof upstream.data === "object" && upstream.data !== null
            ? upstream.data
            : { error: String(upstream.data || upstream.statusText || "Upstream error") },
        );
        return;
      }
      res.status(502).json({ error: `Upstream unreachable: ${error.message}` });
  }
}

function proxyGet(req, res) {
  return new Promise((resolve) => {
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      resolve();
    };
    const fail = (error) => {
      console.error('Proxy error:', error);
      if (!res.headersSent) {
        res.status(502).send('Proxy error');
      }
      complete();
    };

    const proxy = createProxyMiddleware({
      target: target, // 设置代理目标地址
      changeOrigin: true, // 设置请求头中的 Host 为目标地址的 Host
      pathRewrite: (path) => {
        if (path === "/api/healthz") {
          return "/healthz";
        }
        return path.replace(/^\/api/, prefix);
      },
      headers: req.headers,
      on: {
        error: fail,
      },
    });

    res.once('finish', complete);
    res.once('close', complete);
    void proxy(req, res, fail);
  });
}

async function request(url, req){
  const method = req.method;
  const headers = req.headers;
  if(method === 'POST'){
    // 普通 POST
    console.log("request url is ", url);
    const response = await axios.post(url, req.body, { headers });
    return response;
  }
  if(method === 'PUT'){
    return await axios.put(url, req.body, {  headers});
  }
  if(method === 'DELETE'){
    return await axios.delete(url, { params: req.body, headers});
  }
  return null;
}

function getTargetUrl(url){
  url = url.replace("/api",prefix)
  return target  + url;
}
