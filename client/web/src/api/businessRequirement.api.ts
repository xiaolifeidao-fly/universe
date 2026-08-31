"use client";

import { getData, getDataList, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import { withBizLine } from "@/utils/bizLine";

export class BusinessRequirementRecord {
  id = 0;
  bizLine = "";
  programId = 0;
  /** 服务端按业务线一次性解析出的项目名与编码，列表不必再显示裸的 #ID。 */
  programName = "";
  programCode = "";
  title = "";
  detail = "";
  status = "submitted";
  createdBy = "";
  createdByName = "";
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateBusinessRequirementPayload {
  programId: number;
}

export class BusinessProgramContext {
  programId = 0;
  bizLine = "";
  programCode = "";
  name = "";
  summary = "";
}

/** 业务方随消息发出的图片或文档。文件本体在远端业务工作目录，这里只有清单。 */
export class BusinessRequirementAttachment {
  id = "";
  name = "";
  contentType = "";
  size = 0;
  isImage = false;
  createdAt?: string;
}

export class BusinessRequirementMessage {
  id = 0;
  role: "user" | "assistant" = "user";
  content = "";
  attachments: BusinessRequirementAttachment[] = [];
  createdAt?: string;
}

/** @ 候选：本项目其它访谈已经沉淀下来的整理文档，只给名字，正文在发送时由服务端解析。 */
export class BusinessDocumentReference {
	documentId = 0;
	requirementId = 0;
	requirementTitle = "";
	title = "";
	version = 0;
	createdAt?: string;
}

export class BusinessRequirementDocument {
  id = 0;
  type = "ai_intake";
  title = "";
  content = "";
  version = 0;
  createdAt?: string;
}

/** 一条运行中的远端访谈过程：推理摘要、执行的命令、读写的文件。只用于展示，不落库。 */
export class BusinessRequirementActivity {
	id = "";
	type = "";
	text = "";
	action = "";
	target = "";
	status = "";
	phase = "";
}

export class BusinessRequirementConversation {
	requirement = new BusinessRequirementRecord();
	program = new BusinessProgramContext();
	messages: BusinessRequirementMessage[] = [];
	documents: BusinessRequirementDocument[] = [];
	active = false;
	threadId = "";
	turnId = "";
	streamingReply = "";
	streamingActivities: BusinessRequirementActivity[] = [];
	remoteError = "";
}

export class SendBusinessRequirementMessageResult {
	userMessage = new BusinessRequirementMessage();
	threadId = "";
	turnId = "";
	active = false;
}

export async function fetchBusinessPrograms(bizLine: string) {
  return getDataList(BusinessProgramContext, "/business/programs", withBizLine(bizLine));
}

export async function fetchBusinessRequirements(bizLine: string, pageIndex = 1, pageSize = 50) {
  return getPage(BusinessRequirementRecord, "/business/requirements", withBizLine(bizLine, { pageIndex, pageSize }));
}

export async function createBusinessRequirement(payload: CreateBusinessRequirementPayload) {
  const response = await instance.post<ApiResponse<BusinessRequirementRecord>>("/business/requirements", payload);
  return unwrapApiResponse(response.data);
}

export async function fetchBusinessRequirementConversation(bizLine: string, requirementId: number) {
  return getData(BusinessRequirementConversation, "/business/requirement", withBizLine(bizLine, { requirementId }));
}

export async function sendBusinessRequirementMessage(
  bizLine: string,
  requirementId: number,
  content: string,
  attachmentIds: string[] = [],
  referenceDocumentIds: number[] = [],
) {
  const response = await instance.post<ApiResponse<SendBusinessRequirementMessageResult>>(
    "/business/requirement/messages",
    { requirementId, content, attachmentIds, referenceDocumentIds },
    { params: withBizLine(bizLine) },
  );
  return unwrapApiResponse(response.data);
}

/** @ 面板的候选文档。keyword 为空时给最近的一批，输入后由服务端按标题过滤。 */
export async function fetchBusinessDocumentReferences(bizLine: string, requirementId: number, keyword = "") {
  return getDataList(
    BusinessDocumentReference,
    "/business/requirement/references",
    withBizLine(bizLine, { requirementId, keyword }),
  );
}

/** 先上传、再随消息发出：和交付会话一样，附件在发送前就已经落到远端工作目录。 */
export async function uploadBusinessRequirementAttachments(bizLine: string, requirementId: number, files: File[]) {
  const form = new FormData();
  form.append("requirementId", String(requirementId));
  files.forEach((file) => form.append("files", file, file.name));
  const response = await instance.post<ApiResponse<BusinessRequirementAttachment[]>>(
    "/business/requirement/attachments",
    form,
    { params: withBizLine(bizLine), timeout: 120000 },
  );
  return unwrapApiResponse(response.data) ?? [];
}

/** 附件内容经由本系统读回，浏览器不直接访问远端 Kodes。 */
export async function fetchBusinessRequirementAttachment(bizLine: string, requirementId: number, attachmentId: string) {
  const response = await instance.get<Blob>("/business/requirement/attachment", {
    params: withBizLine(bizLine, { requirementId, attachmentId }),
    responseType: "blob",
    timeout: 60000,
  });
  return response.data;
}

// Product/research collection is read-only. It is intentionally separate
// from the business user's own workspace APIs above.
export async function fetchCollectedBusinessRequirements(bizLine: string, pageIndex = 1, pageSize = 50) {
  return getPage(BusinessRequirementRecord, "/business/research/requirements", withBizLine(bizLine, { pageIndex, pageSize }));
}

export async function fetchCollectedBusinessRequirementConversation(bizLine: string, requirementId: number) {
  return getData(BusinessRequirementConversation, "/business/research/requirement", withBizLine(bizLine, { requirementId }));
}
