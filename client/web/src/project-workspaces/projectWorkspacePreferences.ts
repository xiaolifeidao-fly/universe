"use client";

export interface ProjectWorkspacePreference {
  workspace: string;
  confirmedAt: string;
}

const STORAGE_KEY = "zb.project-workspaces.v1";

function loadPreferences(): Record<string, ProjectWorkspacePreference> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Partial<ProjectWorkspacePreference>>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([programId, value]) => {
        const workspace = String(value?.workspace || "").trim();
        return workspace ? [[programId, { workspace, confirmedAt: String(value?.confirmedAt || "") }]] : [];
      }),
    );
  } catch {
    return {};
  }
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
  const preferences = loadPreferences();
  preferences[String(programId)] = {
    workspace: normalized,
    confirmedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  return preferences[String(programId)];
}

export function clearProjectWorkspacePreference(programId: number) {
  const preferences = loadPreferences();
  delete preferences[String(programId)];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
