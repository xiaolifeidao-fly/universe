"use client";

import { CopyOutlined, DownloadOutlined, EyeOutlined, FileOutlined, FolderOpenOutlined, LoadingOutlined, PictureOutlined } from "@ant-design/icons";
import { Button, Empty, Modal, Segmented, Spin, Tooltip, message } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  fetchCodexConversationAttachment,
  revealCodexWorkspaceFile,
  workspaceFileAbsolutePath,
  type CodexConversationAttachment,
} from "@/api/delivery.api";
import { copyTextToClipboard } from "@/utils/clipboard";
import { DeliveryHtmlFrame } from "./DeliveryHtmlFrame";

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
  "txt", "md", "markdown", "mdx", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "config", "log", "csv", "tsv", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "css", "scss", "less", "html", "htm", "xml", "svg", "sql", "go", "py", "java", "kt", "kts", "rb", "php", "sh", "bash", "zsh", "fish", "dockerfile", "graphql", "gql", "proto", "properties",
  // 常见源文件都要能按源码看：面板里点开的多半就是执行器刚写的代码。
  "rs", "c", "h", "hpp", "hh", "cc", "cpp", "cxx", "cs", "swift", "m", "mm", "scala", "groovy", "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl", "hs", "clj", "vue", "svelte", "astro", "tf", "tfvars", "gradle", "cmake", "mk", "makefile", "bat", "ps1", "patch", "diff", "sum", "mod", "editorconfig", "gitignore", "npmrc",
]);

export type AttachmentPreviewKind = "image" | "pdf" | "video" | "audio" | "html" | "markdown" | "text" | "download";

/** 预览的两种看法：render 是渲染后的效果，source 是源文件。 */
export type FilePreviewMode = "render" | "source";

/** 只有渲染出来和源码不是一回事的类型，才需要给两种看法：HTML 和 Markdown。 */
export function supportsPreviewModes(kind: AttachmentPreviewKind) {
  return kind === "html" || kind === "markdown";
}

/** 源码视图上标出来的语言，纯展示用，认不出来就按扩展名原样显示。 */
const SOURCE_LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", py: "Python", rb: "Ruby", php: "PHP",
  sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell",
  css: "CSS", scss: "SCSS", less: "Less", html: "HTML", htm: "HTML", xml: "XML", svg: "SVG",
  json: "JSON", jsonl: "JSON Lines", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
  md: "Markdown", markdown: "Markdown", mdx: "MDX", txt: "Text", log: "Log", csv: "CSV",
  proto: "Protobuf", graphql: "GraphQL", gql: "GraphQL", dockerfile: "Dockerfile",
  c: "C", h: "C", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", cs: "C#", swift: "Swift",
  m: "Objective-C", mm: "Objective-C++", scala: "Scala", dart: "Dart", lua: "Lua", r: "R",
  vue: "Vue", svelte: "Svelte", astro: "Astro", tf: "Terraform", patch: "Diff", diff: "Diff",
};

/** 行号是 CSS 计数器画的；超过这个行数就退回不带行号的纯文本，避免上万个 li 拖垮页面。 */
const MAX_NUMBERED_SOURCE_LINES = 5000;

export function sourceLanguageOf(name: string) {
  const extension = fileExtension(name);
  return SOURCE_LANGUAGE_NAMES[extension] || extension.toUpperCase();
}

/** 源文件视图：等宽 + 行号，.java / .sql / .go / .ts 这类都走这里。 */
export function FileSourceView({ text, name }: { text: string; name: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  if (lines.length > MAX_NUMBERED_SOURCE_LINES) return <pre className="delivery-file-preview__text">{text}</pre>;
  return (
    <ol className="delivery-file-source" aria-label={name}>
      {lines.map((line, index) => (
        // 行号靠 CSS 计数器，复制正文时不会把行号一起带走。
        <li key={`${index}-${line}`}><code>{line || " "}</code></li>
      ))}
    </ol>
  );
}

function fileExtension(name: string) {
  const extension = name.trim().split(".").pop();
  return extension?.toLowerCase() ?? "";
}

export function attachmentPreviewKind(attachment: CodexConversationAttachment): AttachmentPreviewKind {
  return filePreviewKind(attachment.name, attachment.contentType, attachment.size, attachment.isImage);
}

/** 只看文件名、类型和大小就能定的预览方式，登记成附件之前也用得上（例如文档栏目里的文件清单）。 */
export function filePreviewKind(
  name: string,
  rawContentType: string,
  size: number,
  isImage = false,
): AttachmentPreviewKind {
  const contentType = (rawContentType || "").toLowerCase().split(";", 1)[0] ?? "";
  const extension = fileExtension(name);
  if (size > MAX_INLINE_PREVIEW_BYTES || OFFICE_EXTENSIONS.has(extension)) return "download";
  if (isImage || contentType.startsWith("image/")) return "image";
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

/** 链接看着像项目里的文件（不是站外地址、锚点）时的工作区相对路径，认不出来给空串。 */
export function workspacePathOfMarkdownLink(href: string) {
  const rawPath = href.trim();
  if (!rawPath || rawPath.startsWith("#") || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return "";
  let path = rawPath.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return "";
  }
  // 回复里的文件链接常带行号（`Foo.kt:42`、`Foo.kt:42:8`），指的还是同一份文件。
  path = path.replace(/(?::\d+){1,2}$/, "");
  const normalized = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) return "";
  return normalized;
}

/** 仅在链接明确指向这条消息已登记的工作区产物时，拦截并打开预览。 */
export function attachmentForMarkdownLink(
  href: string,
  attachments: CodexConversationAttachment[],
) {
  const normalized = workspacePathOfMarkdownLink(href);
  if (!normalized) return null;
  const exact = attachments.find((attachment) => (attachment.relativePath || "").replaceAll("\\", "/") === normalized);
  if (exact) return exact;
  // 回复里的链接常写成绝对路径（`/Users/…/工作区/子目录/Foo.kt`），附件记的是工作区相对路径：
  // 只要链接以某个附件的相对路径收尾，就是同一份文件，命中唯一一条才认。
  const suffix = attachments.filter((attachment) => {
    const relative = (attachment.relativePath || "").replaceAll("\\", "/");
    return Boolean(relative) && normalized.endsWith(`/${relative}`);
  });
  if (suffix.length === 1) return suffix[0];
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

function PreviewBody({
  attachment,
  blobUrl,
  text,
  mode,
}: {
  attachment: CodexConversationAttachment;
  blobUrl: string;
  text: string;
  mode: FilePreviewMode;
}) {
  const kind = attachmentPreviewKind(attachment);
  // 选了「源码」就一律按源文件看，HTML 和 Markdown 都不再渲染。
  if (mode === "source" && supportsPreviewModes(kind)) return <FileSourceView text={text} name={attachment.name} />;
  if (kind === "image") return <img className="delivery-file-preview__image" src={blobUrl} alt={attachment.name} />;
  if (kind === "pdf") return <iframe className="delivery-file-preview__frame" title={attachment.name} src={blobUrl} />;
  if (kind === "video") return <video className="delivery-file-preview__media" controls src={blobUrl} />;
  if (kind === "audio") return <audio className="delivery-file-preview__audio" controls src={blobUrl} />;
  // 走 blob 地址的 iframe：页内锚点、目录跳转都正常，且始终不带 allow-same-origin。
  if (kind === "html") return <DeliveryHtmlFrame className="delivery-file-preview__frame" html={text} title={attachment.name} />;
  if (kind === "markdown") {
    return <div className="delivery-session-markdown is-document"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
  }
  return <FileSourceView text={text} name={attachment.name} />;
}

/**
 * 文件预览弹窗：聊天附件和「本次改动」里的文件都走这一个surface。
 *
 * HTML 和 Markdown 给「效果 / 源码」两种看法，其余源文件（.ts / .go / .sql / .java ...）
 * 直接按带行号的源码显示；图片、PDF、音视频各用各自的组件。
 */
export function SessionFilePreviewModal({
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
  const [revealing, setRevealing] = useState(false);
  const [textLoaded, setTextLoaded] = useState(false);
  const [mode, setMode] = useState<FilePreviewMode>("render");
  const kind = attachment ? attachmentPreviewKind(attachment) : "download";
  const copyable = ["text", "markdown", "html"].includes(kind);
  // 桥接和面板跑在同一台机器上，绝对路径按工作区根目录拼出来即可，不必多跑一次接口。
  const absolutePath = useMemo(
    () => (attachment?.relativePath ? workspaceFileAbsolutePath(programId, attachment.relativePath) : ""),
    [attachment?.relativePath, programId],
  );
  const copyValue = (value: string, successKey: string, failedKey: string) => {
    void copyPreviewText(value)
      .then(() => message.success(t(successKey)))
      .catch(() => message.error(t(failedKey)));
  };
  const metadata = useMemo(
    () => attachment
      ? [attachment.contentType || "-", readableAttachmentSize(attachment.size), sourceLanguageOf(attachment.name)].filter(Boolean)
      : [],
    [attachment],
  );

  // 换一份文件就回到默认看法，别把上一份选的「源码」带过来。
  useEffect(() => setMode("render"), [attachment?.id]);

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
    <Modal
      className="delivery-file-preview-modal"
      wrapClassName="manager-form-skin"
      title={(
        <div className="delivery-file-preview__heading">
          <span className="delivery-file-preview__title">
            <FileOutlined />
            <b title={attachment.name}>{attachment.name}</b>
            <Tooltip title={t("delivery.session.copyFileName")}>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label={t("delivery.session.copyFileName")}
                onClick={() => copyValue(attachment.name, "delivery.session.copyFileNameSuccess", "delivery.session.copyFilePathFailed")}
              />
            </Tooltip>
          </span>
          {/* 产物没登记工作区相对路径时（比如纯上传的附件）就没有本机位置可给，这一行整体不出现。 */}
          {absolutePath ? (
            <div className="delivery-file-preview__path">
              <code className="manager-mono" title={absolutePath}>{absolutePath}</code>
              <Tooltip title={t("delivery.session.copyFilePath")}>
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label={t("delivery.session.copyFilePath")}
                  onClick={() => copyValue(absolutePath, "delivery.session.copyFilePathSuccess", "delivery.session.copyFilePathFailed")}
                />
              </Tooltip>
              <Tooltip title={t("delivery.session.revealFile")}>
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  loading={revealing}
                  aria-label={t("delivery.session.revealFile")}
                  onClick={() => {
                    setRevealing(true);
                    void revealCodexWorkspaceFile(programId, attachment.relativePath)
                      .then(() => message.success(t("delivery.session.revealFileSuccess")))
                      .catch((error) => message.error((error as Error).message))
                      .finally(() => setRevealing(false));
                  }}
                />
              </Tooltip>
            </div>
          ) : null}
        </div>
      )}
      width="min(1100px, calc(100vw - 32px))"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
      centered
    >
      <div className="delivery-file-preview">
        <div className="delivery-file-preview__toolbar">
          <div className="delivery-file-preview__meta">
            {metadata.map((value) => <span key={value}>{value}</span>)}
          </div>
          <div className="delivery-file-preview__actions">
            {supportsPreviewModes(kind) && !failed ? (
              <Segmented
                size="small"
                value={mode}
                onChange={(value) => setMode(value as FilePreviewMode)}
                options={[
                  { value: "render", label: t("delivery.session.filePreviewRendered") },
                  { value: "source", label: t("delivery.session.filePreviewSource") },
                ]}
              />
            ) : null}
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
          </div>
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
            : <div className="delivery-file-preview__body"><PreviewBody attachment={attachment} blobUrl={blobUrl} text={text} mode={mode} /></div>}
      </div>
    </Modal>
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
