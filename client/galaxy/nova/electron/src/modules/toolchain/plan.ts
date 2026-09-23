/**
 * 自带的 node / npm：本机没装 Node 时的兜底。
 *
 * Nova 的 Electron 里本来就带着一个 Node（40.10.2 → 24.15.0），`ELECTRON_RUN_AS_NODE=1`
 * 起同一个可执行文件就是它。缺的只有 npm —— npm 是随官方 Node 分发的一包 JS，
 * Electron 不带，所以它跟着 Nova 一起打进 resources（见 package.json 的 extraResources）。
 *
 * 光有这两样还不够，真正卡住的是 PATH。macOS 上从 Dock 点开的应用继承的是 launchd
 * 的环境，PATH 就 `/usr/bin:/bin:/usr/sbin:/sbin` 四个目录，nvm 和 homebrew 都不在里面，
 * 而 `/usr/bin/node` 根本不存在。于是凡是 `#!/usr/bin/env node` 的东西一律找不到人：
 * 实测 `npm install -g @anthropic-ai/claude-code` 会在它自己的 postinstall
 * （`sh -c node install.cjs`）上以 127 退出，包都装了一半。所以三件事缺一不可：
 *
 *   1. 把登录 shell 的 PATH 捞回来 —— 本机有什么就用本机的（见 index.ts）；
 *   2. 在 PATH 末尾挂上自带的 node / npm / npx 三个 shim —— 本机没有才轮到自带的；
 *   3. 用自带 npm 装东西时把 prefix 指到 userData —— 默认 prefix 在 .app 里面，
 *      签名之后写不进去，装什么都是 EACCES。
 *
 * 顺序是「本机优先、自带兜底」：本机装了 Node 的人，用 Nova 装出来的 claude 仍然
 * 落在他自己的全局目录里，终端里直接能用；那正是他要的。
 *
 * 这个文件只算「环境该长什么样」，不碰磁盘，好让 node --test 把各种形态都过一遍。
 * 真正去探 shell、写文件的在 index.ts。
 */

import { posix, win32 } from 'node:path';

/**
 * 按 layout.platform 拼路径，而不是按跑测试的这台机器 —— 否则在 mac 上跑
 * Windows 那组用例，拼出来的是 `C:\...\npm/bin/npm-cli.js`，测了个寂寞。
 */
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === 'win32' ? win32 : posix).join(...parts);
}

export interface ToolchainLayout {
  /** Nova 自己的可执行文件。`ELECTRON_RUN_AS_NODE=1` 起它就是一个 node。 */
  execPath: string;
  /** 打进包里的 npm 根目录，入口是它的 bin/npm-cli.js。 */
  npmRoot: string;
  /** 三个 shim 的落点，在 userData 下。 */
  shimDir: string;
  /** 自带 npm 的全局 prefix，在 userData 下。 */
  prefixDir: string;
  platform: NodeJS.Platform;
}

export interface ShimFile {
  name: string;
  content: string;
  mode: number;
}

export interface ToolchainEnv {
  PATH: string;
  /** 只有轮到自带 npm 时才给。本机有自己的 npm 时一个字都不改。 */
  npm_config_prefix?: string;
}

const BANNER = 'Nova 自带的 Node —— 由 src/modules/toolchain 生成，删了下次启动会重建';

/**
 * 路径里出现引号、换行或百分号就当作没有自带环境：与其拼一段能被截断的脚本，
 * 不如老老实实回落到「本机装了什么用什么」。正常的安装位置不会长这样，
 * 这里挡的是被人摆弄过的目录名。反斜杠要放行 —— Windows 的路径全是它。
 */
export function isShellSafe(value: string): boolean {
  return value.length > 0 && !/['"\n\r%]/.test(value);
}

function posixShim(argv: string[]): string {
  // 单引号包住，里面不会再有单引号（isShellSafe 已经挡掉了）。
  const command = argv.map((value) => `'${value}'`).join(' ');
  return [`#!/bin/sh`, `# ${BANNER}`, 'ELECTRON_RUN_AS_NODE=1', 'export ELECTRON_RUN_AS_NODE',
    `exec ${command} "$@"`, ''].join('\n');
}

function cmdShim(argv: string[]): string {
  const command = argv.map((value) => `"${value}"`).join(' ');
  // cmd 的换行必须是 CRLF，LF 的 .cmd 在老一点的 Windows 上会解析错行。
  return ['@echo off', `rem ${BANNER}`, 'set "ELECTRON_RUN_AS_NODE=1"', `${command} %*`, ''].join('\r\n');
}

/**
 * 三个 shim：node 直接就是 Electron 的 Node，npm / npx 是拿它去跑那两个 JS 入口。
 * Windows 上是 `.cmd` —— 也正因为如此，Rust 那边不能裸 `Command::new("npm")`
 * （它只补 `.exe`，不认 PATHEXT），见 pool/tools.rs 的 resolve_program。
 */
export function shimFiles(layout: ToolchainLayout): ShimFile[] {
  const windows = layout.platform === 'win32';
  const write = windows ? cmdShim : posixShim;
  const entries: [string, string[]][] = [
    ['node', []],
    ['npm', [joinFor(layout.platform, layout.npmRoot, 'bin', 'npm-cli.js')]],
    ['npx', [joinFor(layout.platform, layout.npmRoot, 'bin', 'npx-cli.js')]],
  ];
  return entries.map(([name, args]) => ({
    name: windows ? `${name}.cmd` : name,
    content: write([layout.execPath, ...args]),
    // Windows 不看这一位；unix 上 shim 必须可执行，否则 PATH 查找会跳过它。
    mode: 0o755,
  }));
}

/** npm 在 unix 上把可执行文件放 `<prefix>/bin`，Windows 上直接铺在 prefix 根下。 */
export function globalBin(layout: ToolchainLayout): string {
  return layout.platform === 'win32' ? layout.prefixDir : joinFor(layout.platform, layout.prefixDir, 'bin');
}

export function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

export function splitPath(value: string, platform: NodeJS.Platform): string[] {
  return value.split(pathDelimiter(platform)).filter((part) => part.length > 0);
}

/**
 * 给桥接子进程的环境补丁。
 *
 * PATH 的顺序就是这套东西的全部语义：登录 shell 的 PATH 在最前（本机的 node、
 * 本机装的 claude 都在这里），然后是自带 npm 的全局 bin（Nova 装出来的 CLI），
 * 最后才是 shim（自带的 node / npm）。本机有的，自带的永远抢不过。
 */
export function toolchainEnv(options: {
  layout: ToolchainLayout;
  loginPath: string;
  /** 登录 PATH 里找得到 npm 吗。找得到就用它的，也不动它的 prefix。 */
  hasNativeNpm: boolean;
  /** shim 有没有真的铺好。铺不好就当没有自带环境，只留 PATH 修复那一半。 */
  available: boolean;
}): ToolchainEnv {
  const { layout, loginPath, hasNativeNpm, available } = options;
  const parts = [...splitPath(loginPath, layout.platform), globalBin(layout)];
  if (available) parts.push(layout.shimDir);
  const seen = new Set<string>();
  const ordered = parts.filter((part) => !seen.has(part) && seen.add(part));
  const env: ToolchainEnv = { PATH: ordered.join(pathDelimiter(layout.platform)) };
  if (available && !hasNativeNpm) env.npm_config_prefix = layout.prefixDir;
  return env;
}

/**
 * Windows 上可执行文件要带后缀。`npm` 装出来的是 `npm.cmd`，不是 `.exe`。
 * 空串排在最前是为了和 Rust 那边的 resolve_program 一致（npm 在 Windows 上还会顺手
 * 放一个给 Git Bash 用的无后缀脚本，认出它也算「本机装了 npm」）。
 */
export const WINDOWS_EXTS = ['', '.exe', '.cmd', '.bat'];

/**
 * 在一份 PATH 里找可执行文件，命中第一个就返回。
 *
 * 判断「在不在」交给调用方（index.ts 用 fs，测试用一张表）—— 这一步是拿来决定
 * 「用本机的还是用自带的」的，值得在 node --test 里把 Windows 那几个后缀也过一遍。
 */
export function findInPath(options: {
  name: string;
  path: string;
  platform: NodeJS.Platform;
  isExecutable: (candidate: string) => boolean;
}): string | undefined {
  const { name, path, platform, isExecutable } = options;
  const suffixes = platform === 'win32' ? WINDOWS_EXTS : [''];
  for (const dir of splitPath(path, platform)) {
    for (const suffix of suffixes) {
      const candidate = joinFor(platform, dir, name + suffix);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 把补丁合进一份环境。
 *
 * Windows 上这个键叫 `Path`，直接 `{ ...process.env, PATH }` 会让同一份环境里
 * 同时躺着 `Path` 和 `PATH` 两个键 —— 传给 CreateProcess 之后哪个生效说不准。
 * 所以先按大小写无关删干净，再写回去。
 */
export function mergeEnv(base: NodeJS.ProcessEnv, patch: ToolchainEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  if (platform === 'win32') {
    for (const key of Object.keys(merged)) {
      if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'NPM_CONFIG_PREFIX') delete merged[key];
    }
  }
  merged.PATH = patch.PATH;
  if (patch.npm_config_prefix) merged.npm_config_prefix = patch.npm_config_prefix;
  else delete merged.npm_config_prefix;
  return merged;
}
