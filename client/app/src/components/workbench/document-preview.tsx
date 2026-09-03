"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Code2, Eye } from "lucide-react";
import { ApiError } from "@/api/client";
import { previewCloudDocument, type CloudDocument } from "@/api/documents.api";
import { RichText } from "@/components/workbench/rich-text";
import { HtmlPreview, referencedAssetPaths, resolveRelativePath, type HtmlAsset } from "@/components/workbench/html-preview";

/** 一份文档在手机上按什么方式看。 */
export type PreviewKind = "markdown" | "html" | "image" | "video" | "audio" | "source" | "binary";

/** 同目录样式脚本一起取的上限：原型引用的就那么几份，别为了一次预览把整个目录拉下来。 */
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 512 * 1024;

const SOURCE_EXTENSIONS = /\.(txt|json|ya?ml|xml|csv|tsv|log|sql|sh|go|ts|tsx|js|jsx|css|scss|java|py|rb|rs|php|ini|toml|conf|env|properties|gitignore)$/i;

export function previewKindOf(file: Pick<CloudDocument, "contentType" | "relativePath">): PreviewKind {
  const path = file.relativePath;
  const type = file.contentType || "";
  if (/\.(md|markdown|mdx)$/i.test(path)) return "markdown";
  if (/\.(html?|xhtml)$/i.test(path) || type.startsWith("text/html")) return "html";
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(path)) return "image";
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(path)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg)$/i.test(path)) return "audio";
  if (type.startsWith("text/") || type.includes("json") || type.includes("xml") || SOURCE_EXTENSIONS.test(path)) return "source";
  return "binary";
}

function readsAsText(kind: PreviewKind) {
  return kind === "markdown" || kind === "html" || kind === "source";
}

export interface DocumentPreview {
  file: CloudDocument;
  kind: PreviewKind;
  /** 文本类文档的正文。 */
  text: string;
  /** 图片、音视频和其它二进制的本地地址。 */
  blobUrl: string;
  /** HTML 引用到的同目录样式和脚本，预览时内联进正文。 */
  assets: HtmlAsset[];
}

/**
 * 打开一份云端文档来看。
 *
 * 文本按正文读，Markdown 交给 RichText 渲染，HTML 交给沙箱 iframe 直接看效果；
 * 多页原型页内的相对链接由 navigate 换算成目录里的另一份文件，翻页跟本地打开一样。
 */
export function useDocumentPreview(programId: number, files: CloudDocument[]) {
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const blobRef = useRef("");
  const filesRef = useRef(files);
  const previewRef = useRef<DocumentPreview | null>(null);
  filesRef.current = files;
  previewRef.current = preview;

  const replaceBlob = useCallback((url: string) => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    blobRef.current = url;
  }, []);

  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    blobRef.current = "";
  }, []);

  const open = useCallback(async (file: CloudDocument) => {
    setLoading(true);
    setError("");
    try {
      const kind = previewKindOf(file);
      const blob = await previewCloudDocument(programId, file);
      if (!readsAsText(kind)) {
        const url = URL.createObjectURL(blob);
        replaceBlob(url);
        setPreview({ file, kind, text: "", blobUrl: url, assets: [] });
        return true;
      }
      const text = await blob.text();
      const assets = kind === "html" ? await loadAssets(programId, file, text, filesRef.current) : [];
      replaceBlob("");
      setPreview({ file, kind, text, blobUrl: "", assets });
      return true;
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法预览该文件。");
      return false;
    } finally {
      setLoading(false);
    }
  }, [programId, replaceBlob]);

  const close = useCallback(() => {
    replaceBlob("");
    setPreview(null);
  }, [replaceBlob]);

  /** 原型页里点了同目录另一页：换算成工作区路径，在已列出的文件里找到它再打开。 */
  const navigate = useCallback((href: string) => {
    const current = previewRef.current;
    if (!current) return;
    const target = resolveRelativePath(current.file.relativePath, href);
    const next = filesRef.current.find((item) => item.relativePath === target);
    if (!next) {
      setError(`这套文档里没有 ${href}，可能还没同步上来。`);
      return;
    }
    void open(next);
  }, [open]);

  return { preview, loading, error, setError, open, close, navigate };
}

/** 把 HTML 引用的同目录样式脚本按路径找出来读成正文，多文件原型才不会只剩裸标签。 */
async function loadAssets(programId: number, file: CloudDocument, html: string, files: CloudDocument[]) {
  const wanted = referencedAssetPaths(html).slice(0, MAX_ASSETS);
  const assets: HtmlAsset[] = [];
  for (const name of wanted) {
    const target = resolveRelativePath(file.relativePath, name);
    const found = files.find((item) => item.relativePath === target);
    if (!found || found.size > MAX_ASSET_BYTES) continue;
    try {
      assets.push({ name, content: await (await previewCloudDocument(programId, found)).text() });
    } catch {
      // 取不到就按缺这份资源渲染：样式差一点也比整页打不开强。
    }
  }
  return assets;
}

/**
 * 预览正文。
 *
 * Markdown 和 HTML 默认给「效果」——需求文档和原型本来就是照着效果写的；
 * 想核对原文时一键切「源码」，和 PC 控制台的文件预览一个口径。
 */
export function DocumentPreviewBody({ preview, onNavigate }: { preview: DocumentPreview; onNavigate?: (href: string) => void }) {
  const [source, setSource] = useState(false);
  const switchable = preview.kind === "markdown" || preview.kind === "html";
  useEffect(() => setSource(false), [preview.file.relativePath]);

  return (
    <>
      {switchable ? (
        <div className="preview-switch" role="group" aria-label="查看方式">
          <button type="button" className={source ? "" : "is-active"} onClick={() => setSource(false)}>
            <Eye size={16} aria-hidden="true" />效果
          </button>
          <button type="button" className={source ? "is-active" : ""} onClick={() => setSource(true)}>
            <Code2 size={16} aria-hidden="true" />源码
          </button>
        </div>
      ) : null}

      {switchable && !source && preview.kind === "markdown" ? <RichText text={preview.text} /> : null}
      {switchable && !source && preview.kind === "html" ? (
        <HtmlPreview html={preview.text} assets={preview.assets} title={preview.file.relativePath} onNavigate={onNavigate} />
      ) : null}
      {(source || preview.kind === "source") ? <pre className="document-preview__text">{preview.text}</pre> : null}
      {preview.kind === "image" ? <img className="document-preview__image" src={preview.blobUrl} alt={preview.file.relativePath} /> : null}
      {preview.kind === "video" ? <video className="document-preview__media" controls src={preview.blobUrl} /> : null}
      {preview.kind === "audio" ? <audio className="document-preview__audio" controls src={preview.blobUrl} /> : null}
      {preview.kind === "binary" ? (
        <iframe className="document-preview__frame" src={preview.blobUrl} title={preview.file.relativePath} sandbox="" />
      ) : null}
    </>
  );
}
