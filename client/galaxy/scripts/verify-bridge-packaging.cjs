#!/usr/bin/env node
// 打包后的桥接是从 app.asar.unpacked 里跑的，和开发时的 workspace 软链完全是两种
// 目录形态：模块解析只会在 unpacked 这棵真实目录树上逐级向上找，**不会**退回
// app.asar 里。留在 asar 里的运行时依赖在开发机上会被仓库的 node_modules 兜住，
// 装到 /Applications 就直接 MODULE_NOT_FOUND —— 这个脚本就是把那种兜底摘掉再跑一遍。
//
// 两种用法：
//   node scripts/verify-bridge-packaging.cjs                     按 asarUnpack 模拟一棵树（不需要 electron-builder）
//   node scripts/verify-bridge-packaging.cjs --bundle <Nova.app> 验真实打出来的包
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const build = require(path.join(root, 'nova/electron/package.json')).build;
const modules = path.join(root, 'node_modules');

let failed = false;
function fail(message) { failed = true; console.error(`✗ ${message}`); }
function pass(message) { console.log(`✓ ${message}`); }

/** asarUnpack 的形态固定是 node_modules/<包名>/**，取出包名即可。 */
function unpackedPackages() {
  return build.asarUnpack
    .map((pattern) => /^node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*)\/\*\*$/.exec(pattern)?.[1])
    .filter(Boolean);
}

/** 与 nova/electron/package.json 的 build.files 排除项对齐：源码与构建产物不进包。 */
const DROP = new Set(['target', 'src', 'tests', 'test', 'scripts', 'node_modules',
  'build.rs', 'Cargo.toml', 'Cargo.lock', 'tsconfig.json']);

function sizeOf(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size;
  }
  return total;
}

/** 按 asarUnpack 拼一棵树。开发机上没有真实产物时用它。 */
function simulate(into) {
  const wanted = unpackedPackages();
  const shipped = [];
  for (const name of wanted) {
    if (!fs.existsSync(path.join(modules, name))) continue; // optionalDependencies 可能没装
    const from = fs.realpathSync(path.join(modules, name));
    const to = path.join(into, 'node_modules', name);
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (DROP.has(entry)) continue;
      fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true, dereference: true });
    }
    shipped.push(name);
  }
  pass(`asarUnpack 声明 ${wanted.length} 项，本机装了 ${shipped.length} 项：${shipped.join(' ')}`);
}

/** 把真实 app 里的 app.asar.unpacked 原样搬出来。 */
function fromBundle(bundle, into) {
  const source = path.join(bundle, 'Contents/Resources/app.asar.unpacked');
  if (!fs.existsSync(source)) {
    fail(`${bundle} 里没有 app.asar.unpacked`);
    process.exit(1);
  }
  fs.cpSync(source, into, { recursive: true });
  const present = fs.readdirSync(path.join(into, 'node_modules'));
  const scoped = present.flatMap((name) => name.startsWith('@')
    ? fs.readdirSync(path.join(into, 'node_modules', name)).map((n) => `${name}/${n}`)
    : [name]);
  for (const required of unpackedPackages()) {
    if (!fs.existsSync(path.join(modules, required))) continue;
    if (!scoped.includes(required)) fail(`app.asar.unpacked 里少了 ${required}（asarUnpack 没生效？）`);
  }
  pass(`包里 unpacked 的依赖：${scoped.join(' ')}`);
}

// 刻意建在系统临时目录：仓库里的任何位置都会被 node_modules 向上查找兜住，
// 那正是这个 bug 在开发机上藏了这么久的原因。
const bundle = process.argv[process.argv.indexOf('--bundle') + 1];
const useBundle = process.argv.includes('--bundle');
const unpacked = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-asar-unpacked-')));
try {
  if (useBundle) {
    if (!bundle) throw new Error('--bundle 后面要跟 Nova.app 的路径');
    fromBundle(path.resolve(bundle), unpacked);
  } else {
    simulate(unpacked);
  }

  // 原生产物是按 平台-架构 挑的，包里缺了哪一片就是那个平台起不来。
  const nativeDir = path.join(unpacked, 'node_modules/@galaxy/ai-bridge-native');
  if (!fs.existsSync(nativeDir)) {
    fail('包里没有 @galaxy/ai-bridge-native');
  } else {
    const slices = fs.readdirSync(nativeDir).filter((name) => name.endsWith('.node'))
      .map((name) => name.replace(/^ai-bridge-native\.|\.node$/g, ''));
    const host = `${process.platform}-${process.arch}`;
    if (!slices.includes(host)) fail(`包里没有本机（${host}）的原生产物，现有：${slices.join('、') || '无'}`);
    else pass(`原生产物：${slices.join('、')}`);
  }

  // 只量桥接自己这两个包：unpacked 里还有 agent 的两个 SDK，那是另一笔账
  // （桌面路径已经加载不到它们了，见 README 的「还留在 Node 的」）。
  const own = ['node_modules/ai-bridge', 'node_modules/@galaxy/ai-bridge-native']
    .map((rel) => path.join(unpacked, rel))
    .filter((dir) => fs.existsSync(dir))
    .reduce((total, dir) => total + sizeOf(dir), 0) / 1048576;
  if (own > 120) fail(`桥接自己占了 ${own.toFixed(0)} MB，多半是 cargo 的 target 或源码混进来了`);
  else pass(`桥接体积 ${own.toFixed(1)} MB`);
  const total = sizeOf(unpacked) / 1048576;
  if (total - own > 50) {
    console.log(`  · unpacked 里另有 ${(total - own).toFixed(0)} MB 不属于桥接（agent 的 SDK），桌面路径用不到`);
  }

  let worker;
  try {
    worker = fs.realpathSync(require.resolve('ai-bridge/desktop-worker', { paths: [unpacked] }));
  } catch (error) {
    fail(`解析不到 ai-bridge/desktop-worker：${error.message}`);
    process.exit(1);
  }
  if (!worker.startsWith(unpacked)) fail(`解析到了树外的 ${worker}`);
  else pass(`worker 入口：${path.relative(unpacked, worker)}`);

  const service = path.join(unpacked, 'node_modules/ai-bridge/dist/desktop/service.js');
  const probe = `
    import { mkdtempSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const { DesktopBridgeService } = await import(${JSON.stringify('file://' + service)});
    const dir = mkdtempSync(join(tmpdir(), 'nova-pack-'));
    const config = join(dir, 'config.yaml');
    writeFileSync(config, 'mode: relay\\nserver: { host: 127.0.0.1, port: 0 }\\nproviders: {}\\nrelay: { enabled: false }\\nauth: { tokenFile: ' + join(dir, 't.json') + ' }\\n');
    const service = new DesktopBridgeService(config);
    await service.initialize();
    const started = await service.start();
    const issued = await service.createToken({ alias: 'packaged', scopes: ['admin'] });
    const stopped = await service.stop();
    console.log(JSON.stringify({ started: started.state, stopped: stopped.state, token: issued.token.length }));
  `;
  // cwd 也放在树里：不能让 node 从仓库那边把缺的依赖找回来。
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
    { encoding: 'utf8', cwd: unpacked });
  const line = (result.stdout || '').trim().split('\n').filter((l) => l.startsWith('{"started')).pop();
  if (result.status !== 0 || !line) {
    fail(`打包形态下跑不起来：\n${(result.stderr || '').trim().slice(-1200)}`);
    process.exit(1);
  }
  const outcome = JSON.parse(line);
  if (outcome.started !== 'running' || outcome.stopped !== 'stopped' || outcome.token < 32) {
    fail(`生命周期不对：${line}`);
  } else {
    pass('打包形态下加载原生模块、启停与签发凭据都正常');
  }
} finally {
  fs.rmSync(unpacked, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
