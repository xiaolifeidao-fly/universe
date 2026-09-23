/**
 * 把 plan.ts 算出来的那套环境真的铺到磁盘上，给桥接子进程用。
 * 只吃普通参数、不 import electron —— 调用方在 modules/bridge/runtime.ts。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findInPath, isShellSafe, mergeEnv, shimFiles, toolchainEnv, type ToolchainEnv, type ToolchainLayout } from './plan';

export type { ToolchainEnv } from './plan';

/** 登录 shell 有可能卡在等输入或者刷一堆欢迎语上，给它一个硬上限。 */
const SHELL_TIMEOUT = 3000;

/**
 * 捞回登录 shell 的 PATH。
 *
 * macOS 上从 Dock / Finder 点开的应用继承的是 launchd 的环境，PATH 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`；nvm 装的 node 在 `~/.nvm/...`，homebrew 的在
 * `/opt/homebrew/bin`，一个都不在里面。要拿到用户自己那份 PATH，只能起一个
 * **登录且交互**的 shell 问它 —— nvm 是写在 `.zshrc` 里的，少了 `-i` 就问不出来。
 *
 * Windows 不需要：GUI 程序拿到的就是用户完整的 PATH。
 */
export function loginPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string> {
  const current = env.PATH ?? '';
  if (platform === 'win32') return Promise.resolve(current);
  const shell = env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    // 让它打自己的环境，而不是 `echo "$PATH"`：fish 里 PATH 是一个列表，展开出来
    // 是空格分隔的，按冒号一切就成了一串垃圾路径。env 打出来的永远是给子进程的
    // 那份，冒号分隔，对 sh / bash / zsh / fish 都成立。
    // rc 文件先刷的欢迎语无所谓 —— 只挑 PATH= 开头的那一行。
    execFile(shell, ['-i', '-l', '-c', '/usr/bin/env'],
      { timeout: SHELL_TIMEOUT, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const value = /^PATH=(.*)$/m.exec(stdout ?? '')?.[1]?.trim();
        if (error && !value) return resolve(fallbackPath(current));
        resolve(value ? value : fallbackPath(current));
      })
      // 交互式 shell 会等 stdin；不主动关掉它就只能等那 3 秒超时。
      .stdin?.end();
  });
}

/**
 * 问不出来才猜：补两个几乎一定有 node 的位置。宁可多两个不存在的目录，
 * 也别让一台装了 homebrew node 的机器白白回落到自带环境。
 */
function fallbackPath(current: string): string {
  return [current, '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(path.delimiter);
}

function executable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** 打进包里的 npm：装好之后在 resources/npm，开发态回落到 workspace 里的那一份。 */
function locateNpm(resourcesPath: string, packaged: boolean): string | undefined {
  const candidates = [path.join(resourcesPath, 'npm')];
  if (!packaged) {
    try {
      candidates.push(path.dirname(createRequire(__filename).resolve('npm/package.json')));
    } catch { /* 开发机上没装 npm 这个包就只当没有自带环境 */ }
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'bin', 'npm-cli.js')));
}

function writeShims(layout: ToolchainLayout): boolean {
  if (!isShellSafe(layout.execPath) || !isShellSafe(layout.npmRoot)) return false;
  try {
    fs.mkdirSync(layout.shimDir, { recursive: true, mode: 0o700 });
    for (const file of shimFiles(layout)) {
      const target = path.join(layout.shimDir, file.name);
      // 每次启动都重写：Nova 换了安装位置、或者升级换了 resources 路径之后，
      // 留着上一版的绝对路径就是一个指向空气的 shim。
      fs.writeFileSync(target, file.content, { mode: file.mode });
      fs.chmodSync(target, file.mode);
    }
    return true;
  } catch {
    return false;
  }
}

export interface ToolchainOptions {
  /** process.execPath：主进程里就是 Nova 自己那个可执行文件。 */
  execPath: string;
  resourcesPath: string;
  userData: string;
  packaged: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface Toolchain extends ToolchainEnv {
  /** 这次到底用谁的 npm。只用来打日志，桥接不看它。 */
  npmSource: 'native' | 'bundled' | 'none';
  /** 直接可以交给 utilityProcess.fork 的那份环境。 */
  env: NodeJS.ProcessEnv;
}

/**
 * 备好工具链并算出要塞给桥接子进程的环境。启动时做一次，结果由调用方持有。
 *
 * 注意它不改自己进程的 env：主进程的 PATH 保持原样，改的只有 fork 出去的那份。
 */
export async function prepareToolchain(options: ToolchainOptions): Promise<Toolchain> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const resolved = await loginPath(env, platform);
  const npmRoot = locateNpm(options.resourcesPath, options.packaged);
  const layout: ToolchainLayout = {
    execPath: options.execPath,
    npmRoot: npmRoot ?? '',
    shimDir: path.join(options.userData, 'toolchain', 'bin'),
    prefixDir: path.join(options.userData, 'toolchain', 'global'),
    platform,
  };
  const available = npmRoot !== undefined && writeShims(layout);
  const native = findInPath({ name: 'npm', path: resolved, platform, isExecutable: executable });
  const patch = toolchainEnv({ layout, loginPath: resolved, hasNativeNpm: native !== undefined, available });
  return { ...patch, npmSource: native ? 'native' : available ? 'bundled' : 'none', env: mergeEnv(env, patch, platform) };
}
