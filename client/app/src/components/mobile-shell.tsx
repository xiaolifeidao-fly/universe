"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, BriefcaseBusiness, Command, Folder, Inbox, Settings } from "lucide-react";
import { saveLastRoute } from "@/lib/navigation";
import { getSession, hasPersona } from "@/lib/auth";
import { useSpace } from "@/components/space-provider";
import { useMessages } from "@/components/messages-provider";
import { SpaceSwitcher } from "@/components/space-switcher";
import { WorkerHeaderState } from "@/components/workbench/worker-status";

/** 对话和任务进度要占满整屏：这些路由自己带返回，不再叠加外壳的头部和底部导航。 */
function immersive(pathname: string) {
  return pathname.startsWith("/workbench/") || pathname.startsWith("/business/workbench/");
}

export function MobileShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { bizLine } = useSpace();
  const { unread } = useMessages();
  const session = getSession();
  const productResearch = hasPersona("product_research", session);
  const business = hasPersona("business", session);
  const navigation = [
    ...(productResearch ? [
      { href: "/", label: "工作台", icon: Inbox, match: (path: string) => path === "/" || path.startsWith("/commands") },
      { href: "/projects", label: "项目", icon: Folder, match: (path: string) => path.startsWith("/projects") },
    ] : []),
    ...(productResearch || business ? [
      { href: "/business", label: "业务", icon: BriefcaseBusiness, match: (path: string) => path.startsWith("/business") },
    ] : []),
    ...(productResearch ? [
      { href: "/messages", label: "消息", icon: Bell, match: (path: string) => path.startsWith("/messages"), badge: unread },
    ] : []),
    { href: "/settings", label: "设置", icon: Settings, match: (path: string) => path.startsWith("/settings") },
  ];
  // 顶栏的分隔线只在页面滚起来之后出现，和 iOS 导航栏一样：置顶时是一整片留白。
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    saveLastRoute(pathname);
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (immersive(pathname)) {
    return <div className="mobile-shell is-immersive">{children}</div>;
  }

  return (
    <div className="mobile-shell">
      <header className={`shell-header glass-surface${stuck ? " is-stuck" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Command size={20} strokeWidth={2.2} />
          </span>
          <div>
            <span className="brand-title">交付台</span>
            <SpaceSwitcher />
          </div>
        </div>
        {/* 顶栏只留一件和「现在能不能干活」有关的事：执行电脑的心跳。 */}
        <WorkerHeaderState key={bizLine} enabled={productResearch} />
      </header>

      {children}

      <nav className="bottom-nav" aria-label="主导航">
        <div className="bottom-nav__inner" style={{ gridTemplateColumns: `repeat(${navigation.length}, minmax(0, 1fr))` }}>
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            return (
              <Link className={`nav-link${active ? " is-active" : ""}`} href={item.href} key={item.href} aria-current={active ? "page" : undefined}>
                <span className="nav-link__icon">
                  <Icon size={23} aria-hidden="true" />
                  {item.badge ? (
                    <span className="nav-link__badge" aria-label={`${item.badge} 条未读`}>
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  ) : null}
                </span>
                <span className="nav-link__label">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
