/**
 * 站点配置的真值来源：**部署机的环境变量**，每次渲染现读。
 * 只在 React Server Component 里调用（和 portal.server.ts 一样）。
 *
 * 读出来之后由根布局塞进 SiteConfigProvider 发给客户端组件，
 * 所以浏览器里拿到的永远是**这个进程启动时**的环境，不是构建那一刻的。
 * 改地址 = 改 runtime.json（或 start.sh 的环境）+ 重启进程，不用重新构建。
 */

import "server-only";

import { unstable_noStore as noStore } from "next/cache";

import { FALLBACK_SITE_CONFIG, type SiteConfig } from "@/utils/site";

/**
 * 每一项认哪些环境变量，**从左到右取第一个非空的**。
 *
 * GALAXY_* 是现在的名字。NEXT_PUBLIC_* 是旧名，留着只为兼容已经在服务器
 * runtime.json 里写好那份配置的部署 —— 它们现在跟别的服务端变量没有区别，
 * NEXT_PUBLIC_ 这个前缀在这里只剩误导（它本来的含义是「会被打进浏览器包」）。
 *
 * ⚠️ 下面 pick() 里必须用 `process.env[名字]` 这样的**动态取法**。
 * 写成 `process.env.NEXT_PUBLIC_CONSOLE_URL` 这种字面量的话，Next 打包时
 * 会把它替换成构建那一刻的值，这个文件就白写了 —— 那正是要修的毛病本身。
 * 动态取法在服务端是安全的：那边 process.env 是活的 Node 对象。
 * （反过来，在**浏览器**里动态取 NEXT_PUBLIC_* 永远是 undefined，所以客户端
 * 组件一个环境变量都不读，全部等服务端发下来。）
 */
const ENV_KEYS: Record<keyof SiteConfig, readonly string[]> = {
  consoleURL: ["GALAXY_CONSOLE_URL", "NEXT_PUBLIC_CONSOLE_URL"],
  docsURL: ["GALAXY_DOCS_URL", "NEXT_PUBLIC_DOCS_URL"],
  contactEmail: ["GALAXY_CONTACT_EMAIL", "NEXT_PUBLIC_CONTACT_EMAIL"],
  contactWechat: ["GALAXY_CONTACT_WECHAT", "NEXT_PUBLIC_CONTACT_WECHAT"],
  icp: ["GALAXY_ICP", "NEXT_PUBLIC_ICP"],
};

function pick(names: readonly string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function readSiteConfig(): SiteConfig {
  // 这一句把调用它的路由从「静态预渲染」里摘出来。
  //
  // 不加的话，根布局会在 next build 时被渲染一次、结果连同环境变量一起烙进
  // 预渲染的 HTML —— 值又一次定格在打包机上，换个地方复发同一个毛病。
  //
  // 代价只在**渲染**：页面改成每次请求渲一遍。取数不受影响 ——
  // overview 那个 fetch 自带 revalidate 60，后端依旧是每分钟最多被打一次
  // （见 portal.server.ts）。门户就四个页面，这点渲染换「改配置不用重新构建」，值。
  noStore();

  return {
    consoleURL: pick(ENV_KEYS.consoleURL) || FALLBACK_SITE_CONFIG.consoleURL,
    docsURL: pick(ENV_KEYS.docsURL),
    contactEmail: pick(ENV_KEYS.contactEmail),
    contactWechat: pick(ENV_KEYS.contactWechat),
    icp: pick(ENV_KEYS.icp),
  };
}
