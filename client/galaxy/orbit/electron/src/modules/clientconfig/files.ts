/**
 * 把一把 Galaxy 密钥接到本机 Claude Code / Codex CLI 上：只算「文件改成什么样」，不碰磁盘，
 * 读写、确认框和备份在 impl/clientconfig.impl.ts。拆出来是为了能在 node --test 里把
 * 各种形状的现有配置都过一遍 —— 这是在改用户自己的文件，写坏一次比不写代价大得多。
 *
 * 两个客户端要的 base_url 不一样：
 *   Claude Code  ANTHROPIC_BASE_URL 是主机根，SDK 自己拼 /v1/messages —— 带着 /v1 会打到 /v1/v1/messages。
 *   Codex        model_providers.*.base_url 要带 /v1，它只拼 /responses。
 */

export const CODEX_PROVIDER_ID = 'galaxy';

/** 只认我们自己签发的密钥形状。它会原样进 JSON 和 TOML，字符集卡死了就不存在转义问题。 */
const SECRET_PATTERN = /^sk-galaxy-[A-Za-z0-9_-]{16,128}$/;

export function normalizeSecret(value: unknown): string {
  const secret = String(value ?? '').trim();
  if (!SECRET_PATTERN.test(secret)) throw new Error('不是 Galaxy 签发的算力密钥');
  return secret;
}

/**
 * 地址必须是干净的 http(s)：不带账号密码、查询串和锚点 —— 这些东西写进配置里只会是被人塞进来的。
 * 返回 origin 和去掉末尾斜杠的路径，由调用方按客户端的口径拼。
 */
export function normalizeBaseUrl(value: unknown): { origin: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('接入地址不是合法的 URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('接入地址只能是 http/https');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('接入地址不能带账号、查询参数或锚点');
  return { origin: parsed.origin, path: parsed.pathname.replace(/\/+$/, '') };
}

/** Claude Code 要主机根：去掉末尾的 /v1。 */
export function claudeBaseUrl(value: unknown): string {
  const { origin, path } = normalizeBaseUrl(value);
  return origin + path.replace(/\/v1$/, '');
}

/** Codex 要带 /v1。 */
export function codexBaseUrl(value: unknown): string {
  const { origin, path } = normalizeBaseUrl(value);
  return origin + (path.endsWith('/v1') ? path : `${path}/v1`);
}

export function isPlainHttp(value: string): boolean {
  return value.startsWith('http://');
}

export function maskSecret(secret: string): string {
  return secret.length <= 14 ? '••••' : `${secret.slice(0, 10)}••••${secret.slice(-4)}`;
}

export function tail(secret: string): string {
  return secret ? secret.slice(-4) : '';
}

/* ---------- Claude Code：~/.claude/settings.json ---------- */

type JsonObject = Record<string, unknown>;

function parseSettings(raw: string | null): JsonObject {
  if (raw === null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 解析不了就不写：按空对象覆盖上去，等于把用户原来的配置整个抹掉。
    throw new Error('settings.json 不是合法的 JSON，没有改动它；修好之后再点一次');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json 的最外层不是一个对象，没有改动它');
  return parsed as JsonObject;
}

/**
 * 只动 env 里的三个键，其余原样保留。
 *
 * ANTHROPIC_API_KEY 要删掉：它和 ANTHROPIC_AUTH_TOKEN 同时在时 Claude Code 两个头都发，
 * 原来那把（往往是真的 Anthropic 密钥）就会跟着请求一起发到 Galaxy 去。
 */
export function applyClaudeSettings(raw: string | null, baseUrl: string, secret: string): string {
  const settings = parseSettings(raw);
  const current = settings.env;
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
    throw new Error('settings.json 里的 env 不是一个对象，没有改动它');
  }
  const env: JsonObject = { ...((current as JsonObject | undefined) ?? {}) };
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = claudeBaseUrl(baseUrl);
  env.ANTHROPIC_AUTH_TOKEN = normalizeSecret(secret);
  settings.env = env;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function readClaudeSettings(raw: string | null): { baseUrl: string; secret: string } {
  try {
    const env = parseSettings(raw).env as JsonObject | undefined;
    return {
      baseUrl: typeof env?.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '',
      secret: typeof env?.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN : '',
    };
  } catch {
    return { baseUrl: '', secret: '' };
  }
}

/* ---------- Codex：~/.codex/config.toml ---------- */

/**
 * 按行改，不引 TOML 库：配置里的注释、空行和顺序都是用户自己的，解析再序列化一遍会全部冲掉。
 *
 * 只做两件事：顶层的 model_provider 指到 galaxy；[model_providers.galaxy] 整段换成新的。
 * 认不清的形状（顶层用内联表或点号键写 model_providers）直接拒绝，不猜。
 */
const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const OWN_TABLE_NAME = `model_providers\\.(?:${CODEX_PROVIDER_ID}|"${CODEX_PROVIDER_ID}"|'${CODEX_PROVIDER_ID}')`;
/** [model_providers.galaxy] 本身和它的子表（比如 .http_headers），换掉时要一起去掉。 */
const OWN_TABLE = new RegExp(`^${OWN_TABLE_NAME}(?:\\.|$)`);
/** 只有 [model_providers.galaxy] 本身，读地址和密钥时用。 */
const OWN_TABLE_EXACT = new RegExp(`^${OWN_TABLE_NAME}$`);

interface TomlLine {
  text: string;
  /** 这一行落在多行字符串里面，长得再像表头也不是。 */
  inString: boolean;
}

/**
 * 逐字符走一遍，只为知道每一行开头是不是落在多行字符串里。
 *
 * 不能按「这一行有奇数个 \"\"\"」来判：注释（# 用 """ 包长提示词）、单行字符串（"'''"）里的引号
 * 都会被当成多行字符串的开头，之后每一行都认不出表头 —— 再点一次「使用」就会追加出第二段
 * [model_providers.galaxy]，重复的表让 Codex 整个配置都读不了。
 */
function scanLines(raw: string | null): TomlLine[] {
  const lines = (raw ?? '').replace(/\r\n/g, '\n').split('\n');
  let open: '"""' | "'''" | null = null;
  return lines.map((text) => {
    const inString = open !== null;
    let index = 0;
    while (index < text.length) {
      if (open !== null) {
        // 基本多行字符串里 \ 转义下一个字符（包括引号）；字面量多行字符串没有转义。
        if (open === '"""' && text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === open[0]) {
          // 结尾允许多带一两个引号（"""a"""" 这种），连续三个以上就算关上。
          let run = 0;
          while (text[index + run] === open[0]) run += 1;
          index += run;
          if (run >= 3) open = null;
          continue;
        }
        index += 1;
        continue;
      }
      const char = text[index];
      if (char === '#') break;
      if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
        open = text.startsWith('"""', index) ? '"""' : "'''";
        index += 3;
        continue;
      }
      if (char === '"') {
        index += 1;
        while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
        index += 1;
        continue;
      }
      if (char === "'") {
        index += 1;
        while (index < text.length && text[index] !== "'") index += 1;
        index += 1;
        continue;
      }
      index += 1;
    }
    return { text, inString };
  });
}

function headerName(line: TomlLine): string | null {
  if (line.inString) return null;
  const match = HEADER.exec(line.text);
  return match ? match[1].replace(/\s+/g, '') : null;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function applyCodexConfig(raw: string | null, baseUrl: string, secret: string): string {
  const url = codexBaseUrl(baseUrl);
  const token = normalizeSecret(secret);
  const lines = scanLines(raw);

  const firstHeader = lines.findIndex((line) => headerName(line) !== null);
  const topEnd = firstHeader < 0 ? lines.length : firstHeader;
  for (let index = 0; index < topEnd; index += 1) {
    if (!lines[index].inString && /^\s*model_providers\s*[.=]/.test(lines[index].text)) {
      throw new Error('config.toml 在顶层用内联表写了 model_providers，没有改动它；改成 [model_providers.xxx] 的写法后再点一次');
    }
  }

  // 1. 顶层的 model_provider：有就改那一行，没有就插在第一个表头之前。
  const providerLine = `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`;
  let replaced = false;
  for (let index = 0; index < topEnd; index += 1) {
    if (!lines[index].inString && /^\s*model_provider\s*=/.test(lines[index].text)) {
      lines[index] = { text: providerLine, inString: false };
      replaced = true;
    }
  }
  if (!replaced) {
    // 插在顶层最后一个非空行之后；后面紧跟着表头的话补一个空行，已经有空行就不再多加。
    let insertAt = topEnd;
    while (insertAt > 0 && lines[insertAt - 1].text.trim() === '') insertAt -= 1;
    const inserted = [{ text: providerLine, inString: false }];
    if (insertAt === topEnd && topEnd < lines.length) inserted.push({ text: '', inString: false });
    lines.splice(insertAt, 0, ...inserted);
  }

  // 2. 去掉旧的 [model_providers.galaxy]（连同它的子表），到下一个别人的表头为止。
  const kept: TomlLine[] = [];
  let skipping = false;
  for (const line of lines) {
    const name = headerName(line);
    if (name !== null) skipping = OWN_TABLE.test(name);
    if (!skipping) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].text.trim() === '') kept.pop();

  // 3. 新的一段放在文件末尾。
  const block = [
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "Galaxy"',
    `base_url = ${tomlString(url)}`,
    'wire_api = "responses"',
    `experimental_bearer_token = ${tomlString(token)}`,
  ];
  const body = kept.map((line) => line.text);
  return `${[...body, ...(body.length > 0 ? [''] : []), ...block].join('\n')}\n`;
}

function tomlValue(text: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`).exec(text);
  if (!match) return null;
  const quoted = match[1];
  return quoted.startsWith("'") ? quoted.slice(1, -1) : quoted.slice(1, -1).replace(/\\(.)/g, '$1');
}

/** 读出现在生效的是不是 galaxy，以及 galaxy 那一段里的地址和密钥。 */
export function readCodexConfig(raw: string | null): { provider: string; baseUrl: string; secret: string } {
  const lines = scanLines(raw);
  let section: string | null = null;
  const result = { provider: '', baseUrl: '', secret: '' };
  for (const line of lines) {
    const name = headerName(line);
    if (name !== null) {
      section = name;
      continue;
    }
    if (line.inString) continue;
    if (section === null) {
      result.provider = tomlValue(line.text, 'model_provider') ?? result.provider;
    } else if (OWN_TABLE_EXACT.test(section)) {
      result.baseUrl = tomlValue(line.text, 'base_url') ?? result.baseUrl;
      result.secret = tomlValue(line.text, 'experimental_bearer_token') ?? result.secret;
    }
  }
  return result;
}
