const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { products, defaultOrigin } = require('../common');
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
    // 壳自己的兜底地址是线上部署（@galaxy/common 的 defaultOrigin），dev 要看的却是
    // 下面这就要起的 next dev，所以把本机地址显式写进环境 —— 这条注入是「开发态用本机」
    // 的**唯一**来源，origin.ts 里没有按 app.isPackaged 的暗门（那条暗门会让
    // `start` 也悄悄指向一个没人监听的端口）。
    // 已经手动指过的不动：拿本机壳连测试环境是常规操作。
    if (action === 'dev' && !env[`GALAXY_${product.toUpperCase()}_APP_ORIGIN`]?.trim() && !env.GALAXY_APP_ORIGIN?.trim()) {
      env[`GALAXY_${product.toUpperCase()}_APP_ORIGIN`] = `http://127.0.0.1:${products[product].port}`;
    }
    // dev 才在本机起 Next：开发时改一行 UI 要立刻看见，界面得跑在本地。
    // start 是「用装好的壳打开已经部署好的控制台」，界面在远端，本机不监听端口 ——
    // 不给环境变量就是打开 defaultOrigin 上那个正式控制台。
    const web = action === 'dev'
      ? run(process.execPath, [next, 'dev', '-H', '127.0.0.1', '-p', String(products[product].port)])
      : null;
    const desktop = run(require('electron'), [electron]);
    await (web ? Promise.race([wait(web), wait(desktop)]) : wait(desktop));
    stop();
    return;
  }
  // 产出两样互不相干的东西：
  //
  //   .desktop/<端>/        要**部署到远端服务器**的 Next standalone 包
  //   <端>/electron/desktop.json  桌面壳要加载哪个地址，打包时冻结进安装包
  //
  // 安装包里不再带那份 standalone —— 界面在远端，壳只负责加载它。
  // 前一样交给 build-webview.cjs：界面自己的 <端>/webview/build.sh 走的也是它。
  require('./build-webview.cjs').buildWebview(product);

  // APP_ORIGIN 是「这个安装包默认连哪个控制台」—— 发测试环境的包时给它。
  // 启动时同名的 GALAXY_<端>_APP_ORIGIN / GALAXY_APP_ORIGIN 仍然可以覆盖。
  //
  // 不给就把 defaultOrigin 冻进去。以前这里写的是空串，靠壳启动时报
  // 「没有配置控制台地址」兜着 —— 但绝大多数包就是要连正式环境，为此每次打包
  // 都记着导一个变量必然会漏，而漏掉的那个包要装到用户机器上才看得出来。
  // 壳里现在也有同一个兜底，这里仍然照写一遍：装好的包能直接翻出
  // resources/desktop.json 看它连哪儿，不用去反编译 dist。
  fs.writeFileSync(path.join(electron, 'desktop.json'), JSON.stringify({
    APP_ORIGIN: (process.env.APP_ORIGIN || '').trim() || defaultOrigin,
  }, null, 2));

  if (action === 'package') await wait(run(process.execPath, [require.resolve('electron-builder/cli.js'), '--projectDir', electron], { cwd: root }));
}
main().catch((error) => { console.error(error); stop(); process.exitCode = 1; });
