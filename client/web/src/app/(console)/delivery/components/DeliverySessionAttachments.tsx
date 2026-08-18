"use client";

import { FileOutlined, LoadingOutlined, PictureOutlined } from "@ant-design/icons";
import { message } from "antd";
import { useEffect, useState } from "react";
import { fetchCodexConversationAttachment, type CodexConversationAttachment } from "@/api/delivery.api";

/**
 * 会话消息里的图片与文件。任务会话和需求拆解会话共用这一份 ——
 * 附件在桥接层是同一套仓库，前端没有理由维护两份渲染。
 */
interface SessionAttachmentProps {
  attachment: CodexConversationAttachment;
  programId: number;
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

function ConversationImage({ attachment, programId }: SessionAttachmentProps) {
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
    <button className="delivery-session-attachment is-image" type="button" onClick={() => void downloadConversationAttachment(programId, attachment)}>
      {previewUrl ? <img src={previewUrl} alt={attachment.name} /> : (
        <span className="delivery-session-attachment__image-loading">
          {failed ? <PictureOutlined /> : <LoadingOutlined spin />}
        </span>
      )}
      <span>{attachment.name}</span>
    </button>
  );
}

function ConversationDownload({ attachment, programId }: SessionAttachmentProps) {
  const [downloading, setDownloading] = useState(false);

  return (
    <button
      className="delivery-session-attachment"
      type="button"
      disabled={downloading}
      onClick={() => {
        setDownloading(true);
        void downloadConversationAttachment(programId, attachment)
          .catch((error) => message.error((error as Error).message))
          .finally(() => setDownloading(false));
      }}
    >
      <FileOutlined /><span>{attachment.name}</span>
    </button>
  );
}

export function SessionAttachments({
  attachments,
  programId,
}: {
  attachments: CodexConversationAttachment[];
  programId: number;
}) {
  if (!attachments.length) return null;
  return (
    <div className="delivery-session-attachments">
      {attachments.map((attachment) => (attachment.isImage ? (
        <ConversationImage attachment={attachment} programId={programId} key={attachment.id} />
      ) : (
        <ConversationDownload attachment={attachment} programId={programId} key={attachment.id} />
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
