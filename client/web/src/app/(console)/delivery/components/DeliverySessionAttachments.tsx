"use client";

import { CopyOutlined, DownloadOutlined, EyeOutlined, FileOutlined, LoadingOutlined, PictureOutlined } from "@ant-design/icons";
import { Button, Drawer, Empty, Spin, Tooltip, message } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { fetchCodexConversationAttachment, type CodexConversationAttachment } from "@/api/delivery.api";
import { copyTextToClipboard } from "@/utils/clipboard";

interface SessionAttachmentProps {
  attachment: CodexConversationAttachment;
  programId: number;
  onPreview: (attachment: CodexConversationAttachment) => void;
}

const MAX_INLINE_PREVIEW_BYTES = 8 * 1024 * 1024;

const OFFICE_EXTENSIONS = new Set([
  "doc", "docx", "dot", "dotx", "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "ppt", "pptx", "pps", "ppsx", "pot", "potx", "odt", "ods", "odp",
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "config", "log", "csv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "less", "html", "htm", "xml", "svg", "sql", "go", "py", "java", "kt", "rb", "php", "sh", "bash", "zsh", "fish", "dockerfile", "graphql", "gql", "proto", "properties",
]);

export type AttachmentPreviewKind = "image" | "pdf" | "video" | "audio" | "html" | "markdown" | "text" | "download";

function fileExtension(name: string) {
  const extension = name.trim().split(".").pop();
  return extension?.toLowerCase() ?? "";
}

export function attachmentPreviewKind(attachment: CodexConversationAttachment): AttachmentPreviewKind {
  const contentType = attachment.contentType.toLowerCase().split(";", 1)[0] ?? "";
  const extension = fileExtension(attachment.name);
  if (attachment.size > MAX_INLINE_PREVIEW_BYTES || OFFICE_EXTENSIONS.has(extension)) return "download";
  if (attachment.isImage || contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf" || extension === "pdf") return "pdf";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "text/html" || ["html", "htm"].includes(extension)) return "html";
  if (["md", "markdown", "mdx"].includes(extension) || contentType === "text/markdown") return "markdown";
  if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || TEXT_EXTENSIONS.has(extension)) return "text";
  return "download";
}

export function canPreviewConversationAttachment(attachment: CodexConversationAttachment) {
  return attachmentPreviewKind(attachment) !== "download";
}

/** 仅在链接明确指向这条消息已登记的工作区产物时，拦截并打开预览。 */
export function attachmentForMarkdownLink(
  href: string,
  attachments: CodexConversationAttachment[],
) {
  const rawPath = href.trim();
  if (!rawPath || rawPath.startsWith("#") || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
  let path = rawPath.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  const normalized = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) return null;
  const exact = attachments.find((attachment) => (attachment.relativePath || "").replaceAll("\\", "/") === normalized);
  if (exact) return exact;
  const sameName = attachments.filter((attachment) => attachment.name === normalized.split("/").at(-1));
  return sameName.length === 1 ? sameName[0] : null;
}

export async function downloadConversationAttachment(
  programId: number,
  attachment: CodexConversationAttachment,
) {
  const blob = await fetchCodexConversationAttachment(programId, attachment.url);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyPreviewText(value: string) {
	await copyTextToClipboard(value);
}

function ConversationImage({ attachment, programId, onPreview }: SessionAttachmentProps) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    setFailed(false);
    void fetchCodexConversationAttachment(programId, attachment.url)
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.url, programId]);

  return (
    <button className="delivery-session-attachment is-image" type="button" onClick={() => onPreview(attachment)}>
      {previewUrl ? <img src={previewUrl} alt={attachment.name} /> : (
        <span className="delivery-session-attachment__image-loading">
          {failed ? <PictureOutlined /> : <LoadingOutlined spin />}
        </span>
      )}
      <span>{attachment.name}</span>
    </button>
  );
}

function ConversationFile({ attachment, programId, onPreview }: SessionAttachmentProps) {
  const [downloading, setDownloading] = useState(false);
  const previewable = canPreviewConversationAttachment(attachment);

  return (
    <button
      className="delivery-session-attachment"
      type="button"
      disabled={downloading}
      onClick={() => {
        if (previewable) {
          onPreview(attachment);
          return;
        }
        setDownloading(true);
        void downloadConversationAttachment(programId, attachment)
          .catch((error) => message.error((error as Error).message))
          .finally(() => setDownloading(false));
      }}
    >
      <FileOutlined /><span>{attachment.name}</span>{previewable ? <EyeOutlined /> : <DownloadOutlined />}
    </button>
  );
}

function PreviewBody({ attachment, blobUrl, text }: { attachment: CodexConversationAttachment; blobUrl: string; text: string }) {
  const kind = attachmentPreviewKind(attachment);
  if (kind === "image") return <img className="delivery-file-preview__image" src={blobUrl} alt={attachment.name} />;
  if (kind === "pdf") return <iframe className="delivery-file-preview__frame" title={attachment.name} src={blobUrl} />;
  if (kind === "video") return <video className="delivery-file-preview__media" controls src={blobUrl} />;
  if (kind === "audio") return <audio className="delivery-file-preview__audio" controls src={blobUrl} />;
  if (kind === "html") return <iframe className="delivery-file-preview__frame" title={attachment.name} sandbox="" srcDoc={text} />;
  if (kind === "markdown") {
    return <div className="delivery-session-markdown is-document"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
  }
  return <pre className="delivery-file-preview__text">{text}</pre>;
}

export function SessionFilePreviewDrawer({
  attachment,
  programId,
  open,
  onClose,
}: {
  attachment: CodexConversationAttachment | null;
  programId: number;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [blobUrl, setBlobUrl] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [textLoaded, setTextLoaded] = useState(false);
  const kind = attachment ? attachmentPreviewKind(attachment) : "download";
  const copyable = ["text", "markdown", "html"].includes(kind);
  const metadata = useMemo(
    () => attachment ? [attachment.contentType || "-", readableAttachmentSize(attachment.size)] : [],
    [attachment],
  );

  useEffect(() => {
    if (!attachment || !open || kind === "download") return undefined;
    let disposed = false;
    let nextUrl = "";
    setLoading(true);
    setFailed(false);
    setText("");
    setBlobUrl("");
    setTextLoaded(false);
    void fetchCodexConversationAttachment(programId, attachment.url)
      .then(async (blob) => {
        if (["text", "markdown", "html"].includes(kind)) {
          const source = await blob.text();
          if (!disposed) {
            setText(source);
            setTextLoaded(true);
          }
        } else {
          if (disposed) return;
          nextUrl = URL.createObjectURL(blob);
          setBlobUrl(nextUrl);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [attachment, kind, open, programId]);

  if (!attachment) return null;
  return (
    <Drawer
      className="delivery-file-preview-drawer"
      title={<span className="delivery-file-preview__title"><FileOutlined />{attachment.name}</span>}
      placement="right"
      width="min(720px, calc(100vw - 16px))"
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={(
        <>
          {copyable && (
            <Tooltip title={t("delivery.session.copyFileContent")}>
              <Button
                type="text"
                icon={<CopyOutlined />}
                loading={copying}
                disabled={loading || failed || !textLoaded}
                onClick={() => {
                  setCopying(true);
                  void copyPreviewText(text)
                    .then(() => message.success(t("delivery.session.copyFileContentSuccess")))
                    .catch(() => message.error(t("delivery.session.copyFileContentFailed")))
                    .finally(() => setCopying(false));
                }}
              />
            </Tooltip>
          )}
          <Button
            type="text"
            icon={<DownloadOutlined />}
            loading={downloading}
            onClick={() => {
              setDownloading(true);
              void downloadConversationAttachment(programId, attachment)
                .catch((error) => message.error((error as Error).message))
                .finally(() => setDownloading(false));
            }}
          >
            {t("delivery.session.download")}
          </Button>
        </>
      )}
    >
      <div className="delivery-file-preview">
        <div className="delivery-file-preview__meta">
          {metadata.map((value) => <span key={value}>{value}</span>)}
        </div>
        {kind === "download" ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={attachment.size > MAX_INLINE_PREVIEW_BYTES
              ? t("delivery.session.filePreviewTooLarge").replace("{size}", readableAttachmentSize(attachment.size))
              : t("delivery.session.filePreviewDownloadOnly")}
          />
        ) : loading ? <div className="delivery-file-preview__loading"><Spin /></div>
          : failed ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("delivery.session.filePreviewFailed")} />
            : <PreviewBody attachment={attachment} blobUrl={blobUrl} text={text} />}
      </div>
    </Drawer>
  );
}

export function SessionAttachments({
  attachments,
  programId,
  onPreview,
}: {
  attachments: CodexConversationAttachment[];
  programId: number;
  onPreview: (attachment: CodexConversationAttachment) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="delivery-session-attachments">
      {attachments.map((attachment) => (attachment.isImage && canPreviewConversationAttachment(attachment) ? (
        <ConversationImage attachment={attachment} programId={programId} onPreview={onPreview} key={attachment.id} />
      ) : (
        <ConversationFile attachment={attachment} programId={programId} onPreview={onPreview} key={attachment.id} />
      )))}
    </div>
  );
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const MAX_ATTACHMENTS = 5;

export const attachmentKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;

export const readableAttachmentSize = (size: number) => (size >= 1024 * 1024
  ? `${(size / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.ceil(size / 1024))} KB`);

/**
 * 从剪贴板里取出可上传的文件。截图粘贴过来统一叫 image.png，
 * 直接入列会被 attachmentKey 判成同一份，所以补一个时间戳文件名，多次粘贴才能并存。
 */
export function clipboardAttachments(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []);
  return files.map((file, index) => {
    if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
    const extension = file.name.split(".").pop() || file.type.split("/")[1] || "png";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return new File([file], `pasted-${stamp}-${index + 1}.${extension}`, {
      type: file.type,
      lastModified: file.lastModified,
    });
  });
}
