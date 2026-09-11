"use client";

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
 */
export async function setGalaxyUserStatus(userId: string, status: GalaxyAccountStatus) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/users/status", { userId, status });
  return unwrapApiResponse(response.data);
}

/** 替忘了密码的人设临时密码（8 个字符起，不超过 72 个字节）。现有令牌作废，本人下次登录必须先改掉它。 */
export async function resetGalaxyUserPassword(userId: string, password: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/admin/users/password", { userId, password });
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
