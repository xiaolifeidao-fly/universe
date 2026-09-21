/**
 * 门户数据的形状与取数。
 *
 * 取数刻意放在**服务端**（React Server Component 里直接 fetch Go 服务端），
 * 而不是照控制台的样子在浏览器里 axios 一次：
 *
 *   · 门户是给陌生人和搜索引擎看的。浏览器取数意味着首屏是一圈转菊花，
 *     价格和模型都进不了 HTML —— 一个搜不到自家模型和价格的门户没有意义；
 *   · 这几条接口本来就没有用户维度，没有 token 要带，服务端取正合适。
 *
 * 表单提交（联系我们）仍然走浏览器 + Next.js 代理那条老路，见 utils/axios.ts。
 *
 * 这个文件只有形状，没有取数 —— 客户端组件也要 import 这些类型来声明 props，
 * 而取数那半带着 SERVER_TARGET，只能在服务端跑（见 portal.server.ts）。
 */

export interface PortalStats {
  models: number;
  vendors: number;
  families: number;
  currency: string;
  maxContext: number;
  keyTtlDays: number;
  freezeDays: number;
  concurrency: number;
  rpm: number;
  /** 部署方声明的可用性承诺。没配就是空串 —— 那一格干脆不显示。 */
  availability?: string;
}

export interface PortalFamily {
  family: string;
  vendor?: string;
  count: number;
  minInput: number;
  currency: string;
}

/**
 * 一个模型在某一档推理强度上的单价，口径与模型那一行的单价完全一致。
 *
 * 服务端只下发**真的单独定过价**的那几档，由浅到深；没在这张表里的强度按模型
 * 那一行的价收。一档都不列的模型就是不分强度 —— 把六档一律铺开、每档都等于
 * 那一行的数，说的是「分了档但都一样」，而那会让人以为运营填漏了价。
 */
export interface PortalEffortPrice {
  /** 档位名，上游原生：Claude 是 low…max，Codex 是 minimal…high。 */
  effort: string;
  inputPrice: number;
  outputPrice: number;
  cachePrice: number;
  cacheWritePrice: number;
}

export interface PortalModel {
  modelId: string;
  displayName: string;
  vendor?: string;
  family: string;
  kind: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  inputPrice: number;
  outputPrice: number;
  cachePrice: number;
  cacheWritePrice: number;
  /** 官方参考价，同口径同币种。0 = 运营没声明，那一档不划线。 */
  listInputPrice?: number;
  listOutputPrice?: number;
  listCachePrice?: number;
  /** 比官方参考价便宜多少，万分之一（8500 = 省 85%）。服务端按输出价算好，门户不再自己减一遍。 */
  discountBps?: number;
  currency: string;
  tags?: string[];
  summary?: string;
  /** 卡片角标与它的配色（hot/new/value/neutral）；文案为空就没有角标。 */
  badgeText?: string;
  badgeTone?: string;
  featured: boolean;
  /** false 表示这几个价来自 kind 的统一价，不是这个模型自己的。 */
  priced: boolean;
  /**
   * 按推理强度单独定过价的那几档，由浅到深。空 = 不分强度，上面那几个数就是全部。
   *
   * 服务端可能整个键都不给（omitempty），所以读的时候一律当可能缺。
   */
  efforts?: PortalEffortPrice[];
  sortOrder: number;
}

export interface PortalPrice {
  kind: string;
  unit: string;
  price: number;
  currency: string;
}

export interface PortalOverview {
  endpoint: string;
  stats: PortalStats;
  families: PortalFamily[];
  models: PortalModel[];
  prices: PortalPrice[];
  updatedAt: string;
}

/**
 * 服务端不可达时的兜底。
 *
 * 一个空对象，不是一份假数据 —— 页面拿到它会把「模型」「定价」这些区块渲染成
 * 空态，而首页的结构性文案（我们是谁、怎么接入）照常在。门户宁可少一块内容，
 * 也不能整页 500：那是陌生人对这个产品的第一印象，也是最后一次。
 */
export const EMPTY_OVERVIEW: PortalOverview = {
  endpoint: "",
  stats: {
    models: 0, vendors: 0, families: 0,
    currency: "CNY", maxContext: 0,
    keyTtlDays: 30, freezeDays: 30, concurrency: 4, rpm: 120,
  },
  families: [],
  models: [],
  prices: [],
  updatedAt: "",
};
