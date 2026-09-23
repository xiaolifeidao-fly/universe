"use client";

import { useEffect } from "react";
import { instance } from "@/utils/axios";
import { getAuthToken, getAuthUser } from "@/utils/auth";
import { getDeliveryTaskPlannerBridgeUrl } from "@/project-workspaces/deliveryTaskPlanner";

/** 插件配置文件只维护后端接口地址，token 和 user_id 靠这条心跳送过去。 */
export const DELIVERY_TASK_PLANNER_HEARTBEAT_INTERVAL_MS = 60_000;

export async function sendDeliveryTaskPlannerHeartbeat() {
  const user = getAuthUser();
  if (!user || !getAuthToken().trim()) {
    return false;
  }
  // 本地桥接没装或没起来是常态，心跳失败不打扰用户，下一分钟再试。
  try {
    await instance.post(
      `${getDeliveryTaskPlannerBridgeUrl()}/v1/session/heartbeat`,
      { userId: String(user.id) },
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** 控制台在线期间每分钟把当前账号凭证同步给本地插件。 */
export function useDeliveryTaskPlannerHeartbeat() {
  useEffect(() => {
    void sendDeliveryTaskPlannerHeartbeat();
    const timer = window.setInterval(() => {
      void sendDeliveryTaskPlannerHeartbeat();
    }, DELIVERY_TASK_PLANNER_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
