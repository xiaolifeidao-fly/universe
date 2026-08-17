"use client";

import { plainToInstance } from "class-transformer";
import { instance } from "@/utils/axios";

const AI_BRIDGE_URL = "https://127.0.0.1:8765";

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
  const response = await instance.get<AIEnvironmentHealth>(`${AI_BRIDGE_URL}/v1/ai/health`, {
    timeout: 10000,
  });
  return plainToInstance(AIEnvironmentHealth, response.data);
}
