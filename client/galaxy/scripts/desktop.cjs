const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { products } = require('../common');
const [action, product] = process.argv.slice(2);
if (!products[product] || !['dev', 'start', 'build', 'package'].includes(action)) throw new Error('Usage: desktop.cjs dev|start|build|package nova|orbit');
const root = path.resolve(__dirname, '..');
const webview = path.join(root, product, 'webview');
const electron = path.join(root, product, 'electron');
const env = { ...process.env };
const children = new Set();
const pidFile = path.join(root, "run", `${product}.pid`);
let ownsPid = false;
process.on("exit", () => { if (ownsPid) fs.rmSync(pidFile, { force: true }); });
function run(binary, args, extra = {}) {
  const child = spawn(binary, args, { cwd: webview, env, stdio: 'inherit', ...extra });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function wait(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Process exited: ${code}`)));
  });
}
function stop() { for (const child of children) child.kill(); }
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });
async function main() {
  if (action === "dev" || action === "start") {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      let running = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); running = true; } catch { /* stale launcher */ }
      }
      if (running) throw new Error(`${product} launcher is already running (${pid})`);
      fs.rmSync(pidFile);
    }
    fs.writeFileSync(pidFile, String(process.pid), { flag: "wx" });
    ownsPid = true;
  }
  await require('./build-electron.cjs').buildElectron(product);
  const next = require.resolve('next/dist/bin/next');
  if (action === 'dev' || action === 'start') {
    const web = action === 'dev'
      ? run(process.execPath, [next, 'dev', '-H', '127.0.0.1', '-p', String(products[product].port)])
      : run(process.execPath, [path.join(root, '.desktop', product, 'client/galaxy', product, 'webview/server.js')], { env: { ...require(path.join(root, '.desktop', product, 'runtime.json')), ...env, HOSTNAME: '127.0.0.1', PORT: String(products[product].port) } });
    const desktop = run(require('electron'), [electron]);
    await Promise.race([wait(web), wait(desktop)]);
    stop();
    return;
  }
  await wait(run(process.execPath, [next, 'build']));
  const dist = path.join(webview, '.next');
  const output = path.join(root, '.desktop', product);
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(path.join(dist, 'standalone'), output, { recursive: true });
  const appRoot = path.join(output, 'client', 'galaxy', product, 'webview');
  fs.cpSync(path.join(dist, 'static'), path.join(appRoot, '.next', 'static'), { recursive: true });
  fs.cpSync(path.join(webview, 'public'), path.join(appRoot, 'public'), { recursive: true });
  // Local environment files can contain secrets. Packaged apps use runtime environment settings.
  for (const name of fs.readdirSync(appRoot)) if (name.startsWith('.env')) fs.rmSync(path.join(appRoot, name));
  require('@next/env').loadEnvConfig(webview, false);
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({
    SERVER_TARGET: process.env.SERVER_TARGET || 'http://127.0.0.1:10004',
    APP_URL_PREFIX: process.env.APP_URL_PREFIX || '/api',
  }, null, 2));
  if (action === 'package') await wait(run(process.execPath, [require.resolve('electron-builder/cli.js'), '--projectDir', electron], { cwd: root }));
}
main().catch((error) => { console.error(error); stop(); process.exitCode = 1; });
