"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export class BizLineRecord {
	code = "";

	name = "";

	enabled = true;
}

export class BizLineAssignment {
	userIds: number[] = [];

	managerIds: number[] = [];
}

export async function fetchBizLines() {
	return getDataList(BizLineRecord, "/bizline/lines");
}

export interface SaveBizLinePayload {
	code: string;
	name: string;
	enabled: boolean;
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

export async function fetchBizLineAssignment(bizLine: string) {
	return getData(BizLineAssignment, "/bizline/line/assignment", { bizLine });
}

export async function saveBizLineAssignment(bizLine: string, assignment: BizLineAssignment) {
	const response = await instance.post<ApiResponse<null>>("/bizline/line/assignment", { bizLine, ...assignment });
	return unwrapApiResponse(response.data);
}
