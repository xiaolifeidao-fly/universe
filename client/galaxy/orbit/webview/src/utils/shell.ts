"use client";

import { ShellApi } from "@galaxy/common/eleapi/shell.api";
import { isDesktop } from "@/utils/product";

const shellApi = new ShellApi();

/**
 * 让系统浏览器打开一个外部地址（目前只有 cc-switch 的下载页）。
 *
 * 桌面壳拦掉了 window.open（主进程 setWindowOpenHandler 一律 deny），桌面里只能走 ShellApi；
 * 纯浏览器里直接开新标签页。
 *
 * 返回 false 是没打开：界面部署在远端，装着旧版 Orbit 的人打开的也是新页面 ——
 * 那一版壳里没有 ShellApi，window.open 又被拦，点了什么都不会发生。调用方得给条退路。
 */
export async function openExternal(url: string): Promise<boolean> {
  if (shellApi.isAvailable()) {
    await shellApi.openExternal(url);
    return true;
  }
  if (isDesktop()) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
