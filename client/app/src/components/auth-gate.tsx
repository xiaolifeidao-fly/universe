"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getCurrentUser } from "@/api/auth.api";
import { canAccessWorkspaceRoute, defaultWorkspaceRoute, getSession, setSessionUser } from "@/lib/auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    let active = true;
    void getCurrentUser()
      .then((user) => {
        if (!active) return;
        const next = setSessionUser(user) ?? session;
        if (!canAccessWorkspaceRoute(pathname, next)) {
          router.replace(defaultWorkspaceRoute(next));
          return;
        }
        setReady(true);
      })
      .catch(() => {
        // 会话内已有兼容身份时仍可离线恢复；接口层会处理真正失效的令牌。
        if (!active) return;
        if (!canAccessWorkspaceRoute(pathname, session)) {
          router.replace(defaultWorkspaceRoute(session));
          return;
        }
        setReady(true);
      });
    return () => { active = false; };
  }, [pathname, router]);

  if (!ready) {
    return (
      <main className="app-loading" aria-label="正在恢复会话">
        <div className="loading-stack">
          <div className="loading-dot" aria-hidden="true" />
          <span className="muted">正在恢复工作台</span>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
