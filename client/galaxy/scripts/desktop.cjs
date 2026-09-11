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
    // dev 才在本机起 Next：开发时改一行 UI 要立刻看见，界面得跑在本地。
    // start 是「用装好的壳打开已经部署好的控制台」，界面在远端，本机不监听端口。
    const web = action === 'dev'
      ? run(process.execPath, [next, 'dev', '-H', '127.0.0.1', '-p', String(products[product].port)])
      : null;
    const desktop = run(require('electron'), [electron]);
    await (web ? Promise.race([wait(web), wait(desktop)]) : wait(desktop));
    stop();
    return;
  }
  await wait(run(process.execPath, [next, 'build']));

  // 产出两样互不相干的东西：
  //
  //   .desktop/<端>/        要**部署到远端服务器**的 Next standalone 包
  //   <端>/electron/desktop.json  桌面壳要加载哪个地址，打包时冻结进安装包
  //
  // 安装包里不再带那份 standalone —— 界面在远端，壳只负责加载它。
  const dist = path.join(webview, '.next');
  const output = path.join(root, '.desktop', product);
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(path.join(dist, 'standalone'), output, { recursive: true });
  const appRoot = path.join(output, 'client', 'galaxy', product, 'webview');
  fs.cpSync(path.join(dist, 'static'), path.join(appRoot, '.next', 'static'), { recursive: true });
  fs.cpSync(path.join(webview, 'public'), path.join(appRoot, 'public'), { recursive: true });
  // Local environment files can contain secrets. Deployed apps use runtime environment settings.
  for (const name of fs.readdirSync(appRoot)) if (name.startsWith('.env')) fs.rmSync(path.join(appRoot, name));
  require('@next/env').loadEnvConfig(webview, false);
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({
    SERVER_TARGET: process.env.SERVER_TARGET || 'http://127.0.0.1:10004',
    APP_URL_PREFIX: process.env.APP_URL_PREFIX || '/api',
  }, null, 2));

  // APP_ORIGIN 是「这个安装包默认连哪个控制台」。启动时同名的
  // GALAXY_<端>_APP_ORIGIN / GALAXY_APP_ORIGIN 可以覆盖它。
  // 打包时没给就写空串：壳启动时会明确报「没有配置控制台地址」，
  // 比让它悄悄回落到一个本机端口强 —— 那个端口上什么都没有。
  fs.writeFileSync(path.join(electron, 'desktop.json'), JSON.stringify({
    APP_ORIGIN: (process.env.APP_ORIGIN || '').trim(),
  }, null, 2));

  if (action === 'package') await wait(run(process.execPath, [require.resolve('electron-builder/cli.js'), '--projectDir', electron], { cwd: root }));
}
main().catch((error) => { console.error(error); stop(); process.exitCode = 1; });
