"use client";

import { getUserScopedStorageKey } from "@/utils/auth";

export interface LocalEnvironmentPreference {
  useGit: boolean;
  environments: string[];
}

const STORAGE_KEY = "zb.local-environment.v2";
const LEGACY_STORAGE_KEY = "zb.local-environment.v1";

function normalize(value: Partial<LocalEnvironmentPreference> | undefined): LocalEnvironmentPreference {
  const environments = Array.isArray(value?.environments) ? value.environments : [];
  return {
    useGit: Boolean(value?.useGit),
    environments: environments.map((item) => String(item || "").trim()).filter(Boolean),
  };
}

function readPreference(storageKey: string): LocalEnvironmentPreference | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? normalize(JSON.parse(raw) as Partial<LocalEnvironmentPreference>) : null;
  } catch {
    return null;
  }
}

function userStorageKey() {
  return getUserScopedStorageKey(STORAGE_KEY);
}

/** 首次读取时，将旧的浏览器全局偏好归属给当前登录用户。 */
export function getLocalEnvironmentPreference(): LocalEnvironmentPreference {
  if (typeof window === "undefined") return normalize(undefined);
  const storageKey = userStorageKey();
  if (!storageKey) return normalize(undefined);

  const saved = readPreference(storageKey);
  if (saved) return saved;

  const legacy = readPreference(LEGACY_STORAGE_KEY);
  if (legacy) {
    window.localStorage.setItem(storageKey, JSON.stringify(legacy));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    return legacy;
  }
  return normalize(undefined);
}

export function saveLocalEnvironmentPreference(useGit: boolean, environments: string[]) {
  const preference = normalize({ useGit, environments });
  const storageKey = userStorageKey();
  if (storageKey) window.localStorage.setItem(storageKey, JSON.stringify(preference));
  return preference;
}
