import { BridgeApi } from '@galaxy/common/eleapi/bridge.api';
import type { BridgePairPayload, BridgePingOptions, BridgeTokenInput } from '@galaxy/common/eleapi/bridge.model';
import { BridgeRuntime } from '../modules/bridge/runtime';

export class BridgeImpl extends BridgeApi {
  constructor(private readonly runtime: BridgeRuntime) { super(); }
  override ping(options: BridgePingOptions = {}) { return this.runtime.call('ping', options); }
  override getState() { return this.runtime.call('getState'); }
  override getStatus() { return this.runtime.call('getStatus'); }
  override start() { return this.runtime.call('start'); }
  override stop() { return this.runtime.call('stop'); }
  override restart() { return this.runtime.call('restart'); }
  override pair(payload: BridgePairPayload) { return this.runtime.call('pair', payload); }
  override finish() { return this.runtime.call('finish'); }
  override startUpstreamLogin(provider: string) { return this.runtime.call('startUpstreamLogin', provider); }
  override getTools() { return this.runtime.call('getTools'); }
  override upgradeTool(tool: string) { return this.runtime.call('upgradeTool', tool); }
  override listTokens() { return this.runtime.call('listTokens'); }
  override createToken(input: BridgeTokenInput) { return this.runtime.call('createToken', input); }
  override revokeToken(alias: string) { return this.runtime.call('revokeToken', alias); }
  override reloadTokens() { return this.runtime.call('reloadTokens'); }
}
