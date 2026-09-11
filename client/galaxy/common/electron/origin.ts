import fs from 'node:fs';
import path from 'node:path';
import type { Product } from '../index';
import { products } from '../index';

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
 *   2. 只认打包时冻结的默认值与启动环境变量，界面里不给改；
 *   3. 未打包（开发态）才回落到本机 next dev。
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

export function resolveOrigin(source: OriginSource): string {
  const { product, packaged, env } = source;
  const upper = product.toUpperCase();
  // 单端覆盖优先于共用覆盖：一台机器上两个端连不同环境是常态。
  const configured = (
    env[`GALAXY_${upper}_APP_ORIGIN`] ??
    env.GALAXY_APP_ORIGIN ??
    (packaged ? frozenOrigin(source) : '')
  ).trim();

  if (!configured) {
    if (!packaged) return `http://127.0.0.1:${products[product].port}`;
    throw new Error(
      `没有配置控制台地址。打包时把 APP_ORIGIN 写进 resources/desktop.json，` +
        `或启动前设 GALAXY_${upper}_APP_ORIGIN。`,
    );
  }

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

/** 打包时冻结进 resources/desktop.json 的默认地址。拿不到就是空串，由上面报错。 */
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
