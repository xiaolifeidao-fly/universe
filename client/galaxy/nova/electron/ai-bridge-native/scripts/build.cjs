#!/usr/bin/env node
// 产出本机平台的 .node。跨平台产物按 napi-rs 的命名放在同一目录，index.js 按 平台-架构 找。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const release = process.argv.includes('--debug') ? 'debug' : 'release';
const args = ['build', '--features', 'node'];
if (release === 'release') args.push('--release');

const build = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const artifact = {
  darwin: 'libai_bridge_native.dylib',
  linux: 'libai_bridge_native.so',
  win32: 'ai_bridge_native.dll',
}[process.platform];
if (!artifact) throw new Error(`ai-bridge-native 还没有 ${process.platform} 的构建配置`);

const from = path.join(root, 'target', release, artifact);
const to = path.join(root, `ai-bridge-native.${process.platform}-${process.arch}.node`);
fs.copyFileSync(from, to);
console.log(`ai-bridge-native: ${path.relative(root, to)} (${(fs.statSync(to).size / 1048576).toFixed(1)} MB)`);
