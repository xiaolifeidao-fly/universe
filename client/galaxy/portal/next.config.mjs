/**
 * 门户站的 Next 配置。
 *
 * 和两个控制台（nova/orbit webview）比，这里少一样东西：不 transpile @galaxy/common。
 * 门户没有桌面壳，也没有本机能力 —— 它是一个任何人都能打开的网页，
 * 把只有 Electron 里才有意义的契约包拉进来只会让打包体积白涨。
 *
 * 只从 client/shared 借两样纯数据/纯浏览器的东西（字体 token、axios 封装），
 * 都不渲染 antd 组件，所以不会踩到 shared/node_modules 那个「唯一符号链接」
 * 导致的 antd 双实例问题（详见 orbit/webview/next.config.mjs 顶部那段）。
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { outputFileTracingRoot: new URL("../../../", import.meta.url).pathname },
  output: "standalone",
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.modules = [...(config.resolve.modules ?? []), "node_modules"];
    return config;
  },
  async headers() {
    return [
      { source: "/favicon.ico", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
      // 自托管字体不会变，缓存一年。门户是陌生人第一次访问的页面，
      // 字体是首屏最大的那几个请求。
      {
        source: "/fonts/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
