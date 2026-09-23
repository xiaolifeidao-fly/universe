"use client";

import { getData, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export class ProgramScope {
  bizLine = "";

  programId = 0;
}

export class UserRecord {
  id = 0;

  username = "";

  displayName = "";

  role: "admin" | "member" = "member";

  persona = "product_research";

  personas: string[] = ["product_research"];

  status: "active" | "disabled" = "active";

  mustChangePassword = false;

  bizLines: string[] = [];

  writableBizLines: string[] = [];

  managedBizLines: string[] = [];

  programs: ProgramScope[] = [];

  managedPrograms: ProgramScope[] = [];

  lastLoginAt?: string;

  updatedAt?: string;

  createdAt?: string;
}

export interface UserQuery {
  pageIndex?: number;
  pageSize?: number;
  keyword?: string;
  role?: "admin" | "member" | "";
  persona?: string;
  status?: "active" | "disabled" | "";
}

export interface SaveUserPayload {
  username: string;
  displayName: string;
  role: "admin" | "member";
  personas: string[];
  status: "active" | "disabled";
  password?: string;
}

export async function fetchUsers(query: UserQuery = {}) {
  return getPage(UserRecord, "/users", {
    pageIndex: query.pageIndex,
    pageSize: query.pageSize,
    keyword: query.keyword,
    role: query.role,
    persona: query.persona,
    status: query.status,
  });
}

export async function fetchUser(id: number) {
  return getData(UserRecord, `/users/${id}`);
}

export async function saveUser(payload: SaveUserPayload, id?: number) {
  const response = await instance.post<ApiResponse<UserRecord>>(id ? `/users/${id}` : "/users", payload);
  return unwrapApiResponse(response.data);
}

export async function resetUserPassword(id: number, password: string) {
  const response = await instance.post<ApiResponse<null>>(`/users/${id}/password`, { password });
  return unwrapApiResponse(response.data);
}

export async function deleteUser(id: number) {
  const response = await instance.post<ApiResponse<null>>(`/users/${id}/delete`);
  return unwrapApiResponse(response.data);
}
