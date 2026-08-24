"use client";

import {
  EditOutlined,
  ExpandOutlined,
  ExportOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { Button, Empty, Input, Modal, Select, Spin, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchDeliveryDocumentFile,
  fetchDeliveryDocumentSet,
  saveDeliveryDocumentFile,
  type DeliveryDocumentContent,
  type DeliveryDocumentFile,
  type DeliveryDocumentScope,
} from "@/api/delivery.api";
import { useLocale } from "@/i18n/LocaleProvider";
import { DeliveryHtmlFrame, inlineHtmlAssets, resolveFrameHref } from "./DeliveryHtmlFrame";
import { SessionDocumentText } from "./DeliverySessionMessage";

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => HTML_ENTITIES[character] ?? character);
}

/** 非 HTML 文档在新标签页用本地只读页承载，避免 Markdown 被浏览器当纯文本下载。 */
function browserDocument(content: string, title: string, isHtml: boolean) {
  if (isHtml) return content;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
body { margin: 0; background: #f2f5f9; color: #101828; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { box-sizing: border-box; width: min(960px, calc(100% - 32px)); margin: 24px auto; padding: 24px; border: 1px solid rgba(16,24,40,.09); border-radius: 12px; background: #fff; box-shadow: 0 8px 24px rgba(16,24,40,.08); }
pre { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style></head><body><main><pre>${escapeHtml(content)}</pre></main></body></html>`;
}

/**
 * 需求大纲、任务文档、设计文档、测试用例都各自对应工作区里的一个目录，目录里可以有多份文档。
 * 面板只负责选择和编辑已有文档：新增文档一律由会话产出，避免面板造出执行器不认识的文件。
 */
export interface DeliveryDocumentSetProps {
  programId: number;
  scope: DeliveryDocumentScope;
  /** 需求栏目传需求键，任务栏目传任务键；变了就整套重新拉。 */
  subjectKey: string;
  codexBridgeReady: boolean;
  title?: ReactNode;
  /** 目录里一份文档都没有时的兜底内容，例如仍留在库里的旧产物正文。 */
  fallback?: ReactNode;
  /** 兜底正文也允许在本地浏览器中打开，给尚未迁移为工作区文件的历史产物使用。 */
  browserContent?: string;
  browserTitle?: string;
  emptyText?: string;
  /** 只读栏目（例如仅供查看的测试报告）传 false。 */
  editable?: boolean;
  /** 传了就在操作区显示「全屏预览」，交给调用方打开左右分栏弹窗。 */
  onExpand?: () => void;
  /** 值变了就重新拉一次目录：文档是会话写进工作区的，面板自己不会知道它变了。 */
  refreshToken?: string | number;
  /**
   * 正文区自己滚动，页头的下拉框和按钮不跟着走。
   * fill 用于父级已经限死高度的页签（占满剩余高度），cap 用于跟随外层滚动的页面（超出后面板内部滚）。
   */
  scroll?: "fill" | "cap";
}

function useDocumentSet(
  programId: number,
  scope: DeliveryDocumentScope,
  subjectKey: string,
  ready: boolean,
  refreshToken: string | number = "",
) {
  const [files, setFiles] = useState<DeliveryDocumentFile[]>([]);
  const [directory, setDirectory] = useState("");
  const [path, setPath] = useState("");
  const [document, setDocument] = useState<DeliveryDocumentContent | null>(null);
  const [listing, setListing] = useState(false);
  const [reading, setReading] = useState(false);

  const reload = useCallback(
    async (preferredPath = "") => {
      if (!programId || !subjectKey || !ready) {
        setFiles([]);
        setDirectory("");
        setPath("");
        setDocument(null);
        return;
      }
      setListing(true);
      try {
        const documentSet = await fetchDeliveryDocumentSet(programId, scope, subjectKey);
        setDirectory(documentSet.directory);
        setFiles(documentSet.files);
        // 刷新后尽量停在用户原来看的那份文档上，只有它没了才回到主文档。
        const selected = preferredPath && documentSet.files.some((file) => file.path === preferredPath)
          ? preferredPath
          : documentSet.primaryPath;
        setPath(selected);
        if (!selected) setDocument(null);
      } catch (error) {
        setFiles([]);
        setDirectory("");
        setPath("");
        setDocument(null);
        message.error((error as Error).message);
      } finally {
        setListing(false);
      }
    },
    // refreshToken 只用于触发重新拉取，正文本身不依赖它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [programId, ready, refreshToken, scope, subjectKey],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // 只读选中的那一份：一个栏目可能有几十份文档，不该为了预览把整个目录都读进来。
  useEffect(() => {
    if (!path || !programId || !subjectKey || !ready) {
      setDocument(null);
      return;
    }
    let cancelled = false;
    setReading(true);
    fetchDeliveryDocumentFile(programId, scope, subjectKey, path)
      .then((content) => {
        if (!cancelled) setDocument(content);
      })
      .catch((error) => {
        if (cancelled) return;
        setDocument(null);
        message.error((error as Error).message);
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, programId, ready, scope, subjectKey]);

  return { files, directory, path, setPath, document, setDocument, loading: listing || reading, reload };
}

interface DocumentSetViewProps extends DeliveryDocumentSetProps {
  /** split 形态用于全屏预览：左侧文件列表，右侧预览与编辑。 */
  layout?: "panel" | "split";
  /** 弹窗形态传进来的铺满视口开关，面板形态不显示这个按钮。 */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

function DocumentSetView({
  programId,
  scope,
  subjectKey,
  codexBridgeReady,
  title,
  fallback,
  browserContent,
  browserTitle,
  emptyText,
  editable = true,
  onExpand,
  refreshToken,
  scroll,
  layout = "panel",
  fullscreen = false,
  onToggleFullscreen,
}: DocumentSetViewProps) {
  const { t } = useLocale();
  const { files, path, setPath, document, setDocument, loading, reload } = useDocumentSet(
    programId,
    scope,
    subjectKey,
    codexBridgeReady,
    refreshToken,
  );
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft(document?.content ?? "");
  }, [document]);

  const panelClassName = [
    "delivery-document-panel",
    "delivery-outline-panel",
    title ? "has-title" : "",
    scroll ? "is-scrollable" : "",
    scroll === "fill" ? "is-fill" : scroll === "cap" ? "is-capped" : "",
  ].filter(Boolean).join(" ");

  const options = useMemo(
    () => files.map((file) => ({ value: file.path, label: file.name })),
    [files],
  );
  const canEdit = editable && Boolean(document?.exists) && !loading;
  const contentForBrowser = document?.content ?? browserContent ?? "";

  const submit = async () => {
    if (!path) return;
    setSaving(true);
    try {
      const saved = await saveDeliveryDocumentFile(programId, scope, subjectKey, path, draft);
      setDocument(saved);
      setEditing(false);
      message.success(t("delivery.docset.saved"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // 多页 HTML 之间的相对链接在 blob 预览里跳不动，换成切换栏目里对应的那份文档。
  const navigate = (href: string) => {
    const resolved = resolveFrameHref(path, href);
    const target = files.find((file) => file.path === resolved);
    if (target) setPath(target.path);
    else message.warning(`${t("delivery.docset.missingPage")}：${href}`);
  };

  /** 在浏览器新标签页打开当前文档；HTML 保持交互，文本类文档用本地只读页展示。 */
  const openInBrowser = () => {
    const content = contentForBrowser;
    if (!content.trim()) return;
    const isHtmlDocument = Boolean(document?.content) && /\.html?$/i.test(path);
    // 新标签页同样是 blob 地址，样式脚本得先内联，否则打开的是一份没有样式的裸页面。
    const body = isHtmlDocument ? inlineHtmlAssets(content, document?.assets) : content;
    const url = URL.createObjectURL(new Blob([
      browserDocument(body, path.slice(path.lastIndexOf("/") + 1) || browserTitle || t("delivery.docset.file"), isHtmlDocument),
    ], { type: "text/html;charset=utf-8" }));
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) message.warning(t("delivery.docset.openBlocked"));
    // 新标签页加载完就不再需要这个地址了，留着只会一直占内存。
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  if (!codexBridgeReady) {
    return (
      <section className={panelClassName}>
        {title ? (
          <header className="delivery-outline-panel__bar">
            <b className="delivery-outline-panel__title">{title}</b>
          </header>
        ) : null}
        <SessionDocumentText value="" fallback={t("delivery.docset.bridgeOffline")} />
      </section>
    );
  }

  // 路径本身很长，横着塞一行会被挤没：目录部分可以省略，文件名和更新时间始终看得见。
  const lastSlash = path.lastIndexOf("/");
  const pathDir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const pathName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const isHtml = /\.html?$/i.test(path);

  const actions = (
    <span className="delivery-outline-panel__actions">
      {layout === "panel" && options.length > 1 ? (
        <Select
          size="small"
          variant="filled"
          className="delivery-document-panel__picker"
          popupMatchSelectWidth={false}
          suffixIcon={<FileTextOutlined />}
          aria-label={t("delivery.docset.file")}
          value={path || undefined}
          placeholder={t("delivery.docset.selectPlaceholder")}
          options={options}
          disabled={editing}
          onChange={(value) => setPath(value)}
        />
      ) : null}
      <Tooltip title={t("delivery.session.refresh")}>
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          disabled={loading || saving}
          aria-label={t("delivery.session.refresh")}
          onClick={() => void reload(path)}
        />
      </Tooltip>
      {onExpand && layout === "panel" ? (
        <Tooltip title={t("delivery.docset.expand")}>
          <Button
            size="small"
            type="text"
            icon={<ExpandOutlined />}
            aria-label={t("delivery.docset.expand")}
            onClick={onExpand}
          />
        </Tooltip>
      ) : null}
      {contentForBrowser.trim() ? (
        <Tooltip title={t("delivery.docset.openInBrowser")}>
          <Button
            size="small"
            type="text"
            icon={<ExportOutlined />}
            aria-label={t("delivery.docset.openInBrowser")}
            onClick={openInBrowser}
          />
        </Tooltip>
      ) : null}
      {onToggleFullscreen && layout === "split" ? (
        <Tooltip title={t(fullscreen ? "delivery.docset.exitFullscreen" : "delivery.docset.fullscreen")}>
          <Button
            size="small"
            type="text"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            aria-label={t(fullscreen ? "delivery.docset.exitFullscreen" : "delivery.docset.fullscreen")}
            onClick={onToggleFullscreen}
          />
        </Tooltip>
      ) : null}
      {editing ? (
        <>
          <Button
            size="small"
            onClick={() => {
              setDraft(document?.content ?? "");
              setEditing(false);
            }}
          >
            {t("delivery.outline.cancel")}
          </Button>
          <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void submit()}>
            {t("delivery.outline.save")}
          </Button>
        </>
      ) : editable ? (
        <Tooltip title={canEdit ? "" : t("delivery.docset.readonlyHint")}>
          <Button size="small" icon={<EditOutlined />} disabled={!canEdit} onClick={() => setEditing(true)}>
            {t("delivery.outline.edit")}
          </Button>
        </Tooltip>
      ) : null}
    </span>
  );

  const body = editing ? (
    <Input.TextArea
      autoSize={{ minRows: layout === "split" ? 20 : 12, maxRows: 40 }}
      value={draft}
      placeholder={t("delivery.outline.placeholder")}
      onChange={(event) => setDraft(event.target.value)}
    />
  ) : !files.length && fallback ? (
    // 目录里还没有文档时，保留库里沉淀的旧产物正文，老数据不会因为改成文档集就看不见。
    <>{fallback}</>
  ) : isHtml && (document?.content ?? "").trim() ? (
    // HTML 文档（例如原型页）按渲染结果预览，源码只在编辑态出现。
    <DeliveryHtmlFrame
      autoHeight
      className="delivery-document-panel__frame"
      title={pathName || t("delivery.docset.file")}
      html={document?.content ?? ""}
      assets={document?.assets}
      onNavigate={navigate}
    />
  ) : (
    <SessionDocumentText value={document?.content ?? ""} fallback={emptyText || t("delivery.docset.empty")} />
  );

  const meta = path ? (
    <div className="delivery-document-panel__path" title={path}>
      <FileTextOutlined className="delivery-document-panel__path-icon" />
      <span className="delivery-document-panel__path-text">
        {pathDir ? <span className="delivery-document-panel__path-dir">{pathDir}</span> : null}
        <span className="delivery-document-panel__path-name">{pathName}</span>
      </span>
      {document?.modifiedAt ? (
        <span className="delivery-document-panel__path-time">
          {dayjs(document.modifiedAt).format("YYYY-MM-DD HH:mm")}
        </span>
      ) : null}
    </div>
  ) : null;

  if (layout === "split") {
    return (
      <div className="delivery-document-set">
        <aside className="delivery-document-set__files" aria-label={t("delivery.docset.files")}>
          <header>{t("delivery.docset.files")}</header>
          {files.length ? (
            <ul>
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className={file.path === path ? "is-active" : ""}
                    disabled={editing}
                    onClick={() => setPath(file.path)}
                  >
                    <FileTextOutlined />
                    <span className="delivery-document-set__name" title={file.name}>{file.name}</span>
                    <small>{file.updatedAt ? dayjs(file.updatedAt).format("MM-DD HH:mm") : ""}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.docset.empty")} />
          )}
        </aside>
        <section className={panelClassName}>
          <header className="delivery-outline-panel__bar">
            {title ? <b className="delivery-outline-panel__title">{title}</b> : null}
            {actions}
          </header>
          {meta}
          <Spin spinning={loading}>{body}</Spin>
        </section>
      </div>
    );
  }

  return (
    <section className={panelClassName}>
      <header className="delivery-outline-panel__bar">
        {title ? <b className="delivery-outline-panel__title">{title}</b> : null}
        {actions}
      </header>
      {meta}
      <Spin spinning={loading}>{body}</Spin>
    </section>
  );
}

/** 嵌在需求编辑、任务详情等页面里的栏目面板：顶部下拉框选文档，下面预览或编辑。 */
export function DeliveryDocumentSetPanel(props: DeliveryDocumentSetProps) {
  return <DocumentSetView {...props} layout="panel" />;
}

/** 全屏预览：左侧是该栏目的文件列表，右侧是预览与编辑。 */
export function DeliveryDocumentSetModal({
  open,
  onClose,
  width = "min(1240px, calc(100vw - 32px))",
  ...props
}: DeliveryDocumentSetProps & { open: boolean; onClose: () => void; width?: string | number }) {
  // 大纲和任务文档经常又长又宽（表格、原型页），留一个铺满视口的开关。
  const [fullscreen, setFullscreen] = useState(false);

  // 关掉再打开时回到常规尺寸，免得上次的全屏状态跟着下一份文档一起弹出来。
  useEffect(() => {
    if (!open) setFullscreen(false);
  }, [open]);

  return (
    <Modal
      className={`delivery-document-set-modal${fullscreen ? " is-fullscreen" : ""}`}
      open={open}
      title={null}
      width={fullscreen ? "100vw" : width}
      footer={null}
      destroyOnClose
      onCancel={onClose}
    >
      {open && props.subjectKey ? (
        <DocumentSetView
          {...props}
          layout="split"
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((value) => !value)}
        />
      ) : null}
    </Modal>
  );
}
