import { request, requestBlob, upload } from "@/api/client";

export interface BusinessProgram {
  programId: number;
  bizLine: string;
  programCode: string;
  name: string;
  summary: string;
}

export interface BusinessRequirement {
  id: number;
  bizLine: string;
  programId: number;
  programName: string;
  programCode: string;
  title: string;
  detail: string;
  status: string;
  createdBy: string;
  createdByName: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BusinessAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isImage: boolean;
  createdAt: string | null;
}

export interface BusinessMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  attachments: BusinessAttachment[];
  createdAt: string | null;
}

/** @ 候选：同项目其它访谈沉淀下来的整理文档，只给名字，正文由服务端在发送时解析。 */
export interface BusinessDocumentReference {
  documentId: number;
  requirementId: number;
  requirementTitle: string;
  title: string;
  version: number;
  createdAt: string | null;
}

export interface BusinessDocument {
  id: number;
  type: string;
  title: string;
  content: string;
  version: number;
  confirmed: boolean;
  createdAt: string | null;
}

export interface BusinessActivity {
  id: string;
  type: string;
  text: string;
  action: string;
  target: string;
  status: string;
  phase: string;
}

export interface BusinessConversation {
  requirement: BusinessRequirement;
  program: BusinessProgram;
  messages: BusinessMessage[];
  documents: BusinessDocument[];
  active: boolean;
  threadId: string;
  turnId: string;
  streamingReply: string;
  streamingActivities: BusinessActivity[];
  remoteError: string;
}

export interface BusinessSendMessageResult {
  userMessage: BusinessMessage;
  threadId: string;
  turnId: string;
  active: boolean;
}

export interface BusinessRequirementPage {
  total: number;
  data: BusinessRequirement[];
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function listBusinessPrograms(bizLine: string) {
  return request<BusinessProgram[]>(`/business/programs${query({ bizLine })}`);
}

export function listBusinessRequirements(bizLine: string, pageSize = 100) {
  return request<BusinessRequirementPage>(`/business/requirements${query({ bizLine, pageIndex: 1, pageSize })}`);
}

export function createBusinessRequirement(programId: number) {
  return request<BusinessRequirement>("/business/requirements", { method: "POST", body: { programId } });
}

export function getBusinessConversation(bizLine: string, requirementId: number) {
  return request<BusinessConversation>(`/business/requirement${query({ bizLine, requirementId })}`);
}

/**
 * 一轮业务访谈的动作。statement 是业务方自己说话；document 是点了「确认文档」，
 * 由服务端换一套提示词让 AI 停止追问、直接把已经聊到的内容写成完整文档。
 */
export type BusinessConversationMode = "statement" | "document";

export function sendBusinessMessage(
  bizLine: string,
  requirementId: number,
  content: string,
  attachmentIds: string[] = [],
  referenceDocumentIds: number[] = [],
  mode: BusinessConversationMode = "statement",
) {
  return request<BusinessSendMessageResult>(
    `/business/requirement/messages${query({ bizLine })}`,
    { method: "POST", body: { requirementId, content, attachmentIds, referenceDocumentIds, mode } },
  );
}

/** @ 面板的候选文档。keyword 为空时给最近的一批，输入后由服务端按标题过滤。 */
export function listBusinessDocumentReferences(bizLine: string, requirementId: number, keyword = "") {
  return request<BusinessDocumentReference[]>(
    `/business/requirement/references${query({ bizLine, requirementId, keyword })}`,
  );
}

export function uploadBusinessAttachments(bizLine: string, requirementId: number, files: File[]) {
  const form = new FormData();
  form.append("requirementId", String(requirementId));
  files.forEach((file) => form.append("files", file, file.name));
  return upload<BusinessAttachment[]>(`/business/requirement/attachments${query({ bizLine })}`, form);
}

export function getBusinessAttachment(bizLine: string, requirementId: number, attachmentId: string) {
  return requestBlob(`/business/requirement/attachment${query({ bizLine, requirementId, attachmentId })}`);
}

export function listCollectedBusinessRequirements(bizLine: string, pageSize = 100) {
  return request<BusinessRequirementPage>(`/business/research/requirements${query({ bizLine, pageIndex: 1, pageSize })}`);
}

export function getCollectedBusinessConversation(bizLine: string, requirementId: number) {
  return request<BusinessConversation>(`/business/research/requirement${query({ bizLine, requirementId })}`);
}
