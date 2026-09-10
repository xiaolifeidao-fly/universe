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

  /**
   * 节点探测到的上游可用模型，随 hello 报上来。**只是候选项**，不参与调度。
   *
   * 和 modelsAllow/modelsDeny 是两回事：那两个是主人定的规则，而且支持通配
   * （`claude-sonnet-*` 前缀匹配、`*` 全放）—— 所以那两个框必须保留自由输入，
   * 不能因为有了候选项就做成纯下拉。
   */
  availableModels: string[] = [];

  seats = 0;

  seatConcurrency = 0;

  status = "";

  reputation = 1;

  online = false;

  seatsUsed = 0;

  seatsEffective = 0;

  inflight = 0;

  /**
   * 节点报的「这台机器现在能不能干这件事」。
   *
   * 和 status（主人愿不愿意共享）是两回事，界面上必须分开显示：
   * 一个是「你自己关掉了」，另一个是「你的 Claude 登录态过期了」——
   * 处置方式完全不同，混成一个状态灯只会让人去关一条本来就没在跑的贡献。
   */
  available = true;

  /** 不可用的原因，人话，直接展示（「请运行 claude auth login」）。 */
  unavailableReason = "";

  /** 有多少消费者绑在这条贡献上。大于 0 时不允许下线。 */
  seatsBound = 0;

  quota: QuotaStatus[] = [];

  schedule: ScheduleWindow[] = [];

  throttledUntil?: string;
}

/**
 * 控制台里不展示的能力。
 *
 * 只是**不显示**，不影响调度 —— 节点照样探测和上报，Hub 那边的贡献行也还在，
 * 主人之前设过的开关和额度都留着。哪天想放出来，把这里清空即可。
 *
 * video.edit.render 目前不对外露出：它的实现是完整的，但产品上还没打算把
 * 视频渲染算力放进共享池，摆在界面上只会让主人以为该配点什么。
 */
export const HIDDEN_KINDS = new Set(["video.edit.render"]);

/** 过滤掉不展示的能力。列表可能是 undefined（刚配对、还没 hello 的机器）。 */
export function visibleContributions(rows: ContributionView[] | undefined): ContributionView[] {
  return (rows ?? []).filter((row) => !HIDDEN_KINDS.has(row.kind));
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

/**
 * 这台机器现在算不算在线。
 *
 * 只有一处定义，因为它同时决定两件互相矛盾不得的事：机器列表上那个绿标，
 * 和「还让不让你再配对一台」。两边各写一份判断，迟早会出现列表说在线、
 * 上面却还摆着「生成配对码」的自相矛盾。
 *
 * status 由服务端巡检维护（心跳过期就降为 offline），所以这里不再自己看
 * lastBeatAt —— 那等于在前端另立一套判活标准。封禁的机器不算在线：它已经
 * 接不了活，显示成在线只会让主人以为一切正常。
 */
export function isNodeOnline(node: NodeView): boolean {
  return !node.banned && node.status === "active";
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

  /**
   * 这一次记了多少积分。来自账本，不是用量乘单价 ——
   * 分成比例改过之后，前端重算出来的和账上的对不上。
   */
  credits = 0;

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
  /** 必须带上：cid 是去掉节点前缀的短名，多台机器上会重名。 */
  nodeId: string;
  cid: string;
  modelsAllow: string[];
  modelsDeny: string[];
  seats: number;
  seatConcurrency: number;
  quota: QuotaGrantInput[];
  schedule: ScheduleWindow[];
}

/**
 * 提供者的 ai-bridge 要填的 pool.hubURL。由服务端给（配置在
 * galaxy.provider_hub_url / galaxy.consumer_base_url），前端不自己拼 ——
 * 控制台的 origin 不等于 Hub 的对外地址：控制台是 Next 站点，节点直连的是
 * Go 服务端那个端口，中间还可能隔着反代和 TLS。
 */
export class ProviderEndpoint {
  hubUrl = "";
}

export async function fetchProviderEndpoint() {
  return getData(ProviderEndpoint, "/galaxy/provider/endpoint");
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

/**
 * 开关一条贡献。
 *
 * **nodeId 不能省。** cid 在视图里是去掉节点前缀的短名（relay_codex），主人有两台
 * 机器时必然重名；不带节点，服务端只能在重名里挑一个，而它挑的是最老那台 ——
 * 表现就是点了报成功、界面完全没变，因为改的不是你看的那条。
 */
export async function setContributionStatus(
  nodeId: string,
  cid: string,
  status: "active" | "paused" | "disabled",
) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/contribution/status", {
    nodeId,
    cid,
    status,
  });
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

/* ---------- 今天 / 收益 / 分页记录 ---------- */

export class DayStats {
  calls = 0;

  failed = 0;

  usage: Record<string, number> = {};

  credits = 0;

  avgDurationMs = 0;
}

export class CreditSummary {
  available = 0;

  pending = 0;

  withdrawn = 0;

  today = 0;

  week = 0;

  month = 0;

  total = 0;
}

export class DailyPoint {
  date = "";

  amount = 0;
}

export class ProviderDashboard {
  nodes = 0;

  online = false;

  /** 本轮连续在线的起点。掉线再上线会重新计，不是「累计共享了多久」。 */
  sharingSince?: string;

  credits: CreditSummary = new CreditSummary();

  today: DayStats = new DayStats();

  yesterday: DayStats = new DayStats();

  trend: DailyPoint[] = [];
}

export class CreditLedgerEntry {
  type = "";

  amount = 0;

  unit = "";

  unitId = "";

  cid = "";

  createdAt = "";
}

export class CreditLedgerPage {
  total = 0;

  entries: CreditLedgerEntry[] = [];
}

export class ProviderRecordPage {
  total = 0;

  records: ExecutionRecord[] = [];

  /** 统计的是**当前筛选条件**下的全部，不是当前这一页。 */
  stats: DayStats = new DayStats();

  models: string[] = [];
}

export class PayoutView {
  payoutId = "";

  credits = 0;

  /** 微分。前端不自己按积分乘兑换比 —— 那个比例只有服务端说了算。 */
  amount = 0;

  currency = "CNY";

  fee = 0;

  method = "";

  /** 已打码，原样的收款账号不出服务端。 */
  account = "";

  status = "";

  note = "";

  handledAt?: string;

  createdTime = "";
}

export async function fetchDashboard() {
  return getData(ProviderDashboard, "/galaxy/provider/dashboard");
}

export async function fetchLedger(params: { type?: string; offset?: number; limit?: number }) {
  return getData(CreditLedgerPage, "/galaxy/provider/ledger", params);
}

/**
 * 分页版执行记录。paged=1 是给服务端的信号：老形状是一个数组，
 * 带上它才返回 {records,total,stats}，还没改的调用方不受影响。
 */
export async function fetchRecordPage(params: {
  cid?: string;
  model?: string;
  state?: string;
  day?: string;
  offset?: number;
  limit?: number;
}) {
  return getData(ProviderRecordPage, "/galaxy/provider/records", { ...params, paged: 1 });
}

export async function fetchPayouts(limit = 20) {
  return getDataList(PayoutView, "/galaxy/provider/payouts", { limit });
}

export async function createPayout(payload: { credits: number; method: string; account: string }) {
  const response = await instance.post<ApiResponse<PayoutView>>("/galaxy/provider/payouts", payload);
  return unwrapApiResponse(response.data);
}
