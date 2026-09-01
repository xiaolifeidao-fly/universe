"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Command, FolderKanban, LayoutDashboard, Settings, Wifi, WifiOff } from "lucide-react";
import { saveLastRoute } from "@/lib/navigation";
import { useNetworkStatus } from "@/components/network-provider";
import { SpaceSwitcher } from "@/components/space-switcher";

const navigation = [
  { href: "/", label: "概览", icon: LayoutDashboard, match: (path: string) => path === "/" },
  { href: "/projects", label: "项目", icon: FolderKanban, match: (path: string) => path.startsWith("/projects") },
  { href: "/commands", label: "活动", icon: Activity, match: (path: string) => path.startsWith("/commands") },
  { href: "/settings", label: "设置", icon: Settings, match: (path: string) => path.startsWith("/settings") },
];

export function MobileShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const online = useNetworkStatus();

  useEffect(() => {
    saveLastRoute(pathname);
  }, [pathname]);

  return (
    <div className="mobile-shell">
      <header className="shell-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Command size={19} strokeWidth={2.3} />
          </span>
          <div>
            <span className="brand-title">交付台</span>
            <SpaceSwitcher />
          </div>
        </div>
        <span className={`connection-state${online ? "" : " is-offline"}`} title={online ? "连接正常" : "当前离线"}>
          {online ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
          {online ? "已连接" : "离线"}
        </span>
      </header>

      {children}

      <nav className="bottom-nav" aria-label="主导航">
        <div className="bottom-nav__inner">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            return (
              <Link className={`nav-link${active ? " is-active" : ""}`} href={item.href} key={item.href} aria-current={active ? "page" : undefined}>
                <Icon size={19} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
