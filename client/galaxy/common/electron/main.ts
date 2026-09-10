import { app, BrowserWindow, utilityProcess, dialog, ipcMain, type UtilityProcess } from 'electron';
import type { Product } from '../index';
import type { ElectronApi } from '../eleapi/base';
import { registerApi } from '../eleapi/register';
import { registerRpc } from './rpc';
import path from 'node:path';
import fs from 'node:fs';
import { products } from '../index';

export function start(product: Product, { preload, implementations, onReady, onShutdown }: { preload: string; implementations: readonly ElectronApi[]; onReady?: () => Promise<void>; onShutdown?: () => Promise<void> }): void {
  const config = products[product];
  app.setName(config.name);
  app.setPath('userData', path.join(app.getPath('appData'), `Galaxy-${config.name}`));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let window: BrowserWindow;
  let server: UtilityProcess | undefined;
  let quitting = false;
  const origin = `http://127.0.0.1:${config.port}`;
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  let shutdownDone = false;
  app.on('before-quit', event => {
    quitting = true;
    if (onShutdown && !shutdownDone) {
      event.preventDefault();
      shutdownDone = true;
      void onShutdown().finally(() => { server?.kill(); app.quit(); });
    } else server?.kill();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    await onReady?.();
    if (app.isPackaged) {
      const root = path.join(process.resourcesPath, 'next');
      const entry = path.join(root, 'client/galaxy', product, 'webview/server.js');
      if (!fs.existsSync(entry)) throw new Error('Missing packaged Next.js server');
      const runtime: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
      server = utilityProcess.fork(entry, [], {
        cwd: path.dirname(entry),
        env: { ...runtime, ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(config.port), GALAXY_PRODUCT: product },
        stdio: 'pipe',
      });
      server.stdout?.on('data', (data) => console.log(data.toString()));
      server.stderr?.on('data', (data) => console.error(data.toString()));
      server.on('exit', () => {
        if (!quitting) { dialog.showErrorBox(config.name, 'Next.js 服务已退出，请检查端口占用后重新启动。'); app.quit(); }
      });
    }
    const deadline = Date.now() + 90000;
    while (true) {
      if (quitting) return;
      try {
        const response = await fetch(`${origin}/api/desktop-health`, { signal: AbortSignal.timeout(1500) });
        const health = await response.json();
        if (health.product !== product) throw new Error('Wrong product on local port');
        break;
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`Next.js 未就绪 (${origin}): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    window = new BrowserWindow({
      title: config.name, width: 1440, height: 960, minWidth: 960, minHeight: 640,
      // macOS 上把标题栏收进内容区：左栏顶部那条 34px 的空白就是给三颗按钮留的，
      // 页面侧靠 -webkit-app-region: drag 让左栏和命令条仍然能拖窗口。
      // 其它平台保持系统标题栏 —— Windows/Linux 上自绘标题栏还要自己实现
      // 最小化/最大化/关闭，得不偿失。
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 18 } }
        : {}),
      webPreferences: {
        preload, contextIsolation: true,
        nodeIntegration: false, sandbox: true,
        additionalArguments: [`--galaxy-product=${product}`],
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const dispose = registerRpc(ipcMain, registerApi(product), implementations, event =>
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === origin,
    );
    window.once('closed', dispose);
    await window.loadURL(origin);
  }).catch((error) => { dialog.showErrorBox(config.name, error.message); app.quit(); });
};
