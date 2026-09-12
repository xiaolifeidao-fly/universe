"use client";

import { plainToInstance } from "class-transformer";
import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 共享算力池的运营接口。请求路径都在 /galaxy/admin 下，全部由 manager-api 自己出
 * （manager-api/pkg/galaxy），代理不按前缀分流（见 src/pages/api/[...all].ts）。
 *
 * galaxy-api 上原来那组 /api/galaxy/admin/* 已经删掉了：它认的是任务宇宙的管理员，
 * 而 Galaxy 有了自己的账号体系之后，那边只剩共享端和使用端的人，没有运营这种身份。
 */

export class LaneStatus {
  kind = "";

  provider = "";

  contributions = 0;

  online = 0;

  seatsTotal = 0;

  seatsUsed = 0;

  seatsEffective = 0;

  inflight = 0;

  draining = 0;

  throttled = 0;

  waitQueueDepth = 0;
}

export class PoolStatus {
  lanes: LaneStatus[] = [];
}

export class QuotaStatus {
  unit = "";

  limit = 0;

  used = 0;

  left = 0;

  ratio = 0;

  warned = false;
}

export class ContributionView {
  cid = "";

  kind = "";

  provider = "";

  seats = 0;

  seatsUsed = 0;

  seatsEffective = 0;

  inflight = 0;

  status = "";

  reputation = 1;

  online = false;

  quota: QuotaStatus[] = [];
}

export class AdminNodeView {
  nodeId = "";

  displayName = "";

  bridgeVersion = "";

  status = "";

  banned = false;

  ownerUserId = "";

  /** 主人的共享端账号「昵称（用户名）」。账号查不到（比如迁移前的老数据）时是空串，界面退回显示 ownerUserId。 */
  ownerName = "";

  /**
   * 主人的身份。注册默认是散户，只有管理端能设成工作室。
   * 散户的信誉跟着账号走（名下机器共用一份），工作室的跟着设备走（每台机器各算各的）。
   */
  providerType: ProviderType = "individual";

  lastBeatAt?: string;

  contributions: ContributionView[] = [];
}

export type ProviderType = "individual" | "studio";

export class AuditProbeView {
  probeId = "";

  cid = "";

  unitId = "";

  family = "";

  model = "";

  similarity = 0;

  verdict = "";

  detail = "";

  createdAt = "";

  checkedAt?: string;
}

export class UsageLine {
  kind = "";

  /** 走的是哪个上游：claude_oauth / codex_chatgpt。 */
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

export async function fetchPoolStatus() {
  return getData(PoolStatus, "/galaxy/admin/pool");
}

export async function fetchAdminNodes(limit = 200) {
  return getDataList(AdminNodeView, "/galaxy/admin/nodes", { limit });
}

export async function fetchProbes(cid = "", limit = 50) {
  return getDataList(AuditProbeView, "/galaxy/admin/probes", cid ? { cid, limit } : { limit });
}

export async function fetchAdminUsage(params: { from?: string; to?: string; kind?: string }) {
  return getData(UsageReport, "/galaxy/admin/usage", params);
}

export async function banNode(nodeId: string, banned: boolean, reason = "") {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/node/ban", { nodeId, banned, reason });
  return unwrapApiResponse(response.data);
}

/** 把账号设成工作室 / 改回散户。改的是账号，名下所有机器一起变。 */
export async function setProviderType(ownerUserId: string, providerType: ProviderType) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/provider/type", {
    ownerUserId,
    providerType,
  });
  return unwrapApiResponse(response.data);
}

/* ---------- Galaxy 账号 ---------- */

/** 共享端出算力（Nova），使用端花钱买额度（Orbit）。两端是两批人：各注册各的，同一个用户名在两端可以是两个人。 */
export type GalaxySide = "provider" | "consumer";

export type GalaxyAccountStatus = "active" | "disabled";

/**
 * Galaxy 自己的账号，和「用户管理」里的业务用户、管理端账号都不是一套。
 * id 是 pu_… / cu_…，就是池内表里 owner 存的那个值；迁移过来的老账号是 pu_legacy_<原 id> / cu_legacy_<原 id>。
 */
export class GalaxyAccountView {
  id = "";

  side: GalaxySide = "provider";

  username = "";

  displayName = "";

  status: GalaxyAccountStatus = "active";

  /** 运营重置过密码、本人还没改。改掉之前除了看本人信息和改密码，什么接口都调不动。 */
  mustChangePassword = false;

  /** 只有共享端有。 */
  providerType?: ProviderType;

  lastLoginAt?: string;

  createdAt = "";
}

export class GalaxyAccountPage {
  list: GalaxyAccountView[] = [];

  total = 0;
}

export interface GalaxyAccountQuery {
  side: GalaxySide;
  /** 模糊匹配用户名 / 昵称，或者精确匹配账号 id。 */
  keyword?: string;
  status?: GalaxyAccountStatus | "";
  /** 只对共享端生效。 */
  providerType?: ProviderType | "";
  offset?: number;
  /** 服务端默认 20，上限 200。 */
  limit?: number;
}

export async function listGalaxyUsers(query: GalaxyAccountQuery) {
  return getData(GalaxyAccountPage, "/galaxy/admin/users", {
    side: query.side,
    keyword: query.keyword?.trim() || undefined,
    status: query.status || undefined,
    providerType: query.side === "provider" ? query.providerType || undefined : undefined,
    offset: query.offset,
    limit: query.limit,
  });
}

/**
 * 停用 / 启用。停用当场生效，这个账号发出去的登录令牌一起作废；再启用也不会让它们复活。
 * 停用只挡登录控制台 —— 名下在跑的机器、发出去的算力密钥不跟着停，它们各有各的开关（封禁机器、吊销密钥）。
 *
 * side 必传：两端各一张账号表，服务端要靠它才知道去哪张表上改。传的是当前列表页所在的那一端。
 */
export async function setGalaxyUserStatus(side: GalaxySide, userId: string, status: GalaxyAccountStatus) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/users/status", { side, userId, status });
  return unwrapApiResponse(response.data);
}

/**
 * 替忘了密码的人设临时密码（8 个字符起，不超过 72 个字节）。现有令牌作废，本人下次登录必须先改掉它。
 * side 必传，理由同上。
 */
export async function resetGalaxyUserPassword(side: GalaxySide, userId: string, password: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/users/password", { side, userId, password });
  return unwrapApiResponse(response.data);
}

/* ---------- 额度包 ---------- */

/**
 * 一个额度商品。运营这条接口列的是**全部**商品，含已下架的；
 * 消费者那条（client/galaxy 的 /galaxy/consumer/packages）只给上架的。
 */
export class GalaxyPackageView {
  /** 商品码。建了就别改：历史订单按它记录买的是什么。 */
  packageCode = "";

  title = "";

  /** 这份商品给的额度：单位 → 数量。 */
  units: Record<string, number> = {};

  /** 售价，整数微元；除以 1_000_000 得到「元」。 */
  amount = 0;

  currency = "CNY";

  /** 这份商品签发出的密钥有效期。 */
  ttlDays = 30;

  /** 空数组 = 不限制。 */
  allowedKinds: string[] = [];

  modelTier: string[] = [];

  concurrency = 0;

  rpm = 0;

  /** 绑定的模型（模型目录里的 modelId），空是通用套餐。分享返现按这个模型的比例算。 */
  modelId = "";

  listed = false;

  sortOrder = 0;
}

export async function fetchGalaxyPackages() {
  return getDataList(GalaxyPackageView, "/galaxy/admin/packages");
}

/**
 * 新建或保存一个商品。语义是**整行覆盖**，不是打补丁 —— 少带一个字段就是把它清零，
 * 所以调用方必须把当前值全部带上。改价改量都不影响已经下过的单：
 * 下单那一刻额度与价格已经快照进订单了。
 */
export async function saveGalaxyPackage(payload: {
  packageCode: string;
  title: string;
  units: Record<string, number>;
  amount: number;
  currency: string;
  ttlDays: number;
  allowedKinds: string[];
  modelTier: string[];
  concurrency: number;
  rpm: number;
  modelId: string;
  listed: boolean;
  sortOrder: number;
}) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/packages/save", payload);
  return unwrapApiResponse(response.data);
}

/* ---------- 争议工单 ---------- */

export class AdminDisputeView {
  disputeId = "";

  unitId = "";

  attempt = 0;

  kind = "";

  keyId = "";

  /** 执行这单的贡献。要找提供者本人从这里去节点与贡献那一栏查。 */
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

export async function fetchDisputes(status = "", limit = 100) {
  return getDataList(AdminDisputeView, "/galaxy/admin/disputes", status ? { status, limit } : { limit });
}

/**
 * 裁决。`upheld` 会在三本账上各记一笔反向流水并扣提供者信誉 —— 这是笔真钱，
 * 所以服务端要求管理员令牌，且同一张工单只会被裁决一次。
 */
export async function resolveDispute(disputeId: string, status: string, resolution: string) {
  const response = await instance.post<ApiResponse<AdminDisputeView>>("/galaxy/admin/disputes/resolve", {
    disputeId,
    status,
    resolution,
  });
  return unwrapApiResponse(response.data);
}

/* ---------- 模型目录与分享返现 ---------- */

/**
 * 门户与模型广场上的一个模型。单价是「每百万 token 的微元」，0 表示按 kind 统一价。
 * 运营这条接口列全部（含下架的），并且带着返现比例 —— 公开接口不给那个比例。
 */
export class GalaxyModelView {
  modelId = "";

  displayName = "";

  vendor = "";

  family = "";

  kind = "";

  contextTokens = 0;

  maxOutputTokens = 0;

  inputPrice = 0;

  outputPrice = 0;

  cachePrice = 0;

  currency = "CNY";

  tags: string[] = [];

  summary = "";

  featured = false;

  priced = false;

  sortOrder = 0;

  /** 分享返现比例，万分之一（1000 = 10%）。没有这个字段表示没单独设、走默认比例。 */
  referralBps?: number;

  listed?: boolean;
}

export async function fetchGalaxyModels() {
  return getDataList(GalaxyModelView, "/galaxy/admin/portal/models");
}

/** 保存一个模型。**整行覆盖**：没带的字段就是清零，所以编辑框要用当前值预填。referralBps 传 null 表示走默认比例。 */
export async function saveGalaxyModel(payload: {
  modelId: string;
  displayName: string;
  vendor: string;
  family: string;
  kind: string;
  contextTokens: number;
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  cachePrice: number;
  currency: string;
  tags: string[];
  summary: string;
  referralBps: number | null;
  listed: boolean;
  featured: boolean;
  sortOrder: number;
}) {
  const response = await instance.post<ApiResponse<null>>("/galaxy/admin/portal/models/save", payload);
  return unwrapApiResponse(response.data);
}

export async function deleteGalaxyModel(modelId: string) {
  const response = await instance.post<ApiResponse<null>>("/galaxy/admin/portal/models/delete", { modelId });
  return unwrapApiResponse(response.data);
}

export class ReferralSettingsView {
  /** 通用套餐（没绑模型）的返现比例，万分之一。 */
  defaultBps = 0;

  updatedBy = "";

  updatedAt?: string;
}

export async function fetchReferralSettings() {
  return getData(ReferralSettingsView, "/galaxy/admin/referral/settings");
}

export async function saveReferralSettings(defaultBps: number) {
  const response = await instance.post<ApiResponse<number>>("/galaxy/admin/referral/settings/save", { defaultBps });
  return unwrapApiResponse(response.data);
}

/* ---------- 使用者积分 ---------- */

/** 1 积分 = ¥1。积分字段都是「微积分」，和金额同一量纲，除以 1_000_000 得到积分。 */
export type PointsType = "recharge" | "purchase" | "referral";

export class PointsLedgerEntry {
  txnId = "";

  ownerUserId = "";

  /** 使用者的「昵称（用户名）」。账号查不到时是空串，界面退回显示 ownerUserId。 */
  ownerName = "";

  type: PointsType = "recharge";

  amount = 0;

  balanceAfter = 0;

  /** 充值：实付金额（微元）；返现：那笔购买实付的积分。 */
  baseAmount = 0;

  rateBps = 0;

  orderId = "";

  /** 返现流水上下单的被邀请人。 */
  relatedName = "";

  modelId = "";

  remark = "";

  /** 经手充值的管理端账号。 */
  operator = "";

  createdAt = "";
}

export class PointsLedgerPage {
  total = 0;

  entries: PointsLedgerEntry[] = [];
}

export class PointsSummaryView {
  balance = 0;

  recharged = 0;

  spent = 0;

  referral = 0;
}

export async function fetchPointsLedger(query: { type?: PointsType | ""; keyword?: string; ownerUserId?: string; offset?: number; limit?: number }) {
  return getData(PointsLedgerPage, "/galaxy/admin/points/ledger", {
    type: query.type || undefined,
    keyword: query.keyword?.trim() || undefined,
    ownerUserId: query.ownerUserId || undefined,
    offset: query.offset,
    limit: query.limit,
  });
}

export async function fetchPointsSummary(userId: string) {
  return getData(PointsSummaryView, "/galaxy/admin/points/summary", { userId });
}

/**
 * 给使用者充积分。requestId 在打开充值框时生成一次：超时重试、连点两下都只会充一次，
 * 第二次原样拿回第一次的结果。
 */
export async function rechargePoints(payload: { userId: string; points: number; paidAmount: number; remark: string; requestId: string }) {
  const response = await instance.post<ApiResponse<PointsLedgerEntry>>("/galaxy/admin/points/recharge", payload);
  return unwrapApiResponse(response.data);
}

/* ---------- 全站密钥 ---------- */

export class AdminKeyView {
  keyId = "";

  alias = "";

  status = "";

  /** claude / codex / video / other。 */
  category = "";

  modelId = "";

  /** 平台能不能取回明文。老密钥只存了哈希，要本人换发一次。 */
  revealable = false;

  modelTier: string[] = [];

  allowedKinds: string[] = [];

  issuedAt = "";

  expiresAt = "";

  balance: Record<string, number> = {};

  ownerUserId = "";

  ownerName = "";

  orderId = "";
}

export class AdminKeyPage {
  total = 0;

  keys: AdminKeyView[] = [];
}

export async function fetchAdminKeys(query: { keyword?: string; status?: string; ownerUserId?: string; offset?: number; limit?: number }) {
  return getData(AdminKeyPage, "/galaxy/admin/keys", {
    keyword: query.keyword?.trim() || undefined,
    status: query.status || undefined,
    ownerUserId: query.ownerUserId || undefined,
    offset: query.offset,
    limit: query.limit,
  });
}

export class KeySecretView {
  keyId = "";

  secret = "";

  /** SDK 的 base_url（带 /v1）。manager-api 没配 galaxy.consumer_base_url 时是空串。 */
  baseUrl = "";
}

/** 取密钥明文。只在要转交的那一刻调，不缓存；接口本身只授给有写权限的角色。 */
export async function revealAdminKey(keyId: string) {
  const response = await instance.post<ApiResponse<KeySecretView>>("/galaxy/admin/keys/secret", { keyId });
  return unwrapApiResponse(response.data);
}

/* ---------- ai-bridge 发布包 ---------- */

export type BridgeReleaseStatus = "published" | "withdrawn";

/**
 * 一个 ai-bridge 安装包：一个版本 × 一个平台一行。运营这条接口列的是**全部**，含已下架的；
 * 公开清单和 Nova 控制台只给每个平台最新的那个已发布版本，节点也只会升级到它。
 */
export class BridgeReleaseView {
  /** br_… */
  releaseId = "";

  version = "";

  /** linux-x64 / linux-arm64 / darwin-arm64 / darwin-x64 / windows-x64 / windows-arm64。 */
  platform = "";

  /** ai-bridge-<version>-<platform>.tar.gz，windows 两个平台是 .zip。 */
  fileName = "";

  /** 字节数。 */
  size = 0;

  /** 整个压缩包的 sha256，小写十六进制。服务端收包时自己算的，不是运营填的。 */
  sha256 = "";

  /** Ed25519 签名的标准 base64（88 个字符），签的是 version + platform + sha256。 */
  signature = "";

  notes = "";

  /**
   * 缺省当成已下架：字段万一没带回来，宁可少算一个「当前最新」，
   * 也不要让运营以为节点会升级到一个其实没在发布的包。
   */
  status: BridgeReleaseStatus = "withdrawn";

  /** 上传它的管理端账号。 */
  publishedBy = "";

  publishedAt?: string;

  createdAt = "";

  updatedAt = "";
}

export async function fetchBridgeReleases() {
  return getDataList(BridgeReleaseView, "/galaxy/admin/bridge/releases");
}

/**
 * 上传并发布一个安装包。整个压缩包以标准 base64 放进 JSON 的 content。
 *
 * 版本与平台服务端从 fileName 解析；sha256 服务端自己算，再用配置的发布公钥验签，
 * 验不过不收。同一版本 + 平台已经发布时也会被拒（先下架再重新上传），已下架的会被这次覆盖。
 */
export async function uploadBridgeRelease(
  payload: { fileName: string; content: string; signature: string; notes?: string },
  options: { onUploadProgress?: (percent: number) => void } = {},
) {
  const { onUploadProgress } = options;
  const response = await instance.post<ApiResponse<BridgeReleaseView>>("/galaxy/admin/bridge/releases/upload", payload, {
    // 共享实例默认 10 秒超时，是给普通 JSON 接口的。这一条要把整个包推上去（base64 比原包大三分之一，
    // 3MB 的包就是 4MB 请求体），服务端收完还要算 sha256、验签、写 OSS 才回。
    // 至少给 120 秒；大包按请求体每 MB 再放宽 4 秒（大约 2Mbps 的上行也传得完）——
    // 64MB 的上限包 base64 之后约 86MB，固定 120 秒得有 6Mbps 以上的上行才赶得上。
    timeout: Math.max(120_000, Math.ceil(payload.content.length / (1024 * 1024)) * 4_000),
    onUploadProgress: onUploadProgress
      ? (event) => onUploadProgress(Math.round((event.progress ?? 0) * 100))
      : undefined,
  });
  return plainToInstance(BridgeReleaseView, unwrapApiResponse(response.data));
}

/** 下架 / 重新上架。下架不删包：已经装上它的机器不受影响，节点也不会降级。 */
export async function setBridgeReleaseStatus(releaseId: string, status: BridgeReleaseStatus) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/bridge/releases/status", {
    releaseId,
    status,
  });
  return unwrapApiResponse(response.data);
}
