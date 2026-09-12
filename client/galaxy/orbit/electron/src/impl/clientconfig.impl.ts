import { app, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientConfigApi } from '@galaxy/common/eleapi/clientconfig.api';
import type { ApplyKeyInput, ApplyKeyResult, ClientConfigStatus, ClientTool, ClientToolStatus } from '@galaxy/common/eleapi/clientconfig.model';
import {
  applyClaudeSettings,
  applyCodexConfig,
  claudeBaseUrl,
  codexBaseUrl,
  CODEX_PROVIDER_ID,
  isPlainHttp,
  maskSecret,
  normalizeSecret,
  readClaudeSettings,
  readCodexConfig,
  tail,
} from '../modules/clientconfig/files';

/**
 * 「使用」按钮的主进程那一半：把密钥写进本机 Claude Code / Codex 的配置。
 *
 * 页面来自远端部署，所以这里按「页面不可信」来写（和 Nova 的 BridgeApi 同一个前提，见 client/galaxy/README.md）：
 *   - 能写的只有两个固定文件，路径不从页面来；地址和密钥过一遍形状校验才进文件。
 *   - 每一次写都弹系统确认框，写什么、写到哪、原件备份在哪都摆在框里。框是主进程画的，
 *     页面既点不了也盖不住 —— 一台被人改过的服务器最多能让用户看见一个奇怪的地址，然后点取消。
 *   - 第一次改写前把原件留一份 .orbit-backup，之后不再覆盖它：它永远是 Orbit 动手之前的样子。
 */

const TOOL_NAMES: Record<ClientTool, string> = { claude: 'Claude Code', codex: 'Codex' };
const BACKUP_SUFFIX = '.orbit-backup';

interface AppliedRecord {
  keyId: string;
  keyTail: string;
  baseUrl: string;
  appliedAt: string;
}

type AppliedState = Partial<Record<ClientTool, AppliedRecord>>;

/** 两个客户端都认自己的环境变量改配置目录；GUI 启动时通常没有，从终端 dev 起来时可能有。 */
function configFile(tool: ClientTool): string {
  if (tool === 'claude') {
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  }
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'client-config.json');
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readState(): Promise<AppliedState> {
  try {
    return JSON.parse((await readText(stateFile())) ?? '{}') as AppliedState;
  } catch {
    return {};
  }
}

/**
 * 先写临时文件再改名：写到一半断电或者磁盘满了，原文件还是完整的。文件里有密钥，权限收到 0600。
 *
 * 目标是软链接时写到它指向的那个文件：dotfiles 仓库管着的配置常常是链过来的，
 * 直接改名覆盖链接，链接就变成一个普通文件，用户仓库里那份再也收不到改动。
 */
async function writeAtomically(file: string, content: string): Promise<void> {
  const target = await fs.realpath(file).catch(() => file);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.orbit-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export class ClientConfigImpl extends ClientConfigApi {
  override async getStatus(): Promise<ClientConfigStatus> {
    const state = await readState();
    const [claude, codex] = await Promise.all([this.toolStatus('claude', state), this.toolStatus('codex', state)]);
    return { claude, codex };
  }

  override async applyKey(input: ApplyKeyInput): Promise<ApplyKeyResult> {
    const tool = input?.tool;
    if (tool !== 'claude' && tool !== 'codex') throw new Error('不支持的客户端');
    const secret = normalizeSecret(input.secret);
    const keyId = String(input.keyId ?? '').slice(0, 64);
    const baseUrl = tool === 'claude' ? claudeBaseUrl(input.baseUrl) : codexBaseUrl(input.baseUrl);
    const file = configFile(tool);
    const original = await readText(file);
    // 先把新内容算出来：现有文件认不清的话在弹框之前就报错，别让用户确认完了才发现没写。
    const next = tool === 'claude' ? applyClaudeSettings(original, baseUrl, secret) : applyCodexConfig(original, baseUrl, secret);
    const backup = `${file}${BACKUP_SUFFIX}`;
    const backupExists = original !== null && (await readText(backup)) !== null;

    const detail = [
      `文件：${file}`,
      `地址：${baseUrl}`,
      `密钥：${maskSecret(secret)}`,
      tool === 'claude'
        ? '改动：env 里的 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN（并移除 ANTHROPIC_API_KEY），其余设置不动。'
        : `改动：顶层 model_provider 设为 ${CODEX_PROVIDER_ID}，[model_providers.${CODEX_PROVIDER_ID}] 整段替换，其余配置不动。`,
      original === null ? '这个文件现在不存在，会新建。' : backupExists ? `原件在 ${backup}（之前留的，这次不覆盖）。` : `写之前先把原件存到 ${backup}。`,
      ...(isPlainHttp(baseUrl) ? ['注意：这是明文 http 地址，密钥会在网络上不加密地传输。'] : []),
    ].join('\n');
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'question' as const,
      title: 'Orbit',
      message: `把这把密钥接到 ${TOOL_NAMES[tool]}？`,
      detail,
      buttons: ['写入配置', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response !== 0) return { applied: false, tool, file };

    if (original !== null && !backupExists) await writeAtomically(backup, original);
    await writeAtomically(file, next);

    const state = await readState();
    state[tool] = { keyId, keyTail: tail(secret), baseUrl, appliedAt: new Date().toISOString() };
    await writeAtomically(stateFile(), `${JSON.stringify(state, null, 2)}\n`).catch(() => {
      // 记不下「哪一把在用」只影响卡片上那个标签，配置已经写好了，不为它报错。
    });
    return { applied: true, tool, file, ...(original !== null ? { backup } : {}) };
  }

  private async toolStatus(tool: ClientTool, state: AppliedState): Promise<ClientToolStatus> {
    const file = configFile(tool);
    const raw = await readText(file).catch(() => null);
    let baseUrl = '';
    let secret = '';
    if (tool === 'claude') {
      ({ baseUrl, secret } = readClaudeSettings(raw));
    } else {
      const codex = readCodexConfig(raw);
      // model_provider 不是 galaxy 时，galaxy 那一段写着也不生效，当成没接。
      if (codex.provider === CODEX_PROVIDER_ID) ({ baseUrl, secret } = codex);
    }
    const record = state[tool];
    // 文件里现在还是 Orbit 写进去的那一把（地址和末 4 位都对得上），才认 keyId；被手动改过就不认。
    const keyId = record && secret && record.keyTail === tail(secret) && record.baseUrl === baseUrl ? record.keyId : '';
    return { tool, file, exists: raw !== null, baseUrl, keyTail: tail(secret), keyId };
  }
}
