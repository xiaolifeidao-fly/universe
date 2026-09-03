"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Monitor, Smartphone, X } from "lucide-react";

const HEIGHT_MESSAGE = "app-html-preview-height";
const NAVIGATE_MESSAGE = "app-html-preview-navigate";

/** 桌面稿按这个宽度渲染再整体缩到屏幕宽，比让用户左右拖着看强。 */
const DESKTOP_WIDTH = 1280;
/** 上报高度前先按这个高度起画，页面里写 100vh 的外壳才有个确定的初值。 */
const INITIAL_HEIGHT = 620;
/** 一份原型再长也不该把父页面撑到失控，超过这个高度改由 iframe 自己滚。 */
const MAX_INLINE_HEIGHT = 4200;

/** HTML 里引用的同目录样式或脚本，name 就是 HTML 里原样写的相对路径。 */
export interface HtmlAsset {
  name: string;
  content: string;
}

/**
 * 把相对链接换算成同一套文档里的路径，用来在多页原型之间翻页。
 *
 * 预览走的是 blob 地址，这种地址没有「所在目录」，页里 `flow.html` 这类同目录链接
 * 自己跳会跳成空白；换算出真实路径后交给外层换一份正文，导航才跟本地打开一样。
 */
export function resolveRelativePath(currentPath: string, href: string) {
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

/** 内联正文里不能出现结束标签，否则解析器会在这里提前收尾。 */
function guardInlineText(text: string, tag: "style" | "script") {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

function attributeValue(tag: string, attribute: "href" | "src") {
  const matched = new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!matched) return "";
  return (matched[2] ?? matched[3] ?? matched[4] ?? "").trim();
}

/** 找出这份 HTML 引用到的同目录样式和脚本，交给外层按路径把内容读出来。 */
export function referencedAssetPaths(html: string) {
  const names = new Set<string>();
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const href = attributeValue(tag, "href");
    if (href && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !href.startsWith("//")) names.add(href);
  }
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = attributeValue(tag, "src");
    if (src && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) && !src.startsWith("//")) names.add(src);
  }
  return Array.from(names);
}

/**
 * 把 `<link href>` / `<script src>` 引用的同目录样式脚本换成内联正文。
 *
 * 预览是 blob 地址，相对路径在 iframe 里一律解析失败，多文件原型不内联就只剩裸 HTML。
 */
export function inlineHtmlAssets(html: string, assets: HtmlAsset[] = []) {
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

function withFrameBridge(html: string, frameId: string) {
  // sandbox 不给 allow-same-origin，父页面读不到 iframe 的文档高度，页内也跳不了同目录的另一页；
  // 两件事都由预览页主动上报，外层只认来自当前 iframe 且带同一实例标识的消息。
  const bridge = `<script>
(() => {
  const frameId = ${JSON.stringify(frameId)};
  let last = -1;
  const report = () => {
    const root = document.documentElement;
    const body = document.body;
    // documentElement.scrollHeight 永远不小于 iframe 自己的高度，只量它的话高度只会一直是初值；
    // 取 html 元素的实际盒高，页面短的时候才收得回来，写死 100vh 的外壳也稳定在一屏。
    const height = Math.max(
      root ? root.getBoundingClientRect().height : 0,
      body ? body.scrollHeight : 0,
    );
    if (!height || height === last) return;
    last = height;
    window.parent.postMessage({ type: ${JSON.stringify(HEIGHT_MESSAGE)}, frameId, height }, "*");
  };
  // 用 setTimeout 而不是 requestAnimationFrame：页面在后台或预览被滚出屏幕时 rAF 会被节流，
  // 高度就一直卡在初值上。
  const schedule = () => window.setTimeout(report, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", schedule, { once: true });
  else schedule();
  window.addEventListener("load", schedule);
  // 图片和网络字体加载完还会再撑一次高度。
  window.setTimeout(report, 400);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  // 指向同一套原型里另一页的相对链接交给外层换页；页内锚点和外链保持浏览器原本的行为。
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || href.slice(0, 2) === "//" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return;
    if (!/\\.html?($|[?#])/i.test(href)) return;
    event.preventDefault();
    window.parent.postMessage({ type: ${JSON.stringify(NAVIGATE_MESSAGE)}, frameId, href }, "*");
  }, true);
})();
</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${bridge}</body>`) : `${html}${bridge}`;
}

/**
 * 直接看一段 HTML 的效果：原型页、HTML 报告都走这里。
 *
 * 不用 srcDoc：srcDoc 文档的地址是 about:srcdoc，页内 `#锚点` 一跳就把沙箱里的文档跳空，
 * 原型里的目录导航基本都是这种锚点。换成 blob 地址后文档有真实 URL，锚点和前进后退都正常。
 *
 * sandbox 给了脚本、弹窗和 print，但始终不给 allow-same-origin：原型跑在不透明源里，
 * 读不到交付台的 Cookie 和 localStorage，也带不上登录态去打接口。
 */
export function HtmlPreview({
  html,
  assets,
  title,
  onNavigate,
}: {
  html: string;
  /** 同目录的样式、脚本，预览前内联进正文。 */
  assets?: HtmlAsset[];
  title: string;
  /** 页内点了指向另一页的相对链接时回调，由外层切换当前预览的文件。 */
  onNavigate?: (href: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [contentHeight, setContentHeight] = useState(INITIAL_HEIGHT);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [full, setFull] = useState(false);
  // 默认按屏幕宽度画：原型大多留了窄屏布局，这样字是能读的。
  // 遇到写死桌面宽的页面再切「桌面宽」，那时整页缩到屏幕里，看的是布局全貌。
  const [desktop, setDesktop] = useState(false);
  const frameId = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const document_ = useMemo(() => withFrameBridge(inlineHtmlAssets(html, assets), frameId), [assets, frameId, html]);

  useEffect(() => {
    setContentHeight(INITIAL_HEIGHT);
    const blobUrl = URL.createObjectURL(new Blob([document_], { type: "text/html;charset=utf-8" }));
    setUrl(blobUrl);
    // 正文换了或组件卸载都要撤销，否则每看一份原型就往内存里留一份副本。
    return () => {
      URL.revokeObjectURL(blobUrl);
      setUrl("");
    };
  }, [document_]);

  // 缩放比例要按实际可用宽度算，抽屉、全屏和竖屏横屏的宽度都不一样。
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // url 还没就绪时舞台没挂上来，量不到宽度；地址一到位要重新量一次。
  }, [full, url]);

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
      if (payload.type === HEIGHT_MESSAGE) {
        if (!("height" in payload) || typeof payload.height !== "number" || !Number.isFinite(payload.height)) return;
        setContentHeight(Math.min(MAX_INLINE_HEIGHT, Math.max(240, Math.ceil(payload.height))));
        return;
      }
      if (payload.type !== NAVIGATE_MESSAGE || !("href" in payload) || typeof payload.href !== "string") return;
      onNavigate?.(payload.href);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frameId, onNavigate]);

  // 全屏时锁住背后的滚动，返回键和 Esc 都先收全屏。
  useEffect(() => {
    if (!full) return;
    const previous = window.document.body.style.overflow;
    window.document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [full]);

  const renderWidth = desktop ? DESKTOP_WIDTH : stage.width || DESKTOP_WIDTH;
  const scale = desktop && stage.width ? Math.min(1, stage.width / DESKTOP_WIDTH) : 1;
  // 全屏时高度由屏幕定，缩放后要反算回 iframe 自己的高度，页面里的 100vh 才落在整屏上。
  const frameHeight = full
    ? Math.round((stage.height || INITIAL_HEIGHT) / (scale || 1))
    : contentHeight;

  const frame = (
    <iframe
      ref={frameRef}
      className="html-preview__frame"
      title={title}
      src={url}
      sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"
      style={{ width: renderWidth, height: frameHeight, transform: scale === 1 ? undefined : `scale(${scale})` }}
    />
  );

  const toolbar = (
    <div className="html-preview__bar">
      <div className="preview-switch" role="group" aria-label="预览宽度">
        <button type="button" className={desktop ? "" : "is-active"} onClick={() => setDesktop(false)}>
          <Smartphone size={16} aria-hidden="true" />手机宽
        </button>
        <button type="button" className={desktop ? "is-active" : ""} onClick={() => setDesktop(true)}>
          <Monitor size={16} aria-hidden="true" />桌面宽
        </button>
      </div>
      <button className="chip-button" type="button" onClick={() => setFull((current) => !current)}>
        {full ? <X size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
        {full ? "退出全屏" : "全屏"}
      </button>
    </div>
  );

  if (!url) return <p className="field-help">正在准备预览…</p>;

  if (full) {
    return createPortal(
      <div className="html-preview is-full" role="dialog" aria-modal="true" aria-label={`${title} 全屏预览`}>
        {toolbar}
        <div className="html-preview__stage" ref={stageRef}>{frame}</div>
      </div>,
      window.document.body,
    );
  }

  return (
    <div className="html-preview">
      {toolbar}
      <div
        className="html-preview__stage"
        ref={stageRef}
        style={{ height: Math.round(contentHeight * scale) }}
      >
        {frame}
      </div>
    </div>
  );
}
