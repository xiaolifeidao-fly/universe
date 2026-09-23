import { homedir } from 'node:os';
import { join } from 'node:path';

// 桥接在用户机器上的配置落点，遵循 XDG 习惯：~/.config/ai-bridge/config.yaml。
// Nova 会用 AI_BRIDGE_CONFIG 指到自己的 userData 下，所以这里只是兜底。
//
// 真正的配置解析在原生模块里（@galaxy/ai-bridge-native），这边只负责算出路径。
function expandHome(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AI_BRIDGE_CONFIG) return expandHome(env.AI_BRIDGE_CONFIG);
  const xdg = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME) : join(homedir(), '.config');
  return join(env.AI_BRIDGE_CONFIG_DIR ? expandHome(env.AI_BRIDGE_CONFIG_DIR) : join(xdg, 'ai-bridge'), 'config.yaml');
}
