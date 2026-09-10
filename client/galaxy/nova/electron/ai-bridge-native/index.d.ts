/**
 * ai-bridge 的原生实现（Rust）。由 Electron UtilityProcess 里的薄 JS 壳加载。
 *
 * 大部分方法返回 JSON 字符串：形状由 @galaxy/common 的 BridgeApi 定义，
 * 在这里再复述一遍类型只会多出一处要同步维护的地方。
 */

export interface CreatedToken {
  alias: string;
  /** 明文 token 只在这一次返回里出现，落盘的只有 sha256。 */
  token: string;
  scopes: string[];
}

export type BridgeScope = 'relay:anthropic' | 'relay:openai' | 'agent' | 'admin' | '*';

/**
 * 原生桥接。relay 与 pool 两种模式都在这里，按配置里的 mode 分流。
 * 不监听管理端口，也不装进程信号钩子：生命周期完全由调用方驱动。
 */
export class NativeBridge {
  /**
   * @param configPath 不传时按 AI_BRIDGE_CONFIG / XDG 习惯推。
   * @param bridgeVersion 由 Node 侧读自己的 package.json 传进来 ——
   *        桌面版随 Nova 分发，原生模块自己找不到那个文件。
   */
  constructor(configPath?: string, bridgeVersion?: string);
  readonly configPath: string;

  /** 解析并校验配置，返回补齐默认值后的 JSON。Node 侧读同一份结果。 */
  loadConfigJson(): string;

  /** 下面四个都返回 getStatus 的同一份 JSON。 */
  start(): Promise<string>;
  stop(): Promise<string>;
  restart(): Promise<string>;
  /** `{ state, mode, paired, nodeId, hubURL, error?, configPath, queue? }` */
  getStatus(): Promise<string>;

  /** `{ configPath, hubURL, displayName, resources, capabilities, paired, nodeId }` */
  getState(): Promise<string>;
  /** `{ running, resident, paired, nodeId, hubURL, hubMatches? }` */
  ping(hubUrl?: string): Promise<string>;

  /** `{ nodeId, tokenFile, configPath, backup, restarting }` */
  pair(code: string, displayName?: string, hubUrl?: string): Promise<string>;
  /** `{ command, launched, alreadyAuthorized? }` */
  startUpstreamLogin(provider: string): Promise<string>;

  /** ToolStatus[] 的 JSON。 */
  getTools(): Promise<string>;
  /** `{ command }` */
  upgradeTool(tool: string): Promise<string>;

  /** TokenSummary[] 的 JSON。 */
  listTokens(): Promise<string>;
  createToken(alias: string, scopes: BridgeScope[], concurrency?: number): Promise<CreatedToken>;
  revokeToken(alias: string): Promise<boolean>;
  reloadTokens(): Promise<void>;
  /** 只做格式检查，返回 tokenFile 里的条目数。 */
  verifyTokenFile(): number;
}

/** 独立的配置解析入口：没建实例时也能校验一份 YAML。 */
export function parseConfigJson(yaml: string): string;
