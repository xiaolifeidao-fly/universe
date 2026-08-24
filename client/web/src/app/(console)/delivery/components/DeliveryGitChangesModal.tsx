"use client";

import { FileOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Modal, Spin, Tooltip } from "antd";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchCodexGitChangeDetail,
  fetchCodexGitChanges,
  type CodexGitChangeDetail,
  type CodexGitChangeFile,
} from "@/api/delivery.api";

// diff 组件依赖 worker 和 DOM，走动态加载，别让它进服务端渲染和首屏包。
const ReactDiffViewer = dynamic(() => import("react-diff-viewer-continued"), {
  ssr: false,
  loading: () => <div className="delivery-git-changes__pending"><Spin /></div>,
});

type Props = {
  open: boolean;
  programId: number;
  branch?: string;
  onClose: () => void;
};

const KIND_LABELS: Record<string, string> = {
  add: "delivery.requirement.gitChangeKind.add",
  modify: "delivery.requirement.gitChangeKind.modify",
  delete: "delivery.requirement.gitChangeKind.delete",
  rename: "delivery.requirement.gitChangeKind.rename",
};

/** 「变更」面板点开后的文件级明细：左边选文件，右边看改动前后的对比。 */
export function DeliveryGitChangesModal({ open, programId, branch, onClose }: Props) {
  const { t } = useLocale();
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<CodexGitChangeFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<CodexGitChangeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const loadChanges = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const result = await fetchCodexGitChanges(programId);
      setFiles(result.files);
      setTruncated(result.truncated);
      // 重新读清单时保住当前选中的文件，除非它已经不在改动列表里了。
      setSelected((current) => (current && result.files.some((file) => file.path === current)
        ? current
        : result.files[0]?.path ?? ""));
    } catch (error) {
      setFiles([]);
      setSelected("");
      setListError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    if (!open) return;
    void loadChanges();
  }, [loadChanges, open]);

  useEffect(() => {
    if (!open || !selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    fetchCodexGitChangeDetail(programId, selected)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(error.message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, programId, selected]);

  const renderDiff = () => {
    if (detailLoading) return <div className="delivery-git-changes__pending"><Spin /></div>;
    if (detailError) return <Alert type="error" showIcon message={detailError} />;
    if (!detail) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.gitChangesEmpty")} />;
    if (detail.binary) return <Alert type="info" showIcon message={t("delivery.requirement.gitChangeBinary")} />;
    if (detail.truncated) return <Alert type="warning" showIcon message={t("delivery.requirement.gitChangeTooLarge")} />;
    if (!detail.oldText && !detail.newText) {
      return <Alert type="info" showIcon message={t("delivery.requirement.gitChangeNoText")} />;
    }
    return (
      <ReactDiffViewer
        oldValue={detail.oldText}
        newValue={detail.newText}
        splitView
        showDiffOnly
        extraLinesSurroundingDiff={3}
        leftTitle={t("delivery.requirement.gitChangeBefore")}
        rightTitle={t("delivery.requirement.gitChangeAfter")}
      />
    );
  };

  return (
    <Modal
      wrapClassName="manager-form-skin delivery-git-changes-modal"
      open={open}
      width="min(1180px, 94vw)"
      destroyOnClose
      title={
        <div className="delivery-git-changes__title">
          <span>{t("delivery.requirement.gitChangesTitle")}</span>
          {branch ? <code className="manager-mono">{branch}</code> : null}
          <Tooltip title={t("delivery.requirement.gitPanelRefresh")}>
            <Button
              type="text"
              size="small"
              shape="circle"
              icon={<ReloadOutlined />}
              loading={loading}
              aria-label={t("delivery.requirement.gitPanelRefresh")}
              onClick={() => void loadChanges()}
            />
          </Tooltip>
        </div>
      }
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
      onCancel={onClose}
    >
      <div className="delivery-git-changes">
        <aside className="delivery-git-changes__files">
          {truncated ? <p className="delivery-git-changes__truncated">{t("delivery.requirement.gitChangesTruncated")}</p> : null}
          {listError ? <Alert type="error" showIcon message={listError} /> : null}
          {loading && !files.length ? <div className="delivery-git-changes__pending"><Spin /></div> : null}
          {!loading && !files.length && !listError ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.gitBranchClean")} />
          ) : null}
          {files.map((file) => (
            <button
              className={`delivery-git-changes__file${file.path === selected ? " is-selected" : ""}`}
              key={file.path}
              type="button"
              onClick={() => setSelected(file.path)}
            >
              <FileOutlined />
              <Tooltip title={file.path} placement="topLeft" mouseEnterDelay={0.4}>
                <span>{file.path}</span>
              </Tooltip>
              <em className={`is-${file.kind}`}>{t(KIND_LABELS[file.kind] ?? KIND_LABELS.modify)}</em>
              <b>
                <i className="is-added">+{file.added}</i>
                <i className="is-removed">-{file.removed}</i>
              </b>
            </button>
          ))}
        </aside>
        <section className="delivery-git-changes__diff">
          {selected ? <header className="manager-mono">{selected}</header> : null}
          <div className="delivery-git-changes__diff-body">{renderDiff()}</div>
        </section>
      </div>
    </Modal>
  );
}
