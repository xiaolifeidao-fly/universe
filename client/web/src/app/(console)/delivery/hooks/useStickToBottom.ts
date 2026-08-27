"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

// 距底多少像素以内仍算「贴着底」。留一点余量，免得字体行高差一两像素就判成用户上翻了。
const BOTTOM_THRESHOLD = 80;

interface StoredScrollPosition {
  top: number;
  stick: boolean;
}

function readScrollPosition(key: string): StoredScrollPosition | null {
  if (!key) return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) || "null") as Partial<StoredScrollPosition> | null;
    if (!value || !Number.isFinite(value.top) || typeof value.stick !== "boolean") return null;
    return { top: Math.max(0, Number(value.top)), stick: value.stick };
  } catch {
    return null;
  }
}

function saveScrollPosition(key: string, position: StoredScrollPosition) {
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(position));
  } catch {
    // sessionStorage 不可用时只退化为当前打开期间的自动吸底，不影响聊天本身。
  }
}

/**
 * 聊天区滚动跟随：只在用户本来就停在底部时才自动滚到最新一条。
 * 用户手动往上翻查历史后，新消息不再把视口拽回底部；再滚回底部就重新恢复跟随。
 *
 * 任务执行中会高频追加内容，自动吸底一律用瞬时定位而不是平滑动画：
 * 平滑动画会持续数百毫秒，被流式内容反复重启后就会和用户的滚轮抢滚动条。
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[], storageKey = "") {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const restoredKey = useRef("");
  // 程序触发的滚动同样会派发 scroll 事件，打个标记避免把用户的跟随状态覆盖掉。
  const programmatic = useRef(false);

  const scrollToBottom = useCallback((el: T) => {
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (!programmatic.current) {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    }
    saveScrollPosition(storageKey, { top: el.scrollTop, stick: stick.current });
  }, [storageKey]);

  // 用户一往上拨就立刻解除跟随，不用等滚出 BOTTOM_THRESHOLD，
  // 否则流式内容会在这段距离内把视口一次次拽回底部。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let touchY = 0;
    const release = () => {
      stick.current = false;
      saveScrollPosition(storageKey, { top: el.scrollTop, stick: false });
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? 0;
      if (y > touchY) release();
      touchY = y;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [storageKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!storageKey) {
      restoredKey.current = "";
      return;
    }
    if (restoredKey.current !== storageKey) {
      restoredKey.current = storageKey;
      const saved = readScrollPosition(storageKey);
      stick.current = saved?.stick ?? true;
      programmatic.current = true;
      el.scrollTop = stick.current
        ? el.scrollHeight
        : Math.min(saved?.top ?? 0, Math.max(0, el.scrollHeight - el.clientHeight));
      requestAnimationFrame(() => {
        programmatic.current = false;
      });
      return;
    }
    if (!stick.current) return;
    scrollToBottom(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, ...deps]);

  return { ref, onScroll };
}
