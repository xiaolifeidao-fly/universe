import { request } from "@/api/client";

export interface PushConfig {
  enabled: boolean;
  applicationServerKey: string;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function getPushConfig() {
  return request<PushConfig>("/push/config");
}

export function savePushSubscription(subscription: PushSubscriptionPayload) {
  return request<{ subscribed: boolean }>("/push/subscription", { method: "PUT", body: subscription });
}

export function removePushSubscription(endpoint: string) {
  return request<{ subscribed: boolean }>("/push/subscription", { method: "DELETE", body: { endpoint } });
}
