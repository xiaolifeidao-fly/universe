"use client";

import { useEffect } from "react";
import { recordPortalOpen } from "@/app/(site)/api/tracking.api";

// React 开发模式会把 effect 挂载两次来检查副作用。模块内闩锁只拦同一次页面生命期的
// 重挂载；真正刷新页面会重新加载模块，仍然会记一次打开。
let recordedThisLoad = false;

/** 无 UI 的官网打开埋点。失败不影响门户内容，也不弹一条用户无法处理的错误。 */
export function PortalOpenTracker() {
  useEffect(() => {
    if (recordedThisLoad) return;
    recordedThisLoad = true;
    void recordPortalOpen().catch(() => {
      // 埋点是旁路能力，不能让网络抖动变成官网错误提示。
    });
  }, []);

  return null;
}
