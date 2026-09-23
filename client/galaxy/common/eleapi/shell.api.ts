import { ElectronApi, Invoke } from './base';

/**
 * Hands an http/https address to the system (default browser downloads it).
 * The page runs inside a window that denies window.open, so this is the only way out;
 * any other scheme is rejected in the main process.
 */
export class ShellApi extends ElectronApi {
  getApiName(): string { return 'ShellApi'; }
  @Invoke openExternal(url: string): Promise<void> { return this.invokeApi('openExternal', url); }
}
