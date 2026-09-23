import type { Product } from '../index';
import type { ApiClass } from './base';
import { BridgeApi } from './bridge.api';
import { ClientConfigApi } from './clientconfig.api';
import { KeyVaultApi } from './keyvault.api';
import { ShellApi } from './shell.api';
import { UpdateApi } from './update.api';

/** One contract registry for both main and preload. New API modules are listed here once. */
export function registerApi(product: Product): readonly ApiClass[] {
  // ShellApi 与 UpdateApi 两端都有：「把地址交给系统去开」和「壳自己升级」都是
  // 壳的能力，和端的业务无关 —— 两个端是同一个壳，实现在 common/electron/main.ts
  // 里统一补上，各端的 impl/register.ts 里不出现它们。
  return product === 'nova'
    ? [BridgeApi, ShellApi, UpdateApi]
    : [ClientConfigApi, KeyVaultApi, ShellApi, UpdateApi];
}
