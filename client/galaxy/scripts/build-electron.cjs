const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { build } = require('esbuild');
async function buildElectron(product) {
  if (!['nova', 'orbit'].includes(product)) throw new Error('Expected nova or orbit');
  const cwd = path.resolve(__dirname, '..', product, 'electron');
  if (product === 'nova') {
    // relay 数据面是 Rust 原生模块，先出 .node 再编 TS —— 桌面服务要按包名解析它。
    const native = spawnSync(process.execPath, [path.join(cwd, 'ai-bridge-native', 'scripts', 'build.cjs')], { cwd: path.join(cwd, 'ai-bridge-native'), stdio: 'inherit' });
    if (native.error || native.status !== 0) throw native.error || new Error('ai-bridge-native build failed');
    const bridge = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: path.join(cwd, 'ai-bridge'), stdio: 'inherit' });
    if (bridge.error || bridge.status !== 0) throw bridge.error || new Error('ai-bridge build failed');
  }
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${product} Electron typecheck failed`);
  fs.rmSync(path.join(cwd, 'dist'), { recursive: true, force: true });
  await build({
    absWorkingDir: cwd, entryPoints: ['src/main.ts', 'src/preload.ts'], outdir: 'dist',
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'ai-bridge/desktop-worker'],
    tsconfig: path.join(cwd, 'tsconfig.json'), sourcemap: true,
  });
  console.log(`${product}: Electron TypeScript compiled`);
}
module.exports = { buildElectron };
if (require.main === module) buildElectron(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
