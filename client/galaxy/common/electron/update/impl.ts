import { UpdateApi } from '../../eleapi/update.api';
import type { UpdateStatus } from '../../eleapi/update.model';
import type { UpdateRuntime } from './runtime';

/**
 * UpdateApi 的实现。两端共用**同一个类** —— 更新这件事在 Nova 和 Orbit 上没有分叉，
 * 各端的 impl/register.ts 里 new 一个就行（见 common/electron/main.ts 传进来的 runtime）。
 *
 * 这一层只是把 IPC 的四个方法接到 runtime 上，不放任何判断：什么时候能下载、
 * 什么时候能装，全在 runtime 的状态机里，页面骗不动它。
 */
export class UpdateImpl extends UpdateApi {
  constructor(private readonly runtime: UpdateRuntime) {
    super();
  }

  override async getStatus(): Promise<UpdateStatus> { return this.runtime.getStatus(); }
  override async check(): Promise<UpdateStatus> { return this.runtime.check(); }
  override async download(): Promise<UpdateStatus> { return this.runtime.download(); }
  override async install(): Promise<UpdateStatus> { return this.runtime.install(); }
}
