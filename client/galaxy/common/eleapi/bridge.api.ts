import { ElectronApi, Invoke } from './base';
import type { BridgePing, BridgePingOptions, BridgeState, BridgePairPayload, BridgePairResult, UpstreamLoginResult, ToolStatus, BridgeRuntimeStatus, BridgeToken, BridgeTokenInput, BridgeIssuedToken } from './bridge.model';

/** Typed Nova-owned bridge API. No arbitrary local URL, file path or shell command is exposed. */
export class BridgeApi extends ElectronApi {
  getApiName(): string { return 'BridgeApi'; }
  @Invoke ping(options: BridgePingOptions = {}): Promise<BridgePing> { return this.invokeApi('ping', options); }
  @Invoke getState(): Promise<BridgeState> { return this.invokeApi('getState'); }
  @Invoke getStatus(): Promise<BridgeRuntimeStatus> { return this.invokeApi('getStatus'); }
  @Invoke start(): Promise<BridgeRuntimeStatus> { return this.invokeApi('start'); }
  @Invoke stop(): Promise<BridgeRuntimeStatus> { return this.invokeApi('stop'); }
  @Invoke restart(): Promise<BridgeRuntimeStatus> { return this.invokeApi('restart'); }
  @Invoke pair(payload: BridgePairPayload): Promise<BridgePairResult> { return this.invokeApi('pair', payload); }
  @Invoke finish(): Promise<void> { return this.invokeApi('finish'); }
  @Invoke startUpstreamLogin(provider: string): Promise<UpstreamLoginResult> { return this.invokeApi('startUpstreamLogin', provider); }
  @Invoke getTools(): Promise<ToolStatus[]> { return this.invokeApi('getTools'); }
  @Invoke upgradeTool(tool: string): Promise<{ command: string }> { return this.invokeApi('upgradeTool', tool); }
  @Invoke listTokens(): Promise<BridgeToken[]> { return this.invokeApi('listTokens'); }
  @Invoke createToken(input: BridgeTokenInput): Promise<BridgeIssuedToken> { return this.invokeApi('createToken', input); }
  @Invoke revokeToken(alias: string): Promise<void> { return this.invokeApi('revokeToken', alias); }
  @Invoke reloadTokens(): Promise<void> { return this.invokeApi('reloadTokens'); }
}
