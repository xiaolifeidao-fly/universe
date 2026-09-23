/** 本机哪一个命令行客户端。claude = Claude Code（~/.claude/settings.json），codex = Codex CLI（~/.codex/config.toml）。 */
export type ClientTool = 'claude' | 'codex';

export interface ApplyKeyInput {
  tool: ClientTool;
  /** 服务端给的 base_url（带 /v1），主进程按客户端各自的口径再改写。 */
  baseUrl: string;
  /** sk-galaxy-… 明文。只在这次调用里经过 IPC，不落进页面的任何存储。 */
  secret: string;
  /** 用来在密钥卡片上标「使用中」，不参与写配置。 */
  keyId: string;
  /**
   * 密钥被锁定的那个模型，非空时一起写进客户端配置
   * （Claude 的 ANTHROPIC_MODEL / Codex 的顶层 model）。
   *
   * 额度按模型卖之后，一份 Opus 的额度签出来的密钥只允许调 Opus。不写这一项，
   * 客户端会按它自己的默认模型发请求，接上去之后每一句都被拒 —— 而人刚买的
   * 就是这个模型。密钥没锁模型时留空：替他写死一个，等于悄悄把一把什么都能调的
   * 密钥限制住，而界面上看不出是谁干的。
   */
  model?: string;
}

export interface ApplyKeyResult {
  /** 用户在系统确认框里点了取消就是 false，文件没有动。 */
  applied: boolean;
  tool: ClientTool;
  file: string;
  /** 第一次改写这个文件时留下的原件。之后再写不会覆盖它 —— 它永远是 Orbit 动手之前的那份。 */
  backup?: string;
}

export interface ClientToolStatus {
  tool: ClientTool;
  file: string;
  exists: boolean;
  /** 配置里现在生效的地址；没接到任何地址是空串。 */
  baseUrl: string;
  /** 配置里现在那串密钥的末 4 位。整串不出主进程。 */
  keyTail: string;
  /** 最近一次由 Orbit 写进去、而且文件里现在还是那一把的 keyId。被手动改过就是空串。 */
  keyId: string;
}

export interface ClientConfigStatus {
  claude: ClientToolStatus;
  codex: ClientToolStatus;
}
