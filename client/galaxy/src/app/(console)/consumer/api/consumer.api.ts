"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/** 消费者侧接口。密钥明文只在签发/换发的响应里出现一次，之后任何接口都查不到。 */

export class ConsumerKeyView {
  keyId = "";

  alias = "";

  status = "";

  allowedKinds: string[] = [];

  allowedProviders: string[] = [];

  modelTier: string[] = [];

  concurrency = 0;

  rpm = 0;

  issuedAt = "";

  expiresAt = "";

  frozenUntil?: string;

  balance: Record<string, number> = {};
}

export class IssuedKeyView {
  keyId = "";

  /** 明文只显示这一次。不要落进任何存储。 */
  secret = "";

  alias = "";

  expiresAt = "";
}

export class NoticeStatus {
  version = "";

  accepted = false;
}

export class PackageView {
  packageCode = "";

  title = "";

  units: Record<string, number> = {};

  amount = 0;

  currency = "CNY";

  ttlDays = 30;

  allowedKinds: string[] = [];

  modelTier: string[] = [];

  concurrency = 0;

  rpm = 0;
}

export class OrderView {
  orderId = "";

  packageCode = "";

  units: Record<string, number> = {};

  amount = 0;

  currency = "CNY";

  status = "";

  targetKeyId = "";

  keyId = "";

  paidAt?: string;

  fulfilledAt?: string;

  createdTime = "";

  issuedSecret = "";
}

/** 收银台上能选的一个支付渠道。 */
export class PaymentChannelView {
  code = "";

  title = "";

  /** 沙箱渠道点一下就算到账，没有真的收钱。界面必须把它标出来。 */
  sandbox = false;
}

export class UsageLine {
  kind = "";

  /** 走的是哪个上游：claude_oauth / codex_chatgpt。单元行不在了就是空串。 */
  provider = "";

  unit = "";

  amount = 0;

  calls = 0;

  unitPrice = 0;

  cost = 0;
}

export class UsageReport {
  from = "";

  to = "";

  lines: UsageLine[] = [];

  totalFee = 0;

  currency = "CNY";
}

/** SDK 要填的 base_url。由服务端给（配置在 galaxy.instance / galaxy.consumer_base_url），前端不再自己拼。 */
export class ConsumerEndpoint {
  baseUrl = "";
}

export async function fetchConsumerEndpoint() {
  return getData(ConsumerEndpoint, "/galaxy/consumer/endpoint");
}

export async function fetchNotice() {
  return getData(NoticeStatus, "/galaxy/consumer/notice");
}

export async function acceptNotice() {
  const response = await instance.post<ApiResponse<string>>("/galaxy/consumer/notice/accept", {});
  return unwrapApiResponse(response.data);
}

export async function fetchKeys() {
  return getDataList(ConsumerKeyView, "/galaxy/consumer/keys");
}

export async function revokeKey(keyId: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/consumer/keys/revoke", { keyId });
  return unwrapApiResponse(response.data);
}

export async function renewKey(keyId: string, ttlDays?: number) {
  const response = await instance.post<ApiResponse<IssuedKeyView>>("/galaxy/consumer/keys/renew", { keyId, ttlDays });
  return unwrapApiResponse(response.data);
}

export async function fetchPackages() {
  return getDataList(PackageView, "/galaxy/consumer/packages");
}

export async function createOrder(packageCode: string, targetKeyId: string, noticeVersion: string) {
  const response = await instance.post<ApiResponse<OrderView>>("/galaxy/consumer/orders", {
    packageCode,
    targetKeyId,
    noticeVersion,
  });
  return unwrapApiResponse(response.data);
}

export async function fetchOrders(limit = 50) {
  return getDataList(OrderView, "/galaxy/consumer/orders", { limit });
}

export async function cancelOrder(orderId: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/consumer/orders/cancel", { orderId });
  return unwrapApiResponse(response.data);
}

export async function fetchPaymentChannels() {
  return getDataList(PaymentChannelView, "/galaxy/consumer/payments/channels");
}

/**
 * 沙箱支付。真渠道的到账走渠道回调，不经过这里 ——
 * 服务端只认配置里显式标成沙箱的渠道，而且只让本人付自己的订单。
 */
export async function paySandbox(orderId: string, channel: string) {
  const response = await instance.post<ApiResponse<OrderView>>("/galaxy/consumer/orders/pay/sandbox", {
    orderId,
    channel,
  });
  return unwrapApiResponse(response.data);
}

export async function fetchUsage(params: { keyId?: string; kind?: string; from?: string; to?: string }) {
  return getData(UsageReport, "/galaxy/consumer/usage", params);
}

/* ---------- 会话与任务（控制台只读） ---------- */

/**
 * 这一组走 `/galaxy/consumer/*` 而不是 `/v1/*`：`/v1/*` 认的是 `sk-` 算力密钥，
 * 而密钥明文只在签发那一次出现，控制台手里没有、也不该有。服务端按令牌解析出
 * 「这个人名下的密钥集合」再过滤，请求里的 keyId 只能在这个集合内收窄。
 */

export class SessionView {
  sid = "";

  keyId = "";

  kind = "";

  kindVersion = 0;

  provider = "";

  space = "";

  programRef = "";

  state = "";

  lastSeq = 0;

  workspaceRef: Record<string, unknown> = {};

  createdTime = "";

  lastTurnAt?: string;

  closeReason = "";

  /** 换过节点。执行层上下文是重建出来的，不是原样接着跑的。 */
  migrated = false;
}

export class TurnView {
  sid = "";

  seq = 0;

  unitId = "";

  state = "";

  outputSummary = "";

  toolCalls: Record<string, unknown>[] = [];

  changedFiles: string[] = [];

  artifacts: Record<string, unknown>[] = [];

  usage: Record<string, number> = {};

  externalThreadId = "";

  /** 工作区没了。续接靠的是账本摘要而不是原样的执行现场。 */
  workspaceLost = false;

  startedAt = "";

  endedAt?: string;
}

export class SessionContextView {
  session: SessionView = new SessionView();

  turns: TurnView[] = [];
}

export class JobProgress {
  pct = 0;

  stage = "";
}

export class ArtifactRef {
  store = "";

  key = "";

  size = 0;

  sha256 = "";

  contentType = "";

  expiresAt = "";

  /** presigned 地址，只在这一次响应里有效，不要缓存。 */
  url = "";
}

export class JobView {
  jobId = "";

  keyId = "";

  kind = "";

  state = "";

  attempt = 0;

  progress?: JobProgress;

  outputs: ArtifactRef[] = [];

  usage: Record<string, number> = {};

  errorCode = "";

  errorMessage = "";

  createdTime = "";

  startedAt?: string;

  finishedAt?: string;
}

export class UnitEventView {
  seq = 0;

  kind = "";

  data: unknown = null;

  at = "";
}

export async function fetchSessions(params: { keyId?: string; kind?: string; state?: string; limit?: number }) {
  return getDataList(SessionView, "/galaxy/consumer/sessions", params);
}

export async function fetchSessionContext(sid: string, fromSeq = 0) {
  return getData(SessionContextView, `/galaxy/consumer/sessions/${encodeURIComponent(sid)}/context`, { fromSeq });
}

export async function closeSession(sid: string, reason?: string) {
  const response = await instance.post<ApiResponse<string>>(
    `/galaxy/consumer/sessions/${encodeURIComponent(sid)}/close`,
    {},
    { params: { reason } },
  );
  return unwrapApiResponse(response.data);
}

export async function fetchJobs(params: { keyId?: string; kind?: string; limit?: number }) {
  return getDataList(JobView, "/galaxy/consumer/jobs", params);
}

export async function fetchJobEvents(jobId: string, fromSeq = 0) {
  return getDataList(UnitEventView, `/galaxy/consumer/jobs/${encodeURIComponent(jobId)}/events`, { fromSeq });
}

export async function cancelJob(jobId: string) {
  const response = await instance.post<ApiResponse<string>>(
    `/galaxy/consumer/jobs/${encodeURIComponent(jobId)}/cancel`,
    {},
  );
  return unwrapApiResponse(response.data);
}

/* ---------- 争议工单 ---------- */

/**
 * 消费者和提供者互相看不见对方，出了问题两边没法自己谈 —— 平台是唯一同时握着
 * 单元、计量和两本账的一方，所以争议只有「建单 → 平台裁决」这一条路。
 */

/** 理由是封闭集合。开放自由文本就没法按类型统计，也判断不出「这个提供者被投诉的都是伪造」。 */
export const DISPUTE_REASONS = ["not_delivered", "wrong_output", "overcharged", "forged", "other"] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export class DisputeView {
  disputeId = "";

  unitId = "";

  attempt = 0;

  kind = "";

  keyId = "";

  /** 执行这单的贡献。对消费者来说只是个不透明的串，看不出对面是谁。 */
  cid = "";

  reason = "";

  detail = "";

  status = "";

  resolution = "";

  refund: Record<string, number> = {};

  clawbackAmount = 0;

  handledBy = "";

  handledAt?: string;

  createdTime = "";

  updatedTime = "";
}

export async function fetchDisputes(limit = 50) {
  return getDataList(DisputeView, "/galaxy/consumer/disputes", { limit });
}

export async function fileDispute(payload: { unitId: string; reason: DisputeReason; detail?: string }) {
  const response = await instance.post<ApiResponse<DisputeView>>("/galaxy/consumer/disputes", payload);
  return unwrapApiResponse(response.data);
}

export async function withdrawDispute(disputeId: string) {
  const response = await instance.post<ApiResponse<string>>(
    `/galaxy/consumer/disputes/${encodeURIComponent(disputeId)}/withdraw`,
    {},
  );
  return unwrapApiResponse(response.data);
}
