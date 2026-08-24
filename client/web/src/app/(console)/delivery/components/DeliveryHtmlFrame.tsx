"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

const FRAME_HEIGHT_MESSAGE = "delivery-html-frame-height";

function withHeightReporter(html: string, frameId: string) {
  // sandbox 没有 allow-same-origin，父页面不能直接读取 iframe 文档高度；由预览页主动上报，
  // 外层仍只接受来自当前 iframe 且带同一实例标识的消息。
  const reporter = `<script>
(() => {
  const frameId = ${JSON.stringify(frameId)};
  const report = () => {
    const root = document.documentElement;
    const body = document.body;
    const height = Math.max(
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      root ? root.clientHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      body ? body.clientHeight : 0,
    );
    window.parent.postMessage({ type: ${JSON.stringify(FRAME_HEIGHT_MESSAGE)}, frameId, height }, "*");
  };
  const scheduleReport = () => window.requestAnimationFrame(report);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleReport, { once: true });
  else scheduleReport();
  window.addEventListener("load", scheduleReport);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(scheduleReport);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  new MutationObserver(scheduleReport).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
})();
</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${reporter}</body>`) : `${html}${reporter}`;
}

/**
 * 预览一段 HTML 正文（原型页、HTML 文档）的统一 iframe。
 *
 * 不用 srcDoc：srcDoc 文档的地址是 about:srcdoc，页内 `#锚点` 链接一跳就把沙箱里的文档整个跳空，
 * 报告和原型里的目录导航基本都是这种锚点。改成 blob 地址后文档有真实 URL，锚点、前进后退都正常。
 *
 * sandbox 里给了脚本、弹窗和 print，但始终不给 allow-same-origin：
 * 文档跑在不透明源里，读不到控制台的 Cookie、localStorage，也带不上登录态去打接口。
 */
export function DeliveryHtmlFrame({
  html,
  title,
  className,
  style,
  autoHeight = false,
}: {
  html: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  /** 由预览页上报自身内容高度，适用于外层可滚动的文档面板。 */
  autoHeight?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const frameId = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewHtml = useMemo(
    () => autoHeight ? withHeightReporter(html, frameId) : html,
    [autoHeight, frameId, html],
  );

  useEffect(() => {
    setContentHeight(null);
    const blobUrl = URL.createObjectURL(new Blob([previewHtml], { type: "text/html;charset=utf-8" }));
    setUrl(blobUrl);
    // 正文换了或组件卸载都要撤销，否则每看一份文档就往内存里留一份副本。
    return () => {
      URL.revokeObjectURL(blobUrl);
      setUrl("");
    };
  }, [previewHtml]);

  useEffect(() => {
    if (!autoHeight) return;
    const receiveHeight = (event: MessageEvent<unknown>) => {
      const payload = event.data;
      if (
        event.source !== frameRef.current?.contentWindow
        || !payload
        || typeof payload !== "object"
        || !("type" in payload)
        || !("frameId" in payload)
        || !("height" in payload)
        || payload.type !== FRAME_HEIGHT_MESSAGE
        || payload.frameId !== frameId
        || typeof payload.height !== "number"
        || !Number.isFinite(payload.height)
      ) return;
      setContentHeight(Math.max(1, Math.ceil(payload.height)));
    };
    window.addEventListener("message", receiveHeight);
    return () => window.removeEventListener("message", receiveHeight);
  }, [autoHeight, frameId]);

  if (!url) return null;
  return (
    <iframe
      ref={frameRef}
      title={title}
      className={className}
      style={autoHeight && contentHeight ? { ...style, height: contentHeight } : style}
      sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"
      src={url}
    />
  );
}
