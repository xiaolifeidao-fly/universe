import { ElectronApi, Invoke } from './base';
import type { UpdateStatus } from './update.model';

/**
 * 两端共用：桌面壳自己的版本更新。
 *
 * 界面主动问、主动点，主进程不往回推事件 —— 这条 IPC 通道是按 @Invoke 自动生成的
 * 请求/响应（见 common/electron/rpc.ts），没有订阅语义。下载进度靠页面轮询
 * `getStatus()`，一次调用就是读一个内存里的结构，便宜到可以每两秒问一次。
 *
 * 界面部署在远端：装着旧版壳的人打开的也是新页面，那一版壳里没有这个契约。
 * 所以页面必须先 `isAvailable()` 再用，拿不到就整块不画（浏览器里也一样）。
 */
export class UpdateApi extends ElectronApi {
  getApiName(): string { return 'UpdateApi'; }
  /** 当前状态。随便问，不触发任何网络请求。 */
  @Invoke getStatus(): Promise<UpdateStatus> { return this.invokeApi('getStatus'); }
  /** 手动检查一次。用户在账户页点「检查更新」走这条；启动后与每隔几小时的自动检查在主进程里。 */
  @Invoke check(): Promise<UpdateStatus> { return this.invokeApi('check'); }
  /** 用户点了「立即更新」。下载在后台跑，这条调用立刻返回，进度看 getStatus()。 */
  @Invoke download(): Promise<UpdateStatus> { return this.invokeApi('download'); }
  /** 下完之后重启装上。装不了的（manualInstall）会改成把安装包在文件管理器里指出来。 */
  @Invoke install(): Promise<UpdateStatus> { return this.invokeApi('install'); }
}
