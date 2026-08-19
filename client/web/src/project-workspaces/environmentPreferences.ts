"use client";

export interface LocalEnvironmentPreference {
  useGit: boolean;
  environments: string[];
}

const STORAGE_KEY = "zb.local-environment.v1";
const LEGACY_STORAGE_KEY = "zb.project-workspaces.v1";

function normalize(value: Partial<LocalEnvironmentPreference> | undefined): LocalEnvironmentPreference {
  const environments = Array.isArray(value?.environments) ? value.environments : [];
  return {
    useGit: Boolean(value?.useGit),
    environments: environments.map((item) => String(item || "").trim()).filter(Boolean),
  };
}

function loadLegacyPreference(): LocalEnvironmentPreference | null {
  try {
    const preferences = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) || "{}") as Record<string, Partial<LocalEnvironmentPreference>>;
    const legacy = Object.values(preferences).find((preference) => Boolean(preference.useGit) || Boolean(preference.environments?.length));
    return legacy ? normalize(legacy) : null;
  } catch {
    return null;
  }
}

/** 旧版曾错误地按项目保存环境偏好；首次读取时兼容迁移已有选择。 */
export function getLocalEnvironmentPreference(): LocalEnvironmentPreference {
  if (typeof window === "undefined") return normalize(undefined);
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return normalize(JSON.parse(saved) as Partial<LocalEnvironmentPreference>);
  } catch {
    // Fall through to the legacy value or defaults.
  }
  return loadLegacyPreference() ?? normalize(undefined);
}

export function saveLocalEnvironmentPreference(useGit: boolean, environments: string[]) {
  const preference = normalize({ useGit, environments });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  return preference;
}
