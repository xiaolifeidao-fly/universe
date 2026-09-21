import type { ElectronApi } from '@galaxy/common/eleapi/base';
import type { BridgeRuntime } from '../modules/bridge/runtime';
import { BridgeImpl } from './bridge.impl';
export function registerApiImpl(runtime: BridgeRuntime): readonly ElectronApi[] { return [new BridgeImpl(runtime)]; }
