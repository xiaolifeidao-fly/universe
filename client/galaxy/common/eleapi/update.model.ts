/**
 * 桌面壳的自动更新：界面看得到的那一份状态。
 *
 * 两个端共用一份 —— 更新这件事在 Nova 和 Orbit 上是同一回事（同一个壳、同一套
 * electron-updater、同一个 OSS 清单），差的只有产品名和 OSS 上那一段路径。
 *
 * 界面不碰 electron-updater 的任何类型：它的事件与状态机在主进程里收敛成下面这
 * 一个结构，页面只按 state 画。主进程换一版实现（甚至换掉 electron-updater），
 * 页面不用跟着改。
 */

/**
 * 更新状态机。页面按它决定画什么，别在页面里用别的字段反推状态。
 *
 * - `unsupported` 这个壳不检查更新：开发态跑的是未打包的应用，或者部署没给
 *   更新地址（见 message）。**这是常态之一，不是故障**，界面上不要报错。
 * - `idle`        没有新版本，或者还没检查过。
 * - `checking`    正在问 OSS 上的清单。
 * - `available`   有新版本，等用户点。非强制：用户可以一直不点。
 * - `downloading`  用户点了「立即更新」，正在下。percent 有效。
 * - `downloaded`  下完了，等一次重启。没重启之前应用照常用。
 * - `error`       检查或下载失败。message 是人话，直接展示。
 */
export type UpdateState = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  /** 这台机器上现在装的版本。任何状态下都有值。 */
  currentVersion: string;
  /** 新版本号。只有 available / downloading / downloaded 时才有值。 */
  version: string;
  /** 版本说明，运营发版时写的。可能是空的 —— 空就别画那一块。 */
  notes: string;
  /** 下载进度 0–100。只有 downloading 时有意义。 */
  percent: number;
  /** 已下载 / 总字节数，用来显示「12.4 / 118 MB」。 */
  transferred: number;
  total: number;
  /** 出错原因或「为什么不检查更新」，人话，直接展示。 */
  message: string;
  /**
   * 装不了、只能让用户自己装一次。
   *
   * macOS 上 Squirrel 只接受**签过名**的应用：没有 Developer ID 证书的包下载得到、
   * 装不上。这时候把安装包在访达里指出来，用户拖一次就完事 —— 比让他自己再去
   * 下载一遍强得多。true 时界面把「立即重启」换成「打开安装包」。
   */
  manualInstall: boolean;
}

/** 起始值。页面拿不到主进程时也用它，省得到处判 null。 */
export const idleUpdateStatus: UpdateStatus = {
  state: 'unsupported',
  currentVersion: '',
  version: '',
  notes: '',
  percent: 0,
  transferred: 0,
  total: 0,
  message: '',
  manualInstall: false,
};
