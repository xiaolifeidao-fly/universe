"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError } from "@/api/client";
import { listSpaces, type SpaceSummary } from "@/api/spaces.api";
import { clearSession, defaultWorkspaceRoute, getSession, setSessionSpace } from "@/lib/auth";

interface SpaceContextValue {
  spaces: SpaceSummary[];
  bizLine: string;
  spaceName: string;
  canWrite: boolean;
  switchTo: (code: string) => void;
  reload: () => void;
}

const SpaceContext = createContext<SpaceContextValue>({
  spaces: [], bizLine: "", spaceName: "", canWrite: false, switchTo: () => {}, reload: () => {},
});

/**
 * 空间是所有交付数据的横切范围：请求头 X-Biz-Line 决定服务端让你看到什么。
 *
 * 这里在渲染工作台之前先把「当前空间」解析成一个用户确实进得去的空间。
 * 会话里存着的那个编码可能已经失效（被移出空间、空间停用、或旧版本里手输的
 * 编码本来就不对），继续拿它发请求只会让每个页面各自弹一次「无权访问该空间」。
 */
export function SpaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [bizLine, setBizLine] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const available = await listSpaces();
      setSpaces(available);
      if (!available.length) {
        setStatus("empty");
        return;
      }
      const remembered = getSession()?.bizLine ?? "";
      const resolved = available.some((space) => space.code === remembered)
        ? available.find((space) => space.code === remembered)!
        : available[0];
      setSessionSpace(resolved.code, resolved.name);
      setBizLine(resolved.code);
      setStatus("ready");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法读取可用空间。");
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const switchTo = useCallback((code: string) => {
    const target = spaces.find((space) => space.code === code);
    if (!target || target.code === bizLine) return;
    setSessionSpace(target.code, target.name);
    setBizLine(target.code);
    // 项目、需求、任务的标识都只在自己的空间里有意义，换空间后必须回到概览，
    // 否则详情页会拿着上一个空间的项目号继续请求。
    if (pathname.startsWith("/business")) router.replace("/business");
    else if (pathname !== "/") router.replace(defaultWorkspaceRoute());
  }, [bizLine, pathname, router, spaces]);

  const value = useMemo<SpaceContextValue>(() => {
    const current = spaces.find((space) => space.code === bizLine);
    return {
      spaces, bizLine,
      spaceName: current?.name || bizLine,
      canWrite: Boolean(current?.canWrite),
      switchTo,
      reload: () => { void load(); },
    };
  }, [bizLine, load, spaces, switchTo]);

  if (status === "loading") {
    return (
      <main className="app-loading" aria-label="正在读取可用空间">
        <div className="loading-stack">
          <div className="loading-dot" aria-hidden="true" />
          <span className="muted">正在读取可用空间</span>
        </div>
      </main>
    );
  }

  if (status !== "ready") {
    const signOut = () => { clearSession(); router.replace("/login"); };
    return (
      <main className="app-loading" aria-label="空间不可用">
        <div className="loading-stack">
          <strong>{status === "empty" ? "你还没有加入任何空间" : "暂时无法读取空间"}</strong>
          <span className="muted">
            {status === "empty" ? "请让空间管理员通过分享链接把你加入后再回到这里。" : error}
          </span>
          <div className="stack-actions">
            <button className="button button-primary" type="button" onClick={() => void load()}>重试</button>
            <button className="button button-secondary" type="button" onClick={signOut}>退出登录</button>
          </div>
        </div>
      </main>
    );
  }

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useSpace() {
  return useContext(SpaceContext);
}
