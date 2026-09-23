import fs from 'node:fs';
import path from 'node:path';
import type { Product } from '../index';
import { defaultOrigin } from '../index';

/**
 * 桌面壳要加载哪个地址。
 *
 * 单独一个文件、**不 import electron**：这几条规则是安全边界，得能被
 * `node --test` 直接跑到。混在 main.ts 里就只能靠人看 —— 而看漏一条
 * （比如某天为了调试放行了 http）不会有任何报错，只会安静地把本机
 * bridge 的调用权交出去。
 *
 * 界面部署在远端，所以 origin 从一个本机端口变成了部署地址，而这一条改变了
 * 威胁模型：Nova 把 BridgeApi 整个暴露给渲染进程（pair 能把节点绑到任意 Hub、
 * startUpstreamLogin 会在本机拉起命令、createToken 会签发能花掉订阅的凭据），
 * 页面来自网络之后，能控制那台服务器的人就能驱动这台机器。于是：
 *
 *   1. 非本机地址必须 https —— 明文 http 谁都能改包；
 *   2. 只认三处：编译进壳的 defaultOrigin、打包时冻结的 desktop.json、
 *      启动环境变量。界面里不给改；
 *   3. 想连本机 next dev 也得走环境变量，没有「开发态就自动用本机」这条暗门。
 */
export interface OriginSource {
  product: Product;
  packaged: boolean;
  /** 打包后 Electron 的 process.resourcesPath；未打包时给空串即可。 */
  resourcesPath: string;
  env: Record<string, string | undefined>;
  /** 读文件，测试里替换掉。 */
  readFile?: (file: string) => string | null;
}

/**
 * 地址来源，从高到低：
 *
 *   GALAXY_<端>_APP_ORIGIN    单端覆盖 —— 一台机器上两个端连不同环境是常态
 *   GALAXY_APP_ORIGIN         两端共用的覆盖
 *   resources/desktop.json    打包时由 APP_ORIGIN 冻结进安装包的值
 *   defaultOrigin             编译进壳的正式部署地址（@galaxy/common）
 *
 * 每一级都用 `||` 往下落，空串和只有空白的值一律当「没配」而不是一个合法的空地址：
 * 运维把变量导出成空值（`GALAXY_APP_ORIGIN=` 这种）比不导出常见得多，那时候
 * 该用的是下一级，不是报错。
 *
 * 最后一级是常量，所以这个函数没有「没配地址」这个失败态；也因此开发态不再
 * 隐式回落到 127.0.0.1 —— 对着本机 next dev 调壳时由 scripts/desktop.cjs 的
 * dev 分支显式注入 GALAXY_<端>_APP_ORIGIN。「壳连的是本机还是线上」于是永远
 * 写在环境里，看一眼 env 就知道，不用去猜 app.isPackaged 当时是什么。
 */
export function resolveOrigin(source: OriginSource): string {
  const { product, packaged, env } = source;
  const upper = product.toUpperCase();
  const configured =
    env[`GALAXY_${upper}_APP_ORIGIN`]?.trim() ||
    env.GALAXY_APP_ORIGIN?.trim() ||
    (packaged ? frozenOrigin(source).trim() : '') ||
    defaultOrigin;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`控制台地址不是合法 URL：${configured}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`控制台地址只支持 http/https：${configured}`);
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new Error(`控制台地址必须是 https（本机调试除外）：${configured}`);
  }
  return parsed.origin;
}

/** 打包时冻结进 resources/desktop.json 的默认地址。拿不到就是空串，由上面往下落。 */
function frozenOrigin(source: OriginSource): string {
  const read = source.readFile ?? ((file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null));
  const raw = read(path.join(source.resourcesPath, 'desktop.json'));
  if (!raw) return '';
  try {
    const parsed: Record<string, string> = JSON.parse(raw);
    return parsed.APP_ORIGIN ?? '';
  } catch {
    return '';
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
