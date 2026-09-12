import { app } from 'electron';
import path from 'node:path';
import { KeyVaultApi } from '@galaxy/common/eleapi/keyvault.api';
import type { KeyRef, KeyVaultEntry, SaveSecretInput, SecretResult } from '@galaxy/common/eleapi/keyvault.model';
import { normalizeSecret } from '../modules/clientconfig/files';
import { openVault, type Vault } from '../modules/keyvault/store';

/**
 * 密钥保险箱的主进程那一半：路径、权限、参数校验在这里，表怎么读写在 modules/keyvault/store.ts。
 *
 * 页面来自远端部署，按「页面不可信」写（和 ClientConfigImpl 同一个前提）：
 *   - 库文件的位置不从页面来，永远是 userData 下那一个。
 *   - ownerId / keyId 只认 ck_、cu_ 那种标识符形状，明文只认 sk-galaxy- 的形状。
 *     这两条卡的是「把奇怪的东西塞进库里」，不是「冒充另一个账号」—— 见 KeyVaultApi 上的说明。
 *   - 这里不弹确认框：写的是我们自己的库文件，不是用户的配置，而且明文本来就是这个页面
 *     刚从服务端拿到的，再确认一次只是噪音。
 *
 * 懒打开：sqlite 出任何问题都只让保险箱不可用（页面回落到服务端取明文），不该连累应用启动。
 */

/** 服务端的业务键形状：cu_…（账号）、ck_…（密钥）。 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function identifier(value: unknown, what: string): string {
  const id = String(value ?? '').trim();
  if (!ID_PATTERN.test(id)) throw new Error(`${what}不合法`);
  return id;
}

export class KeyVaultImpl extends KeyVaultApi {
  private vault: Vault | null = null;

  override async list(ownerId: string): Promise<KeyVaultEntry[]> {
    return this.open().list(identifier(ownerId, '账号标识'));
  }

  override async read(ref: KeyRef): Promise<SecretResult> {
    const keyId = identifier(ref?.keyId, '密钥标识');
    return { keyId, secret: this.open().read(identifier(ref?.ownerId, '账号标识'), keyId) };
  }

  override async save(input: SaveSecretInput): Promise<void> {
    this.open().save({
      ownerId: identifier(input?.ownerId, '账号标识'),
      keyId: identifier(input?.keyId, '密钥标识'),
      alias: String(input?.alias ?? '').slice(0, 64),
      secret: normalizeSecret(input?.secret),
      savedAt: new Date().toISOString(),
    });
  }

  override async remove(ref: KeyRef): Promise<void> {
    this.open().remove(identifier(ref?.ownerId, '账号标识'), identifier(ref?.keyId, '密钥标识'));
  }

  private open(): Vault {
    if (!this.vault) this.vault = openVault(path.join(app.getPath('userData'), 'key-vault.db'));
    return this.vault;
  }
}
