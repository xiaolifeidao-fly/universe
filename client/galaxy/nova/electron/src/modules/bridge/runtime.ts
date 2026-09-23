import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { BridgeApi } from '@galaxy/common/eleapi/bridge.api';
import { prepareToolchain } from '../toolchain';

type Method = Exclude<keyof BridgeApi, 'getApiName' | 'getNamespace' | 'getRendererName' | 'isAvailable'>;
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** Owns Nova's packaged ai-bridge process. There is no caller-supplied port, path, or token. */
export class BridgeRuntime {
  private child?: UtilityProcess;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private ready?: Promise<void>;
  private closing = false;

  async ensureReady(): Promise<void> {
    if (this.closing) throw new Error('Nova is shutting down');
    if (this.ready) return this.ready;
    this.ready = this.launch().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  private async launch(): Promise<void> {
    await app.whenReady();
    let entry = require.resolve('ai-bridge/desktop-worker');
    if (app.isPackaged) entry = entry.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const data = process.env.NOVA_BRIDGE_DATA_DIR || path.join(app.getPath('userData'), 'ai-bridge');
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    // 桥接要起 npm / claude / codex（见 pool/tools.rs），而从 Dock 点开的 Nova
    // 继承的是 launchd 那份只有四个目录的 PATH —— 不补这一下，本机装了 node 也找不到。
    // 补丁只作用于这个子进程，主进程自己的 env 不动。
    const toolchain = await prepareToolchain({
      execPath: process.execPath, resourcesPath: process.resourcesPath,
      userData: app.getPath('userData'), packaged: app.isPackaged,
    });
    console.log('[ai-bridge] toolchain npm =', toolchain.npmSource);
    const child = utilityProcess.fork(entry, [], {
      cwd: path.dirname(entry), serviceName: 'Nova ai-bridge', stdio: 'pipe',
      env: { ...toolchain.env, AI_BRIDGE_DESKTOP: '1',
        AI_BRIDGE_CONFIG: path.join(data, 'config.yaml'), AI_BRIDGE_CONFIG_DIR: data,
        AI_BRIDGE_RUNTIME_DIR: path.join(data, 'state') },
    });
    this.child = child;
    child.stdout?.on('data', data => console.log('[ai-bridge]', data.toString().trimEnd()));
    child.stderr?.on('data', data => console.error('[ai-bridge]', data.toString().trimEnd()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('ai-bridge initialization timed out')); child.kill(); }, 30000);
      child.on('message', (message: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
        if (message.ready) { clearTimeout(timer); resolve(); return; }
        const pending = this.pending.get(message.id ?? -1);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id!);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        const error = new Error(`ai-bridge exited (${code})`);
        reject(error);
        if (this.child === child) { this.child = undefined; this.ready = undefined; }
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear();
      });
    });
  }
  async call<K extends Method>(method: K, ...args: Parameters<BridgeApi[K]>): Promise<Awaited<ReturnType<BridgeApi[K]>>> {
    await this.ensureReady();
    return this.send(method, args) as Promise<Awaited<ReturnType<BridgeApi[K]>>>;
  }
  private send(method: string, args: unknown[]): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('ai-bridge is not running'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ai-bridge ${method} timed out`)); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child!.postMessage({ id, method, args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async dispose(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.send('stop', []).catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 4000); }),
    ]);
    if (timer) clearTimeout(timer);
    child.kill();
  }
}
