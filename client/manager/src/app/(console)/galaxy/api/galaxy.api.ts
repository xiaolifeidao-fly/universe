"use client";

import { getData, getDataList, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

/**
 * 共享算力池的运营接口。请求路径都在 /galaxy/admin 下，
 * 由代理按前缀分流到 galaxy-api（见 src/pages/api/[...all].ts）。
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

  lastBeatAt?: string;

  contributions: ContributionView[] = [];
}

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
