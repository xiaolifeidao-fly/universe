import { useEffect, useRef } from "react";

/**
 * 会话面板的轮询：上一轮跑完再等间隔，而不是固定频率打点。
 *
 * 桥接侧读会话正文本来就慢（要拉起执行器再读整段历史），固定 `setInterval`
 * 会让请求一轮压一轮：浏览器同域连接被占满、桥接侧线程互相抢锁，单次耗时被
 * 越推越长，最后撞穿 axios 的 20s 超时被 abort，DevTools 里就是一串
 * `(canceled)`。这里改成串行轮询，并且页面切到后台时不发请求。
 */
export function usePollingLoop(
  enabled: boolean,
  delayMs: number,
  task: () => Promise<unknown>,
  immediate = false,
) {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = 0;

    // 互相引用，用函数声明避免 TDZ。
    function schedule() {
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), delayMs);
    }

    async function tick() {
      if (cancelled) return;
      // 页面不可见时跳过这一轮：用户看不到，没必要占着桥接的读线程。
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      try {
        await taskRef.current();
      } catch {
        // 失败提示由调用方自己处理，这里只保证轮询不会因为一次异常断掉。
      }
      schedule();
    }

    if (immediate) void tick();
    else schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delayMs, enabled, immediate]);
}
