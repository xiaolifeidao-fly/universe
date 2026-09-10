import path from 'node:path';
import { start } from '@galaxy/common/electron/main';
import { registerApiImpl } from './impl/register';
import { BridgeRuntime } from './modules/bridge/runtime';
const runtime = new BridgeRuntime();
start('nova', { preload: path.join(__dirname, 'preload.js'), implementations: registerApiImpl(runtime),
  onReady: () => runtime.ensureReady(), onShutdown: () => runtime.dispose() });
