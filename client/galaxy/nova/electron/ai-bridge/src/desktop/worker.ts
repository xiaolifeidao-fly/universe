import { DesktopBridgeService } from './service.js';
import { defaultConfigPath } from '../core/paths.js';

// Electron UtilityProcess private channel. Never listen on a public management HTTP port.
const parent = (process as typeof process & { parentPort?: {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
} }).parentPort;
if (!parent) throw new Error('The desktop bridge worker must be started by Nova');
const service = new DesktopBridgeService(defaultConfigPath());
const methods: Record<string, (...args: unknown[]) => unknown> = {
  ping: input => service.ping(input), getState: () => service.getState(), getStatus: () => service.getStatus(),
  start: () => service.start(), stop: () => service.stop(), restart: () => service.restart(),
  pair: input => service.pair(input), finish: () => service.finish(),
  startUpstreamLogin: name => service.startUpstreamLogin(name), getTools: () => service.getTools(),
  upgradeTool: name => service.upgradeTool(name), listTokens: () => service.listTokens(),
  createToken: input => service.createToken(input), revokeToken: alias => service.revokeToken(alias),
  reloadTokens: () => service.reloadTokens(),
};
const ready = service.initialize();
parent.on('message', event => {
  void (async () => {
    const message = event.data as { id?: number; method?: string; args?: unknown[] };
    if (!message || !Number.isSafeInteger(message.id) || typeof message.method !== 'string' || !Array.isArray(message.args)) return;
    const id = message.id;
    try {
      await ready;
      if (!Object.hasOwn(methods, message.method)) throw new Error('Unknown bridge method');
      const result = await methods[message.method](...message.args);
      parent.postMessage({ id, result });
    } catch (error) { parent.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  })();
});
await ready;
// Existing Nova pairing is consent to resume after opening Nova. New installs remain stopped.
if ((await service.getStatus()).paired && process.env.NOVA_BRIDGE_AUTOSTART !== '0') await service.start().catch(() => undefined);
parent.postMessage({ ready: true });
