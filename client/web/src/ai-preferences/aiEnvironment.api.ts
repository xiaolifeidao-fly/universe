"use client";

import { plainToInstance } from "class-transformer";
import { instance } from "@/utils/axios";
import { getDeliveryTaskPlannerBridgeUrl } from "@/project-workspaces/deliveryTaskPlanner";

export class AIEnvironmentHealth {
  ready = false;

  bridge = false;

  codex = false;

  claude = false;

  configured = false;

  apiReachable = false;

  message = "";

  checkedAt = 0;
}

export async function fetchAIEnvironmentHealth() {
  const response = await instance.get<AIEnvironmentHealth>(`${getDeliveryTaskPlannerBridgeUrl()}/v1/ai/health`, {
    timeout: 10000,
  });
  return plainToInstance(AIEnvironmentHealth, response.data);
}
