import { products } from "@galaxy/common";

export const product = "nova";
export const productConfig = products.nova;

/**
 * 跑在桌面壳里还是浏览器里。
 *
 * 两处需要区分：macOS 的桌面窗口用 hiddenInset 标题栏，左栏顶上要给红黄绿三颗
 * 按钮让位；本机能力（bridge）也只有桌面壳里才有。浏览器里调试时两样都没有。
 */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.galaxyDesktop);
}

/** macOS 桌面窗口才有那条 34px 的可拖拽让位区。 */
export function hasOverlayTitlebar(): boolean {
  return isDesktop() && typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
}
