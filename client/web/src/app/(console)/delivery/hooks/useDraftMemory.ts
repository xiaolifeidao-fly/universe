"use client";

import { useEffect, useRef } from "react";

/**
 * 聊天草稿的按会话记忆。
 *
 * 需求窗口里切到 review / 测试用例会把整个会话区卸载掉，输入框里没发出去的字会跟着没。
 * 每个聊天区按自己的 storageKey 存一份草稿，切回来原样接上；发送后正文被清空，存的那份也一起清掉。
 */
export function useDraftMemory(storageKey: string, draft: string, setDraft: (value: string) => void) {
  const restoredKey = useRef("");

  useEffect(() => {
    if (!storageKey) {
      // 会话还没加载出来时 key 是空的，不当成一次有效恢复，等真正的 key 到位再接。
      restoredKey.current = "";
      return;
    }
    if (restoredKey.current === storageKey) return;
    restoredKey.current = storageKey;
    try {
      const saved = window.sessionStorage.getItem(storageKey) || "";
      if (saved) setDraft(saved);
    } catch {
      // sessionStorage 不可用时退化成不记忆，输入本身不受影响。
    }
  }, [setDraft, storageKey]);

  useEffect(() => {
    // 恢复动作没跑完就写入，会把上一个 tab 的草稿覆盖到当前 key 上。
    if (!storageKey || restoredKey.current !== storageKey) return;
    try {
      if (draft) window.sessionStorage.setItem(storageKey, draft);
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      // 同上，存不下不影响输入。
    }
  }, [draft, storageKey]);
}
