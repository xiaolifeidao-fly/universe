/**
 * 门户取数。只在 React Server Component 里调用 —— 它读 SERVER_TARGET，
 * 那是只有服务端才有的环境变量。类型在 utils/portal.ts，两边都要用。
 */

import "server-only";

import { EMPTY_OVERVIEW, type PortalOverview } from "@/utils/portal";

interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string | null;
}

function endpointURL(path: string): string {
  const target = (process.env.SERVER_TARGET ?? "http://127.0.0.1:10004").replace(/\/+$/, "");
  const prefix = process.env.APP_URL_PREFIX ?? "/api";
  return `${target}${prefix}${path}`;
}

/**
 * 取门户整站数据。
 *
 * revalidate 60 秒：目录和价格是运营改的，不是实时数据，一分钟的陈旧换来的是
 * 每分钟只打一次后端 —— 而后端那边还有一层 30 秒缓存，两层加起来，
 * 门户被爬也压不到数据库。
 */
export async function fetchOverview(): Promise<PortalOverview> {
  try {
    const response = await fetch(endpointURL("/galaxy/portal/overview"), {
      next: { revalidate: 60 },
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return EMPTY_OVERVIEW;
    const envelope = (await response.json()) as Envelope<PortalOverview>;
    if (!envelope?.success || !envelope.data) return EMPTY_OVERVIEW;
    // stats 要单独兜一层：浅合并只补顶层的键，对面一旦给回 stats: null
    // （字段改成指针、或者 SERVER_TARGET 指错了一个同样套信封的服务），
    // 首屏读 stats.models 当场就崩。
    return { ...EMPTY_OVERVIEW, ...envelope.data, stats: { ...EMPTY_OVERVIEW.stats, ...(envelope.data.stats ?? {}) } };
  } catch {
    // 后端没起来是开发态的常态，也可能是一次线上抖动。两种情况下门户都该照常打开。
    return EMPTY_OVERVIEW;
  }
}
