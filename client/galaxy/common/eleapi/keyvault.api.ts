import { ElectronApi, Invoke } from './base';
import type { KeyRef, KeyVaultEntry, SaveSecretInput, SecretResult } from './keyvault.model';

/**
 * Orbit-owned: keeps issued `sk-` secrets in a local SQLite file so the console can read them back
 * without the server having to hold plaintext. Browsers fall back to localStorage in the renderer.
 *
 * 分区键 ownerId 由页面递过来，它是**多账号隔离**，不是安全边界：页面本来就拿得到自己
 * 那份明文，能骗过的只有「同一台机器上另一个使用端账号」。真要挡的是别的进程读文件 ——
 * 所以库文件落在 userData 下、权限收到 0600。
 */
export class KeyVaultApi extends ElectronApi {
  getApiName(): string { return 'KeyVaultApi'; }
  @Invoke list(ownerId: string): Promise<KeyVaultEntry[]> { return this.invokeApi('list', ownerId); }
  @Invoke read(ref: KeyRef): Promise<SecretResult> { return this.invokeApi('read', ref); }
  @Invoke save(input: SaveSecretInput): Promise<void> { return this.invokeApi('save', input); }
  @Invoke remove(ref: KeyRef): Promise<void> { return this.invokeApi('remove', ref); }
}
