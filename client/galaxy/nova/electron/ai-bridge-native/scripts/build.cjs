#!/usr/bin/env node
// 产出 .node。默认编本机，也可以 --target <rust triple> 交叉编译；
// 产物按 napi-rs 惯例命名成 <包名>.<平台>-<架构>.node，index.js 按 platform-arch 找。
//
// macOS 上从 arm64 交叉编 x64 开箱即用（Apple 的工具链自带两边）。
// Windows / Linux 需要各自的链接器，实际靠 CI 的对应 runner 出产物
// （见 .github/workflows/ai-bridge-native.yml），拿回来放进包根目录即可。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/** rust triple → Node 的 platform-arch，以及那个平台上 cdylib 的文件名。 */
const TARGETS = {
  'aarch64-apple-darwin': ['darwin-arm64', 'libai_bridge_native.dylib'],
  'x86_64-apple-darwin': ['darwin-x64', 'libai_bridge_native.dylib'],
  'x86_64-pc-windows-msvc': ['win32-x64', 'ai_bridge_native.dll'],
  'aarch64-pc-windows-msvc': ['win32-arm64', 'ai_bridge_native.dll'],
  'x86_64-unknown-linux-gnu': ['linux-x64', 'libai_bridge_native.so'],
  'aarch64-unknown-linux-gnu': ['linux-arm64', 'libai_bridge_native.so'],
};

/** 产物目录由 .cargo/config.toml 挪到了包外，别再假设是 ./target —— 问 cargo。 */
function targetDir() {
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (meta.status !== 0) throw new Error(`cargo metadata 失败：${(meta.stderr || '').trim()}`);
  return path.resolve(JSON.parse(meta.stdout).target_directory);
}

/** 没给 --target 时按本机推，顺带把「本机是什么」说清楚，出错时好排查。 */
function hostTriple() {
  const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const triple = /^host:\s*(\S+)$/m.exec(host.stdout ?? '')?.[1];
  if (!triple) throw new Error('问不出 rustc 的 host triple，装好 Rust 再来');
  return triple;
}

const argv = process.argv.slice(2);
const profile = argv.includes('--debug') ? 'debug' : 'release';
const target = argv[argv.indexOf('--target') + 1] || (argv.includes('--target') ? undefined : hostTriple());
if (!target) throw new Error('--target 后面要跟一个 rust triple');
const mapping = TARGETS[target];
if (!mapping) {
  throw new Error(`ai-bridge-native 还没有 ${target} 的构建配置（认识的：${Object.keys(TARGETS).join(', ')}）`);
}
const [platformArch, artifact] = mapping;

// 只编库：同一个包里还有 ai-bridge 命令行（src/bin），它不能带着 node 特性链接 ——
// napi 的符号要由 Node 宿主提供，一个独立的可执行文件里没有这个宿主。
const args = ['build', '--lib', '--features', 'node', '--target', target];
if (profile === 'release') args.push('--release');
const build = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const from = path.join(targetDir(), target, profile, artifact);
const to = path.join(root, `ai-bridge-native.${platformArch}.node`);
fs.copyFileSync(from, to);
console.log(`ai-bridge-native: ${path.relative(root, to)} (${(fs.statSync(to).size / 1048576).toFixed(1)} MB)`);
