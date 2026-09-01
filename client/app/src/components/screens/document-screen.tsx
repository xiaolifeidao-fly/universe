"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, FileCode2, FileText, Image, LoaderCircle, PackageOpen, Paperclip, RefreshCw, ShieldAlert, X } from "lucide-react";
import { ApiError } from "@/api/client";
import { documentCategories, getCloudDocumentURL, listCloudDocuments, previewCloudDocument, type CloudDocument, type DocumentCategory } from "@/api/documents.api";
import { EmptyState } from "@/components/empty-state";

const categoryLabels: Record<DocumentCategory, string> = {
  chat: "会话",
  requirement: "需求",
  design: "设计",
  test: "测试",
  prototype: "原型",
  execution: "执行产物",
  attachment: "附件",
};

function categoryIcon(category: DocumentCategory) {
  if (category === "prototype") return <FileCode2 size={18} />;
  if (category === "test") return <ShieldAlert size={18} />;
  if (category === "execution") return <PackageOpen size={18} />;
  if (category === "attachment") return <Paperclip size={18} />;
  return <FileText size={18} />;
}

function displayTime(value?: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function displaySize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function canReadAsText(contentType: string, path: string) {
  return contentType.startsWith("text/") || contentType.includes("json") || /\.(md|txt|json|yaml|yml|xml|csv|log)$/i.test(path);
}

function canRenderImage(contentType: string, path: string) {
  return contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(path);
}

type Preview = {
  file: CloudDocument;
  mode: "text" | "image" | "frame";
  content: string;
};

export function DocumentScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  const programId = Number(projectId);
  const [category, setCategory] = useState<DocumentCategory | "all">("all");
  const [files, setFiles] = useState<CloudDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(programId) || programId <= 0) {
      setFiles([]);
      setError("项目标识无效。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setFiles(await listCloudDocuments(programId, category === "all" ? undefined : category));
    } catch (reason) {
      setFiles([]);
      setError(reason instanceof ApiError ? reason.message : "无法读取云端文档。");
    } finally {
      setLoading(false);
    }
  }, [category, programId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => () => {
    if (preview && preview.mode !== "text") URL.revokeObjectURL(preview.content);
  }, [preview]);

  const grouped = useMemo(() => {
    const rows = new Map<DocumentCategory, CloudDocument[]>();
    for (const item of files) rows.set(item.category, [...(rows.get(item.category) ?? []), item]);
    return documentCategories.map((item) => [item, rows.get(item) ?? []] as const).filter(([, rows]) => rows.length > 0);
  }, [files]);

  const openPreview = async (file: CloudDocument) => {
    setPreviewLoading(true);
    setError("");
    try {
      const blob = await previewCloudDocument(programId, file);
      if (canReadAsText(file.contentType, file.relativePath)) {
        setPreview({ file, mode: "text", content: await blob.text() });
      } else {
        setPreview({ file, mode: canRenderImage(file.contentType, file.relativePath) ? "image" : "frame", content: URL.createObjectURL(blob) });
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法预览该文件。");
    } finally {
      setPreviewLoading(false);
    }
  };

  const openControlledURL = async (file: CloudDocument) => {
    try {
      const signed = await getCloudDocumentURL(programId, file);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法打开该文件。");
    }
  };

  return (
    <main className="screen document-screen">
      <div className="screen-title-row">
        <div><p className="eyebrow">项目 #{projectId}</p><h1>云端文档</h1><p>已同步的交付资料</p></div>
        <div className="stack-actions">
          <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新云端文档" title="刷新云端文档" disabled={loading}><RefreshCw size={20} className={loading ? "spin-icon" : ""} /></button>
          <Link className="icon-button" href={`/projects/${projectId}`} aria-label="返回项目" title="返回项目"><ArrowLeft size={20} /></Link>
        </div>
      </div>

      <div className="document-filter" role="group" aria-label="文档类别">
        <button type="button" className={category === "all" ? "is-active" : ""} onClick={() => setCategory("all")}>全部</button>
        {documentCategories.map((item) => <button type="button" className={category === item ? "is-active" : ""} onClick={() => setCategory(item)} key={item}>{categoryLabels[item]}</button>)}
      </div>

      {loading ? <EmptyState icon={<LoaderCircle size={22} className="spin-icon" />} title="正在同步目录" description="" /> : null}
      {!loading && error ? <EmptyState icon={<ShieldAlert size={22} />} title="暂时无法查看云端文档" description={error} action={<button className="button button-primary" type="button" onClick={() => void load()}>重新连接</button>} /> : null}
      {!loading && !error && !files.length ? <EmptyState icon={<FileText size={22} />} title="暂无可查看的云端文档" description="项目未开启云端同步时，文件只保留在执行电脑。" /> : null}
      {!loading && !error && grouped.map(([kind, rows]) => (
        <section className="document-group" key={kind} aria-labelledby={`document-group-${kind}`}>
          <h2 id={`document-group-${kind}`}><span>{categoryIcon(kind)}</span>{categoryLabels[kind]}<small>{rows.length}</small></h2>
          <div className="document-list">
            {rows.map((file) => (
              <article className="document-row" key={`${file.category}:${file.relativePath}`}>
                <span className="document-row__icon" aria-hidden="true">{canRenderImage(file.contentType, file.relativePath) ? <Image size={18} /> : categoryIcon(file.category)}</span>
                <button className="document-row__body" type="button" onClick={() => void openPreview(file)}>
                  <strong>{file.relativePath.split("/").pop()}</strong>
                  <span>{file.relativePath}</span>
                  <small>{displaySize(file.size)} · {displayTime(file.updatedAt)}</small>
                </button>
                <button className="icon-button document-row__open" type="button" onClick={() => void openControlledURL(file)} aria-label={`在新窗口打开 ${file.relativePath}`} title="在新窗口打开"><ExternalLink size={18} /></button>
              </article>
            ))}
          </div>
        </section>
      ))}

      {preview || previewLoading ? (
        <section className="document-preview" aria-live="polite">
          <div className="document-preview__header"><div><p className="eyebrow">受控预览</p><h2>{preview?.file.relativePath || "正在打开文件"}</h2></div>{preview ? <button className="icon-button" type="button" onClick={() => setPreview(null)} aria-label="关闭预览" title="关闭预览"><X size={19} /></button> : null}</div>
          {previewLoading ? <EmptyState icon={<LoaderCircle size={22} className="spin-icon" />} title="正在加载预览" description="" /> : null}
          {preview?.mode === "text" ? <pre className="document-preview__text">{preview.content}</pre> : null}
          {preview?.mode === "image" ? <img className="document-preview__image" src={preview.content} alt={preview.file.relativePath} /> : null}
          {preview?.mode === "frame" ? <iframe className="document-preview__frame" src={preview.content} title={preview.file.relativePath} sandbox="" /> : null}
        </section>
      ) : null}
    </main>
  );
}
