"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 外壳自己的两个接口：当前用户与当前菜单。
 *
 * 都是每次挂载现取，不读 localStorage —— `writable` 和菜单范围决定了页面上
 * 有哪些按钮，存在本地就等于把它交给了能改 localStorage 的人。
 */

export class ManagerRole {
  id = 0;

  code = "";

  name = "";
}

export class CurrentUser {
  userId = "";

  username = "";

  displayName = "";

  status = "";

  mustChangePassword = false;

  roles: ManagerRole[] = [];

  /** 只读开关的唯一来源。任何一个在职角色开了写权限就是 true。 */
  writable = false;

  /** 超级管理员绕过资源过滤，菜单是全量的。 */
  superAdmin = false;

  lastLoginAt = "";
}

/** 资源树是**扁平数组 + parentId**，树在前端拼。 */
export class ResourceItem {
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

export async function fetchCurrentUser() {
  return getData(CurrentUser, "/auth/me");
}

export async function fetchCurrentUserMenus() {
  return getDataList(ResourceItem, "/current-user-menus");
}

export async function changeOwnPassword(payload: { oldPassword: string; newPassword: string }) {
  const response = await instance.post<ApiResponse<string>>("/auth/password", payload);
  return unwrapApiResponse(response.data);
}
