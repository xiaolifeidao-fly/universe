import type { NextApiRequest, NextApiResponse } from 'next';
import { product } from '../../utils/product';

/**
 * 桌面壳启动时探的那一下。它**只回这份包是哪个端**，这一项不打后端 ——
 * 后端没起的时候也应该能判断「界面自己活了」（见 common/electron/main.ts 的 probe，
 * 那边探不通就直接弹「连不上控制台」，壳连界面都不加载）。
 *
 * 顺带回这个端的更新目录：壳本来就要探这一下才肯加载界面，而「更新包放在 OSS 的哪儿」
 * 是部署的一部分。放在这里而不是冻进安装包，换桶不用重新打包 —— 装出去的壳改不了，
 * 冻进去之后换一次桶就等于所有老版本永远收不到更新。
 *
 * 这个值**不在界面这一侧维护**：它由后端从发版用的同一份 oss.* 推出来
 * （<publicHost 或 endpoint>/<dirPrefix>，见 server/common/objectstore 的
 * PublicPrefixURL）。发版页往 <dirPrefix>/<端>/ 写清单，客户端就去同一个地方取；
 * 界面另配一个地址等于养第二份真相，而两份对不上的症状是客户端 404 ——
 * 表现为「安静地不更新」，没有任何人会收到告警。
 */
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const base = await updateFeedBase();
  res.status(200).json({ product, updateFeed: base ? `${base}/${product}` : '' });
}

/** 后端答案的缓存。成功的值只在改部署配置时才变，失败则短一点，好让后端起来后快速恢复。 */
const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000;
let cache: { value: string; until: number } | null = null;

/**
 * 取更新目录前缀。
 *
 * GALAXY_UPDATE_FEED_URL 仍然优先 —— 它现在只是**本机覆盖**（对着本地起的静态目录
 * 调更新流程时用），不再是主来源；不配就问后端。
 *
 * 问后端这一跳有三条硬约束，全都是为了不拖垮壳的启动探测（那边 4 秒超时、
 * 失败三次就弹框）：超时给到 1.5 秒、**任何失败都吞掉回空串**、答案带缓存 ——
 * 后端挂着的时候不能让每一次探测都先干等 1.5 秒。
 *
 * 回空串是合法状态（「这个部署不检查更新」），不是故障，界面上整块不画。
 */
async function updateFeedBase(): Promise<string> {
  const override = trimURL(process.env.GALAXY_UPDATE_FEED_URL);
  if (override) return override;

  const now = Date.now();
  if (cache && now < cache.until) return cache.value;

  const target = trimURL(process.env.SERVER_TARGET);
  const prefix = (process.env.APP_URL_PREFIX ?? '/api').trim();
  if (!target) return '';
  let value = '';
  try {
    const response = await fetch(`${target}${prefix}/galaxy/desktop/update-feed`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await response.json()) as { data?: { updateFeed?: string } };
    value = trimURL(body.data?.updateFeed);
  } catch {
    value = '';
  }
  cache = { value, until: now + (value ? OK_TTL_MS : FAIL_TTL_MS) };
  return value;
}

/** 末尾的 / 要去掉：调用方是拿它直接拼 /<端> 的。 */
function trimURL(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}
