


/**
 * client/shared 是普通源码目录、不是 workspace 包，它自己没有 node_modules ——
 * 靠 client/shared/node_modules 这个符号链接才能解析 `import "antd"` 这类裸导入。
 * 下面这行让 shared/** 的裸导入能落到 node_modules 上，删掉会让 shared 编译失败。
 *
 * ⚠️ 已知隐患：那个符号链接**只有一个**，指向第一个 npm install 的那个 app
 * （现在是 client/manager）。于是 shared/** 里的 antd 来自 manager 的副本，
 * 而本应用页面里的 antd 来自自己的副本 —— 服务端与客户端解析到了两份实例，
 * 开发模式下会看到 antd cssinjs 的 className 水合不一致告警。
 *
 * 今天没有实际影响（两个 app 的 antd 版本一致，主题也确实传到了组件），
 * 但两边版本一旦漂移就会变成真问题。试过的三条路都不行，记录下来免得重踩：
 *   · resolve.alias 把 antd 指向目录 → 绕过 package.json 的 exports，
 *     `antd/locale/zh_CN` 这类子路径导入直接解析失败；
 *   · 顺带 alias react / react-dom → Next 已经把它们指向捆绑的 react-server 变体，
 *     再别名一次 RSC 预渲染崩在 useContext 上；
 *   · 把本应用的 node_modules 插到 resolve.modules 最前面 → 同样打挂预渲染。
 * 正解是把 client/ 做成 npm workspaces，让三个 app 共用一份提升后的 node_modules。
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@galaxy/common"],
  experimental: { outputFileTracingRoot: new URL("../../../../", import.meta.url).pathname },
  output: "standalone",
  reactStrictMode: false,
  webpack: (config) => {
    config.resolve.modules = [...(config.resolve.modules ?? []), "node_modules"];
    return config;
  },
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
