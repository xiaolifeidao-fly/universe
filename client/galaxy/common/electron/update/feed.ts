import type { Product } from '../../index';

/**
 * 更新清单放在哪儿。
 *
 * 和 origin.ts 一样单独成文件、**不 import electron**：这几条是能不能把一个
 * 安装包推到用户机器上的规则，得能被 `node --test` 直接跑到。
 *
 * 地址指向 OSS 上这个端的**目录**，electron-updater 会在它下面取
 * `latest-mac.yml` / `latest.yml` / `latest-linux.yml`，再按清单里的文件名取安装包：
 *
 *     https://<桶>.<endpoint>/<oss.dirPrefix>/desktop/nova
 *     └─ latest-mac.yml、Nova-0.1.1-arm64-mac.zip、…
 *
 * 和 origin 不同的是**它没有编译进壳的兜底值**：桶名是部署出来的，写死一个在代码里，
 * 换桶就要重新打包所有平台的安装包 —— 而更新地址恰恰是那种「换了之后老包还得能用」
 * 的东西。所以它由部署提供（见下），没配就是这个壳不检查更新，不是错误。
 */
export interface UpdateFeedSource {
  product: Product;
  env: Record<string, string | undefined>;
  /**
   * 控制台自己报的地址：壳启动时探 `<base>/api/desktop-health`，那一跳顺带把这个端的
   * 更新目录带回来（界面部署机的 runtime.json 里的 GALAXY_UPDATE_FEED_URL）。
   *
   * 为什么不冻进安装包：装出去的壳改不了，而「更新包放哪儿」是运维的事 ——
   * 冻进去之后换桶就等于所有老版本永远收不到更新。放在界面那一侧，改一次
   * runtime.json 重启界面，全网的壳下一次检查就跟着走了。
   */
  remote?: string;
}

export interface UpdateFeed {
  /** 规范化后的目录地址，末尾不带 `/`。空串表示这个壳不检查更新。 */
  url: string;
  /** 为什么是空的。url 有值时是空串。人话，直接展示。 */
  reason: string;
}

/**
 * 取更新地址，从高到低：
 *
 *   GALAXY_<端>_UPDATE_FEED   单端覆盖 —— 一台机器上拿两个端对不同的桶测试
 *   GALAXY_UPDATE_FEED        两端共用的覆盖
 *   控制台 /api/desktop-health 带回来的地址（部署机 runtime.json）
 *
 * 一级都拿不到就是「这个部署没开自动更新」：返回空 url + 一句原因，界面上整块不画。
 * 更新是可选的，**任何一步都不许把应用弄崩** —— 地址写错了也只是不更新。
 */
export function resolveUpdateFeed(source: UpdateFeedSource): UpdateFeed {
  const upper = source.product.toUpperCase();
  const configured =
    source.env[`GALAXY_${upper}_UPDATE_FEED`]?.trim() ||
    source.env.GALAXY_UPDATE_FEED?.trim() ||
    source.remote?.trim() ||
    '';
  if (!configured) {
    return { url: '', reason: '这个部署没有配置更新地址，不检查更新' };
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { url: '', reason: `更新地址不是合法 URL：${configured}` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url: '', reason: `更新地址只支持 http/https：${configured}` };
  }
  // 明文 http 上的清单谁都能改，而清单指向的是一个**会被装到用户机器上**的文件。
  // 本机除外：对着本地起的静态目录调更新流程是常规操作。
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    return { url: '', reason: `更新地址必须是 https（本机调试除外）：${configured}` };
  }
  if (parsed.search || parsed.hash) {
    // electron-updater 是拿目录地址去拼文件名的，带上查询串之后拼出来的是
    // `…?x=1/latest-mac.yml` 这种取不到的地址。签名地址同理 —— 更新目录必须公开读。
    return { url: '', reason: `更新地址不能带查询参数或片段：${configured}` };
  }
  return { url: parsed.toString().replace(/\/+$/, ''), reason: '' };
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
