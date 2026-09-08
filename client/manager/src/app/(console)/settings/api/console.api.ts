"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 管理端自己的账号与权限。
 *
 * 注意和 `/users` 那一组区分：那个管的是**业务用户**（web 控制台和 App 的账号），
 * 这个管的是**登录管理端的人**。两套账号刻意分开，互不能登录对方。
 */

export class ManagerRoleRef {
  id = 0;

  code = "";

  name = "";
}

export class AccountRecord {
  userId = "";

  username = "";

  displayName = "";

  status = "";

  mustChangePassword = false;

  remark = "";

  roles: ManagerRoleRef[] = [];

  lastLoginAt = "";

  createdTime = "";
}

export class AccountPage {
  list: AccountRecord[] = [];

  total = 0;
}

export class RoleRecord {
  id = 0;

  code = "";

  name = "";

  /** 关掉之后这个角色的一切写操作都会被拒，不必逐条撤销它的写资源。 */
  writable = false;

  status = "";

  remark = "";

  userCount = 0;

  createdTime = "";
}

export class ResourceRecord {
  id = 0;

  parentId = 0;

  code = "";

  name = "";

  resourceType = "";

  method = "";

  resourceUrl = "";

  pageUrl = "";

  icon = "";

  sortId = 0;

  status = "";
}

export interface SaveAccountPayload {
  userId?: string;
  username: string;
  displayName?: string;
  password?: string;
  status?: string;
  remark?: string;
  roleIds: number[];
}

export async function fetchAccounts(params: { keyword?: string; status?: string; pageIndex?: number; pageSize?: number }) {
  return getData(AccountPage, "/manager/accounts", params);
}

export async function saveAccount(payload: SaveAccountPayload) {
  const response = await instance.post<ApiResponse<AccountRecord>>("/manager/accounts", payload);
  return unwrapApiResponse(response.data);
}

export async function resetAccountPassword(userId: string, password: string) {
  const response = await instance.post<ApiResponse<string>>(
    `/manager/accounts/${encodeURIComponent(userId)}/password`,
    { userId, password },
  );
  return unwrapApiResponse(response.data);
}

export async function setAccountStatus(userId: string, status: string) {
  const response = await instance.post<ApiResponse<string>>(
    `/manager/accounts/${encodeURIComponent(userId)}/status`,
    { status },
  );
  return unwrapApiResponse(response.data);
}

export async function deleteAccount(userId: string) {
  const response = await instance.post<ApiResponse<string>>(
    `/manager/accounts/${encodeURIComponent(userId)}/delete`,
    {},
  );
  return unwrapApiResponse(response.data);
}

export async function fetchRoles() {
  return getDataList(RoleRecord, "/manager/roles");
}

export async function saveRole(payload: {
  id?: number;
  code: string;
  name: string;
  writable: boolean;
  status?: string;
  remark?: string;
}) {
  const response = await instance.post<ApiResponse<RoleRecord>>("/manager/roles", payload);
  return unwrapApiResponse(response.data);
}

export async function deleteRole(id: number) {
  const response = await instance.post<ApiResponse<number>>(`/manager/roles/${id}/delete`, {});
  return unwrapApiResponse(response.data);
}

export async function fetchRoleResourceIds(roleId: number) {
  const response = await instance.get<ApiResponse<number[]>>(`/manager/roles/${roleId}/resources`);
  return unwrapApiResponse(response.data) ?? [];
}

export async function saveRoleResources(roleId: number, resourceIds: number[]) {
  const response = await instance.post<ApiResponse<number>>(`/manager/roles/${roleId}/resources`, {
    roleId,
    resourceIds,
  });
  return unwrapApiResponse(response.data);
}

export async function fetchResources(resourceType?: string) {
  return getDataList(ResourceRecord, "/manager/resources", resourceType ? { resourceType } : undefined);
}
