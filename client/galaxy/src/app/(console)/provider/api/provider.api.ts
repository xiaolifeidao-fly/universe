"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 提供者侧接口。响应模型一律用 class 且字段带默认值 —— class-transformer 的
 * plainToInstance 要有真实的类和已初始化字段才能反序列化。
 */

export class QuotaStatus {
  unit = "";

  limit = 0;

  used = 0;

  reserved = 0;

  left = 0;

  window = "";

  windowKey = "";

  ratio = 0;

  warned = false;
}

export class ScheduleWindow {
  from = "";

  to = "";

  tz = "";
}

export class ContributionView {
  cid = "";

  nodeId = "";

  kind = "";

  kindVersion = 1;

  provider = "";

  modelsAllow: string[] = [];

  modelsDeny: string[] = [];

  seats = 0;

  seatConcurrency = 0;

  status = "";

  reputation = 1;

  online = false;

  seatsUsed = 0;

  seatsEffective = 0;

  inflight = 0;

  quota: QuotaStatus[] = [];

  schedule: ScheduleWindow[] = [];

  throttledUntil?: string;
}

export class NodeView {
  nodeId = "";

  displayName = "";

  bridgeVersion = "";

  status = "";

  banned = false;

  lastBeatAt?: string;

  contributions: ContributionView[] = [];
}

export class TermsStatus {
  version = "";

  accepted = false;
}

export class PairingCode {
  code = "";

  expiresAt = "";
}

export class ExecutionRecord {
  unitId = "";

  kind = "";

  model = "";

  state = "";

  errorCode = "";

  usage: Record<string, number> = {};

  startedAt?: string;

  finishedAt?: string;
}

export class CreditBalance {
  balance = 0;
}

export interface QuotaGrantInput {
  unit: string;
  limit: number;
  window: string;
  resetAt?: string;
}

export interface SaveLimitsPayload {
  cid: string;
  modelsAllow: string[];
  modelsDeny: string[];
  seats: number;
  seatConcurrency: number;
  quota: QuotaGrantInput[];
  schedule: ScheduleWindow[];
}

export async function fetchTerms() {
  return getData(TermsStatus, "/galaxy/provider/terms");
}

export async function acceptTerms() {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/terms/accept", {});
  return unwrapApiResponse(response.data);
}

export async function issuePairingCode() {
  const response = await instance.post<ApiResponse<PairingCode>>("/galaxy/provider/pairing-code", {});
  return unwrapApiResponse(response.data);
}

export async function fetchNodes() {
  return getDataList(NodeView, "/galaxy/provider/nodes");
}

export async function revokeNode(nodeId: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/node/revoke", { nodeId });
  return unwrapApiResponse(response.data);
}

export async function setContributionStatus(cid: string, status: "active" | "paused" | "disabled") {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/contribution/status", { cid, status });
  return unwrapApiResponse(response.data);
}

export async function saveContributionLimits(payload: SaveLimitsPayload) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/contribution/limits", payload);
  return unwrapApiResponse(response.data);
}

export async function fetchRecords(cid: string, limit = 100) {
  return getDataList(ExecutionRecord, "/galaxy/provider/records", cid ? { cid, limit } : { limit });
}

export async function fetchCredits() {
  return getData(CreditBalance, "/galaxy/provider/credits");
}
