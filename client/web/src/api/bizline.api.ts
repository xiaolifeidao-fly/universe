"use client";

import { plainToInstance } from "class-transformer";
import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export class BizLineRecord {
	code = "";

	name = "";

	description = "";

	enabled = true;

	/** 置否后除本空间管理员外任何人都看不到这个空间，成员也不例外。 */
	visible = true;

	/** 建这个空间的人。创建者不能被移出空间，成员面板据此隐掉那一行的剔除入口。 */
	createdBy = 0;

	/** 当前登录用户对这条业务线的权限，由服务端按调用者身份返回。 */
	canManage = false;

	canWrite = false;
}

export type BizLinePermission = "read" | "write" | "manager";

export class BizLineMemberRecord {
	id = 0;

	username = "";

	displayName = "";

	isManager = false;

	canWrite = false;

	permission: BizLinePermission = "read";

	joinedAt?: string;
}

export class BizLineShareLink {
	token = "";

	bizLine = "";

	permission: Exclude<BizLinePermission, "manager"> = "read";

	expiresAt = "";
}

export class BizLineShareTarget {
	bizLine = "";

	name = "";

	description = "";

	permission: Exclude<BizLinePermission, "manager"> = "read";

	expiresAt = "";

	joined = false;
}

export async function fetchBizLines() {
	return getDataList(BizLineRecord, "/bizline/lines");
}

export interface SaveBizLinePayload {
	code: string;
	name: string;
	description: string;
	enabled: boolean;
	visible: boolean;
}

export async function fetchAllBizLines() {
	return getDataList(BizLineRecord, "/bizline/lines/all");
}

export async function saveBizLine(payload: SaveBizLinePayload) {
	const response = await instance.post<ApiResponse<null>>("/bizline/line/save", payload);
	return unwrapApiResponse(response.data);
}

export async function deleteBizLine(code: string) {
	const response = await instance.post<ApiResponse<null>>("/bizline/line/delete", { code });
	return unwrapApiResponse(response.data);
}

/**
 * 空间成员名单。项目成员的候选也走这个接口：项目成员只能从所属空间的成员里挑。
 */
export async function fetchBizLineMembers(bizLine: string) {
	return getDataList(BizLineMemberRecord, "/bizline/line/members", { bizLine });
}

/**
 * 调整成员在空间里的角色。管理员一档由空间管理员授予，服务端会挡住降级最后一个管理员。
 */
export async function saveBizLineMemberPermission(bizLine: string, userId: number, permission: BizLinePermission) {
	const response = await instance.post<ApiResponse<null>>("/bizline/line/member/permission", {
		bizLine,
		userId,
		canWrite: permission !== "read",
		asManager: permission === "manager",
	});
	return unwrapApiResponse(response.data);
}

export async function removeBizLineMember(bizLine: string, userId: number) {
	const response = await instance.post<ApiResponse<null>>("/bizline/line/member/remove", { bizLine, userId });
	return unwrapApiResponse(response.data);
}

export async function createBizLineShareLink(bizLine: string, permission: "read" | "write", ttlMinutes: number) {
	const response = await instance.post<ApiResponse<BizLineShareLink>>("/bizline/line/share", { bizLine, permission, ttlMinutes });
	return plainToInstance(BizLineShareLink, unwrapApiResponse(response.data));
}

export async function fetchBizLineShareTarget(token: string) {
	return getData(BizLineShareTarget, "/bizline/share", { token });
}

export async function joinBizLineByShareLink(token: string) {
	const response = await instance.post<ApiResponse<null>>("/bizline/share/join", { token });
	return unwrapApiResponse(response.data);
}
