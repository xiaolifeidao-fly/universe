"use client";

import { getData } from "@/utils/axios";

/**
 * 仪表盘。数据全部来自共享算力池（manager-api/pkg/galaxy 的 /galaxy/admin/dashboard），
 * 一次取回 —— 六个数六条请求的话，页面会一格一格地跳出来，而且刷新时每一格的
 * 时间点还不一样。
 *
 * 响应模型一律用 class 且字段带默认值：class-transformer 的 plainToInstance
 * 要有真实的类和已初始化字段才能反序列化（同 galaxy.api.ts）。
 */

export class DashboardAccountStat {
  /** 今天登录过的**人数**，不是次数。口径见服务端 dto 的注释。 */
  loggedIn = 0;

  registered = 0;

  /** 账号总数，含停用的。登录数要有分母才读得出意思。 */
  total = 0;
}

export class DashboardAccounts {
  provider: DashboardAccountStat = new DashboardAccountStat();

  consumer: DashboardAccountStat = new DashboardAccountStat();
}

export class DashboardMachines {
  online = 0;

  /** 在线机器里的散户。没有 provider 行的算散户 —— 注册默认就是散户。 */
  individual = 0;

  studio = 0;

  offline = 0;

  banned = 0;

  total = 0;
}

export class DashboardUsageUnit {
  unit = "";

  /** 量纲随 unit 而定：token 数 / 调用次数 / 秒。跨单位相加没有意义。 */
  amount = 0;

  consumerAmount = 0;

  providerAmount = 0;
}

export class DashboardUsageCategory {
  /** claude / codex / video / other；合计那一格是空串。 */
  category = "";

  tokens = 0;

  calls = 0;

  /** 微元。使用端花掉的（收入）。 */
  consumerAmount = 0;

  /** 微元。共享端挣到的（成本）。和上面不是同一个数，别相加。 */
  providerAmount = 0;

  /** = consumerAmount - providerAmount。可以是负的（结算价高过对外价时平台在倒贴）。 */
  margin = 0;

  units: DashboardUsageUnit[] = [];
}

export class DashboardUsage {
  categories: DashboardUsageCategory[] = [];

  total: DashboardUsageCategory = new DashboardUsageCategory();

  /** 汇总表封口到哪一刻；这之后的量是现算的。数字对不上时先看它。 */
  rolledUntil = "";
}

export class DashboardRevenue {
  /** 运营充积分时的实付金额（微元）。钱是今天进来的。 */
  rechargePaid = 0;

  /** 充进去的积分（微积分）。 */
  rechargePoints = 0;

  rechargeCount = 0;

  /** 渠道直接支付的订单金额（微元）。钱也是今天进来的。 */
  channelPaid = 0;

  channelCount = 0;

  /** 用积分买掉的订单。这笔钱在充值那天就进来过了，**不能算进今日充值**。 */
  pointsPaid = 0;

  pointsCount = 0;
}

export class DashboardCapacityUnit {
  unit = "";

  limit = 0;

  used = 0;

  left = 0;
}

export class DashboardCapacityWindow {
  /** 5h / day / week / month / total。 */
  window = "";

  limit = 0;

  used = 0;

  left = 0;

  machines = 0;

  contributions = 0;

  units: DashboardCapacityUnit[] = [];
}

export class DashboardCapacity {
  windows: DashboardCapacityWindow[] = [];

  /** 至少还有一档 token 额度有剩的在线机器数。 */
  machines = 0;

  onlineMachines = 0;

  /** 在线但一条 token 额度都没设的机器数。它们不在任何一档里。 */
  unlimited = 0;

  snapshotAt = "";

  /** 快照太旧：已用是旧数，剩余会偏多。 */
  stale = false;
}

export class AdminDashboard {
  generatedAt = "";

  date = "";

  dayStart = "";

  accounts: DashboardAccounts = new DashboardAccounts();

  machines: DashboardMachines = new DashboardMachines();

  usage: DashboardUsage = new DashboardUsage();

  revenue: DashboardRevenue = new DashboardRevenue();

  capacity: DashboardCapacity = new DashboardCapacity();

  /** 取不到的那几块。取不到就说取不到，不显示成 0。 */
  degraded: string[] = [];
}

export async function fetchDashboard() {
  return getData(AdminDashboard, "/galaxy/admin/dashboard");
}
