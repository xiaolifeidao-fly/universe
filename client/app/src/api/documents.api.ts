import { request, requestBlob } from "@/api/client";

export const documentCategories = ["chat", "requirement", "design", "test", "prototype", "execution", "attachment"] as const;

export type DocumentCategory = (typeof documentCategories)[number];

/** 云端文档的归属：需求文档跟着需求走，任务文档跟着任务走，认不出归属的算项目级未归类。 */
export type DocumentOwnerKind = "requirement" | "task" | "program";

/** 需求下的阶段，顺序即需求文档的分栏顺序。 */
export const requirementDocumentStages = ["outline", "prototype", "review", "testing", "fine-tuning", "chat"] as const;

/** 任务下的阶段，顺序即任务文档的分栏顺序。 */
export const taskDocumentStages = ["document", "design", "testing", "fine-tuning", "prototype", "execution", "attachment", "chat"] as const;

export type DocumentStage = (typeof requirementDocumentStages)[number] | (typeof taskDocumentStages)[number];

/**
 * 分栏名字按归属分别取：同一个 `testing` 在需求下是「总体测试」，在任务下是「成品测试」，
 * 同一个 `prototype` 在需求下是需求原型，在任务下是这条任务自己产出的页面。
 */
export const requirementStageLabels: Record<(typeof requirementDocumentStages)[number], string> = {
  outline: "需求拆解",
  prototype: "原型",
  review: "评审",
  testing: "测试",
  "fine-tuning": "微调",
  chat: "会话归档",
};

export const taskStageLabels: Record<(typeof taskDocumentStages)[number], string> = {
  document: "需求",
  design: "设计",
  testing: "测试",
  "fine-tuning": "微调",
  prototype: "原型",
  execution: "执行产物",
  attachment: "附件",
  chat: "会话归档",
};

export interface CloudDocument {
  programId: number;
  category: DocumentCategory;
  relativePath: string;
  contentType: string;
  ownerKind: DocumentOwnerKind | "";
  ownerKey: string;
  stage: DocumentStage | "";
  size: number;
  sha256: string;
  updatedAt?: string;
}

/** 文档目录的浏览条件；不传的维度就是不过滤。 */
export interface CloudDocumentFilter {
  category?: DocumentCategory;
  ownerKind?: DocumentOwnerKind;
  ownerKey?: string;
  stage?: DocumentStage;
}

function queryOf(programId: number, filter: CloudDocumentFilter = {}, relativePath?: string) {
  const query = new URLSearchParams({ programId: String(programId) });
  if (filter.category) query.set("category", filter.category);
  if (filter.ownerKind) query.set("ownerKind", filter.ownerKind);
  if (filter.ownerKey) query.set("ownerKey", filter.ownerKey);
  if (filter.stage) query.set("stage", filter.stage);
  if (relativePath) query.set("relativePath", relativePath);
  return query.toString();
}

export function listCloudDocuments(programId: number, filter: CloudDocumentFilter = {}) {
  return request<CloudDocument[]>(`/documents?${queryOf(programId, filter)}`);
}

export function previewCloudDocument(programId: number, file: Pick<CloudDocument, "category" | "relativePath">) {
  return requestBlob(`/documents/preview?${queryOf(programId, { category: file.category }, file.relativePath)}`);
}

export interface DocumentURL {
  url: string;
  expiresAt: string;
}

export function getCloudDocumentURL(programId: number, file: Pick<CloudDocument, "category" | "relativePath">) {
  return request<DocumentURL>(`/documents/url?${queryOf(programId, { category: file.category }, file.relativePath)}`);
}
