"use client";
import { BridgeApi } from "@galaxy/common/eleapi/bridge.api";
import type { BridgePairPayload, BridgePingOptions } from "@galaxy/common/eleapi/bridge.model";
export type * from "@galaxy/common/eleapi/bridge.model";
export const bridgeApi = new BridgeApi();
export async function pingBridge(options: BridgePingOptions = {}) {
  if (!bridgeApi.isAvailable()) return null;
  try { return await bridgeApi.ping(options); } catch { return null; }
}
export const fetchBridgeState = () => bridgeApi.getState();
export const pairWithBridge = (payload: BridgePairPayload) => bridgeApi.pair(payload);
export const fetchTools = () => bridgeApi.getTools();
export const startUpstreamLogin = (provider: string) => bridgeApi.startUpstreamLogin(provider);
export const upgradeTool = (tool: string) => bridgeApi.upgradeTool(tool);
