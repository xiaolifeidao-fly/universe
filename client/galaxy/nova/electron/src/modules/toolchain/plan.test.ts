import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInPath, globalBin, mergeEnv, isShellSafe, shimFiles, splitPath, toolchainEnv, type ToolchainLayout } from './plan';

const mac: ToolchainLayout = {
  execPath: '/Applications/Nova.app/Contents/MacOS/Nova',
  npmRoot: '/Applications/Nova.app/Contents/Resources/npm',
  shimDir: '/Users/x/Library/Application Support/Nova/toolchain/bin',
  prefixDir: '/Users/x/Library/Application Support/Nova/toolchain/global',
  platform: 'darwin',
};
const win: ToolchainLayout = {
  execPath: 'C:\\Program Files\\Nova\\Nova.exe',
  npmRoot: 'C:\\Program Files\\Nova\\resources\\npm',
  shimDir: 'C:\\Users\\x\\AppData\\Roaming\\Nova\\toolchain\\bin',
  prefixDir: 'C:\\Users\\x\\AppData\\Roaming\\Nova\\toolchain\\global',
  platform: 'win32',
};

const shim = (layout: ToolchainLayout, name: string) => {
  const found = shimFiles(layout).find((file) => file.name === name);
  assert.ok(found, `没有生成 ${name}`);
  return found;
};

test('node 的 shim 就是 Electron 自己，靠 ELECTRON_RUN_AS_NODE 切成 Node', () => {
  const node = shim(mac, 'node');
  assert.match(node.content, /^#!\/bin\/sh\n/);
  assert.match(node.content, /export ELECTRON_RUN_AS_NODE/);
  assert.equal(node.content.trimEnd().split('\n').pop(),
    `exec '/Applications/Nova.app/Contents/MacOS/Nova' "$@"`);
  assert.equal(node.mode, 0o755);
});

test('npm / npx 的 shim 是拿那个 Node 去跑包里的 JS 入口', () => {
  assert.match(shim(mac, 'npm').content, /Resources\/npm\/bin\/npm-cli\.js' "\$@"$/m);
  assert.match(shim(mac, 'npx').content, /Resources\/npm\/bin\/npx-cli\.js' "\$@"$/m);
});

test('Windows 出 .cmd，CRLF 换行', () => {
  const npm = shim(win, 'npm.cmd');
  assert.match(npm.content, /^@echo off\r\n/);
  assert.match(npm.content, /set "ELECTRON_RUN_AS_NODE=1"/);
  assert.ok(npm.content.includes(`"C:\\Program Files\\Nova\\Nova.exe" "C:\\Program Files\\Nova\\resources\\npm\\bin\\npm-cli.js" %*`));
  assert.deepEqual(shimFiles(win).map((file) => file.name), ['node.cmd', 'npm.cmd', 'npx.cmd']);
});

test('路径里有引号、换行或百分号就不算安全 —— 拼出来的脚本会被截断', () => {
  assert.equal(isShellSafe('/Applications/Nova.app/Contents/MacOS/Nova'), true);
  assert.equal(isShellSafe('C:\\Program Files\\Nova\\Nova.exe'), true);
  assert.equal(isShellSafe("/tmp/it's here/Nova"), false);
  assert.equal(isShellSafe('/tmp/a"b/Nova'), false);
  assert.equal(isShellSafe('/tmp/a\nb/Nova'), false);
  assert.equal(isShellSafe('C:\\%USERPROFILE%\\Nova.exe'), false);
  assert.equal(isShellSafe(''), false);
});

test('npm 的全局 bin：unix 在 prefix/bin，Windows 直接在 prefix 根下', () => {
  assert.equal(globalBin(mac), '/Users/x/Library/Application Support/Nova/toolchain/global/bin');
  assert.equal(globalBin(win), 'C:\\Users\\x\\AppData\\Roaming\\Nova\\toolchain\\global');
});

test('PATH 顺序：本机的在前，自带的兜底', () => {
  const env = toolchainEnv({ layout: mac, loginPath: '/opt/homebrew/bin:/usr/bin', hasNativeNpm: true, available: true });
  assert.deepEqual(splitPath(env.PATH, 'darwin'), [
    '/opt/homebrew/bin', '/usr/bin',
    '/Users/x/Library/Application Support/Nova/toolchain/global/bin',
    '/Users/x/Library/Application Support/Nova/toolchain/bin',
  ]);
});

test('本机有 npm 就不动它的 prefix —— 装出来的 claude 要能在用户自己的终端里用', () => {
  const env = toolchainEnv({ layout: mac, loginPath: '/opt/homebrew/bin', hasNativeNpm: true, available: true });
  assert.equal(env.npm_config_prefix, undefined);
});

test('本机没有 npm 才把 prefix 指到 userData —— 默认 prefix 在 .app 里面，签名后写不进去', () => {
  const env = toolchainEnv({ layout: mac, loginPath: '/usr/bin:/bin', hasNativeNpm: false, available: true });
  assert.equal(env.npm_config_prefix, '/Users/x/Library/Application Support/Nova/toolchain/global');
});

test('shim 没铺成就当没有自带环境：PATH 里不挂 shim 目录，也不改 prefix', () => {
  const env = toolchainEnv({ layout: mac, loginPath: '/usr/bin', hasNativeNpm: false, available: false });
  assert.deepEqual(splitPath(env.PATH, 'darwin'),
    ['/usr/bin', '/Users/x/Library/Application Support/Nova/toolchain/global/bin']);
  assert.equal(env.npm_config_prefix, undefined);
});

test('PATH 去重且保序：登录 shell 给重复项不该让它越排越长', () => {
  const env = toolchainEnv({ layout: mac, loginPath: '/usr/bin:/opt/homebrew/bin:/usr/bin::', hasNativeNpm: true, available: false });
  assert.deepEqual(splitPath(env.PATH, 'darwin'),
    ['/usr/bin', '/opt/homebrew/bin', '/Users/x/Library/Application Support/Nova/toolchain/global/bin']);
});

test('Windows 用分号切分', () => {
  const env = toolchainEnv({ layout: win, loginPath: 'C:\\Windows\\system32;C:\\Windows', hasNativeNpm: false, available: true });
  assert.deepEqual(splitPath(env.PATH, 'win32'), [
    'C:\\Windows\\system32', 'C:\\Windows',
    'C:\\Users\\x\\AppData\\Roaming\\Nova\\toolchain\\global',
    'C:\\Users\\x\\AppData\\Roaming\\Nova\\toolchain\\bin',
  ]);
});

test('找本机的 npm：unix 按原名，命中第一个', () => {
  const present = new Set(['/usr/local/bin/npm', '/opt/homebrew/bin/npm']);
  const found = findInPath({ name: 'npm', path: '/usr/bin:/opt/homebrew/bin:/usr/local/bin', platform: 'darwin',
    isExecutable: (candidate) => present.has(candidate) });
  assert.equal(found, '/opt/homebrew/bin/npm');
});

test('Windows 要认 .cmd —— npm 装出来的就是 npm.cmd，不是 npm.exe', () => {
  const present = new Set(['C:\\Program Files\\nodejs\\npm.cmd']);
  const found = findInPath({ name: 'npm', path: 'C:\\Windows;C:\\Program Files\\nodejs', platform: 'win32',
    isExecutable: (candidate) => present.has(candidate) });
  assert.equal(found, 'C:\\Program Files\\nodejs\\npm.cmd');
});

test('找不到就是 undefined —— 上层据此决定要不要用自带的', () => {
  assert.equal(findInPath({ name: 'npm', path: '/usr/bin:/bin', platform: 'darwin', isExecutable: () => false }), undefined);
});

test('Windows 上先把 Path 删干净再写 PATH —— 两个键同时在，哪个生效说不准', () => {
  const merged = mergeEnv({ Path: 'C:\\Windows', HOME: 'C:\\Users\\x' }, { PATH: 'C:\\new' }, 'win32');
  assert.deepEqual(Object.keys(merged).filter((key) => key.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(merged.PATH, 'C:\\new');
  assert.equal(merged.HOME, 'C:\\Users\\x');
});

test('unix 上照常覆盖，其余变量原样带过去', () => {
  const merged = mergeEnv({ PATH: '/usr/bin', SHELL: '/bin/zsh' }, { PATH: '/a:/b', npm_config_prefix: '/p' }, 'darwin');
  assert.equal(merged.PATH, '/a:/b');
  assert.equal(merged.npm_config_prefix, '/p');
  assert.equal(merged.SHELL, '/bin/zsh');
});

test('没有 prefix 要把继承来的那个删掉 —— 用本机 npm 时不该留着上一次的指向', () => {
  const merged = mergeEnv({ npm_config_prefix: '/stale' }, { PATH: '/usr/bin' }, 'darwin');
  assert.equal('npm_config_prefix' in merged, false);
});
