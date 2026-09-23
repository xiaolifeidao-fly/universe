"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

export class ProgramRecord {
  programId = 0;

  programCode = "";

  bizLine = "";

  name = "";

  summary = "";

  status: "active" | "archived" | string = "active";

  gitEnabled = false;

  gitRepositoryUrl = "";

  updatedBy = "";

  updatedAt?: string;

  canAdminister = false;

  canWrite = false;
}

export interface SaveProgramPayload {
  programCode: string;
  name: string;
  summary: string;
  status: string;
}

export async function fetchPrograms(bizLine: string) {
  return getDataList(ProgramRecord, "/programs", { bizLine });
}

export async function fetchProgram(id: number) {
  return getData(ProgramRecord, `/programs/${id}`);
}

export async function saveProgram(payload: SaveProgramPayload, bizLine: string, id?: number) {
  const url = id ? `/programs/${id}` : "/programs";
  const response = await instance.post<ApiResponse<null>>(url, payload, { params: id ? undefined : { bizLine } });
  return unwrapApiResponse(response.data);
}
