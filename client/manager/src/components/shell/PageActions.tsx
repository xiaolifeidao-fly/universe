"use client";

import { createContext, type PropsWithChildren, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * 页头右侧的动作槽。
 *
 * 页面标题由外壳统一画（见 ManagerShellStub），页面自己的「刷新 / 新建」这类整页级
 * 动作用 <PageActions> 包一下，就会被送到标题那一行的右边 —— 而不是在内容区顶上
 * 单独占一行、孤零零地挂一个按钮。
 *
 * 只放**整页**的动作。只作用于某张表的筛选、某张卡的按钮，留在原地。
 */
const PageActionsSlot = createContext<HTMLElement | null>(null);

export const PageActionsProvider = PageActionsSlot.Provider;

export function PageActions({ children }: PropsWithChildren) {
  const slot = useContext(PageActionsSlot);
  // 不在外壳里（或槽还没挂上）时原地渲染，保证按钮不会凭空消失。
  if (!slot) return <div className="manager-page-actions-inline">{children}</div>;
  return createPortal(children, slot);
}
