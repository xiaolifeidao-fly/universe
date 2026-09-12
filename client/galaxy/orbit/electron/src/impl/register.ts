import type { ElectronApi } from '@galaxy/common/eleapi/base';
import { ClientConfigImpl } from './clientconfig.impl';
export function registerApiImpl(): readonly ElectronApi[] { return [new ClientConfigImpl()]; }
