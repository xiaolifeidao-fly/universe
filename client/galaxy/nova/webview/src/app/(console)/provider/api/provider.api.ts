"use client";

import { plainToInstance } from "class-transformer";

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

/**
 * 一条**上游余量下限**：上游某个窗口只剩这么多的时候，这条贡献就不再接新单。
 *
 * 和「每日上限」那几条不是一回事，两个都要有：
 *   每日上限   主人打算放多少出去   —— 平台按它计量，到顶就排空
 *   余量下限   给自己留多少         —— 上游账号本身快见底时先停下
 * 前者填得再小，也拦不住「这个月的 Claude 额度被别人跑光了」。
 */
export class UpstreamFloor {
  /** 空串 = 任一窗口。填了就只看那一个（5h / 7d）。 */
  window = "";

  /** **剩余**百分比的下限，0–100。剩余 ≤ 它就停。 */
  percent = 0;
}

/**
 * 此刻是哪条线把这条贡献挡住了。服务端算好给的 —— 和派单那一侧是同一个函数，
 * 界面再算一遍的话，迟早出现「页面说正常接单，实际一单也派不进来」。
 */
export class UpstreamBlock {
  window = "";

  percent = 0;

  /** 此刻实际还剩多少。 */
  left = 0;

  /** 真正触线的那个桶在上游那边叫什么。一个窗口可能有好几个桶。 */
  bucket = "";
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

  /**
   * 这条车道是哪一家的算力：claude / codex / video / other。服务端算好给的。
   *
   * 别在前端按 cid 或 provider 自己认：cid 是主人在那台机器上起的配置键，
   * 叫什么都行；provider 是路由键，认它等于把「claude_oauth 算 Claude」
   * 这条规则在每个端各抄一遍。模型候选（fetchModelOptions）就按它取。
   */
  category = "";

  /**
   * 这条车道加入了哪些**模型分组**（mg_…）。空 = 不限，什么分组的单都接。
   *
   * 这是这条车道**唯一**的范围设置：分组属于某一个模型，加入了哪些分组，
   * 就等于提供那些模型的那几档能力。2026-09-22 之前旁边还有一份模型通配名单
   * （modelsAllow / modelsDeny），已经撤掉 —— 两道闸并排摆着的时候，
   * 勾了分组却接不到单，界面上看不出是谁拦的。
   */
  groups: string[] = [];

  /**
   * 节点探测到的上游可用模型，随 hello 报上来。**只作标注**，不参与调度：
   * 界面拿它在模型旁边写一句「这台机器有」。
   *
   * 它是探测来的事实，上游抽一次风就会空半天 —— 所以它不能当清单用，
   * 列出来的模型以平台目录为准（fetchModelOptions）。
   */
  availableModels: string[] = [];

  seats = 0;

  seatConcurrency = 0;

  status = "";

  /**
   * 主人点了关闭、正在等在途请求跑完时，要落到的那个状态（paused / disabled）。
   *
   * 非空就意味着这条已经**不接新单**了，只是手上的活还没跑完。界面要把它和
   * 「共享中」分开画：都显示成开着的话，主人会以为没点上，然后反复点。
   */
  pendingStatus = "";

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

  /**
   * 上游账号此刻还剩多少。undefined = 这台机器还没观测到过（一次中转都没跑过，
   * 或者这一版 ai-bridge 还不报）—— 和「剩 0」不是一回事，界面要分开。
   */
  upstreamUsage?: UpstreamUsage;

  upstreamUsageAt?: string;

  /**
   * 主人设的余量下限。服务端保证至少一条 —— 界面不必判空。
   *
   * 嵌套对象不经过 class-transformer（项目里没用 @Type），拿到的是普通对象。
   */
  upstreamFloors: UpstreamFloor[] = [];

  /**
   * 此刻被余量下限挡住了没有。undefined = 没被挡。
   *
   * 它是**第三种状态**，界面上要和另外两个分开说：主人没关（status 还是 active）、
   * 机器也好着（available 为真），只是上游快用完了，窗口重置之后自己会回来。
   * 混进前两者里，主人会去开一个本来就开着的开关。
   */
  upstreamBlock?: UpstreamBlock;

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

  /**
   * 这台机器怎么接进池子。
   *
   * poll：机器自己来领活 —— Nova 客户端只有这一种。
   * export：独立部署的 ai-bridge 把自己暴露在公网上，由平台主动回连。
   *
   * 要露在界面上：两种方式的排障路径完全不同，而主人自己往往说不清
   * 机房里那台是怎么配的。
   */
  accessMode: "poll" | "export" = "poll";

  /** export 机器的公网入口。不含密钥 —— 密钥永远不出服务端。 */
  endpointUrl = "";

  /**
   * 最近一次回连探测：ok / unreachable，还没探过是空串。
   *
   * 和 status 是两件事：心跳是节点主动出站的，公网入口不通照样能心跳。
   * 分开显示，主人才看得出「进程活着，但端口没映射对」。
   */
  endpointStatus = "";

  /** 回连失败的原因，人话，直接展示。 */
  endpointError = "";

  endpointCheckedAt?: string;

  contributions: ContributionView[] = [];

  /** 平台名，和安装包同一套：linux-x64、darwin-arm64、windows-x64……老节点不报，是空串。 */
  platform = "";

  /**
   * ai-bridge 是怎么装上的。cli：独立部署的命令行，能远程升级；nova：随 Nova 应用分发，
   * 跟着应用更新。老节点不报，是空串 —— 那一版还不认远程升级指令。
   */
  distribution = "";

  /** 节点自己报的「此刻为什么不能远程升级」，人话，原样展示；空串是没有障碍。只对 cli 有意义。 */
  upgradeBlocker = "";

  /** 这台机器所在平台最新的已发布版本；空串是平台还没发布这个平台的包。 */
  latestVersion = "";

  /** 服务端算好的：cli 且 latestVersion 比 bridgeVersion 新。按钮能不能点以它为准，前端不自己比。 */
  upgradeAvailable = false;

  /**
   * 最近一次远程升级；从没升级过就没有。
   *
   * 嵌套对象不经过 class-transformer（项目里没用 @Type），拿到的是服务端原样的普通对象，
   * NodeUpgrade 上的默认值在这里不生效 —— 读的时候按可能缺字段处理。
   */
  upgrade?: NodeUpgrade;
}

export type NodeUpgradeStatus = "pending" | "downloading" | "installing" | "restarting" | "succeeded" | "failed";

export class NodeUpgrade {
  id = "";

  /** 目标版本。 */
  version = "";

  /** 发起时的版本。 */
  fromVersion = "";

  status: NodeUpgradeStatus = "pending";

  /** 人话，原样显示：节点报的进度、失败原因，或者服务端判的超时。 */
  message = "";

  requestedAt?: string;

  updatedAt?: string;
}

const UPGRADE_IN_PROGRESS = new Set<string>(["pending", "downloading", "installing", "restarting"]);

/**
 * 这次升级还没到终态。卡太久的服务端已经折算成 failed，前端不自己算超时 ——
 * 两边各算一套，就会出现这边说超时、机器那边其实刚装完。
 */
export function isUpgradeInProgress(upgrade: NodeUpgrade | undefined): boolean {
  return Boolean(upgrade && UPGRADE_IN_PROGRESS.has(upgrade.status));
}

const BRIDGE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * candidate 是不是比 current 新。规则和节点、服务端同一套：先比三段数字；数字相同时
 * 没有预发布后缀的更大；两个都有后缀按字符串比。
 *
 * 只用来显示「（最新 x）」—— 随 Nova 分发、版本太旧的机器 upgradeAvailable 恒为 false，
 * 可主人照样该知道有新版。任何一边认不出来就当不新，宁可少说一句也不乱说。
 */
export function isNewerBridgeVersion(candidate: string, current: string): boolean {
  const next = BRIDGE_VERSION.exec((candidate ?? "").trim());
  const now = BRIDGE_VERSION.exec((current ?? "").trim());
  if (!next || !now) return false;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(next[index]) - Number(now[index]);
    if (delta !== 0) return delta > 0;
  }
  if (!next[4] || !now[4]) return !next[4] && Boolean(now[4]);
  return next[4] > now[4];
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

/** 机器在界面上叫什么。主人没起名（刚注册、还没 hello）时退回节点 ID，不显示成空白。 */
export function nodeDisplayName(node: NodeView): string {
  return node.displayName || node.nodeId;
}

/**
 * 机器列表的顺序：这台电脑钉在第一个，其余按名字排（机房-2 排在机房-10 前面）。
 *
 * 「今天」和「共享设置」必须是同一个顺序，不然主人每换一页都得把机器重新找一遍。
 *
 * 刻意不按在线状态排：列表 20 秒刷一次，机器一上下线就挪位置，
 * 鼠标正要点的那一行会从手底下跑掉。在不在线看状态点。
 */
export function orderMachines(nodes: NodeView[], localNodeId: string): NodeView[] {
  return [...nodes].sort((left, right) => {
    const local = Number(right.nodeId === localNodeId) - Number(left.nodeId === localNodeId);
    if (local !== 0) return local;
    return nodeDisplayName(left).localeCompare(nodeDisplayName(right), undefined, { numeric: true });
  });
}

/**
 * 界面上该出现哪几台机器。
 *
 * 散户只管自己坐着的这一台。名下万一还挂着别的（早先是工作室、或者拿接入密钥注册过服务器），
 * 也不摆出来 —— 散户的控制台就是「这台电脑」的控制台，机房那一套整块不给；
 * 另一台自家电脑在它自己的 Nova 里管，本来也不必从这台遥控。
 *
 * 认不出本机是哪一台时（纯浏览器里没有 bridge 可问）不筛：筛出来是空的，
 * 整页会变成「还没有机器」，比多列一台更误导。
 */
export function visibleNodes(nodes: NodeView[], studio: boolean, local: { nodeId: string } | null): NodeView[] {
  if (studio || !local) return nodes;
  return nodes.filter((node) => node.nodeId === local.nodeId);
}

/* ---------- 接入密钥（独立部署的 ai-bridge 用） ---------- */

/**
 * 一把接入密钥。**不含明文** —— 明文只在签发那一次返回。
 *
 * 它和配对码的分工：配对码一次性、十分钟有效，给「人同时看着两块屏幕」的
 * Nova 客户端用；接入密钥长期有效，写进机房里那台机器的配置，重启之后它
 * 自己就能重新注册。代价是它值钱得多 —— 拿到它的人能以你的名义往池子里加机器。
 */
export class ProviderKeyView {
  keyId = "";

  alias = "";

  /** active / revoked */
  status = "";

  lastUsedAt?: string;

  /** 最近一次用它注册出来的机器。主人靠它判断「这把密钥还有谁在用」。 */
  lastNodeId = "";

  expiresAt?: string;

  createdTime = "";
}

/** 签发结果。secret 是唯一一次能看到明文的地方，界面必须当场让人复制走。 */
export class IssuedProviderKey extends ProviderKeyView {
  secret = "";
}

export async function fetchProviderKeys() {
  return getDataList(ProviderKeyView, "/galaxy/provider/access-keys");
}

export async function issueProviderKey(payload: { alias?: string; expiresInDays?: number }) {
  const response = await instance.post<ApiResponse<IssuedProviderKey>>("/galaxy/provider/access-keys", payload);
  return unwrapApiResponse(response.data);
}

/**
 * 吊销。已经用它注册出来的机器**不受影响** —— 它们手里是各自的节点令牌。
 * 要停哪一台，去机器列表里解绑那一台。
 */
export async function revokeProviderKey(keyId: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/access-keys/revoke", { keyId });
  return unwrapApiResponse(response.data);
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

  /**
   * 这一次落在哪个**分组**上。结算单价按分组定，所以它解释得了「同一个模型，
   * 这一行为什么记了比隔壁行多得多的积分」。老记录、分组被删掉的都是空串。
   */
  groupId = "";

  groupName = "";

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

  /** 这一次是哪台机器跑的。nodeName 是主人给机器起的名字，机器解绑了也照样有。 */
  nodeId = "";

  nodeName = "";
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
  /**
   * 加入哪些模型分组。**整份提交**（空数组 = 不限，什么都接）——
   * 漏传会被服务端当成「清空」，而清空的意思正是「不限」，两者恰好相反。
   */
  groups: string[];
  seats: number;
  seatConcurrency: number;
  quota: QuotaGrantInput[];
  schedule: ScheduleWindow[];
  /** 必填：不给的话服务端会落一条「任一窗口剩 0% 停」，也就是不额外保护。 */
  upstreamFloors: UpstreamFloor[];
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

/**
 * 一个模型底下的一个**分组**：平台在这个模型上卖的一个档次，以及它的**结算价**。
 *
 * 卡片上那几个数是模型通价 —— 没单独定价的分组都按它结。这个列表列的是
 * 这个模型在卖的分组，一个都没有时是空的。
 */
export class ModelGroupPrice {
  groupId = "";

  name = "";

  summary = "";

  isDefault = false;

  inputPrice = 0;

  outputPrice = 0;

  cachePrice = 0;

  /** 缓存写入 5 分钟档。名字不带 5m 是历史包袱，别改：旧版本桌面端还在读它。 */
  cacheWritePrice = 0;

  /** 缓存写入 1 小时档。只有 Claude 一族有这个数。 */
  cacheWrite1hPrice = 0;
}


/**
 * 模型页的一行：这个模型是什么，跑它能记多少积分。
 *
 * 四档单价是**结算价**，也就是记进你积分账户的那个数 —— 不是平台对外收的价。
 * 这条接口里没有对外价，也就反推不出平台抽了几成；那是运营台的事。
 */
export class ProviderModelView {
  modelId = "";

  displayName = "";

  vendor = "";

  family = "";

  kind = "";

  contextTokens = 0;

  maxOutputTokens = 0;

  tags: string[] = [];

  summary = "";

  badgeText = "";

  badgeTone = "";

  /** 每百万 token 记多少微积分。0 = 这一档没有价，不是免费。 */
  inputPrice = 0;

  outputPrice = 0;

  cachePrice = 0;

  /**
   * 缓存写入两档：5 分钟与 1 小时，单价差 1.6 倍。
   *
   * 哪一档由使用者的客户端在请求体的 cache_control 里写，共享端这边只是照单记账 ——
   * 接到一笔 1h 的缓存写入，记的积分比 5m 多六成。只有 Claude 一族会分这两档，
   * Codex 一族恒为 0，界面上按 family 决定摆不摆。
   */
  cacheWritePrice = 0;

  cacheWrite1hPrice = 0;


  /** 这四个数是这个模型自己的价，还是回落到了该能力的统一价。 */
  priced = false;

  /**
   * 这个模型在卖的分组，价是**结算价**。空 = 这个模型还没建分组。
   *
   * 深档那个分组烧掉的推理 token 多一个量级，往往也单独加过价 ——
   * 「跑哪个模型的哪个分组更赚」这个问题要靠它才答得了。
   *
   * 嵌套对象不经过 class-transformer（项目里没用 @Type），拿到的是普通对象。
   */
  groups: ModelGroupPrice[] = [];

  /** 你名下至少有一条车道加入了的分组。 */
  joinedGroups: string[] = [];

  /** 你名下至少有一条车道是「不限分组」—— 那种车道什么分组的单都接。 */
  groupsUnrestricted = false;

  /**
   * 你有没有开放这个模型 —— 也就是加入了它底下的某个分组（或者那条车道不限分组）。
   * 和「机器上有没有」是两回事：开放了但上游没有，照样接不到单。
   */
  allowed = false;

  /** 至少有一台机器的上游真的有这个模型（节点报上来的事实）。 */
  available = false;

  /** 最近 7 天这个模型给你记了多少微积分。 */
  earned7d = 0;

  sortOrder = 0;
}

export async function fetchProviderModels() {
  return getDataList(ProviderModelView, "/galaxy/provider/models");
}

/** 候选项里的一个模型。只有名字和它底下的分组 —— 填规则的时候用不上价。 */
export class ModelOption {
  modelId = "";

  displayName = "";

  /**
   * 这个模型在卖的分组，**带结算价**。共享设置里勾的就是它。
   *
   * 价要跟着来：勾不勾一个分组本来就是「这一档值不值得我接」的决定，
   * 让人先记住数字再切到「模型」那一页去比，等于把一个决定拆成两步做。
   */
  groups: ModelGroupPrice[] = [];
}

/**
 * 平台在卖的模型，按厂商分一组。共享设置里「接哪些模型」那份清单就是它。
 *
 * 用 category 去取自己那一组（和 ContributionView.category 同一套词）：
 * relay_claude 那条车道只该看见 Claude 的模型 —— 给它列一排 gpt，
 * 选中了也是白选，派过去只换来一次失败。
 *
 * 嵌套对象不经过 class-transformer（项目里没用 @Type），models 拿到的是普通对象。
 */
export class ModelOptionGroup {
  category = "";

  vendor = "";

  family = "";

  models: ModelOption[] = [];
}

export async function fetchModelOptions() {
  return getDataList(ModelOptionGroup, "/galaxy/provider/model-options");
}

export async function fetchNodes() {
  return getDataList(NodeView, "/galaxy/provider/nodes");
}

/**
 * 解绑掉的机器，账户页「已解绑」那一栏用。最近解绑的在前，不带能力（解绑时已经关掉了）。
 *
 * 和 fetchNodes 是两个接口而不是一个开关：今天、共享设置都靠 fetchNodes 不含解绑的行。
 */
export async function fetchRetiredNodes() {
  return getDataList(NodeView, "/galaxy/provider/nodes/retired");
}

export async function revokeNode(nodeId: string) {
  const response = await instance.post<ApiResponse<string>>("/galaxy/provider/node/revoke", { nodeId });
  return unwrapApiResponse(response.data);
}

/**
 * 远程升级一台 cli 机器。只是下发指令：机器下一次心跳领走，之后的进度看 NodeView.upgrade。
 * 条件不满足时服务端回人话（不在线、随 Nova 分发、版本太旧、有障碍、没有包、已是最新、正在升级），原样弹出。
 */
export async function requestNodeUpgrade(nodeId: string) {
  const response = await instance.post<ApiResponse<NodeUpgrade>>("/galaxy/provider/node/upgrade", { nodeId });
  return unwrapApiResponse(response.data);
}

/* ---------- ai-bridge 安装包 ---------- */

/** 一个平台最新的已发布安装包。 */
export class BridgeReleasePackage {
  /** <系统>-<架构>：linux-x64、linux-arm64、darwin-arm64、darwin-x64、windows-x64、windows-arm64。 */
  platform = "";

  version = "";

  fileName = "";

  size = 0;

  /** 整个压缩包的 sha256，小写十六进制。 */
  sha256 = "";

  signature = "";

  /** Hub 上的稳定地址（302 到 OSS），不会过期，可以写进脚本和文档。 */
  downloadUrl = "";

  notes = "";

  publishedAt?: string;
}

/**
 * 安装包清单。version / notes / publishedAt 取所有平台里最新的那个；一个包都没发布时
 * version 是空串、platforms 是空数组。platforms 由服务端排好序，每个平台只列最新一个。
 *
 * platforms 里的每一项同 NodeView.upgrade，是没经过转换的普通对象。
 */
export class BridgeReleaseManifest {
  version = "";

  notes = "";

  publishedAt?: string;

  /** Hub 的对外地址。手动安装那几行 register 命令用它。 */
  hubUrl = "";

  /**
   * 一行安装脚本（sh）的地址，Hub 地址已经写在脚本里。
   *
   * 服务端还会带一个 installPowerShell（Windows 版），这里不接：手装 ai-bridge 只给 Linux，
   * 见「安装 ai-bridge」那一块的文件头注释。
   */
  installScript = "";

  platforms: BridgeReleasePackage[] = [];
}

export async function fetchBridgeReleases() {
  return getData(BridgeReleaseManifest, "/galaxy/provider/bridge/releases");
}

/**
 * 一次开关的结果。
 *
 * 关闭不一定立即生效：手上还有请求在跑时是**排队** —— 先停止接新单，在途跑完
 * 自动落地。只看「请求成功了」就把开关画成关上，主人会以为已经停了，
 * 而那台机器还在给别人干活。所以这几个字段必须带回来。
 */
export class ContributionStatusResult {
  /** 现在的状态。排队时是 draining（已停止接新单）。 */
  status = "";

  /** 等在途跑完之后要落到的状态；空串表示这次已经落地了。 */
  pending = "";

  /** 还有几条请求在跑。 */
  inflight = 0;

  /** 强制关闭掐断了几条。 */
  aborted = 0;

  /** 这次扣了多少信誉分（负数）。0 表示没扣。 */
  reputationDelta = 0;
}

/**
 * 开关一条贡献。
 *
 * **nodeId 不能省。** cid 在视图里是去掉节点前缀的短名（relay_codex），主人有两台
 * 机器时必然重名；不带节点，服务端只能在重名里挑一个，而它挑的是最老那台 ——
 * 表现就是点了报成功、界面完全没变，因为改的不是你看的那条。
 *
 * force 是「别等了，现在就关」：它会把在跑的请求当场掐断，那是消费者眼里的一次
 * 失败，所以要扣信誉分。只在主人明确确认过之后才传 true —— 默认的关闭不掐任何东西。
 */
export async function setContributionStatus(
  nodeId: string,
  cid: string,
  status: "active" | "paused" | "disabled",
  force = false,
) {
  const response = await instance.post<ApiResponse<ContributionStatusResult>>(
    "/galaxy/provider/contribution/status",
    { nodeId, cid, status, force },
  );
  return plainToInstance(ContributionStatusResult, unwrapApiResponse(response.data) ?? {});
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

  /**
   * 累计邀请奖励净额（已扣掉申诉追回）。不是和上面并列的一个桶：邀请奖励本身也记在
   * available / pending / total 里，这里只是单独报一下其中有多少来自邀请。
   *
   * credits 在 ProviderDashboard 里是嵌套对象，不经过转换 —— 老服务端不带这个字段时读到的是 undefined。
   */
  referral = 0;
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
