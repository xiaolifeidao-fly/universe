"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, FileText, LoaderCircle, RotateCw } from "lucide-react";
import { ApiError } from "@/api/client";
import {
  getCloudDocumentURL,
  listCloudDocuments,
  requirementDocumentStages,
  requirementStageLabels,
  taskDocumentStages,
  taskStageLabels,
  type CloudDocument,
  type DocumentOwnerKind,
} from "@/api/documents.api";
import { Sheet } from "@/components/sheet";
import { DocumentPreviewBody, useDocumentPreview } from "@/components/workbench/document-preview";

/** 没有阶段信息的文档单独一栏：多半是本次改造之前同步上去的旧记录。 */
const UNCLASSIFIED = "__unclassified__";

/**
 * 需求和任务各自固定展示的几个阶段。用户从面板点进来时这几栏一定在，
 * 空栏也要留着——「这个阶段还没有文档」本身就是要看的信息。
 */
const pinnedStages: Record<"requirement" | "task", readonly string[]> = {
  requirement: ["outline", "review", "testing", "fine-tuning"],
  task: ["document", "design", "testing", "fine-tuning"],
};

function stageOrderOf(ownerKind: "requirement" | "task"): readonly string[] {
  return ownerKind === "requirement" ? requirementDocumentStages : taskDocumentStages;
}

function stageLabelOf(ownerKind: "requirement" | "task", stage: string) {
  if (stage === UNCLASSIFIED) return "未归类";
  const labels: Record<string, string> = ownerKind === "requirement" ? requirementStageLabels : taskStageLabels;
  return labels[stage] ?? stage;
}

function displaySize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 需求或任务的云端文档，按阶段分栏。
 *
 * 文档的归属和阶段由本机桥接同步时判定并存在服务端，这里只按归属取自己的那一份目录，
 * 不再靠路径里出现过需求键来猜。归属为空的旧记录取不到，会退回一次全项目查询并单独列出，
 * 提示重新同步一次就能各归各位。
 */
export function DocumentSheet({
  open,
  programId,
  ownerKind,
  ownerKey,
  ownerName,
  onClose,
}: {
  open: boolean;
  programId: number;
  ownerKind: "requirement" | "task";
  ownerKey: string;
  ownerName?: string;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<CloudDocument[]>([]);
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<string>("");
  const { preview, loading: previewLoading, error: previewError, open: openPreview, close: closePreview, navigate } = useDocumentPreview(programId, files);

  const load = useCallback(async () => {
    if (!programId || !ownerKey) return;
    setLoading(true);
    setError("");
    try {
      const owned = await listCloudDocuments(programId, { ownerKind: ownerKind as DocumentOwnerKind, ownerKey });
      if (owned.length) {
        setFiles(owned);
        setLegacy(false);
        return;
      }
      // 归属是本次改造后才带上的。旧记录归属为空，按需求键或任务键在路径里认一次，
      // 认出来的先让用户能看到，同时明确告诉他重新同步就能恢复分栏。
      const all = await listCloudDocuments(programId);
      const matched = all.filter((file) => file.relativePath.split("/").includes(ownerKey));
      setFiles(matched);
      setLegacy(matched.length > 0);
    } catch (reason) {
      setFiles([]);
      setLegacy(false);
      setError(reason instanceof ApiError ? reason.message : "无法读取云端文档。");
    } finally {
      setLoading(false);
    }
  }, [ownerKey, ownerKind, programId]);

  useEffect(() => {
    if (!open) return;
    closePreview();
    setStage("");
    void load();
  }, [closePreview, load, open]);

  const grouped = useMemo(() => {
    const rows = new Map<string, CloudDocument[]>();
    for (const file of files) {
      const key = file.stage || UNCLASSIFIED;
      rows.set(key, [...(rows.get(key) ?? []), file]);
    }
    const order = stageOrderOf(ownerKind);
    const tabs = order
      .filter((item) => pinnedStages[ownerKind].includes(item) || (rows.get(item)?.length ?? 0) > 0)
      .map((item) => ({ stage: item as string, rows: rows.get(item) ?? [] }));
    if (rows.has(UNCLASSIFIED)) tabs.push({ stage: UNCLASSIFIED, rows: rows.get(UNCLASSIFIED) ?? [] });
    return tabs;
  }, [files, ownerKind]);

  const active = grouped.find((tab) => tab.stage === stage) ?? grouped[0];
  const visible = active?.rows ?? [];

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
      title={ownerKind === "requirement" ? "需求文档" : "任务文档"}
      subtitle={ownerName || ownerKey}
      onClose={onClose}
      actions={
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="刷新文档" title="刷新文档" disabled={loading}>
          <RotateCw size={21} className={loading ? "spin-icon" : ""} />
        </button>
      }
    >
      {error || previewError ? <p className="form-message is-error" role="alert">{error || previewError}</p> : null}

      {preview ? (
        <div className="document-preview-pane">
          <button className="chip-button" type="button" onClick={closePreview}><ArrowLeft size={18} aria-hidden="true" />返回列表</button>
          <p className="git-detail__path">{preview.file.relativePath}</p>
          {previewLoading ? <p className="git-loading"><LoaderCircle size={18} className="spin-icon" aria-hidden="true" />正在打开</p> : null}
          <DocumentPreviewBody preview={preview} onNavigate={navigate} />
        </div>
      ) : (
        <>
          <div className="document-filter" role="tablist" aria-label={ownerKind === "requirement" ? "需求文档阶段" : "任务文档阶段"}>
            {grouped.map((tab) => (
              <button
                key={tab.stage}
                type="button"
                role="tab"
                aria-selected={active?.stage === tab.stage}
                className={active?.stage === tab.stage ? "is-active" : ""}
                onClick={() => setStage(tab.stage)}
              >
                {stageLabelOf(ownerKind, tab.stage)}
                {tab.rows.length ? <small className="document-filter__count">{tab.rows.length}</small> : null}
              </button>
            ))}
          </div>

          {legacy ? (
            <p className="field-help">这些文档还是按旧格式同步上来的，暂时分不出阶段。在电脑上重新同步一次就会各归各位。</p>
          ) : null}

          {(loading || previewLoading) && !files.length ? <p className="git-loading"><LoaderCircle size={18} className="spin-icon" aria-hidden="true" />正在读取云端文档</p> : null}
          {!loading && !visible.length ? (
            <p className="field-help">
              {files.length
                ? `「${stageLabelOf(ownerKind, active?.stage ?? "")}」还没有已同步的文档。`
                : "这里还没有已同步的文档。项目未开启云端同步时，文档只留在执行电脑上。"}
            </p>
          ) : null}

          <ul className="document-simple-list">
            {visible.map((file) => (
              <li key={`${file.category}:${file.relativePath}`}>
                <button type="button" onClick={() => void openPreview(file)}>
                  <span className="document-simple-list__icon" aria-hidden="true"><FileText size={19} /></span>
                  <span>
                    <strong>{file.relativePath.split("/").pop()}</strong>
                    <small>{file.relativePath}</small>
                    <small className="muted">{displaySize(file.size)}</small>
                  </span>
                </button>
                <button className="icon-button" type="button" onClick={() => void openSigned(file)} aria-label={`在新窗口打开 ${file.relativePath}`} title="在新窗口打开">
                  <ExternalLink size={19} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}
