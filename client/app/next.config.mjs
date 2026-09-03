/** @type {import('next').NextConfig} */

// PWA 和 app-api 分开部署时，浏览器里的 localhost 指的是用户自己的机器，
// 直连必然失败。和 client/web 一样，让 Next 服务端把 /api 转发到 app-api，
// 前端只用同源相对路径，既不跨域也不用对外暴露 10002 端口。
function appApiTarget() {
  const target = process.env.APP_API_TARGET?.trim().replace(/\/$/, "");
  return target || "";
}

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const target = appApiTarget();
    if (!target) return [];
    return [
      { source: "/api/:path*", destination: `${target}/api/:path*` },
      { source: "/healthz", destination: `${target}/healthz` },
    ];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
