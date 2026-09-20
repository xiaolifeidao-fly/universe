import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { Product } from '../index';
import type { ElectronApi } from '../eleapi/base';
import { registerApi } from '../eleapi/register';
import { registerRpc } from './rpc';
import path from 'node:path';
import { products } from '../index';
import { resolveOrigin } from './origin';
import { UpdateRuntime } from './update/runtime';
import { UpdateImpl } from './update/impl';

/**
 * 确认这个地址上跑的确实是**这个端**的控制台。
 *
 * 它拦的是配置错误（Nova 指到了 Orbit 的部署、指到了一个不相干的站点），
 * 不是攻击 —— 一台有敌意的服务器当然可以照着返回。真正挡攻击的是
 * 「地址来自配置 + 必须 https + 证书不放行」那三条。
 *
 * 连不上时给一个「重试 / 退出」，而不是直接退：远端部署碰上网络抖动是常态，
 * 为此让用户重开一次应用太粗暴。
 */
async function probe(base: string, product: Product, title: string): Promise<{ ok: boolean; updateFeed: string }> {
  for (;;) {
    let detail = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${base}/api/desktop-health`, { signal: AbortSignal.timeout(4000) });
        const health = (await response.json()) as { product?: string; updateFeed?: string };
        if (health.product !== product) {
          throw new Error(`该地址上跑的是 ${health.product ?? '未知应用'}，不是 ${product}`);
        }
        // 顺带把「这个端的更新包放在哪儿」带回来。放在这一跳而不是单开一个接口：
        // 壳本来就要探这一下才肯加载界面，而更新地址正是部署的一部分 ——
        // 换桶只要改界面那台机器的 runtime.json，装出去的壳不用重新打包。
        return { ok: true, updateFeed: (health.updateFeed ?? '').trim() };
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title,
      message: `连不上控制台 ${base}`,
      detail,
      buttons: ['重试', '退出'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return { ok: false, updateFeed: '' };
  }
}

export function start(product: Product, { preload, implementations, onReady, onShutdown }: { preload: string; implementations: readonly ElectronApi[]; onReady?: () => Promise<void>; onShutdown?: () => Promise<void> }): void {
  const config = products[product];
  // 自动更新归壳自己管，不归端：两个端是同一个壳，各端的 impl/register.ts 里
  // 不需要出现它（契约由 registerApi 给两端都注册了，实现在下面统一补上）。
  const updates = new UpdateRuntime(product);
  app.setName(config.name);
  app.setPath('userData', path.join(app.getPath('appData'), `Galaxy-${config.name}`));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let window: BrowserWindow;
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  let shutdownDone = false;
  app.on('before-quit', event => {
    updates.dispose();
    if (!onShutdown || shutdownDone) return;
    event.preventDefault();
    shutdownDone = true;
    void onShutdown().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  // 证书错误一律拒绝。Electron 默认就是拒绝，这里显式写一遍是为了让后面
  // 想「临时放行自签证书」的人必须动这一行，而不是悄悄加个 preventDefault。
  app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });
  app.whenReady().then(async () => {
    await onReady?.();
    // 地址的来源与校验规则在 origin.ts，那里有 node --test 守着（npm run test:desktop）。
    const origin = resolveOrigin({
      product,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      env: process.env,
    });
    // 三个成员共用一个域名，门户占着 `/`，控制台各挂在自己那一段下（见
    // common/index.js 的 basePath）。所以「加载哪个地址」是 origin + basePath，
    // 而「允许跳到哪里」仍然按 origin 判断 —— 同一个部署里的跳转本来就该放行，
    // 收紧到 basePath 只会把登录后回跳这类站内流程误伤掉。
    const base = origin + config.basePath;
    const health = await probe(base, product, config.name);
    if (!health.ok) { app.quit(); return; }
    // 更新在窗口之前起：检查是异步的，起得早一点，用户看到提示也就早一点。
    // 它自己吞掉所有失败 —— 更新出问题不该拦着人用应用。
    updates.start(health.updateFeed);
    window = new BrowserWindow({
      title: config.name, width: 1440, height: 960, minWidth: 960, minHeight: 640,
      // macOS 上把标题栏收进内容区：左栏顶部那条 34px 的空白就是给三颗按钮留的，
      // 页面侧靠 -webkit-app-region: drag 让左栏和命令条仍然能拖窗口。
      // 其它平台保持系统标题栏 —— Windows/Linux 上自绘标题栏还要自己实现
      // 最小化/最大化/关闭，得不偿失。
      // 窗口与任务栏图标只有 Windows/Linux 要显式给；macOS 用的是安装包里的
      // .icns，这里给了也不生效。assets/ 跟 dist/ 一起打进包（见 electron/package.json
      // 的 build.files），所以开发态和装好之后是同一条相对路径。
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 18 } }
        : { icon: path.join(__dirname, '..', 'assets', 'icon.png') }),
      webPreferences: {
        preload, contextIsolation: true,
        nodeIntegration: false, sandbox: true,
        additionalArguments: [`--galaxy-product=${product}`],
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // 站内跳转与服务端重定向都钉在这个 origin 上：跳出去的那一下，
    // 页面就不再是我们认的那个部署，却还带着同一个 IPC 通道。
    const sameOrigin = (event: { preventDefault: () => void }, url: string) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    };
    window.webContents.on('will-navigate', sameOrigin);
    window.webContents.on('will-redirect', sameOrigin);
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const dispose = registerRpc(ipcMain, registerApi(product), [...implementations, new UpdateImpl(updates)], event =>
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === origin,
    );
    window.once('closed', dispose);
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 是 ABORTED，用户自己点走或者我们拦下的跳转都会报它，不算故障。
      if (!isMainFrame || code === -3) return;
      dialog.showErrorBox(config.name, `页面加载失败 (${code} ${description})\n${url}`);
    });
    await window.loadURL(base);
  }).catch((error) => { dialog.showErrorBox(config.name, error.message); app.quit(); });
};
