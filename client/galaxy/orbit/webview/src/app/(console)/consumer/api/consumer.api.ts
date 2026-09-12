"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 消费者侧接口。密钥列表里没有明文；要明文（「使用」、复制带密钥的命令）单独调 revealKey，
 * 拿到就用、用完就丢，不落进任何存储。
 */

/** claude = 接 Claude Code；codex = 接 Codex；video / other 两个都不对口（other 是范围不限，两个都能接）。 */
export type KeyCategory = "claude" | "codex" | "video" | "other";

export class ConsumerKeyView {
  keyId = "";

  alias = "";

  status = "";

  /** 服务端按范围和来源套餐的模型推出来的类别，「使用」按钮据此决定写哪个客户端。 */
  category: KeyCategory = "other";

  modelId = "";

  /** 平台能不能取回明文。老密钥只存了哈希，要换发一次才行。 */
  revealable = false;

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

  /** 签发那一刻顺带回来的明文。之后在密钥页也能再取，但不要落进任何存储。 */
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

  /**
   * 商品归属（claude / codex / video / other），由服务端从 kind 与模型档推出来。
   * 分栏规则放服务端：两个端各写一份匹配规则的话，同一个额度包会落进不同的栏。
   */
  category = "other";

  units: Record<string, number> = {};

  amount = 0;

  currency = "CNY";

  ttlDays = 30;

  allowedKinds: string[] = [];

  modelTier: string[] = [];

  concurrency = 0;

  rpm = 0;

  /** 绑定的模型，空是通用套餐。分享返现按这个模型的比例算。 */
  modelId = "";
}

export class OrderView {
  orderId = "";

  packageCode = "";

  units: Record<string, number> = {};

  amount = 0;

  currency = "CNY";

  status = "";

  /** points = 积分；channel = 支付渠道（老订单）。 */
  payMethod = "channel";

  modelId = "";

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

export class KeySecretView {
  keyId = "";

  secret = "";

  /** SDK 的 base_url（带 /v1）。服务端没配时是空串。 */
  baseUrl = "";
}

/** 取回密钥明文。只在要用的那一刻调，不缓存。 */
export async function revealKey(keyId: string) {
  const response = await instance.post<ApiResponse<KeySecretView>>("/galaxy/consumer/keys/secret", { keyId });
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

/* ---------- 概览与逐笔扣费 ---------- */

export class DayStats {
  calls = 0;

  failed = 0;

  usage: Record<string, number> = {};

  credits = 0;

  avgDurationMs = 0;
}

export class ConsumerDashboard {
  keys = 0;

  activeKeys = 0;

  balance: Record<string, number> = {};

  today: DayStats = new DayStats();

  /** 微分。折算成元的口径只有服务端一处。 */
  spentMicros = 0;

  days = 10;

  currency = "CNY";

  avgFirstByteMs = 0;
}

/**
 * 一次请求的扣费明细。
 *
 * 和 UsageLine 的区别是粒度：那个回答「这个月花了多少」，这个回答
 * 「14:28 那次为什么扣了 2,288」。申诉钉的是 (unitId, attempt)，
 * 所以逐笔视图必须把 unitId 摆出来。
 */
export class UsageRecord {
  unitId = "";

  keyId = "";

  keyAlias = "";

  kind = "";

  provider = "";

  model = "";

  state = "";

  attempt = 1;

  errorCode = "";

  usage: Record<string, number> = {};

  cost = 0;

  currency = "CNY";

  startedAt?: string;

  finishedAt?: string;

  durationMs = 0;
}

export class UsageRecordPage {
  total = 0;

  records: UsageRecord[] = [];
}

export async function fetchDashboard(days = 10) {
  return getData(ConsumerDashboard, "/galaxy/consumer/dashboard", { days });
}

export async function fetchUsageRecords(params: {
  keyId?: string;
  kind?: string;
  state?: string;
  day?: string;
  offset?: number;
  limit?: number;
}) {
  return getData(UsageRecordPage, "/galaxy/consumer/usage/records", params);
}

/* ---------- 模型广场、积分与分享 ---------- */

/**
 * 1 积分 = ¥1。积分字段和金额一样是「微」（÷1_000_000 得到积分），套餐标价直接就是积分价。
 * 积分只能由平台运营充值；这一端只有看和花。
 */

export class PortalModelView {
  modelId = "";

  displayName = "";

  vendor = "";

  family = "";

  kind = "";

  contextTokens = 0;

  maxOutputTokens = 0;

  /** 每百万 token 的单价，微积分。 */
  inputPrice = 0;

  outputPrice = 0;

  cachePrice = 0;

  currency = "CNY";

  tags: string[] = [];

  summary = "";

  featured = false;

  /** 为假表示这几个单价是按能力统一定的价，不是这个模型单独的价。 */
  priced = false;

  sortOrder = 0;
}

export class ConsumerModelView extends PortalModelView {
  category: KeyCategory = "other";

  /** 被邀请的人买这个模型的套餐时，按实付积分返给邀请人的比例，万分之一。 */
  referralBps = 0;

  packages: PackageView[] = [];
}

export class ConsumerCatalog {
  endpoint = "";

  models: ConsumerModelView[] = [];

  /** 通用套餐：没绑模型的上架套餐。 */
  packages: PackageView[] = [];

  defaultBps = 0;

  updatedAt = "";
}

export class PointsSummary {
  balance = 0;

  recharged = 0;

  spent = 0;

  referral = 0;
}

export type PointsType = "recharge" | "purchase" | "referral";

export class PointsLedgerEntry {
  txnId = "";

  type: PointsType = "recharge";

  amount = 0;

  balanceAfter = 0;

  /** 充值：实付金额（微元）；返现：那笔购买实付的积分。 */
  baseAmount = 0;

  rateBps = 0;

  orderId = "";

  /** 返现流水上被邀请人的用户名，打过码。 */
  relatedName = "";

  modelId = "";

  createdAt = "";
}

export class PointsLedgerPage {
  total = 0;

  entries: PointsLedgerEntry[] = [];
}

export class ReferralRateView {
  modelId = "";

  displayName = "";

  family = "";

  bps = 0;

  inherited = false;
}

export class ReferralOverview {
  inviteCode = "";

  invitees = 0;

  earned = 0;

  defaultBps = 0;

  rates: ReferralRateView[] = [];
}

export class InviteeView {
  name = "";

  joinedAt = "";

  earned = 0;
}

export class InviteePage {
  total = 0;

  invitees: InviteeView[] = [];
}

export async function fetchCatalog() {
  return getData(ConsumerCatalog, "/galaxy/consumer/catalog");
}

export async function fetchPoints() {
  return getData(PointsSummary, "/galaxy/consumer/points");
}

export async function fetchPointsLedger(params: { type?: PointsType | ""; offset?: number; limit?: number }) {
  return getData(PointsLedgerPage, "/galaxy/consumer/points/ledger", { ...params, type: params.type || undefined });
}

/**
 * 用积分买一个套餐。签发新密钥时回来的订单里带着明文（issuedSecret）。
 * requestId 同一单重试时要带同一个：服务端按它只扣一次，重复的那次拿回的是第一次的订单（不带明文）。
 */
export async function purchaseWithPoints(packageCode: string, targetKeyId: string, noticeVersion: string, requestId: string) {
  const response = await instance.post<ApiResponse<OrderView>>("/galaxy/consumer/points/purchase", {
    packageCode,
    targetKeyId,
    noticeVersion,
    requestId,
  });
  return unwrapApiResponse(response.data);
}

export async function fetchReferral() {
  return getData(ReferralOverview, "/galaxy/consumer/referral");
}

export async function fetchInvitees(offset = 0, limit = 20) {
  return getData(InviteePage, "/galaxy/consumer/referral/invitees", { offset, limit });
}
