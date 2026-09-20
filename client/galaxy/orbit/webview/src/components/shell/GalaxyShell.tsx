"use client";

/**
 * Orbit 控制台的外壳：220 宽左栏 + 命令条。
 *
 * 命令条**不由外壳渲染**。每一页的右上角都不一样（今天那页是共享总开关，
 * 密钥那页是新建按钮），由外壳统一渲染就得开一条 context 把节点传上来，
 * 页面写起来反而绕。所以外壳只给左栏和 <main>，标题条是页面自己 render 的
 * <PageHeader>，位置由 .gx-head 固定住。
 */

import { usePathname, useRouter } from "next/navigation";
import { type PropsWithChildren, type ReactNode, useEffect, useRef, useState } from "react";
import { useLocale, type TranslationKey } from "@/i18n/LocaleProvider";
import { UpdateGate } from "@/components/shell/UpdateGate";
import { clearAuthToken, getAuthUser } from "@/utils/auth";
import { hasOverlayTitlebar, productConfig } from "@/utils/product";
import { IconChevronDown, IconLogout, IconUser } from "@/components/ui/icons";
import { IconBag, IconChat, IconCoins, IconKey, IconList, IconSparkle } from "@/components/ui/icons";

interface NavEntry {
  href: string;
  labelKey: TranslationKey;
  icon: ReactNode;
}

// 钱的流向排在一起：看模型 → 用积分买 → 积分从哪来（含分享返现）。
const NAV: NavEntry[] = [
  { href: "/consumer/keys", labelKey: "nav.keys", icon: <IconKey size={18} /> },
  { href: "/consumer/models", labelKey: "nav.models", icon: <IconSparkle size={18} /> },
  { href: "/consumer/store", labelKey: "nav.store", icon: <IconBag size={18} /> },
  { href: "/consumer/points", labelKey: "nav.points", icon: <IconCoins size={18} /> },
  { href: "/consumer/usage", labelKey: "nav.usage", icon: <IconList size={18} /> },
  { href: "/consumer/chat", labelKey: "nav.chat", icon: <IconChat size={18} /> },
  { href: "/consumer/account", labelKey: "nav.account", icon: <IconUser size={18} /> },
];

/** 外壳只关心「这一页高亮哪一条」。标题与副标题由页面自己写。 */
function activeHref(pathname: string | null): string {
  const path = pathname ?? productConfig.home;
  return NAV.find((entry) => path.startsWith(entry.href))?.href ?? path;
}

export function GalaxyShell({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const { locale, setLocale, t } = useLocale();
  const [user, setUser] = useState<{ displayName: string; username: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 登录态在 localStorage 里，服务端读不到。首屏先渲染成空，挂载后再补 ——
  // 直接在渲染期读会让 SSR 的 HTML 和水合结果对不上。
  useEffect(() => {
    const current = getAuthUser();
    setUser(current ? { displayName: current.displayName || current.username, username: current.username } : null);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const active = activeHref(pathname);
  // 桌面壳里 macOS 用的是 hiddenInset 标题栏，左栏顶上要给三颗按钮让位；
  // 浏览器里调试时没有那三颗按钮，让位就是一条无谓的空白。
  //
  // 首屏一律按 native 渲染，挂载后再改：这个判断依赖 window，服务端渲染时
  // 取不到，直接在渲染期读会让首屏 HTML 与水合结果差一条 24px 的空白。
  const [titlebar, setTitlebar] = useState<"overlay" | "native">("native");
  useEffect(() => {
    if (hasOverlayTitlebar()) setTitlebar("overlay");
  }, []);

  return (
    <div className="gx-shell" data-titlebar={titlebar}>
      <aside className="gx-side">
        <div className="gx-side__drag" />
        <div className="gx-brand">
          <strong>{productConfig.name}</strong>
          <span>{t("brand.subtitle")}</span>
        </div>
        <nav className="gx-side__nav">
          {NAV.map((entry) => (
            <button
              key={entry.href}
              type="button"
              className={`gx-nav${entry.href === active ? " is-active" : ""}`}
              onClick={() => router.push(entry.href)}
            >
              {entry.icon}
              <span>{t(entry.labelKey)}</span>
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div className="gx-side__foot" ref={menuRef} style={{ position: "relative" }}>
          {menuOpen ? (
            <div
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                right: 0,
                padding: 6,
                borderRadius: 12,
                border: "1px solid var(--gx-line)",
                background: "var(--gx-surface)",
                boxShadow: "0 18px 44px rgba(20,20,19,0.12)",
                zIndex: 20,
              }}
            >
              <button
                type="button"
                className="gx-nav"
                style={{ width: "100%" }}
                onClick={() => {
                  setMenuOpen(false);
                  router.push("/consumer/account");
                }}
              >
                <IconUser size={16} />
                <span>{t("nav.account")}</span>
              </button>
              <button
                type="button"
                className="gx-nav"
                style={{ width: "100%" }}
                onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
              >
                <span style={{ width: 16, textAlign: "center", fontSize: 12 }}>文</span>
                <span>{t(locale === "zh-CN" ? "locale.en-US" : "locale.zh-CN")}</span>
              </button>
              <button
                type="button"
                className="gx-nav"
                style={{ width: "100%" }}
                onClick={() => {
                  clearAuthToken();
                  router.replace("/login");
                }}
              >
                <IconLogout size={16} />
                <span>{t("shell.logout")}</span>
              </button>
            </div>
          ) : null}
          <button type="button" className="gx-user" onClick={() => setMenuOpen((open) => !open)}>
            <span className="gx-avatar">{(user?.displayName ?? "·").slice(0, 1)}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="gx-user__name" style={{ display: "block" }}>
                {user?.displayName ?? "—"}
              </span>
              <span className="gx-user__meta" style={{ display: "block" }}>
                {user?.username ?? ""}
              </span>
            </span>
            <IconChevronDown size={14} style={{ color: "var(--gx-faint)", flex: "0 0 auto" }} />
          </button>
        </div>
      </aside>
      <main className="gx-main">{children}</main>
      {/* 桌面壳的版本更新。浏览器里、或者壳旧到没有 UpdateApi 时它自己不画。 */}
      <UpdateGate />
    </div>
  );
}

/** 命令条。左边是这一页在回答什么，右边是这一页能做的事。 */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="gx-head">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
        <h1>{title}</h1>
        {meta ? <span className="gx-head__meta">{meta}</span> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{actions}</div>
    </header>
  );
}
