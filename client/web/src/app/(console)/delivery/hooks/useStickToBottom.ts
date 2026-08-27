"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// 距底多少像素以内仍算「贴着底」。留一点余量，免得字体行高差一两像素就判成用户上翻了。
const BOTTOM_THRESHOLD = 80;
// 恢复位置后继续补位的时间窗：Markdown、代码块、图片是逐步撑开高度的，
// 挂载那一帧的 scrollHeight 往往还不够，一次性定位必然落空。
const SETTLE_DURATION = 1500;

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
 *
 * 切到别的 tab 会把整个会话区卸载掉，回来时按 storageKey 重新落位；
 * 落位要跨越内容渲染的过程，所以在一个短时间窗内持续补，而不是只定位一次。
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[], storageKey = "") {
  // 用回调 ref 而不是对象 ref：切 tab 会把整个会话区卸载掉再挂回来，
  // 对象 ref 换了节点不会触发任何 effect，恢复逻辑和滚轮监听都会留在已经被丢弃的旧节点上。
  const [element, setElement] = useState<T | null>(null);
  const elementRef = useRef<T | null>(null);
  const ref = useCallback((node: T | null) => {
    elementRef.current = node;
    setElement(node);
  }, []);
  const stick = useRef(true);
  const restoredKey = useRef("");
  // 已经落过位的那个 DOM 节点；换了节点说明是重新挂载，scrollTop 已归零，必须重新落位。
  const restoredElement = useRef<T | null>(null);
  // 程序触发的滚动同样会派发 scroll 事件，打个标记避免把用户的跟随状态覆盖掉。
  const programmatic = useRef(false);
  // 想恢复到的历史位置；内容还没长到这个高度时先挂着，等撑开了再落位。
  const pendingTop = useRef<number | null>(null);
  const settleUntil = useRef(0);
  const settleFrame = useRef(0);

  const scrollTo = useCallback((el: T, top: number) => {
    if (Math.abs(el.scrollTop - top) <= 1) return;
    programmatic.current = true;
    el.scrollTop = top;
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const scrollToBottom = useCallback((el: T) => {
    scrollTo(el, el.scrollHeight);
  }, [scrollTo]);

  const stopSettle = useCallback(() => {
    settleUntil.current = 0;
    pendingTop.current = null;
    if (settleFrame.current) {
      cancelAnimationFrame(settleFrame.current);
      settleFrame.current = 0;
    }
  }, []);

  // 在时间窗内反复把视口拉回目标位置：内容每撑开一点就补一次，
  // 直到落位成功、时间窗结束，或者用户自己动了滚动条。
  const settle = useCallback(() => {
    settleUntil.current = performance.now() + SETTLE_DURATION;
    if (settleFrame.current) return;
    const step = () => {
      settleFrame.current = 0;
      const el = elementRef.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (stick.current) {
        scrollTo(el, max);
      } else if (pendingTop.current !== null) {
        scrollTo(el, Math.min(pendingTop.current, max));
        if (pendingTop.current <= max) pendingTop.current = null;
      }
      const unfinished = stick.current || pendingTop.current !== null;
      if (unfinished && performance.now() < settleUntil.current) settleFrame.current = requestAnimationFrame(step);
    };
    settleFrame.current = requestAnimationFrame(step);
  }, [scrollTo]);

  useEffect(() => stopSettle, [stopSettle]);

  const onScroll = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;
    if (!programmatic.current) {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    }
    saveScrollPosition(storageKey, { top: el.scrollTop, stick: stick.current });
  }, [storageKey]);

  // 用户一往上拨就立刻解除跟随，不用等滚出 BOTTOM_THRESHOLD，
  // 否则流式内容会在这段距离内把视口一次次拽回底部。
  useEffect(() => {
    const el = element;
    if (!el) return;
    let touchY = 0;
    const release = () => {
      // 用户接管后不再补位，恢复逻辑立刻让路。
      stopSettle();
      stick.current = false;
      saveScrollPosition(storageKey, { top: el.scrollTop, stick: false });
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };
    const onPointerDown = () => {
      // 拖滚动条、按住内容拖选都算用户接管，先停掉补位再看最终落点。
      settleUntil.current = 0;
      pendingTop.current = null;
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
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [element, stopSettle, storageKey]);

  useLayoutEffect(() => {
    const el = element;
    if (!el) return;
    // 节点变了就是刚重新挂上来的：这时 deps 通常一个都没变，
    // 只盯 deps 的话会一路走到「维持现状」分支，视口就停在 0。
    const remounted = restoredElement.current !== el;
    if (remounted) restoredElement.current = el;
    if (!storageKey) {
      // 会话还没加载出来时 key 是空的，别把它当成一次有效恢复，否则真正的 key 到位后就不补了。
      restoredKey.current = "";
      // 没有 key 可查时至少按当前的跟随状态把底部补回来。
      if (remounted) settle();
      return;
    }
    if (remounted || restoredKey.current !== storageKey) {
      restoredKey.current = storageKey;
      const saved = readScrollPosition(storageKey);
      stick.current = saved?.stick ?? true;
      pendingTop.current = stick.current ? null : saved?.top ?? 0;
      settle();
      return;
    }
    if (!stick.current) return;
    scrollToBottom(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, storageKey, ...deps]);

  return { ref, onScroll };
}
