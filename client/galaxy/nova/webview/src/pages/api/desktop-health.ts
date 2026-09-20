import type { NextApiRequest, NextApiResponse } from 'next';
import { product } from '../../utils/product';

/**
 * 桌面壳启动时探的那一下。它**只回这份包是哪个端**，不打后端 ——
 * 后端没起的时候也应该能判断「界面自己活了」（见 common/electron/main.ts 的 probe）。
 *
 * 顺带回这个端的更新目录：壳本来就要探这一下才肯加载界面，而「更新包放在 OSS 的哪儿」
 * 是部署的一部分。放在这里而不是冻进安装包，换桶只要改这台机器的 runtime.json
 * 再重启界面，全网装出去的壳下一次检查就跟着走了。
 *
 * GALAXY_UPDATE_FEED_URL 给的是**两个端共用的前缀**（OSS 上那个公开读的目录），
 * 这里补上自己这一段。没配就是空串 —— 那个部署不检查更新，不是故障。
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const base = (process.env.GALAXY_UPDATE_FEED_URL ?? '').trim().replace(/\/+$/, '');
  res.status(200).json({ product, updateFeed: base ? `${base}/${product}` : '' });
}
