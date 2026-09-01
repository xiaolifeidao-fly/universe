import { request, requestBlob } from "@/api/client";

export const documentCategories = ["chat", "requirement", "design", "test", "prototype", "execution", "attachment"] as const;

export type DocumentCategory = (typeof documentCategories)[number];

export interface CloudDocument {
  programId: number;
  category: DocumentCategory;
  relativePath: string;
  contentType: string;
  size: number;
  sha256: string;
  updatedAt?: string;
}

function queryOf(programId: number, category?: DocumentCategory, relativePath?: string) {
  const query = new URLSearchParams({ programId: String(programId) });
  if (category) query.set("category", category);
  if (relativePath) query.set("relativePath", relativePath);
  return query.toString();
}

export function listCloudDocuments(programId: number, category?: DocumentCategory) {
  return request<CloudDocument[]>(`/documents?${queryOf(programId, category)}`);
}

export function previewCloudDocument(programId: number, file: Pick<CloudDocument, "category" | "relativePath">) {
  return requestBlob(`/documents/preview?${queryOf(programId, file.category, file.relativePath)}`);
}

export interface DocumentURL {
  url: string;
  expiresAt: string;
}

export function getCloudDocumentURL(programId: number, file: Pick<CloudDocument, "category" | "relativePath">) {
  return request<DocumentURL>(`/documents/url?${queryOf(programId, file.category, file.relativePath)}`);
}
