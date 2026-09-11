const { build } = require('esbuild');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
async function main() {
  const root = path.resolve(__dirname, '..');
  const outdir = path.join(root, '.electron-tests');
  fs.rmSync(outdir, { recursive: true, force: true });
  await build({
    absWorkingDir: root,
    entryPoints: { rpc: 'common/electron/rpc.test.ts', origin: 'common/electron/origin.test.ts' },
    outdir, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    tsconfig: path.join(root, 'nova/electron/tsconfig.json'),
  });
  const result = spawnSync(process.execPath, ['--test', path.join(outdir, 'rpc.js'), path.join(outdir, 'origin.js')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
