import { copyFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeBridge as NativeBridgeInstance } from '@galaxy/ai-bridge-native';
import { ScopeSchema } from '../config/schema.js';
import { z } from 'zod';

// 桌面服务：一层薄壳。
//
// 真正的实现（配置解析、鉴权、并发闸门、上游凭据、relay 透传、共享池运行循环）
// 都在 Rust 原生模块里。这里只做三件事：入参校验、把变更串行化、把首次启动
// 需要的配置模板铺到位。
//
// CJS 原生模块用 createRequire 显式加载，不依赖 ESM/CJS 的 default 互操作猜测。
const requireNative = createRequire(import.meta.url);
const { NativeBridge } = requireNative('@galaxy/ai-bridge-native') as {
  NativeBridge: new (configPath?: string, bridgeVersion?: string) => NativeBridgeInstance;
};

const PairInput = z.object({ hubURL: z.string().url().optional(), code: z.string().trim().min(1).max(512), displayName: z.string().max(256).optional() }).strict();
const PingInput = z.object({ hubUrl: z.string().url().optional() }).strict();
const TokenInput = z.object({ alias: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/), scopes: z.array(ScopeSchema).min(1), concurrency: z.number().int().positive().optional() }).strict();
const NameInput = z.string().min(1).max(128);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** No HTTP listener or CLI process hooks. Called only by Nova's private worker channel. */
export class DesktopBridgeService {
  private native?: NativeBridgeInstance;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(readonly configPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    if (!existsSync(this.configPath)) {
      await copyFile(join(packageRoot, 'config.example.yaml'), this.configPath);
      // copyFile preserves the template mode; protect local settings from other users.
      await chmod(this.configPath, 0o600);
    }
    // 版本号从这个包自己的 package.json 来：桌面版随 Nova 分发，
    // 原生模块所在的目录里没有这个文件。
    let version = '0.0.0';
    try {
      version = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version ?? version;
    } catch { /* 读不到就用兜底值，不该因此起不来 */ }
    this.native = new NativeBridge(this.configPath, version);
  }

  private get bridge(): NativeBridgeInstance {
    if (!this.native) throw new Error('bridge service is not initialized');
    return this.native;
  }

  /** 变更串行化：并发的 start / stop / pair 不该互相插队。 */
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action, action);
    this.serial = result.catch(() => undefined);
    return result;
  }

  async ping(input: unknown = {}) {
    const options = PingInput.parse(input);
    return JSON.parse(await this.bridge.ping(options.hubUrl));
  }
  async getState() { return JSON.parse(await this.bridge.getState()); }
  async getStatus() { return JSON.parse(await this.bridge.getStatus()); }

  start() { return this.mutate(async () => JSON.parse(await this.bridge.start())); }
  stop() { return this.mutate(async () => JSON.parse(await this.bridge.stop())); }
  restart() { return this.mutate(async () => JSON.parse(await this.bridge.restart())); }

  pair(input: unknown) {
    const payload = PairInput.parse(input);
    return this.mutate(async () =>
      JSON.parse(await this.bridge.pair(payload.code, payload.displayName, payload.hubURL)));
  }
  async finish(): Promise<void> { /* Closes the UI flow, never the owned service. */ }

  async startUpstreamLogin(input: unknown) {
    return JSON.parse(await this.bridge.startUpstreamLogin(NameInput.parse(input)));
  }
  async getTools() { return JSON.parse(await this.bridge.getTools()); }
  async upgradeTool(input: unknown) { return JSON.parse(await this.bridge.upgradeTool(NameInput.parse(input))); }

  async listTokens() { return JSON.parse(await this.bridge.listTokens()); }
  createToken(input: unknown) {
    const payload = TokenInput.parse(input);
    return this.mutate(() => this.bridge.createToken(payload.alias, payload.scopes, payload.concurrency));
  }
  revokeToken(input: unknown) {
    const alias = NameInput.parse(input);
    return this.mutate(async () => {
      if (!await this.bridge.revokeToken(alias)) throw new Error('token alias not found');
    });
  }
  async reloadTokens(): Promise<void> { await this.bridge.reloadTokens(); }
}
