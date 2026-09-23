import type { ElectronApi } from '@galaxy/common/eleapi/base';
import { ClientConfigImpl } from './clientconfig.impl';
import { KeyVaultImpl } from './keyvault.impl';
export function registerApiImpl(): readonly ElectronApi[] { return [new ClientConfigImpl(), new KeyVaultImpl()]; }
