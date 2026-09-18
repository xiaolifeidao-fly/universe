#!/usr/bin/env node
// 自带的 node / npm 到底能不能用，只有把 PATH 剥干净跑一遍才知道。
//
// 这个脚本就是那一遍：造出 shim，然后在一份只有 /usr/bin:/bin:/usr/sbin:/sbin 的
// PATH 下（macOS 上从 Dock 点开的应用拿到的就是这一份）验四件事 ——
//
//   1. 打包配置里指的那份 npm 真的在（extraResources 的 from 不能指空）；
//   2. shim 里的 node 起得来，而且就是 Electron 里那个 Node；
//   3. shim 里的 npm 起得来 —— 它自己也要靠那个 node 才能跑；
//   4. 全局 prefix 指到了 userData，不是 .app 里面那个签名后写不进去的位置。
//
// 第 3 件事是这套东西的命门：实测过 `npm install -g @anthropic-ai/claude-code`
// 会在自己的 postinstall（sh -c node install.cjs）上以 127 失败 —— 没有 node shim，
// 光有 npm 是装不上东西的。
//
// 两种用法：
//   node scripts/verify-toolchain.cjs                      验仓库里那份 npm（开发态）
//   node scripts/verify-toolchain.cjs --bundle <Nova.app>  验真打出来的包里那份
//
// **--bundle 不是可选的。** electron-builder 会往每个 file set 里硬塞一条
// `!**/node_modules/**`，npm 自己那 12MB 依赖就这么被整个丢掉过一次 —— 包里躺着一个
// 少了依赖、一跑就报 MODULE_NOT_FOUND 的 npm，而开发态这份是好的，什么都验不出来。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const build = require(path.join(root, 'nova/electron/package.json')).build;

let failed = false;
const fail = (message) => { failed = true; console.error(`✗ ${message}`); };
const pass = (message) => console.log(`✓ ${message}`);

const bundleArg = process.argv.includes('--bundle') ? process.argv[process.argv.indexOf('--bundle') + 1] : undefined;

/** npm 从哪来：默认读 extraResources 指的源目录，--bundle 时读真实包里的那份。 */
function bundledNpm() {
  let from;
  if (bundleArg) {
    from = path.join(path.resolve(bundleArg), 'Contents/Resources/npm');
  } else {
    // afterPack 的路径是 electron-builder 按 **cwd** 解析的，而 desktop.cjs 就是在
    // client/galaxy 下起它的。写错了不会悄悄跳过，会直接 Cannot find module。
    if (!build.afterPack) { fail('nova/electron/package.json 里没有 afterPack —— 自带的 npm 没人往包里拷'); return undefined; }
    if (!fs.existsSync(path.join(root, build.afterPack))) {
      fail(`afterPack 指的 ${build.afterPack} 不存在（它是相对 client/galaxy 的）`);
      return undefined;
    }
    from = path.join(root, 'node_modules', 'npm');
  }
  if (!fs.existsSync(path.join(from, 'bin', 'npm-cli.js'))) {
    fail(`${from} 下没有 bin/npm-cli.js（npm 这个依赖没装？打包漏了？）`);
    return undefined;
  }
  // npm 是靠自己 node_modules 里那一堆包跑起来的，少了它就是个一跑就 MODULE_NOT_FOUND 的空壳。
  const deps = path.join(from, 'node_modules');
  if (!fs.existsSync(deps)) {
    fail(`${from} 下没有 node_modules —— npm 的依赖被打包过滤掉了，它跑不起来`);
    return undefined;
  }
  pass(`自带 npm：${bundleArg ? from : path.relative(root, from)}（依赖 ${fs.readdirSync(deps).length} 个包）`);
  return from;
}

/**
 * 充当 node 的那个可执行文件：开发态是仓库里的 Electron，--bundle 时就是 Nova 自己
 * —— 装到用户机器上之后 process.execPath 指的正是它。
 */
function electronBinary() {
  if (bundleArg) {
    const app = path.resolve(bundleArg);
    const binary = path.join(app, 'Contents/MacOS', path.basename(app, '.app'));
    if (!fs.existsSync(binary)) { fail(`${binary} 不存在`); return undefined; }
    return binary;
  }
  const binary = require(path.join(root, 'node_modules/electron'));
  if (typeof binary !== 'string' || !fs.existsSync(binary)) { fail('找不到 Electron 的可执行文件'); return undefined; }
  return binary;
}

const npmRoot = bundledNpm();
const execPath = electronBinary();
if (!npmRoot || !execPath) process.exit(1);

// 刻意建在系统临时目录，且 PATH 里不留任何本机的 node —— 否则验的是这台开发机
// 装了 nvm，而不是这套 shim。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-toolchain-'));
const shimDir = path.join(home, 'toolchain', 'bin');
const prefixDir = path.join(home, 'toolchain', 'global');
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

try {
  // shim 的内容只有一处源头：Electron 那边的 plan.ts。这里现编一份来用，
  // 免得脚本里再抄一遍格式，抄的那份迟早和真的不一样。
  const compiled = path.join(home, 'plan.cjs');
  buildSync({ absWorkingDir: root, entryPoints: [path.join(root, 'nova/electron/src/modules/toolchain/plan.ts')],
    outfile: compiled, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const { shimFiles } = require(compiled);
  fs.mkdirSync(shimDir, { recursive: true });
  for (const file of shimFiles({ execPath, npmRoot, shimDir, prefixDir, platform: process.platform })) {
    fs.writeFileSync(path.join(shimDir, file.name), file.content, { mode: file.mode });
  }
  pass(`shim 已铺：${fs.readdirSync(shimDir).join(' ')}`);

  const env = { HOME: home, PATH: `${BARE_PATH}${path.delimiter}${shimDir}`, npm_config_prefix: prefixDir };
  const run = (command, args) => spawnSync(command, args, { env, encoding: 'utf8', shell: false });

  // 先确认这份 PATH 里真的没有 node —— 否则下面几条全是假通过。
  const bare = spawnSync('/bin/sh', ['-c', 'command -v node || true'], { env: { PATH: BARE_PATH }, encoding: 'utf8' });
  if (bare.stdout.trim()) fail(`这台机器的 ${BARE_PATH} 里有 node（${bare.stdout.trim()}），验不出兜底效果`);
  else pass(`${BARE_PATH} 里没有 node，符合 GUI 应用拿到的环境`);

  const node = run(path.join(shimDir, 'node'), ['-p', 'process.versions.node']);
  if (node.status !== 0) fail(`node shim 起不来：${(node.stderr || '').trim().slice(0, 400)}`);
  else pass(`node shim → Node ${node.stdout.trim()}（Electron 里那个）`);

  const version = run(path.join(shimDir, 'npm'), ['--version']);
  if (version.status !== 0) fail(`npm shim 起不来：${(version.stderr || '').trim().slice(0, 400)}`);
  else pass(`npm shim → npm ${version.stdout.trim()}`);

  // npm 自己认不认这个 prefix：认错了就是往 .app 里写，签名之后必然 EACCES。
  const prefix = run(path.join(shimDir, 'npm'), ['config', 'get', 'prefix']);
  if (prefix.stdout.trim() !== prefixDir) fail(`npm 的 prefix 是 ${prefix.stdout.trim()}，应该是 ${prefixDir}`);
  else pass(`npm 全局 prefix → ${path.relative(home, prefixDir)}（userData 下，可写）`);

  // sh -c 里能不能找到 node —— 包的 postinstall 就是这么跑的，claude 那个 127 就出在这。
  const script = spawnSync('/bin/sh', ['-c', 'node -e "process.stdout.write(String(1+1))"'], { env, encoding: 'utf8' });
  if (script.stdout.trim() !== '2') fail(`postinstall 那种 sh -c node 跑不通：${(script.stderr || '').trim().slice(0, 300)}`);
  else pass('sh -c 里的 node 也找得到（包的 postinstall 靠这条）');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
