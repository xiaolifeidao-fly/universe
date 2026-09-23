/**
 * basePath：管理端挂在站点的 `/manager` 这一段下。
 *
 * 不是审美选择 —— www.galaxy.rodeo 的证书只签了一个名字，所有站点挤在同一个 host 上
 * 按路径分流（门户占根，Nova 在 /nova，Orbit 在 /orbit，管理端在 /manager，
 * 见 doc/deployment/nginx/www.galaxy.rodeo.conf）。nginx 那条 location **不改写路径**，
 * 所以应用自己必须知道自己挂在哪，这一项不能省。
 *
 * 写成常量而不是构建期环境变量（Nova/Orbit 那边是变量，因为同一份构建还要塞进桌面壳、
 * 跑在 127.0.0.1 的根上；管理端没有壳，只有这一个部署形态）。漏注入环境变量的症状是
 * 线上页面能开、_next 与接口全 404，很难当场看出来，不如不给它这个机会。
 * 本机开发也跟着走：http://localhost:7895/manager —— 和线上同一个地址形状。
 *
 * 跟着 basePath 走的东西里，只有两样要手工带前缀，其余（页面跳转、`_next` 静态资源、
 * `public/` 下的文件、headers() 的 source）Next 自己会加：
 *   · src/utils/axios.ts 的 baseURL 与未登录跳转，是界面里仅有的两处手拼绝对路径；
 *   · src/app/fonts.css —— CSS 的 url() 不认 basePath，Next 也不会帮你改写它。
 */
const BASE_PATH = "/manager";

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: BASE_PATH,
  // 客户端代码从这里读（src/utils/site.ts）。构建期内联，改部署机上的环境变量不会生效 ——
  // basePath 本来也是构建期就定死的，两者必须是同一个值，所以刻意从同一个常量出。
  env: {
    NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  },
  output: "standalone",
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/favicon.ico",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
};

export default nextConfig;
