"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

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
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[], storageKey = "") {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const restoredKey = useRef("");

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    saveScrollPosition(storageKey, { top: el.scrollTop, stick: stick.current });
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
      el.scrollTop = stick.current
        ? el.scrollHeight
        : Math.min(saved?.top ?? 0, Math.max(0, el.scrollHeight - el.clientHeight));
      return;
    }
    if (!stick.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, ...deps]);

  return { ref, onScroll };
}
