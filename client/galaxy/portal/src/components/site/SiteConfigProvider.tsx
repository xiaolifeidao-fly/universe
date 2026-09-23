"use client";

/**
 * 把服务端读到的站点配置递给客户端组件。
 *
 * 用 context 而不是让每个组件自己 import 一个模块级常量：常量是**构建期**的，
 * 而这份配置要等到进程启动才知道（见 utils/site.server.ts 开头那段）。
 * 值由根布局当 props 传进来，跟着 RSC 载荷走 —— 服务端渲染用的和浏览器水合
 * 用的是同一份，不会出现两边不一致那类问题。
 */

import { createContext, useContext, type ReactNode } from "react";

import { FALLBACK_SITE_CONFIG, type SiteConfig } from "@/utils/site";

const SiteConfigContext = createContext<SiteConfig>(FALLBACK_SITE_CONFIG);

export function SiteConfigProvider({ value, children }: { value: SiteConfig; children: ReactNode }) {
  return <SiteConfigContext.Provider value={value}>{children}</SiteConfigContext.Provider>;
}

/** 客户端组件取站点配置的唯一入口。 */
export function useSiteConfig(): SiteConfig {
  return useContext(SiteConfigContext);
}
