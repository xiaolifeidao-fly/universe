import { ElectronApi, Invoke } from './base';
import type { ApplyKeyInput, ApplyKeyResult, ClientConfigStatus } from './clientconfig.model';

/**
 * Orbit-owned: points the local Claude Code / Codex CLI at a Galaxy key.
 * Only the two fixed config files can be touched; every write is confirmed in a native dialog
 * that the page cannot drive, and the original file is backed up once.
 */
export class ClientConfigApi extends ElectronApi {
  getApiName(): string { return 'ClientConfigApi'; }
  @Invoke getStatus(): Promise<ClientConfigStatus> { return this.invokeApi('getStatus'); }
  @Invoke applyKey(input: ApplyKeyInput): Promise<ApplyKeyResult> { return this.invokeApi('applyKey', input); }
}
