/** Shared DTOs for Nova-owned bridge IPC. */
export interface BridgePing {
  /** 内置 bridge 配置的平台地址。 */
  hubURL?: string;
  running: boolean;
  resident: boolean;
  paired: boolean;
  nodeId?: string;
  /**
   * 本机 ai-bridge 连的是不是**调用方问的那个** Hub。只有传了 hubUrl 才有值。
   *
   */
  hubMatches?: boolean;
}

export interface BridgeCapability {
  kind: string;
  provider: string;
  available: boolean;
  detail: string;
  upstream?: string;
}

export interface BridgeResources {
  platform?: string;
  cpus?: number;
  totalMemMB?: number;
  freeMemMB?: number;
}

export interface BridgeState {
  configPath: string;
  hubURL: string;
  displayName: string;
  resources: BridgeResources;
  capabilities: BridgeCapability[];
  paired: boolean;
  nodeId?: string;
}

/** 把本机绑定的平台地址对齐到控制台所连的那台的结果。 */
export interface BridgeHubSync {
  /** 校准之后本机绑的地址。changed 为 false 时就是原来那个。 */
  hubURL: string;
  /** 是否真的改写了配置。origin 一致、或者本机还没绑过平台时都是 false。 */
  changed: boolean;
  /** 校准之后还算不算已配对。换了平台就是 false —— 旧令牌只对旧地址有效。 */
  paired: boolean;
  /** 改写前的地址，只有 changed 为 true 时有。 */
  previous?: string;
  /** 改写前的配置备份路径。 */
  backup?: string;
}

export interface BridgePairPayload {
  /** 省略时使用本机配置的平台地址；已有平台配置时必须匹配。 */
  hubURL?: string;
  code: string;
  displayName?: string;
}

export interface BridgePairResult {
  nodeId: string;
  tokenFile: string;
  configPath: string;
  backup?: string;
  /** 配对后已使用新身份重新启动内置 runner。 */
  restarting?: boolean;
}

export interface UpstreamLoginResult {
  /** 该上游的登录命令，控制台在拉不起终端时显示出来让用户自己敲。 */
  command: string;
  /** 是否真的把终端窗口拉起来了。只有 macOS 会是 true。 */
  launched: boolean;
  /** 凭据本来就是好的，没必要重新登录。 */
  alreadyAuthorized?: boolean;
}

export interface ToolStatus {
  name: string;
  /** 本机正在跑的版本。空串表示没装。 */
  current: string;
  /** 上游最新版。空串表示拿不到（网络不通等）。 */
  latest: string;
  /** 只有两边都拿得到、且不相等才为 true —— 拿不到时不催人升级。 */
  upgradable: boolean;
  installed: boolean;
}

export interface BridgePingOptions { hubUrl?: string }

export interface BridgeRuntimeStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  mode: 'relay' | 'pool';
  /**
   * 接入方式。Nova 内置的 bridge 只走 poll；export 是独立部署的 ai-bridge 才有的。
   * runner 在跑时报的是回落之后的事实，没在跑时是配置里声明的值。
   */
  accessMode?: 'poll' | 'export';
  paired: boolean;
  nodeId?: string;
  hubURL: string;
  error?: string;
  configPath: string;
}
export type BridgeScope = '*' | 'relay:anthropic' | 'relay:openai' | 'agent' | 'admin';
export interface BridgeTokenInput { alias: string; scopes: BridgeScope[]; concurrency?: number }
export interface BridgeToken { alias: string; scopes: BridgeScope[]; concurrency?: number; source: string }
export interface BridgeIssuedToken { alias: string; token: string; scopes: BridgeScope[] }
