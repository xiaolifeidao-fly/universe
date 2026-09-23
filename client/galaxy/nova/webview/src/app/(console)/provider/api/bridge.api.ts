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
/** 把本机绑的平台地址对齐到控制台所连的那台。origin 一致时是空操作。 */
export const syncBridgeHub = (hubUrl: string) => bridgeApi.setHubUrl(hubUrl);
export const fetchTools = () => bridgeApi.getTools();
export const startUpstreamLogin = (provider: string) => bridgeApi.startUpstreamLogin(provider);
export const upgradeTool = (tool: string) => bridgeApi.upgradeTool(tool);
