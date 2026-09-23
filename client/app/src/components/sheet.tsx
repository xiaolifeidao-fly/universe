"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * 从底部升起的面板。移动端把 Git、文档这类「看一眼就回去」的内容放在这里，
 * 不占用一条新路由，返回手势也不会退出当前工作台。
 */
export function Sheet({
  open,
  title,
  subtitle,
  onClose,
  actions,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  actions?: ReactNode;
  /** 钉在面板底部、不跟着正文滚动的一块：表单和确认按钮放这里，长列表滚不走它。 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  // 面板必须挂到 body 上再渲染：顶栏带 backdrop-filter，会成为 fixed 的包含块，
  // 挂在它内部的面板会被钉在顶栏而不是视口。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button className="sheet-scrim" type="button" onClick={onClose} aria-label="关闭面板" />
      <section className="sheet">
        <span className="sheet__grip" aria-hidden="true" />
        <header className="sheet__header">
          <div className="sheet__title">
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
          <div className="sheet__actions">
            {actions}
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭" title="关闭"><X size={21} /></button>
          </div>
        </header>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__footer">{footer}</div> : null}
      </section>
    </div>,
    document.body,
  );
}
