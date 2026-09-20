import type { Product } from '../index';
import type { ApiClass } from './base';
import { BridgeApi } from './bridge.api';
import { ClientConfigApi } from './clientconfig.api';
import { KeyVaultApi } from './keyvault.api';
import { ShellApi } from './shell.api';
import { UpdateApi } from './update.api';

/** One contract registry for both main and preload. New API modules are listed here once. */
export function registerApi(product: Product): readonly ApiClass[] {
  // UpdateApi 两端都有：壳的自动更新和端的业务无关，两个端是同一个壳、同一套
  // electron-updater，只是各自去自己那一段 OSS 路径上取清单。
  return product === 'nova'
    ? [BridgeApi, ShellApi, UpdateApi]
    : [ClientConfigApi, KeyVaultApi, UpdateApi];
}
