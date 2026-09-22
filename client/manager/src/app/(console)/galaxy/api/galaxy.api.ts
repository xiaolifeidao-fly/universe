"use client";

import axios from "axios";
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

/**
 * 上游订阅自己报的余量（Claude / Codex 的 5 小时、周限额之类）。
 *
 * 和主人设的那份额度（QuotaStatus）是**两回事**：那份是「打算放多少出去」，
 * 这份是「上游实际还让跑多少」。前者填得比后者宽，机器就会在上游那儿撞限流，
 * 而平台这边看到的是「额度还剩大半」。
 *
 * 数据来自节点本来就要发的那些中转请求的响应头 —— **不额外打上游**。代价是
 * 机器闲着的时候它不更新，所以 observedAt 必须显示出来。
 */
export class UsageBucket {
  /** 桶名，原样保留：unified-5h / requests / tokens…… */
  bucket = "";

  /** 从桶名里认出来的时间窗，如 5h / 7d。认不出来是空串。 */
  window = "";

  /** 下面这几项**可能是 undefined**：上游没报就没有。别用 ?? 0 兜底 —— 「没报」和「剩 0」不是一回事。 */
  limit?: number;

  remaining?: number;

  used?: number;

  usedPercent?: number;

  /** 归零时刻，原样的字符串：可能是 unix 秒、ISO 时间，也可能是 6ms 这种时长。 */
  reset = "";

  status = "";
}

export class UpstreamUsage {
  buckets: UsageBucket[] = [];

  /** 原样的限流头。归一化认不出来的东西全靠它。 */
  raw: Record<string, string> = {};

  /** 节点观测到的时刻。**必须显示** —— 闲置的机器这个数会一直是旧的。 */
  observedAt = "";

  source = "";
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

  /** 这条通道背后那个上游账号此刻还剩多少。undefined = 这台机器还没观测到过。 */
  upstreamUsage?: UpstreamUsage;

  upstreamUsageAt?: string;
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

/* ---------- 争议工单 ---------- */

export class AdminDisputeView {
  disputeId = "";

  unitId = "";

  attempt = 0;

  kind = "";

  keyId = "";

  /** 执行这单的贡献。要找提供者本人从这里去「节点与贡献」页面查。 */
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

  /**
   * 我们自己此刻对外收的单价，每百万 token 微元。几个桶互不重叠：inputPrice 只算
   * **未命中缓存的新增输入**，命中的走 cachePrice，写入的走 cacheWrite*。
   *
   * **库里不存这几个数**，服务端按「能力 × 模型 × 计量单位」从价目表现算了下发，
   * 和门户卡片、使用端模型广场走的是同一段代码 —— 运营台是用来核对门户标了多少的，
   * 再自己算一遍的话，两处迟早显示两个数。priced 为 false 表示这几个数来自
   * 该 kind 的兜底价，不是这个模型自己的行。改它们要走「定价」，不是「基础配置」。
   */
  inputPrice = 0;

  outputPrice = 0;

  cachePrice = 0;

  /**
   * 缓存写入两档：5 分钟（不带后缀的这个）与 1 小时，单价差 1.6 倍。
   *
   * 只有 Claude 一族会按 TTL 分档报 cache_creation，Codex 一族这两个恒为 0 ——
   * 界面上按族决定摆不摆，别把「上游没有这个概念」显示成「这一档免费」。
   */
  cacheWritePrice = 0;

  cacheWrite1hPrice = 0;


  /**
   * 官方参考价（别人家的价），每百万 token 微元。0 = 那一档不划线。
   *
   * 这是唯一存在模型行上的价 —— 它是**声明**，不是我们收的钱。
   * 我们自己的单价只有价目表一个出处（见上面几档）。
   */
  listInputPrice = 0;

  listOutputPrice = 0;

  listCachePrice = 0;

  /** 比官方参考价便宜多少，万分之一（8500 = 省 85%）。服务端按输出价算好下发。 */
  discountBps = 0;

  currency = "CNY";

  tags: string[] = [];

  summary = "";

  /** 卡片右上角的角标文案，空=不显示。配色只在 hot / new / value / neutral 里选。 */
  badgeText = "";

  badgeTone = "";

  featured = false;

  priced = false;

  sortOrder = 0;

  /** 分享返现比例，万分之一（1000 = 10%）。没有这个字段表示没单独设、走默认比例。 */

  listed?: boolean;
}

export async function fetchGalaxyModels() {
  return getDataList(GalaxyModelView, "/galaxy/admin/portal/models");
}

/** 保存一个模型。**整行覆盖**：没带的字段就是清零，所以编辑框要用当前值预填。 */
export async function saveGalaxyModel(payload: {
  modelId: string;
  displayName: string;
  vendor: string;
  family: string;
  kind: string;
  contextTokens: number;
  maxOutputTokens: number;
  listInputPrice: number;
  listOutputPrice: number;
  listCachePrice: number;
  currency: string;
  tags: string[];
  summary: string;
  badgeText: string;
  badgeTone: string;
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

  /** 主人账户此刻的积分余额（微积分）。额度不在密钥上，几把密钥花的是同一份钱。 */
  balance = 0;

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

/**
 * 一个客户端在一个平台上的那条地址。
 *
 * platform 空串表示通用下载页（一个列出各系统安装包的页面，也是平台那条没填时的兜底）；
 * 其余取值见服务端的 dto.DesktopPlatforms —— 界面只按它取自己的标题，不自己枚举，
 * 所以加一个平台不用改这里。
 *
 * settingKey 由服务端给：改地址走的是 /settings/save，键名拼错了要等运营点保存那一刻
 * 才被「这一项不是可调参数」顶回来。
 */
export class ClientDownloadSlot {
  platform = "";

  settingKey = "";

  /** 现在填的地址，空串表示还没填 —— 界面上那一格显示「未填写」。 */
  url = "";
}

/** 两个桌面客户端各自的那几行，顺序由服务端排（通用那条在前）。 */
export class ClientDownloads {
  /** 共享端 Nova。目前只有管理端展示它。 */
  provider: ClientDownloadSlot[] = [];

  /** 使用端 Orbit。使用端控制台的密钥页摆出来的就是这几条。 */
  consumer: ClientDownloadSlot[] = [];
}

/**
 * 「ai-bridge 版本」这一页的全部内容：命令行版 ai-bridge 的包，加上两个桌面客户端的下载地址。
 *
 * 两样东西合在一条接口里，因为它们是同一个问题的两半 ——「用户要装的东西从哪儿拿」。
 * 客户端地址存在运行参数表里，但读它跟着这一页的授权走，不必再要一份「运行参数」的读权限；
 * 改它才回到 /settings/save（写权限判在那条路上），键名跟着每一行由服务端给，前端不自己拼。
 */
export class AdminBridgeReleasePage {
  releases: BridgeReleaseView[] = [];

  clients: ClientDownloads = new ClientDownloads();

  /** 改完最多多少秒在全部进程上生效 —— 使用端控制台读的是同一行，不是立刻跟着变。 */
  propagationSeconds = 0;
}

export async function fetchBridgeReleases() {
  return getData(AdminBridgeReleasePage, "/galaxy/admin/bridge/releases");
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

/* ---------- 桌面客户端（Nova / Orbit）发版 ---------- */

export type DesktopReleaseStatus = "staging" | "published" | "withdrawn";

/** 清单里的一个文件。真正的下载依据是服务端存下来的清单原文，这里只为了在页面上列出来。 */
export class DesktopReleaseFile {
  name = "";

  size = 0;

  /** electron-builder 打包时算的 base64，客户端下载完比对的就是它。 */
  sha512 = "";
}

/**
 * 一次桌面客户端发版：一个端 × 一个平台通道 × 一个版本一行。
 *
 * 和 ai-bridge 的发布包不是一回事：那边的包才三兆、经服务端、要验 Ed25519 签名；
 * 这边的安装包一百多兆，浏览器拿签名地址直传 OSS，服务端只签地址、写清单、确认包到了没有。
 * 客户端（electron-updater）读的是 OSS 上那份清单，不打任何接口。
 */
export class DesktopReleaseView {
  /** dr_… */
  releaseId = "";

  /** nova=共享端 / orbit=使用端。 */
  product = "";

  /** mac / win / linux。决定 OSS 上那份清单叫什么名字。 */
  channel = "";

  version = "";

  /** latest-mac.yml / latest.yml / latest-linux.yml。 */
  manifestFile = "";

  files: DesktopReleaseFile[] = [];

  size = 0;

  notes = "";

  /**
   * 缺省当成还没传完：字段万一没带回来，宁可少算一个「当前版本」，
   * 也不要让运营以为客户端已经在更新到它了。
   */
  status: DesktopReleaseStatus = "staging";

  /** 客户端现在会更新到的就是这一版。由服务端算，前端不自己比版本号。 */
  current = false;

  publishedBy = "";

  publishedAt?: string;

  createdAt = "";

  updatedAt = "";
}

export class DesktopReleasePage {
  releases: DesktopReleaseView[] = [];

  /** 服务端配了对象存储没有。没配这一页发不了版，而 objectRoot 的空串也不再是「桶根目录」的意思。 */
  configured = false;

  /**
   * 两个端目录的父目录（部署配置的 dirPrefix，没配就是空串 = 桶根）。
   * 清单与安装包落在 `<objectRoot>/<端>/` 下，运营拿它拼客户端的更新地址。
   */
  objectRoot = "";

  products: string[] = [];

  channels: string[] = [];
}

export class DesktopReleaseUploadTarget {
  name = "";

  size = 0;

  /** 上传时必须原样带上：它参与签名，对不上 OSS 直接拒。 */
  contentType = "";

  /** 短期有效的 PUT 直传地址。 */
  url = "";
}

export class DesktopReleaseUpload {
  releaseId = "";

  product = "";

  channel = "";

  version = "";

  uploads: DesktopReleaseUploadTarget[] = [];

  expiresAt = "";
}

export async function fetchDesktopReleases() {
  return getData(DesktopReleasePage, "/galaxy/admin/desktop/releases");
}

/**
 * 发版第一步：把 electron-builder 出的 latest-*.yml 原文交上去，换回几个直传地址。
 *
 * 版本、文件名、大小、sha512 全部由服务端从清单解析 —— 那些值是打包时算出来的，
 * 让人再填一遍只会填错。
 */
export async function prepareDesktopRelease(payload: {
  product: string;
  fileName: string;
  manifest: string;
  notes?: string;
}) {
  const response = await instance.post<ApiResponse<DesktopReleaseUpload>>(
    "/galaxy/admin/desktop/releases/prepare",
    payload,
  );
  return plainToInstance(DesktopReleaseUpload, unwrapApiResponse(response.data));
}

/**
 * 把一个安装包直传到对象存储。
 *
 * **绕开共享的 axios 实例**，这是故意的：它带着 baseURL、管理端令牌和响应拦截器，
 * 而这一次请求打的是对象存储的签名地址 —— 令牌不该发给第三方，那边回的也不是
 * 我们那套 {code,data} 包封。
 *
 * Content-Type 必须原样带上服务端给的那个值：它参与签名，改一个字符 OSS 就拒。
 */
export async function uploadDesktopAsset(
  target: DesktopReleaseUploadTarget,
  file: File,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
) {
  await axios.put(target.url, file, {
    headers: { "Content-Type": target.contentType },
    // 包一百多兆，慢一点的上行要传十几分钟。共享实例那 10 秒的默认超时在这里毫无意义。
    timeout: 0,
    signal: options.signal,
    onUploadProgress: options.onProgress
      ? (event) => options.onProgress?.(Math.round((event.progress ?? 0) * 100))
      : undefined,
  });
}

/**
 * 发版第二步：包都传完了，把清单写到对象存储上。
 *
 * **全网的客户端从这一刻起开始提示更新**，所以服务端会先 HEAD 一遍确认包真的在那儿。
 */
export async function publishDesktopRelease(releaseId: string) {
  const response = await instance.post<ApiResponse<DesktopReleaseView>>(
    "/galaxy/admin/desktop/releases/publish",
    { releaseId },
  );
  return plainToInstance(DesktopReleaseView, unwrapApiResponse(response.data));
}

/** 下架 / 重新上架。下架把清单换回上一个在架版本，包不删 —— 已经更新过的人不受影响。 */
export async function setDesktopReleaseStatus(releaseId: string, status: DesktopReleaseStatus) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/desktop/releases/status", {
    releaseId,
    status,
  });
  return unwrapApiResponse(response.data);
}

/* ---------- 提现审批 ---------- */

export type PayoutStatus = "pending" | "paid" | "rejected";

export type PayoutMethod = "alipay" | "wechat" | "bank";

/**
 * 一张提现申请单。
 *
 * **积分在申请那一刻就从账户里扣走了** —— 单子停在 pending 等于那笔钱既不在
 * 用户手上、也没打出去。所以这一页不是「可以有」，是那笔钱唯一的出口。
 */
export class AdminPayoutView {
  payoutId = "";

  ownerUserId = "";

  /** 申请人的共享端账号「昵称（用户名）」。查不到时是空串，界面退回显示 ownerUserId。 */
  ownerName = "";

  /** 提现的微积分数。界面按 ÷1,000,000 显示成积分，1 积分 = ¥1。 */
  credits = 0;

  /** 折算出来的钱（微分）。下单那一刻快照进来，之后改兑换比不影响已受理的申请。 */
  amount = 0;

  currency = "CNY";

  fee = 0;

  method: PayoutMethod | "" = "";

  /** 打码后的收款账号。要打款时点「查看收款账号」单独取明文。 */
  account = "";

  status: PayoutStatus | "" = "";

  note = "";

  handledBy = "";

  handledAt?: string;

  createdTime = "";
}

export class AdminPayoutPage {
  total = 0;

  payouts: AdminPayoutView[] = [];

  /** 各状态的计数。不随分页变 —— 它回答「还剩多少笔要处理」。 */
  counts: Record<string, number> = {};

  /** 起提金额（微积分）。界面上解释「为什么这个人提不了」。 */
  minCredits = 0;

  /** 争议期天数：这段时间内结算的积分算待结算，提不出来。 */
  holdDays = 0;
}

export class PayoutAccountView {
  payoutId = "";

  method = "";

  account = "";
}

export async function fetchPayouts(query: {
  status?: PayoutStatus | "";
  ownerUserId?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
}) {
  return getData(AdminPayoutPage, "/galaxy/admin/payouts", {
    status: query.status || undefined,
    ownerUserId: query.ownerUserId || undefined,
    keyword: query.keyword || undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

/** 打款完成 / 驳回。驳回会把积分原路退回申请人账户，所以 note 必填。 */
export async function handlePayout(payoutId: string, status: Exclude<PayoutStatus, "pending">, note: string) {
  const response = await instance.post<ApiResponse<AdminPayoutView>>("/galaxy/admin/payouts/handle", {
    payoutId,
    status,
    note,
  });
  return plainToInstance(AdminPayoutView, unwrapApiResponse(response.data));
}

/**
 * 取收款账号明文。用 POST 和 revealAdminKey 同一个理由：只读角色只授 GET，
 * 别人的银行卡号天然就不在它的授权范围里。
 */
export async function revealPayoutAccount(payoutId: string) {
  const response = await instance.post<ApiResponse<PayoutAccountView>>("/galaxy/admin/payouts/account", { payoutId });
  return plainToInstance(PayoutAccountView, unwrapApiResponse(response.data));
}

/* ---------- 价目表 ---------- */

/**
 * 价目表的一行。
 *
 * 一行**两个价**：price 向使用者收，providerPrice 结给共享者，差额是平台毛利。
 * 两个数各填各的 —— 上游价不再是下游价的一个百分比。
 *
 * 两个价都是**每百万单位的微分**：1,000,000 微分 = ¥1，所以「¥3 / 百万 token」
 * 存进来是 3,000,000。界面上按元显示，别把这两个量纲混了。
 */
export class PriceView {
  kind = "";

  /**
   * 这一行管哪个模型。空串 = 该 kind 的**兜底价**，不是「一个叫空串的模型」。
   * 取价先找模型自己的行，按单位找不到才回落到兜底行。
   */
  modelId = "";

  /**
   * 这一行管哪一档推理强度。空串 = **不分强度**，这个模型的所有强度都按它算。
   * 档位名是上游原生的，两族不通用（Claude 的 low…max、Codex 的 minimal…high）。
   */
  effort = "";

  unit = "";

  /** 对外单价：向使用者收多少。 */
  price = 0;

  currency = "CNY";

  /** 运营填的结算单价。0 表示这一行还没迁过来，结算回落到 providerShare。 */
  providerPrice = 0;

  /**
   * 共享者**实际**按多少结。providerPrice 填了就是它，没填就是回落算出来的那个数。
   * 编辑时要拿它预填 —— 拿 providerPrice 预填的话，一行还没迁移的价被保存一次
   * 就从「按七成」变成了「一分不给」。
   */
  settlePrice = 0;

  /** 平台毛利率，万分之一（3000 = 30%）。负数是平台在倒贴。对外单价为 0 时是 0。 */
  marginBps = 0;

  /** 老口径分成比例。只在 providerPrice 为 0 时还参与计算，看到它就是「这行没迁」。 */
  providerShare = 0.7;

  effectiveFrom = "";

  /** 此刻正在生效的那一行。历史价与还没到点的未来价都是 false。 */
  effective = false;
}

export class PriceTableView {
  prices: PriceView[] = [];

  /** 界面上的候选值，来自已有的价与真实跑过的用量 —— 不用运营去背单位字符串。 */
  kinds: string[] = [];

  units: string[] = [];

  /** 模型候选：模型目录里的（含已下架的）加上价目表里出现过的。同样是提示不是白名单。 */
  models: string[] = [];

  /**
   * 协议族 → 它认识的推理强度档位，由浅到深。
   *
   * 按族分开给而不是并成一张扁平清单：Claude 的 xhigh / max 在 Codex 不存在，
   * Codex 的 minimal 在 Claude 不存在 —— 并起来运营迟早给某个模型填上一个
   * 它永远不会出现的档，而那行价只会安静地躺在表里，匹配不上任何用量。
   */
  efforts: Record<string, string[]> = {};

  /**
   * 近 30 天产生过用量、却查不到价的 (kind, unit)。
   * 这些用量的扣费与分成会**静默算 0**，不报错 —— 这一列就是那个告警。
   */
  unpriced: PriceView[] = [];
}

export async function fetchPrices() {
  return getData(PriceTableView, "/galaxy/admin/prices");
}

export async function savePrice(payload: {
  kind: string;
  /** 留空 = 改该 kind 的兜底价。 */
  modelId: string;
  /** 留空 = 这个模型不分强度的价。服务端只认上游真实存在的档，编出来的会被拒。 */
  effort: string;
  unit: string;
  price: number;
  /** 结算单价。一律显式带上 —— 不带就是把这一行的结算价清成 0。 */
  providerPrice: number;
  currency?: string;
  effectiveFrom?: string;
}) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/prices/save", payload);
  return unwrapApiResponse(response.data);
}

/** modelId 与 effort 都在唯一键里，删除**一定要带**：少带一个就会去删另一行。 */
export async function deletePrice(payload: {
  kind: string;
  modelId: string;
  effort: string;
  unit: string;
  effectiveFrom: string;
}) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/prices/delete", payload);
  return unwrapApiResponse(response.data);
}

/* ---------- 门户线索 ---------- */

export type LeadStatus = "new" | "handled" | "closed";

/** 门户「联系我们」留下的一条线索。里面是陌生人的手机、邮箱 —— 别往别处复制。 */
export class LeadRecord {
  leadId = "";

  name = "";

  contact = "";

  company = "";

  topic = "";

  scale = "";

  message = "";

  source = "";

  status: LeadStatus | "" = "";

  handledBy = "";

  handledAt?: string;

  createdTime = "";
}

export class LeadPage {
  total = 0;

  leads: LeadRecord[] = [];
}

export async function fetchLeads(query: { status?: LeadStatus | ""; offset?: number; limit?: number }) {
  return getData(LeadPage, "/galaxy/admin/portal/leads", {
    status: query.status || undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

export async function handleLead(leadId: string, status: LeadStatus) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/portal/leads/handle", { leadId, status });
  return unwrapApiResponse(response.data);
}

/* ---------- 订单 ---------- */

export type OrderStatus = "pending" | "paid" | "fulfilled" | "cancelled";

/** 怎么付的：points=用积分买；channel=走支付渠道（含沙箱与人工确认到账）。 */
export type OrderPayMethod = "points" | "channel";

export class AdminOrderView {
  orderId = "";

  userId = "";

  /** 下单人的使用端账号「昵称（用户名）」。查不到时是空串，界面退回显示 userId。 */
  userName = "";

  packageCode = "";

  /** 下单那一刻的额度快照。套餐之后改了不影响这一单。 */
  units: Record<string, number> = {};

  /** 微分，÷1,000,000 是元。 */
  amount = 0;

  currency = "CNY";

  status: OrderStatus | "" = "";

  payMethod: OrderPayMethod | "" = "";

  modelId = "";

  /** 非空表示给这把已有密钥充值，空表示履约时签发新密钥。 */
  targetKeyId = "";

  /** 履约后落到哪把密钥。 */
  keyId = "";

  /** 渠道流水号。人工确认到账时运营填的就是它，所以它也在搜索范围里。 */
  paymentRef = "";

  paidAt?: string;

  fulfilledAt?: string;

  createdTime = "";
}

export class AdminOrderPage {
  total = 0;

  orders: AdminOrderView[] = [];

  /** 各状态的计数，不随分页变。 */
  counts: Record<string, number> = {};
}

export async function fetchOrders(query: {
  status?: OrderStatus | "";
  userId?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
}) {
  return getData(AdminOrderPage, "/galaxy/admin/orders", {
    status: query.status || undefined,
    userId: query.userId || undefined,
    keyword: query.keyword || undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

/* ---------- 封禁名单 ---------- */

/** 封禁名单上一台设备底下还留着的节点记录，含已撤销的。 */
export class BannedMachineNode {
  nodeId = "";

  displayName = "";

  ownerUserId = "";

  ownerName = "";

  status = "";
}

/**
 * 一条封禁记录。
 *
 * 封禁记在**设备指纹**上，而「节点与贡献」那页的解封是按 node_id 找机器的 ——
 * 机器一旦从节点表里消失（撤销、重装、换了 node_id），那个指纹就再也没有入口碰得到。
 * 这张名单是它唯一看得见、也解得开的地方。
 */
export class BannedMachineView {
  fingerprint = "";

  banned = false;

  reason = "";

  updatedBy = "";

  updatedTime = "";

  nodes: BannedMachineNode[] = [];
}

export async function fetchBannedMachines(bannedOnly = true, limit = 100) {
  return getDataList(BannedMachineView, "/galaxy/admin/bans", { bannedOnly: String(bannedOnly), limit });
}

/** 按设备指纹封禁 / 解封。机器在不在册都办得了。 */
export async function banMachine(fingerprint: string, banned: boolean, reason = "") {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/bans/set", {
    fingerprint,
    banned,
    reason,
  });
  return unwrapApiResponse(response.data);
}

/* ---------- 代签密钥 ---------- */

export class IssuedKeyView {
  keyId = "";

  /** 明文**只在签发这一次**返回，之后再也查不到 —— 要当场转交。 */
  secret = "";

  alias = "";

  expiresAt = "";
}

/**
 * 运营直接给一个使用端账号签一把密钥（内测、补发、线下成交）。
 *
 * 不走订单，也不扣积分。grants 是初始额度余额，按计量单位填。
 */
/**
 * 代签一把密钥。
 *
 * 不发额度 —— 额度是账户里的积分，要给人额度就去「积分」页充值。
 * 使用者自己也能在 Orbit 上签发，这条路留给「帮人排查」和内部用途。
 */
export async function issueKey(payload: {
  ownerUserId: string;
  alias?: string;
  ttlDays?: number;
  concurrency?: number;
  rpm?: number;
  modelId?: string;
}) {
  const response = await instance.post<ApiResponse<IssuedKeyView>>("/galaxy/admin/keys/issue", {
    ...payload,
    // 后端要求 noticeVersion 非空；不传就由 manager-api 填成当前版本。
    noticeVersion: "",
  });
  return plainToInstance(IssuedKeyView, unwrapApiResponse(response.data));
}

/* ---------- 运营总览 ---------- */

export class OverviewPool {
  lanes = 0;

  contributions = 0;

  online = 0;

  seatsTotal = 0;

  seatsUsed = 0;

  inflight = 0;

  waitQueue = 0;
}

export class OverviewToday {
  units = 0;

  failed = 0;

  running = 0;
}

/**
 * 「今天要做什么」。
 *
 * 每一项都是一个待办计数，点进去就是对应那一页。里面有几件是**有人在等**：
 * 提现停在待处理，就是有人的钱既不在手上也没打出去。
 */
export class AdminOverview {
  pendingPayouts = 0;

  pendingOrders = 0;

  openDisputes = 0;

  newLeads = 0;

  /** 有用量却查不到价的计量单位数。不是零就意味着有一部分钱正在被静默算成 0。 */
  unpricedUnits = 0;

  recentMismatches = 0;

  bannedMachines = 0;

  pool: OverviewPool = new OverviewPool();

  today: OverviewToday = new OverviewToday();

  /** 取不到的那几块。控制面没配 Redis 时池水位取不到 —— 那和「池子空了」不是一回事。 */
  degraded: string[] = [];
}

export async function fetchOverview() {
  return getData(AdminOverview, "/galaxy/admin/overview");
}

/* ---------- 用量偏差 ---------- */

/**
 * 一次「节点自报和 Hub 解析对不上」。
 *
 * hubValue 是平台侧计量（平台侧优先），nodeValue 是节点自报的。
 * 单看一行说明不了问题 —— 偶发一次是解析抖动，同一条贡献反复上榜才是虚报。
 */
export class UsageMismatchView {
  unitId = "";

  cid = "";

  ownerName = "";

  unit = "";

  hubValue = 0;

  nodeValue = 0;

  ratio = 0;

  createdAt = "";
}

export class MismatchOffender {
  cid = "";

  ownerName = "";

  times = 0;

  worstRatio = 0;
}

export class MismatchPage {
  total = 0;

  records: UsageMismatchView[] = [];

  /** 这段时间里偏差次数最多的几条贡献。逐行看看不出规律，这份排行才是结论。 */
  offenders: MismatchOffender[] = [];

  /** 当前告警阈值（galaxy.usage_mismatch_ratio）。 */
  threshold = 0;

  days = 0;
}

export async function fetchMismatches(query: { cid?: string; minRatio?: number; days?: number; offset?: number; limit?: number }) {
  return getData(MismatchPage, "/galaxy/admin/mismatches", {
    cid: query.cid || undefined,
    minRatio: query.minRatio || undefined,
    days: query.days || undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

/* ---------- 运行工单 ---------- */

export type UnitState = "queued" | "placed" | "running" | "streaming" | "completed" | "failed" | "cancelled" | "expired";

/** 已经结束的状态。结束了的工单取消不了 —— 写一个取消标记只会误导后来人。 */
export const TERMINAL_UNIT_STATES = new Set<string>(["completed", "failed", "cancelled", "expired"]);

/** 一条工单。**不含任何请求内容** —— 工单表上本来就不存它。 */
export class AdminUnitView {
  unitId = "";

  kind = "";

  primitive = "";

  provider = "";

  model = "";

  /**
   * 这一次的推理强度，计价键的一部分。排查「这笔怎么收这么多」时，
   * 模型对得上而金额对不上，差的通常就是这一档。老记录是空串。
   */
  effort = "";

  consumerKey = "";

  keyAlias = "";

  cid = "";

  state: UnitState | "" = "";

  errorClass = "";

  errorCode = "";

  errorMessage = "";

  /** 持有消费者连接的 Hub 实例。多实例部署时排障第一步就是它。 */
  instance = "";

  attempt = 1;

  startedAt?: string;

  finishedAt?: string;

  durationMs = 0;

  createdTime = "";
}

export class AdminUnitPage {
  total = 0;

  units: AdminUnitView[] = [];

  /** 这段时间里各状态各有多少，不随分页变。 */
  counts: Record<string, number> = {};

  days = 0;
}

export async function fetchUnits(query: {
  state?: UnitState | "";
  kind?: string;
  cid?: string;
  consumerKey?: string;
  days?: number;
  offset?: number;
  limit?: number;
}) {
  return getData(AdminUnitPage, "/galaxy/admin/units", {
    state: query.state || undefined,
    kind: query.kind || undefined,
    cid: query.cid || undefined,
    consumerKey: query.consumerKey || undefined,
    days: query.days || undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

/** 强制取消一条还在跑的工单。取消是**请求**不是命令：真正 abort 上游的是节点。 */
export async function cancelUnit(unitId: string, reason: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/units/cancel", { unitId, reason });
  return unwrapApiResponse(response.data);
}

/* ---------- 邀请返现 ---------- */

/** 一行邀请关系。invitedBy 空表示自己注册的，没有邀请人。 */
export class ReferralRecord {
  userId = "";

  userName = "";

  inviteCode = "";

  invitedBy = "";

  inviterName = "";

  createdTime = "";
}

/** 一个邀请人的战绩。payout 是微积分，共享端已扣掉申诉追回的部分，是净额。 */
export class InviterRank {
  inviterId = "";

  inviterName = "";

  invitees = 0;

  payout = 0;
}

export class AdminReferralPage {
  total = 0;

  records: ReferralRecord[] = [];

  /** 拉人最多的几位。逐行翻看不出谁在真的带量，这份排行才是结论。 */
  top: InviterRank[] = [];

  /** 使用端通用套餐的默认返现比例（万分之一）。各模型自己的比例在模型目录上。 */
  defaultBps = 0;

  /** 共享端返现比例（0.1 = 10%），0 表示这个活动没开。它在配置文件里，不在后台。 */
  providerRate = 0;

  /** 共享端返现期限（天），0 表示长期有效。 */
  providerDays = 0;

  side: GalaxySide | "" = "";
}

export async function fetchReferrals(query: {
  side: GalaxySide;
  inviterId?: string;
  keyword?: string;
  invitedOnly?: boolean;
  offset?: number;
  limit?: number;
}) {
  return getData(AdminReferralPage, "/galaxy/admin/referrals", {
    side: query.side,
    inviterId: query.inviterId || undefined,
    keyword: query.keyword || undefined,
    invitedOnly: query.invitedOnly ? "true" : undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

/* ---------- 信誉 ---------- */

export type ReputationKind = "account" | "device" | "node";

/**
 * 一份信誉记录。
 *
 * settled 是结算那一刻的分数，effective 是按回升速率算出来的**此刻**的分数 ——
 * 界面上要看 effective，显示 settled 会把早就自然回满的主体说成还在低分。
 */
export class ReputationView {
  subject = "";

  /** account:<账号> / device:<设备指纹> / node:<nodeId> 拆出来的前缀。 */
  kind: ReputationKind | "" = "";

  /** 冒号后面那一段。 */
  ref = "";

  ownerName = "";

  settled = 1;

  effective = 1;

  settledAt = "";

  updatedAt = "";

  /** 这个主体对应的机器，帮运营认出「这是谁的哪台」。 */
  nodes: BannedMachineNode[] = [];
}

export class ReputationPage {
  records: ReputationView[] = [];

  threshold = 1;

  /** 每天回升多少，封顶 1。解释「为什么过几天自己就好了」。 */
  recoveryPerDay = 0;
}

export async function fetchReputations(threshold = 0, limit = 100) {
  return getData(ReputationPage, "/galaxy/admin/reputations", { threshold: threshold || undefined, limit });
}

/** 人工设定信誉。**设成，不是加减** —— 点两次和点一次结果一样。 */
export async function setReputation(subject: string, value: number, reason: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/reputations/set", {
    subject,
    value,
    reason,
  });
  return unwrapApiResponse(response.data);
}

/* ---------- 三本账 ---------- */

export type LedgerSide = "consumer" | "provider" | "platform";

/**
 * amount 是什么量纲。**三侧不一样**，界面必须按它分开渲染 ——
 * 拿同一套「÷1,000,000 显示成元」去画消费侧那一列，会得到一个荒唐的小数，
 * 而看的人不会意识到自己在读一个错的数。
 *
 * - metering：计量数（token 之类），原样显示
 * - credit：微积分，÷1,000,000 是积分，1 积分 = ¥1
 * - money：微分，÷1,000,000 是元
 */
export type LedgerAmountUnit = "metering" | "credit" | "money";

/** 一行账本。三侧共用一个形状，各自没有的字段是空的。 */
export class LedgerEntry {
  txnId = "";

  type = "";

  unit = "";

  amount = 0;

  price = 0;

  /** 对应的工单号，排障时拿它去「运行工单」里查。 */
  unitId = "";

  keyId = "";

  balanceAfter = 0;

  cid = "";

  ownerUserId = "";

  ownerName = "";

  relatedUserId = "";

  createdAt = "";
}

/** 某一类流水的笔数与合计。按整个筛选条件算，不随分页变。 */
export class LedgerTypeTotal {
  type = "";

  count = 0;

  amount = 0;
}

export class AdminLedgerPage {
  total = 0;

  entries: LedgerEntry[] = [];

  totals: LedgerTypeTotal[] = [];

  side: LedgerSide | "" = "";

  days = 0;

  amountUnit: LedgerAmountUnit | "" = "";

  /** 这一侧会出现的流水类型，供下拉用 —— 别让运营去背 ref_clawback 这种字符串。 */
  types: string[] = [];
}

export async function fetchLedger(query: {
  side: LedgerSide;
  type?: string;
  keyword?: string;
  days?: number;
  offset?: number;
  limit?: number;
}) {
  return getData(AdminLedgerPage, "/galaxy/admin/ledger", {
    side: query.side,
    type: query.type || undefined,
    keyword: query.keyword || undefined,
    days: query.days || undefined,
    offset: query.offset ?? 0,
    limit: query.limit ?? 20,
  });
}

/* ---------- 运行参数 ---------- */

export type SettingKind = "int" | "float" | "duration" | "text";

export type SettingGroup =
  | "placement"
  | "score"
  | "key"
  | "artifact"
  | "risk"
  | "payout"
  | "referral"
  | "compliance"
  // client 这一组不在「运行参数」页上画：两个客户端下载地址有自己的位置
  // （「ai-bridge 版本」页顶上那张卡片），在两处都能改只会让人不知道该信哪一处。
  | "client";

/**
 * 一项可调参数。
 *
 * value 是此刻生效的值，default 是配置文件里的那份。overridden 为假表示这一项
 * 还跟着配置文件走 —— 「改回默认」做的是**删掉后台那一行**，不是写一个默认值进去。
 *
 * kind 为 duration 时，value 与 default 都是**毫秒**。
 */
export class SettingView {
  key = "";

  group: SettingGroup | "" = "";

  kind: SettingKind | "" = "";

  value = "";

  default = "";

  overridden = false;

  min = 0;

  max = 0;

  /** 单位提示：second / minute / hour / day / ratio / bps / seat / time / credit。 */
  unit = "";

  updatedBy = "";

  updatedAt?: string;
}

export class AdminSettingsPage {
  settings: SettingView[] = [];

  /**
   * 改完最多多少秒在全部进程上生效。
   *
   * 必须显示给运营看：各进程按自己的节奏回查，改完刷新页面没立刻看到效果是正常的。
   * 不说这句话，运营会以为没保存上，然后再改一遍。
   */
  propagationSeconds = 0;
}

export async function fetchSettings() {
  return getData(AdminSettingsPage, "/galaxy/admin/settings");
}

/** 改一项参数。reset 为真表示改回配置文件里的默认值。 */
export async function saveSetting(payload: { key: string; value?: string; reset?: boolean }) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/settings/save", payload);
  return unwrapApiResponse(response.data);
}
