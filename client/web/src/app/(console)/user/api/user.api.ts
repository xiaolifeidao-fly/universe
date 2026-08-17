"use client";

import { getData, getDataList, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export class ProgramScope {
  bizLine = "";

  programId = 0;
}

export class UserRecord {
  id = 0;

  username = "";

  displayName = "";

  role: "admin" | "member" = "member";

  status: "active" | "disabled" = "active";

  mustChangePassword = false;

  bizLines: string[] = [];

  programs: ProgramScope[] = [];

  lastLoginAt?: string;

  updatedAt?: string;

  createdAt?: string;
}

export class BizLineOption {
  code = "";

  name = "";

  enabled = true;
}

export class ProgramOption {
  programId = 0;

  bizLine = "";

  name = "";
}

export interface UserQuery {
  pageIndex?: number;
  pageSize?: number;
  keyword?: string;
  role?: "admin" | "member" | "";
  status?: "active" | "disabled" | "";
}

export interface SaveUserPayload {
  username: string;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  password?: string;
  bizLines: string[];
  programs: ProgramScope[];
}

export async function fetchUsers(query: UserQuery = {}) {
  return getPage(UserRecord, "/system/users", {
    pageIndex: query.pageIndex,
    pageSize: query.pageSize,
    keyword: query.keyword,
    role: query.role,
    status: query.status,
  });
}

export async function fetchUser(id: number) {
  return getData(UserRecord, `/system/users/${id}`);
}

export async function fetchBizLineOptions() {
  return getDataList(BizLineOption, "/bizline/lines/all");
}

export async function fetchProgramOptions(bizLine: string) {
  return getDataList(ProgramOption, "/delivery/programs", { bizLine });
}

export async function saveUser(payload: SaveUserPayload, id?: number) {
  const response = await instance.post<ApiResponse<UserRecord>>(id ? `/system/users/${id}` : "/system/users", payload);
  return unwrapApiResponse(response.data);
}

export async function resetUserPassword(id: number, password: string) {
  const response = await instance.post<ApiResponse<null>>(`/system/users/${id}/password`, { password });
  return unwrapApiResponse(response.data);
}

export async function deleteUser(id: number) {
  const response = await instance.post<ApiResponse<null>>(`/system/users/${id}/delete`);
  return unwrapApiResponse(response.data);
}
