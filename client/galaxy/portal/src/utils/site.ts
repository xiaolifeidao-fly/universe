/**
 * 站点级配置的**形状与兜底**。真值不在这个文件里 —— 它在部署机的环境变量里，
 * 由服务端在渲染时现读一次，随 RSC 载荷发给浏览器（见 utils/site.server.ts
 * 与 components/site/SiteConfigProvider.tsx）。
 *
 * ⚠️ 这里一个 process.env 都不许出现，NEXT_PUBLIC_ 的也不行。
 *
 * 原来这几个值是写成 `process.env.NEXT_PUBLIC_XXX` 从这里读的。那种写法是
 * **构建期**的：Next 打包时把它替换成字符串字面量塞进浏览器包，值就此定格在
 * 构建那一刻 —— 打包机上是什么，线上部署多少次都还是什么。线上真踩了：
 * www.galaxy.rodeo 的「控制台」按钮指着 http://127.0.0.1:17899/orbit/consumer/keys，
 * 那是打包机的地址；服务器上怎么改配置都没用，只能回去重新构建一次。
 *
 * 换域名、换联系方式是运维动作，不该是一次前端发版 —— 所以现在全部走服务端
 * 运行时读。想加一项就在 SiteConfig 里加个字段，再到 site.server.ts 的表里
 * 写上它认哪个环境变量。
 *
 * 没配的联系方式**不编一个**：页面上显示成 [待填写]，运营一眼就知道该补哪。
 * 编一个假邮箱的代价是有人真的往那儿发信，然后再也没有下文。
 */

export const PLACEHOLDER = "[待填写]";

export interface SiteConfig {
  /** 「控制台」按钮指向哪儿 —— 使用端（Orbit）那个控制台部署的地址。 */
  consoleURL: string;
  docsURL: string;
  contactEmail: string;
  contactWechat: string;
  icp: string;
}

/**
 * 控制台地址没配时的兜底。同域部署时它正好对 —— 前面那段 /orbit 不能省：
 * 门户占着站点根，两个控制台各挂在自己的 basePath 下（见 common/index.js）。
 * 分域部署必须配 GALAXY_CONSOLE_URL，否则点过去就是门户自己的 404。
 */
export const DEFAULT_CONSOLE_URL = "/orbit/consumer/keys";

/**
 * 服务端还没把配置发下来时用的那一份（客户端组件被单独渲染、测试里直接挂载
 * 这类场合）。除了控制台兜底，其余一律空串 —— 空串会渲染成 [待填写]。
 */
export const FALLBACK_SITE_CONFIG: SiteConfig = {
  consoleURL: DEFAULT_CONSOLE_URL,
  docsURL: "",
  contactEmail: "",
  contactWechat: "",
  icp: "",
};

/** 没配就显示占位。写死的 PLACEHOLDER 在页面上很扎眼，那正是它的用处。 */
export function orPlaceholder(value: string): string {
  return value || PLACEHOLDER;
}

export const NAV_ITEMS = [
  { href: "/", key: "nav.home" },
  { href: "/models", key: "nav.models" },
  { href: "/contact", key: "nav.contact" },
] as const;
