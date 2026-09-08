"use client";

import { getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export class BizLineRecord {
  code = "";

  name = "";

  description = "";

  enabled = true;

  visible = true;

  createdBy = 0;

  canManage = false;

  canWrite = false;
}

export class BizLineMemberRecord {
  id = 0;

  username = "";

  displayName = "";

  isManager = false;

  canWrite = false;

  permission = "";

  joinedAt?: string;
}

export interface SaveBizLinePayload {
  code: string;
  name: string;
  description: string;
  enabled: boolean;
  visible: boolean;
}

export async function fetchBizLines() {
  return getDataList(BizLineRecord, "/bizlines");
}

export async function saveBizLine(payload: SaveBizLinePayload) {
  const response = await instance.post<ApiResponse<null>>("/bizlines", payload);
  return unwrapApiResponse(response.data);
}

export async function deleteBizLine(code: string) {
  const response = await instance.post<ApiResponse<null>>("/bizlines/delete", { code });
  return unwrapApiResponse(response.data);
}

export async function fetchBizLineMembers(code: string) {
  return getDataList(BizLineMemberRecord, "/bizlines/members", { code });
}

export async function saveBizLineMemberPermission(bizLine: string, userId: number, canWrite: boolean, asManager: boolean) {
  const response = await instance.post<ApiResponse<null>>("/bizlines/member/permission", { bizLine, userId, canWrite, asManager });
  return unwrapApiResponse(response.data);
}

export async function removeBizLineMember(bizLine: string, userId: number) {
  const response = await instance.post<ApiResponse<null>>("/bizlines/member/remove", { bizLine, userId });
  return unwrapApiResponse(response.data);
}
