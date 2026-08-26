"use client";

import {
  DeleteOutlined,
  DiffOutlined,
  EditOutlined,
  FileAddOutlined,
  FileOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Modal, Segmented, Spin, Tooltip } from "antd";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  /** 要看哪个工程的改动：空串是项目根工作目录，否则是子项目的绝对路径。 */
  workspace?: string;
  /** 子项目名，只用于标题上标出这份改动属于哪个工程。 */
  projectName?: string;
  onClose: () => void;
};

const KIND_LABELS: Record<string, string> = {
  add: "delivery.requirement.gitChangeKind.add",
  modify: "delivery.requirement.gitChangeKind.modify",
  delete: "delivery.requirement.gitChangeKind.delete",
  rename: "delivery.requirement.gitChangeKind.rename",
};

type ChangeFilter = "all" | "add" | "modify" | "delete" | "rename";

const KIND_ICONS: Record<string, ReactNode> = {
  add: <FileAddOutlined />,
  modify: <EditOutlined />,
  delete: <DeleteOutlined />,
  rename: <SwapOutlined />,
};

function replaceTokens(template: string, values: Record<string, number>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, String(value)),
    template,
  );
}

/** 「变更」面板点开后的文件级明细：左边选文件，右边看改动前后的对比。 */
export function DeliveryGitChangesModal({ open, programId, branch, workspace = "", projectName = "", onClose }: Props) {
  const { t } = useLocale();
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<CodexGitChangeFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<CodexGitChangeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChangeFilter>("all");

  const loadChanges = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const result = await fetchCodexGitChanges(programId, workspace);
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
  }, [programId, workspace]);

  useEffect(() => {
    if (!open) return;
    void loadChanges();
  }, [loadChanges, open]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setFilter("all");
  }, [open]);

  const visibleFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return files.filter((file) => (
      (filter === "all" || file.kind === filter)
      && (!normalizedQuery || file.path.toLocaleLowerCase().includes(normalizedQuery))
    ));
  }, [files, filter, query]);

  const summary = useMemo(() => files.reduce(
    (result, file) => ({
      added: result.added + file.added,
      removed: result.removed + file.removed,
    }),
    { added: 0, removed: 0 },
  ), [files]);

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selected),
    [files, selected],
  );

  // 筛选后别让右侧还停在已隐藏的文件上；自动落到当前列表第一项，保持导航和预览一致。
  useEffect(() => {
    if (!open || (selected && visibleFiles.some((file) => file.path === selected))) return;
    setSelected(visibleFiles[0]?.path ?? "");
  }, [open, selected, visibleFiles]);

  useEffect(() => {
    if (!open || !selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    fetchCodexGitChangeDetail(programId, selected, workspace)
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
  }, [open, programId, selected, workspace]);

  const renderPreviewState = (icon: ReactNode, title: string, description: string, tone = "neutral") => (
    <div className="delivery-git-changes__preview-empty" data-tone={tone}>
      <span className="delivery-git-changes__preview-empty-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );

  const renderDiff = () => {
    if (detailLoading) return <div className="delivery-git-changes__pending"><Spin /></div>;
    if (detailError) return <Alert type="error" showIcon message={detailError} />;
    if (!detail) return renderPreviewState(
      <DiffOutlined />,
      t("delivery.requirement.gitChangesEmptyTitle"),
      t("delivery.requirement.gitChangesEmpty"),
    );
    if (detail.binary) return renderPreviewState(
      <FileOutlined />,
      t("delivery.requirement.gitChangeBinary"),
      t("delivery.requirement.gitChangeBinaryHint"),
    );
    if (detail.truncated) return renderPreviewState(
      <FileTextOutlined />,
      t("delivery.requirement.gitChangeTooLarge"),
      t("delivery.requirement.gitChangeTooLargeHint"),
      "warning",
    );
    if (!detail.oldText && !detail.newText) {
      return renderPreviewState(
        <FileTextOutlined />,
        t("delivery.requirement.gitChangeNoText"),
        t("delivery.requirement.gitChangeNoTextHint"),
      );
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
      width="min(1280px, calc(100vw - 48px))"
      destroyOnClose
      title={
        <div className="delivery-git-changes__title">
          <span>{t("delivery.requirement.gitChangesTitle")}</span>
          <div className="delivery-git-changes__title-actions">
            {projectName ? <em className="delivery-git-changes__project">{projectName}</em> : null}
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
        </div>
      }
      footer={null}
      onCancel={onClose}
    >
      <div className="delivery-git-changes">
        <aside className="delivery-git-changes__files">
          <header className="delivery-git-changes__files-header">
            <div className="delivery-git-changes__files-heading">
              <span>{t("delivery.requirement.gitChangesFiles")}</span>
              <b>{replaceTokens(t("delivery.requirement.gitChangesFilesCount"), { count: files.length })}</b>
            </div>
            <div className="delivery-git-changes__files-summary" aria-label={replaceTokens(
              t("delivery.requirement.gitChangesSummary"),
              summary,
            )}>
              <span className="is-added">+{summary.added}</span>
              <span className="is-removed">-{summary.removed}</span>
            </div>
            <Input
              allowClear
              className="delivery-git-changes__search"
              placeholder={t("delivery.requirement.gitChangesSearch")}
              prefix={<SearchOutlined />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Segmented
              block
              className="delivery-git-changes__filter"
              options={(["all", "add", "modify", "delete", "rename"] as ChangeFilter[]).map((kind) => ({
                label: kind === "all"
                  ? t("delivery.requirement.gitChangesFilter.all")
                  : t(KIND_LABELS[kind]),
                value: kind,
              }))}
              value={filter}
              onChange={(value) => setFilter(value as ChangeFilter)}
            />
          </header>
          <div className="delivery-git-changes__file-list">
            {truncated ? <p className="delivery-git-changes__truncated">{t("delivery.requirement.gitChangesTruncated")}</p> : null}
            {listError ? <Alert type="error" showIcon message={listError} /> : null}
            {loading && !files.length ? <div className="delivery-git-changes__pending"><Spin /></div> : null}
            {!loading && !files.length && !listError ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.gitBranchClean")} />
            ) : null}
            {!loading && files.length > 0 && !visibleFiles.length ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.requirement.gitChangesNoMatches")} />
            ) : null}
            {visibleFiles.map((file) => (
              <button
                aria-pressed={file.path === selected}
                className={`delivery-git-changes__file is-${file.kind}${file.path === selected ? " is-selected" : ""}`}
                key={file.path}
                type="button"
                onClick={() => setSelected(file.path)}
              >
                <span className="delivery-git-changes__file-icon" aria-hidden="true">
                  {KIND_ICONS[file.kind] ?? <FileOutlined />}
                </span>
                <Tooltip title={file.path} placement="topLeft" mouseEnterDelay={0.4}>
                  <span className="delivery-git-changes__file-path">{file.path}</span>
                </Tooltip>
                <span className="delivery-git-changes__file-meta">
                  <em>{t(KIND_LABELS[file.kind] ?? KIND_LABELS.modify)}</em>
                  <b>
                    <i className="is-added">+{file.added}</i>
                    <i className="is-removed">-{file.removed}</i>
                  </b>
                </span>
              </button>
            ))}
          </div>
        </aside>
        <section className="delivery-git-changes__diff">
          <header className="delivery-git-changes__preview-header">
            <div>
              <span>{t("delivery.requirement.gitChangesPreview")}</span>
              {selected ? <code className="manager-mono" title={selected}>{selected}</code> : null}
            </div>
            {selectedFile ? <div className="delivery-git-changes__preview-meta">
              <em className={`is-${selectedFile.kind}`}>{t(KIND_LABELS[selectedFile.kind] ?? KIND_LABELS.modify)}</em>
              <span className="is-added">+{selectedFile.added}</span>
              <span className="is-removed">-{selectedFile.removed}</span>
            </div> : null}
          </header>
          <div className="delivery-git-changes__diff-body">{renderDiff()}</div>
        </section>
      </div>
    </Modal>
  );
}
