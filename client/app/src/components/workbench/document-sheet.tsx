"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, FileText, LoaderCircle, RotateCw } from "lucide-react";
import { ApiError } from "@/api/client";
import { getCloudDocumentURL, listCloudDocuments, previewCloudDocument, type CloudDocument } from "@/api/documents.api";
import type { RequirementSummary } from "@/api/management.api";
import { Sheet } from "@/components/sheet";
import { RichText } from "@/components/workbench/rich-text";

type Preview = { file: CloudDocument; mode: "text" | "image" | "frame"; content: string };

function isText(file: CloudDocument) {
  return file.contentType.startsWith("text/") || file.contentType.includes("json") || /\.(md|markdown|txt|json|ya?ml|csv|log)$/i.test(file.relativePath);
}

function isImage(file: CloudDocument) {
  return file.contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.relativePath);
}

function displaySize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 需求文档：云端已同步的这条需求目录下的文档，按文件名读，正文直接在面板里看。 */
export function DocumentSheet({
  open,
  programId,
  requirement,
  onClose,
}: {
  open: boolean;
  programId: number;
  requirement: RequirementSummary | null;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<CloudDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showAll, setShowAll] = useState(false);

  const requirementKey = requirement?.requirementKey ?? "";

  const load = useCallback(async () => {
    if (!programId) return;
    setLoading(true);
    setError("");
    try {
      setFiles(await listCloudDocuments(programId));
    } catch (reason) {
      setFiles([]);
      setError(reason instanceof ApiError ? reason.message : "无法读取云端文档。");
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setShowAll(false);
    void load();
  }, [load, open]);

  useEffect(() => () => {
    if (preview && preview.mode !== "text") URL.revokeObjectURL(preview.content);
  }, [preview]);

  const owned = useMemo(
    () => files.filter((file) => requirementKey && file.relativePath.includes(`/${requirementKey}/`)),
    [files, requirementKey],
  );
  const visible = showAll || !owned.length ? files : owned;

  const openPreview = async (file: CloudDocument) => {
    setLoading(true);
    setError("");
    try {
      const blob = await previewCloudDocument(programId, file);
      if (isText(file)) setPreview({ file, mode: "text", content: await blob.text() });
      else setPreview({ file, mode: isImage(file) ? "image" : "frame", content: URL.createObjectURL(blob) });
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法预览该文件。");
    } finally {
      setLoading(false);
    }
  };

  const openSigned = async (file: CloudDocument) => {
    try {
      const signed = await getCloudDocumentURL(programId, file);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "无法打开该文件。");
    }
  };

  return (
    <Sheet
      open={open}
      title="需求文档"
      subtitle={requirement?.name || requirementKey}
      onClose={onClose}
      actions={
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新文档" title="刷新文档" disabled={loading}>
          <RotateCw size={19} className={loading ? "spin-icon" : ""} />
        </button>
      }
    >
      {error ? <p className="form-message is-error" role="alert">{error}</p> : null}

      {preview ? (
        <div className="document-preview-pane">
          <button className="chip-button" type="button" onClick={() => setPreview(null)}><ArrowLeft size={16} aria-hidden="true" />返回列表</button>
          <p className="git-detail__path">{preview.file.relativePath}</p>
          {preview.mode === "text" ? <RichText text={preview.content} /> : null}
          {preview.mode === "image" ? <img className="document-preview__image" src={preview.content} alt={preview.file.relativePath} /> : null}
          {preview.mode === "frame" ? <iframe className="document-preview__frame" src={preview.content} title={preview.file.relativePath} sandbox="" /> : null}
        </div>
      ) : (
        <>
          {loading && !files.length ? <p className="git-loading"><LoaderCircle size={16} className="spin-icon" aria-hidden="true" />正在读取云端文档</p> : null}
          {!loading && !visible.length ? (
            <p className="field-help">这条需求还没有已同步的文档。项目未开启云端同步时，文档只留在执行电脑上。</p>
          ) : null}
          <ul className="document-simple-list">
            {visible.map((file) => (
              <li key={`${file.category}:${file.relativePath}`}>
                <button type="button" onClick={() => void openPreview(file)}>
                  <span className="document-simple-list__icon" aria-hidden="true"><FileText size={17} /></span>
                  <span>
                    <strong>{file.relativePath.split("/").pop()}</strong>
                    <small>{file.relativePath}</small>
                    <small className="muted">{displaySize(file.size)}</small>
                  </span>
                </button>
                <button className="icon-button" type="button" onClick={() => void openSigned(file)} aria-label={`在新窗口打开 ${file.relativePath}`} title="在新窗口打开">
                  <ExternalLink size={17} />
                </button>
              </li>
            ))}
          </ul>
          {owned.length && files.length > owned.length ? (
            <button className="chip-button" type="button" onClick={() => setShowAll((current) => !current)}>
              {showAll ? "只看这条需求" : `查看项目全部文档（${files.length}）`}
            </button>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
