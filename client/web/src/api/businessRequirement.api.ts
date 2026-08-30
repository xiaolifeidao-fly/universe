"use client";

import { getData, getDataList, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";
import { withBizLine } from "@/utils/bizLine";

export class BusinessRequirementRecord {
  id = 0;
  bizLine = "";
  programId = 0;
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

export class BusinessRequirementMessage {
  id = 0;
  role: "user" | "assistant" = "user";
  content = "";
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

export class BusinessRequirementConversation {
  requirement = new BusinessRequirementRecord();
  program = new BusinessProgramContext();
  messages: BusinessRequirementMessage[] = [];
  documents: BusinessRequirementDocument[] = [];
}

export class SendBusinessRequirementMessageResult {
  userMessage = new BusinessRequirementMessage();
  assistantMessage = new BusinessRequirementMessage();
  document = new BusinessRequirementDocument();
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

export async function sendBusinessRequirementMessage(bizLine: string, requirementId: number, content: string) {
  const response = await instance.post<ApiResponse<SendBusinessRequirementMessageResult>>(
    "/business/requirement/messages",
    { requirementId, content },
    { params: withBizLine(bizLine) },
  );
  return unwrapApiResponse(response.data);
}

// Product/research collection is read-only. It is intentionally separate
// from the business user's own workspace APIs above.
export async function fetchCollectedBusinessRequirements(bizLine: string, pageIndex = 1, pageSize = 50) {
  return getPage(BusinessRequirementRecord, "/business/research/requirements", withBizLine(bizLine, { pageIndex, pageSize }));
}

export async function fetchCollectedBusinessRequirementConversation(bizLine: string, requirementId: number) {
  return getData(BusinessRequirementConversation, "/business/research/requirement", withBizLine(bizLine, { requirementId }));
}
