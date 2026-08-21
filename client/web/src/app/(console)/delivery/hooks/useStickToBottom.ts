"use client";

import { useCallback, useEffect, useRef } from "react";

// 距底多少像素以内仍算「贴着底」。留一点余量，免得字体行高差一两像素就判成用户上翻了。
const BOTTOM_THRESHOLD = 80;

/**
 * 聊天区滚动跟随：只在用户本来就停在底部时才自动滚到最新一条。
 * 用户手动往上翻查历史后，新消息不再把视口拽回底部；再滚回底部就重新恢复跟随。
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  const stick = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, onScroll };
}
