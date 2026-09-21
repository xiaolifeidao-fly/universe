"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 消费者侧接口。密钥列表里没有明文；要明文（「使用」、复制带密钥的命令）单独调 revealKey，
 * 拿到就用、用完就丢，不落进任何存储。
 *
 * 这一端**不卖任何东西**：额度就是账户里的积分余额，由运营充进来，调模型时按单价逐笔扣。
 * 所以没有商品、没有订单、没有支付 —— 密钥只是一串能访问模型的凭证，随手新建、随手作废。
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

export class UsageLine {
  kind = "";

  /** 走的是哪个上游：claude_oauth / codex_chatgpt。单元行不在了就是空串。 */
  provider = "";

  /**
   * 调的是哪个模型。单价按模型定，所以账单也按模型分行 ——
   * 合并成一行的话，那一行的 unitPrice 只能是几个模型里随便一个的价。
   * 和 provider 一样只记在单元行上，老记录的单元行被清掉之后是空串。
   */
  model = "";

  /**
   * 这笔用量跑的是哪一档推理强度。单价也按它定，所以账单必须分行 ——
   * 同一个模型的 max 档和 low 档收的是两个价，合成一行就只能显示其中一个。
   * 老记录、以及不按强度分档的能力是空串。
   */
  effort = "";

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

/**
 * 桌面客户端的安装包地址，一个系统一条，外加一条通用下载页。
 *
 * 分系统不是为了整齐：Apple 芯片和 Intel 的包**不能互相代替**（arm64 的包在 Intel
 * 机器上装完直接起不来），而浏览器认得出是不是 Mac，却认不出是哪种芯片 ——
 * navigator.platform 在两种 Mac 上都报 MacIntel。所以页面把填过的那几条都摆出来让人自己挑，
 * 不替他猜。
 *
 * default 是兜底：一个列出各系统安装包的下载页。某个系统没填就用它，全空就是那一块不显示。
 */
export class ConsumerClientDownloads {
  default = "";

  windows = "";

  macX64 = "";

  macArm64 = "";
}

/**
 * 接入要的两类部署事实，都由服务端给，前端不再自己拼。
 *
 * baseUrl          SDK 要填的地址（galaxy.instance / galaxy.consumer_base_url）。
 * clientDownloads  桌面客户端各系统的下载地址（运行参数 client.consumer_download_url[.平台]）。
 *
 * 都可能是空的 —— 部署方没配就是没配，页面各自少显示一块，不猜。
 */
export class ConsumerEndpoint {
  baseUrl = "";

  clientDownloads: ConsumerClientDownloads = new ConsumerClientDownloads();
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

/**
 * 新建一把密钥。明文只在这一次响应里出现 —— 调用方拿到要立刻存进本机保险箱
 * （api/keyvault.api.ts），之后再要走 revealKey。最多 5 把有效的，超了服务端会拒。
 */
export async function createKey(alias: string, noticeVersion: string) {
  const response = await instance.post<ApiResponse<IssuedKeyView>>("/galaxy/consumer/keys", {
    alias,
    noticeVersion,
  });
  return unwrapApiResponse(response.data);
}

/** 一个人最多几把有效密钥。和服务端的 maxConsumerKeys 对齐，界面据此提前禁用按钮。 */
export const MAX_KEYS = 5;

export async function renewKey(keyId: string, ttlDays?: number) {
  const response = await instance.post<ApiResponse<IssuedKeyView>>("/galaxy/consumer/keys/renew", { keyId, ttlDays });
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

  /** 账户积分余额（微积分）。名下几把密钥花的是同一份钱。 */
  balance = 0;

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

  /** 这一次的推理强度。单价按 (模型, 强度) 定，「为什么扣这么多」要靠它才答得完整。 */
  effort = "";

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
 * 一个模型在某一档推理强度上的单价。
 *
 * 卡片上那几个数是**不分强度**那一档 —— 它是「没单独定价的强度都按它收」，
 * 也是绝大多数请求真正走的价。这个列表只列真的单独定过价的档，一档都没有时是空的。
 */
export class ModelEffortPrice {
  /** 档位名，上游原生：Claude 是 low…max，Codex 是 minimal…high。 */
  effort = "";

  inputPrice = 0;

  outputPrice = 0;

  cachePrice = 0;

  cacheWritePrice = 0;
}

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

  cacheWritePrice = 0;

  /** 官方参考价，同口径同币种。0 = 运营没声明，卡片上不划线也不标折扣。 */
  listInputPrice = 0;

  /** 官方缓存读取价。0 = 运营没声明，划线价里不出现这一段。 */
  listCachePrice = 0;

  listOutputPrice = 0;

  /** 比官方参考价便宜多少，万分之一（8500 = 省 85%）。服务端按输出价算好，前端不再自己减一遍。 */
  discountBps = 0;

  currency = "CNY";

  tags: string[] = [];

  summary = "";

  /** 卡片右上角的角标；空就没有角标。配色是语义名（hot/new/value/neutral），由前端映射到本端的调色板。 */
  badgeText = "";

  badgeTone = "";

  featured = false;

  /** 为假表示这几个单价是按能力统一定的价，不是这个模型单独的价。 */
  priced = false;

  /**
   * 这个模型按推理强度单独定过价的那几档，由浅到深。空 = 不分强度，上面那几个数就是全部。
   *
   * 和 NodeUpgrade 一样是嵌套对象：项目里没用 @Type，所以拿到的是服务端原样的普通对象，
   * ModelEffortPrice 上的默认值在这里不生效。读的时候按可能缺字段处理。
   */
  efforts: ModelEffortPrice[] = [];

  sortOrder = 0;
}

export class ConsumerModelView extends PortalModelView {
  category: KeyCategory = "other";
}

export class ConsumerCatalog {
  endpoint = "";

  models: ConsumerModelView[] = [];

  /** 分享返现比例，万分之一。按好友**充值**的金额算，所以只有一个比例。 */
  defaultBps = 0;

  updatedAt = "";
}

export class PointsSummary {
  balance = 0;

  recharged = 0;

  /** 按量消费累计花掉的（正数，已扣掉退款）。 */
  used = 0;

  referral = 0;

  /** 历史额度包购买。额度包已下架，新账号恒为 0。 */
  spent = 0;
}

/** purchase 是历史（额度包已下架），不会再有新的。 */
export type PointsType = "recharge" | "usage" | "refund" | "referral" | "purchase";

export class PointsLedgerEntry {
  txnId = "";

  type: PointsType = "recharge";

  amount = 0;

  balanceAfter = 0;

  /** 充值：实付金额（微元）；返现：那笔充值的积分。 */
  baseAmount = 0;

  rateBps = 0;

  orderId = "";

  /** 消费与退款指向的那一次请求。账单上的 unitId 就是它。 */
  unitId = "";

  /** 消费调的是哪类能力。 */
  kind = "";

  /** 返现流水上被邀请人的用户名，打过码。 */
  relatedName = "";

  modelId = "";

  createdAt = "";
}

export class PointsLedgerPage {
  total = 0;

  entries: PointsLedgerEntry[] = [];
}

export class ReferralOverview {
  inviteCode = "";

  invitees = 0;

  earned = 0;

  /** 返现比例，万分之一。按好友**充值**的金额算 —— 充值不挑模型，所以只有一个比例。 */
  defaultBps = 0;
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

export async function fetchReferral() {
  return getData(ReferralOverview, "/galaxy/consumer/referral");
}

export async function fetchInvitees(offset = 0, limit = 20) {
  return getData(InviteePage, "/galaxy/consumer/referral/invitees", { offset, limit });
}
