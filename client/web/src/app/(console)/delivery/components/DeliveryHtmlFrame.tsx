"use client";

import { useEffect, useState, type CSSProperties } from "react";

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
}: {
  html: string;
  title: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    setUrl(blobUrl);
    // 正文换了或组件卸载都要撤销，否则每看一份文档就往内存里留一份副本。
    return () => {
      URL.revokeObjectURL(blobUrl);
      setUrl("");
    };
  }, [html]);

  if (!url) return null;
  return (
    <iframe
      title={title}
      className={className}
      style={style}
      sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox"
      src={url}
    />
  );
}
