"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getSession } from "@/lib/auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getSession()) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setReady(true);
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
