import { app, shell } from 'electron';
import type { AppUpdater } from 'electron-updater';
import type { UpdateInfo } from 'builder-util-runtime';
import type { Product } from '../../index';
import { type UpdateStatus, idleUpdateStatus } from '../../eleapi/update.model';
import { resolveUpdateFeed } from './feed';

/**
 * 桌面壳的自动更新。两端共用一份。
 *
 * electron-updater 的事件流在这里收敛成 UpdateStatus 那一个结构，界面只轮询它
 * （契约见 common/eleapi/update.api.ts）。三条产品决定写死在这里：
 *
 *   1. **不自动下载**（autoDownload = false）。有新版本先问人 —— 更新不是强制的，
 *      用户点了「稍后再说」就该什么都不发生，包括不偷偷占他的带宽。
 *   2. **下完不自动重启**。装在哪一刻由用户决定；他不点，退出应用时顺手装上
 *      （autoInstallOnAppQuit）。
 *   3. **任何一步出错都只是不更新**，绝不影响应用本身 —— 更新地址没配、清单 404、
 *      网断了、mac 上没签名装不了，都收敛成一个 message 摆在界面上。
 *
 * ## macOS 上「下载完了却装不上」
 *
 * Squirrel.Mac 只接受**签过名**的应用。没有 Developer ID 证书时，
 * MacUpdater 会先派发 update-downloaded、再让原生 autoUpdater 去取那个包，
 * 然后在 error 事件里吐一句 "Could not get code signature for running application"
 * （见 node_modules/electron-updater/out/MacUpdater.js 的 updateDownloaded）。
 * 也就是说**失败发生在 downloaded 之后**，而那时候安装包已经躺在本机了。
 *
 * 所以这里不把它当失败：状态留在 downloaded，只把 manualInstall 立起来，
 * 界面上的「立即重启」换成「打开安装包」，用户自己拖一次。等哪天配了证书，
 * 这条路自然就不走了 —— 不需要改代码。
 */
export class UpdateRuntime {
  private status: UpdateStatus = { ...idleUpdateStatus };
  private updater: AppUpdater | null = null;
  private downloadedFile = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly product: Product) {}

  /**
   * 壳探到控制台之后调一次。remote 是控制台报的更新地址（/api/desktop-health 带回来的）。
   *
   * 这一步之前 getStatus() 回的是 unsupported —— 那也是开发态和没配更新地址时的终态。
   */
  start(remote: string): void {
    this.status = { ...idleUpdateStatus, currentVersion: app.getVersion() };
    // 未打包的应用没有安装包可换，electron-updater 自己也会拒绝检查。
    // GALAXY_UPDATE_DEV=1 强行打开，是为了不打包就能把整条流程跑一遍。
    const dev = !app.isPackaged && process.env.GALAXY_UPDATE_DEV !== '1';
    if (dev) {
      this.status.message = '开发态不检查更新（要验证整条流程：GALAXY_UPDATE_DEV=1）';
      return;
    }
    const feed = resolveUpdateFeed({ product: this.product, env: process.env, remote });
    if (!feed.url) {
      this.status.message = feed.reason;
      return;
    }
    const updater = loadUpdater();
    if (!updater) {
      // Linux 上不是从 AppImage / deb / rpm 里跑起来的时候没有可用的更新器。
      this.status.message = '这种安装方式不支持自动更新，请到官网下载新版本';
      return;
    }
    this.updater = updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    // 差量下载要在 OSS 上多取一个 .blockmap、还要发分段 Range 请求。省下的那点流量
    // 换来的是一条更容易出错、且只在「上一版恰好也在本机缓存里」时才生效的路径。
    // 安装包一百多兆，整包下完就是几十秒的事。
    updater.disableDifferentialDownload = true;
    if (!app.isPackaged) updater.forceDevUpdateConfig = true;
    updater.setFeedURL({ provider: 'generic', url: feed.url, channel: 'latest' });

    updater.on('checking-for-update', () => {
      if (this.status.state === 'downloading' || this.status.state === 'downloaded') return;
      this.patch({ state: 'checking', message: '' });
    });
    updater.on('update-available', (info: UpdateInfo) => {
      if (this.status.state === 'downloading' || this.status.state === 'downloaded') return;
      this.patch({ state: 'available', version: info.version, notes: releaseNotes(info), message: '' });
    });
    updater.on('update-not-available', () => {
      if (this.status.state === 'downloading' || this.status.state === 'downloaded') return;
      this.patch({ state: 'idle', version: '', notes: '', message: '' });
    });
    updater.on('download-progress', progress => {
      this.patch({
        state: 'downloading',
        percent: Math.min(100, Math.max(0, Math.round(progress.percent))),
        transferred: progress.transferred,
        total: progress.total,
      });
    });
    updater.on('update-downloaded', event => {
      this.downloadedFile = event.downloadedFile ?? '';
      this.patch({ state: 'downloaded', version: event.version, notes: releaseNotes(event), percent: 100, message: '' });
    });
    updater.on('error', error => this.fail(error));

    // 启动之后过一会儿再问：开机那几秒机器最忙，而且这时候网络常常还没就绪。
    // 之后每六小时一次 —— 更新不是紧急的事，一天问四次足够。
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    setTimeout(() => void this.check(), 8_000).unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /** 问一次 OSS 上的清单。已经在下载或已经下完的时候不打扰它。 */
  async check(): Promise<UpdateStatus> {
    if (!this.updater) return this.getStatus();
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return this.getStatus();
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.fail(error, '检查更新失败');
    }
    return this.getStatus();
  }

  /**
   * 用户点了「立即更新」。
   *
   * 下载在后台跑，这条调用不等它 —— 一百多兆要下几十秒，IPC 那头等不了那么久；
   * 进度由页面轮询 getStatus()。
   */
  async download(): Promise<UpdateStatus> {
    if (!this.updater) return this.getStatus();
    if (this.status.state !== 'available' && this.status.state !== 'error') return this.getStatus();
    if (!this.status.version) return this.getStatus();
    this.patch({ state: 'downloading', percent: 0, transferred: 0, total: 0, message: '' });
    this.updater.downloadUpdate().catch(error => this.fail(error, '下载失败'));
    return this.getStatus();
  }

  /**
   * 装上。
   *
   * 正常路径是退出应用、由安装器换掉文件再把应用拉起来，所以这条调用**不会返回给一个
   * 还活着的页面** —— 退出动作丢进 setImmediate，先把这次 IPC 的响应发出去，
   * 否则页面那边会看到一个永远不 resolve 的 Promise。
   */
  async install(): Promise<UpdateStatus> {
    if (!this.updater || this.status.state !== 'downloaded') return this.getStatus();
    if (this.status.manualInstall) {
      if (this.downloadedFile) shell.showItemInFolder(this.downloadedFile);
      return this.getStatus();
    }
    const updater = this.updater;
    setImmediate(() => {
      try {
        updater.quitAndInstall();
      } catch (error) {
        this.fail(error, '安装失败');
      }
    });
    return this.getStatus();
  }

  private patch(next: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...next };
  }

  /**
   * 出错。原文一起带上：运维排「为什么全网都没收到更新」时，要的正是
   * "Cannot find latest-mac.yml" 这种原话。
   */
  private fail(error: unknown, prefix = '更新失败'): void {
    const detail = error instanceof Error ? error.message : String(error);
    // mac 上没签名时，这条 error 是在 update-downloaded **之后**来的：包已经在本机了，
    // 装不上而已。这时候降级成「自己装一次」，而不是把一次成功的下载报成失败。
    if (this.status.state === 'downloaded') {
      this.patch({ manualInstall: true, message: `这台电脑上装不了，需要手动安装一次（${detail}）` });
      return;
    }
    this.patch({ state: 'error', message: `${prefix}：${detail}` });
  }
}

/**
 * 取平台对应的更新器。
 *
 * electron-updater 的 autoUpdater 是个惰性 getter，取值那一刻才按平台 new 出来；
 * Linux 上不是从 AppImage / deb / rpm 里跑起来的时候它给不出实例（那种安装方式
 * 本来也没有「换掉安装包」这个动作）。所以这里不在模块顶上取，也允许它是空的。
 */
function loadUpdater(): AppUpdater | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { autoUpdater } = require('electron-updater') as { autoUpdater?: AppUpdater };
    return autoUpdater ?? null;
  } catch {
    return null;
  }
}

/** 版本说明。运营在管理端发版时写的那段，可能按版本分段，这里只要最新那一段。 */
function releaseNotes(info: UpdateInfo): string {
  const notes = info.releaseNotes;
  if (typeof notes === 'string') return notes.trim();
  if (Array.isArray(notes)) return notes.map(item => item.note ?? '').filter(Boolean).join('\n\n').trim();
  return '';
}
