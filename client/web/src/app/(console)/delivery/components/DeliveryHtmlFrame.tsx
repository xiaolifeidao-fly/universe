"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

const FRAME_HEIGHT_MESSAGE = "delivery-html-frame-height";
const FRAME_NAVIGATE_MESSAGE = "delivery-html-frame-navigate";

/**
 * 把预览页里的相对链接换算成工作区路径，用来在同一套文档里找到被点开的那一页。
 *
 * 多页原型的顶部导航写的都是 `collection-flow.html` 这种同目录相对地址，blob 地址没有目录，
 * iframe 里点一下就跳成空白页；换算出真实路径后交给外层切换选中的文件，导航才跟本地打开一样。
 */
export function resolveFrameHref(currentPath: string, href: string) {
  const target = href.split("#")[0].split("?")[0].trim();
  if (!target) return "";
  const segments = currentPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

/** HTML 文档引用的同目录样式或脚本，name 就是 HTML 里原样写的相对路径。 */
export interface DeliveryHtmlAsset {
  name: string;
  content: string;
}

/** 内联正文里不能出现结束标签，否则解析器会在这里提前收尾。 */
function guardInlineText(text: string, tag: "style" | "script") {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

function attributeValue(tag: string, attribute: "href" | "src") {
  const matched = new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!matched) return "";
  return (matched[2] ?? matched[3] ?? matched[4] ?? "").trim();
}

/**
 * 把 <link href> / <script src> 引用的同目录样式脚本换成内联正文。
 *
 * 预览是 blob 地址，页面没有所在目录，相对路径在 iframe 里一律解析失败；服务端已经按引用把这些文件读了出来，
 * 这里按原样的引用串对上号直接内联，样式和脚本才跟着文档一起生效。
 */
export function inlineHtmlAssets(html: string, assets: DeliveryHtmlAsset[] = []) {
  if (!assets.length) return html;
  const byReference = new Map(assets.map((asset) => [asset.name, asset.content]));
  return html
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const content = byReference.get(attributeValue(tag, "href"));
      return content === undefined ? tag : `<style>${guardInlineText(content, "style")}</style>`;
    })
    .replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (tag, rawAttributes: string) => {
      const content = byReference.get(attributeValue(`<script${rawAttributes}>`, "src"));
      if (content === undefined) return tag;
      // src 之外的属性保留下来，type、defer 这些还会影响脚本怎么跑。
      const attributes = rawAttributes.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/i, "").trim();
      return `<script${attributes ? ` ${attributes}` : ""}>${guardInlineText(content, "script")}</script>`;
    });
}

function withFrameBridge(html: string, frameId: string, reportHeight: boolean) {
  // sandbox 没有 allow-same-origin，父页面不能直接读取 iframe 文档高度，页内也无法自己跳到同目录的另一页；
  // 两件事都由预览页主动上报，外层仍只接受来自当前 iframe 且带同一实例标识的消息。
  const reporter = `<script>
(() => {
  const frameId = ${JSON.stringify(frameId)};
  const reportHeight = ${JSON.stringify(reportHeight)};
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
  if (reportHeight) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleReport, { once: true });
    else scheduleReport();
    window.addEventListener("load", scheduleReport);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(scheduleReport);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    new MutationObserver(scheduleReport).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
  // 指向同一套文档里另一个页面的相对链接自己跳会跳成空白，交给外层换页；
  // 页内锚点、外链和下载链接都保持浏览器原本的行为。
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || href.slice(0, 2) === "//" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return;
    if (!/\.html?($|[?#])/i.test(href)) return;
    event.preventDefault();
    window.parent.postMessage({ type: ${JSON.stringify(FRAME_NAVIGATE_MESSAGE)}, frameId, href }, "*");
  }, true);
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
  assets,
  onNavigate,
  title,
  className,
  style,
  autoHeight = false,
}: {
  html: string;
  /** 文档引用的同目录样式、脚本，预览前内联进正文。 */
  assets?: DeliveryHtmlAsset[];
  /** 页内点了指向另一个页面的相对链接时回调，由外层切换当前预览的文件。 */
  onNavigate?: (href: string) => void;
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
    () => withFrameBridge(inlineHtmlAssets(html, assets), frameId, autoHeight),
    [assets, autoHeight, frameId, html],
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
    const receive = (event: MessageEvent<unknown>) => {
      const payload = event.data;
      if (
        event.source !== frameRef.current?.contentWindow
        || !payload
        || typeof payload !== "object"
        || !("type" in payload)
        || !("frameId" in payload)
        || payload.frameId !== frameId
      ) return;
      if (payload.type === FRAME_HEIGHT_MESSAGE) {
        if (!autoHeight || !("height" in payload) || typeof payload.height !== "number" || !Number.isFinite(payload.height)) return;
        setContentHeight(Math.max(1, Math.ceil(payload.height)));
        return;
      }
      if (payload.type !== FRAME_NAVIGATE_MESSAGE) return;
      if (!("href" in payload) || typeof payload.href !== "string") return;
      onNavigate?.(payload.href);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [autoHeight, frameId, onNavigate]);

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
