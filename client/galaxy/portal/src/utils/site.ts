/**
 * 站点级常量。全部来自 NEXT_PUBLIC_* —— 换域名、换联系方式是运维动作，
 * 不该是一次前端发版。
 *
 * ⚠️ 每一个都必须写成 `process.env.NEXT_PUBLIC_XXX` 这样的**字面量**。
 * Next 是在打包时做字符串替换把这些值塞进浏览器包的，写成 process.env[name]
 * 这种动态取法它认不出来：服务端仍然读得到真值（那边 process.env 是活的），
 * 浏览器里却是 undefined —— 于是同一个链接服务端渲染成线上地址、客户端渲染成
 * 兜底值，水合直接失败，整棵树退回客户端渲染。这个坑踩过一次，别再改回去。
 *
 * 没配的联系方式**不编一个**：页面上显示成 [待填写]，运营一眼就知道该补哪。
 * 编一个假邮箱的代价是有人真的往那儿发信，然后再也没有下文。
 */

export const PLACEHOLDER = "[待填写]";

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

export const siteConfig = {
  /** 「控制台」指向控制台（Orbit）。同域部署时 /consumer/keys 正好对。 */
  consoleURL: clean(process.env.NEXT_PUBLIC_CONSOLE_URL) || "/consumer/keys",
  docsURL: clean(process.env.NEXT_PUBLIC_DOCS_URL),
  contactEmail: clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL),
  contactWechat: clean(process.env.NEXT_PUBLIC_CONTACT_WECHAT),
  icp: clean(process.env.NEXT_PUBLIC_ICP),
};

/** 没配就显示占位。写死的 PLACEHOLDER 在页面上很扎眼，那正是它的用处。 */
export function orPlaceholder(value: string): string {
  return value || PLACEHOLDER;
}

export const NAV_ITEMS = [
  { href: "/", key: "nav.home" },
  { href: "/models", key: "nav.models" },
  { href: "/pricing", key: "nav.pricing" },
  { href: "/contact", key: "nav.contact" },
] as const;
