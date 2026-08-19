"use client";

export interface ProjectWorkspacePreference {
  workspace: string;
  confirmedAt: string;
  /** 高级设置：项目是否使用 Git。 */
  useGit: boolean;
  /** 高级设置：预设环境标识，预设项用 python / node / go，其余是用户自定义的原文。 */
  environments: string[];
}

const STORAGE_KEY = "zb.project-workspaces.v1";

function normalize(value: Partial<ProjectWorkspacePreference> | undefined): ProjectWorkspacePreference {
  const environments = Array.isArray(value?.environments) ? value.environments : [];
  return {
    workspace: String(value?.workspace || "").trim(),
    confirmedAt: String(value?.confirmedAt || ""),
    useGit: Boolean(value?.useGit),
    environments: environments.map((item) => String(item || "").trim()).filter(Boolean),
  };
}

function loadPreferences(): Record<string, ProjectWorkspacePreference> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Partial<ProjectWorkspacePreference>>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([programId, value]) => {
        const preference = normalize(value);
        // 只有高级设置、还没确认工作目录的项目也要留着：两个页签各存各的。
        const kept = preference.workspace || preference.useGit || preference.environments.length;
        return kept ? [[programId, preference]] : [];
      }),
    );
  } catch {
    return {};
  }
}

function writePreference(programId: number, preference: ProjectWorkspacePreference) {
  const preferences = loadPreferences();
  preferences[String(programId)] = preference;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  return preference;
}

export function getProjectWorkspacePreference(programId: number) {
  return loadPreferences()[String(programId)] || null;
}

export function getProjectWorkspace(programId: number) {
  return getProjectWorkspacePreference(programId)?.workspace || "";
}

export function saveProjectWorkspacePreference(programId: number, workspace: string) {
  const normalized = workspace.trim();
  if (!normalized) throw new Error("workspace is required");
  const current = getProjectWorkspacePreference(programId);
  return writePreference(programId, {
    ...normalize(current ?? undefined),
    workspace: normalized,
    confirmedAt: new Date().toISOString(),
  });
}

/** 高级设置单独保存：改了 Git 开关或预设环境不该动已确认的工作目录。 */
export function saveProjectAdvancedPreference(programId: number, useGit: boolean, environments: string[]) {
  const current = getProjectWorkspacePreference(programId);
  return writePreference(programId, {
    ...normalize(current ?? undefined),
    useGit,
    environments: environments.map((item) => item.trim()).filter(Boolean),
  });
}

export function clearProjectWorkspacePreference(programId: number) {
  const preferences = loadPreferences();
  delete preferences[String(programId)];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
