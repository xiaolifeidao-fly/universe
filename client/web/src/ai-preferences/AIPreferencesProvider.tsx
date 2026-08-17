"use client";

import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type AITool = "codex" | "claude";
export type AIToolScene = "taskPlanning" | "requirementRefinement" | "actionExecution" | "productTesting";
export type CodexModel = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ClaudeModel = "opus" | "sonnet";
export type ClaudeEffort = "minimal" | "low" | "medium" | "high" | "max";

/** 界面上展示的工具名。存储和接口用的都是小写的 tool 值，只有露给用户的文案走这里。 */
export const toolDisplayName = (tool: AITool) => (tool === "claude" ? "Claude" : "Codex");

export const AI_TOOL_SCENES: readonly AIToolScene[] = [
  "taskPlanning",
  "requirementRefinement",
  "actionExecution",
  "productTesting",
];

export const CODEX_MODEL_OPTIONS: Array<{ value: CodexModel; label: string }> = [
  { value: "gpt-5.6-sol", label: "5.6 Sol" },
  { value: "gpt-5.6-terra", label: "5.6 Terra" },
  { value: "gpt-5.6-luna", label: "5.6 Luna" },
];

export const CLAUDE_MODEL_OPTIONS: Array<{ value: ClaudeModel; label: string }> = [
  { value: "opus", label: "Opus 5" },
  { value: "sonnet", label: "Sonnet 5" },
];

export const CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ["minimal", "low", "medium", "high", "max"];

export interface AIExecutionConfig {
  tool: AITool;
  codexModel: CodexModel;
  codexReasoningEffort: CodexReasoningEffort;
  claudeModel: ClaudeModel;
  claudeEffort: ClaudeEffort;
  claudeFastMode: boolean;
}

export type AISceneOverride = Partial<AIExecutionConfig>;

export interface AIPreferences {
  globalTool: AITool;
  codexModel: CodexModel;
  codexReasoningEffort: CodexReasoningEffort;
  claudeModel: ClaudeModel;
  claudeEffort: ClaudeEffort;
  claudeFastMode: boolean;
  scenes: Partial<Record<AIToolScene, AISceneOverride>>;
}

const STORAGE_KEY = "zb.ai.preferences.v1";
export const DEFAULT_AI_PREFERENCES: AIPreferences = {
  globalTool: "codex",
  codexModel: "gpt-5.6-terra",
  codexReasoningEffort: "medium",
  claudeModel: "sonnet",
  claudeEffort: "medium",
  claudeFastMode: false,
  scenes: {},
};

interface AIPreferencesContextValue {
  preferences: AIPreferences;
  setPreferences: (preferences: AIPreferences) => void;
  configFor: (scene: AIToolScene) => AIExecutionConfig;
  toolFor: (scene: AIToolScene) => AITool;
  setSceneOverride: (scene: AIToolScene, override: AISceneOverride | null) => void;
}

const AIPreferencesContext = createContext<AIPreferencesContextValue | null>(null);

function isAITool(value: unknown): value is AITool {
  return value === "codex" || value === "claude";
}

export function isCodexModel(value: unknown): value is CodexModel {
  return CODEX_MODEL_OPTIONS.some((option) => option.value === value);
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return CLAUDE_MODEL_OPTIONS.some((option) => option.value === value);
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return CLAUDE_EFFORTS.includes(value as ClaudeEffort);
}

function normalizeSceneOverride(value: unknown): AISceneOverride {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  return {
    ...(isAITool(raw.tool) ? { tool: raw.tool } : {}),
    ...(isCodexModel(raw.codexModel) ? { codexModel: raw.codexModel } : {}),
    ...(isCodexReasoningEffort(raw.codexReasoningEffort) ? { codexReasoningEffort: raw.codexReasoningEffort } : {}),
    ...(isClaudeModel(raw.claudeModel) ? { claudeModel: raw.claudeModel } : {}),
    ...(isClaudeEffort(raw.claudeEffort) ? { claudeEffort: raw.claudeEffort } : {}),
    ...(typeof raw.claudeFastMode === "boolean" ? { claudeFastMode: raw.claudeFastMode } : {}),
  };
}

function loadPreferences(): AIPreferences {
  if (typeof window === "undefined") return DEFAULT_AI_PREFERENCES;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, unknown>;
    const globalTool = isAITool(value.globalTool) ? value.globalTool : DEFAULT_AI_PREFERENCES.globalTool;
    const storedScenes = value.scenes && typeof value.scenes === "object"
      ? value.scenes as Record<string, unknown>
      : null;
    const scenes: AIPreferences["scenes"] = {};
    for (const scene of AI_TOOL_SCENES) {
      const override = storedScenes
        ? normalizeSceneOverride(storedScenes[scene])
        : isAITool(value[scene]) && value[scene] !== globalTool
          ? { tool: value[scene] as AITool }
          : {};
      if (Object.keys(override).length) scenes[scene] = override;
    }
    return {
      globalTool,
      codexModel: isCodexModel(value.codexModel) ? value.codexModel : DEFAULT_AI_PREFERENCES.codexModel,
      codexReasoningEffort: isCodexReasoningEffort(value.codexReasoningEffort)
        ? value.codexReasoningEffort
        : DEFAULT_AI_PREFERENCES.codexReasoningEffort,
      claudeModel: isClaudeModel(value.claudeModel) ? value.claudeModel : DEFAULT_AI_PREFERENCES.claudeModel,
      claudeEffort: isClaudeEffort(value.claudeEffort) ? value.claudeEffort : DEFAULT_AI_PREFERENCES.claudeEffort,
      claudeFastMode: typeof value.claudeFastMode === "boolean" ? value.claudeFastMode : DEFAULT_AI_PREFERENCES.claudeFastMode,
      scenes,
    };
  } catch {
    return DEFAULT_AI_PREFERENCES;
  }
}

export function globalConfig(preferences: AIPreferences): AIExecutionConfig {
  return {
    tool: preferences.globalTool,
    codexModel: preferences.codexModel,
    codexReasoningEffort: preferences.codexReasoningEffort,
    claudeModel: preferences.claudeModel,
    claudeEffort: preferences.claudeEffort,
    claudeFastMode: preferences.claudeFastMode,
  };
}

export function resolveSceneConfig(preferences: AIPreferences, scene: AIToolScene): AIExecutionConfig {
  return { ...globalConfig(preferences), ...(preferences.scenes[scene] ?? {}) };
}

export function modelForConfig(config: AIExecutionConfig) {
  return config.tool === "codex" ? config.codexModel : config.claudeModel;
}

export function effortForConfig(config: AIExecutionConfig) {
  return config.tool === "codex" ? config.codexReasoningEffort : config.claudeEffort;
}

export function AIPreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferencesState] = useState<AIPreferences>(DEFAULT_AI_PREFERENCES);

  useEffect(() => setPreferencesState(loadPreferences()), []);

  const setPreferences = useCallback((next: AIPreferences) => {
    setPreferencesState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Browser storage is optional; the selected values still apply for this session.
    }
  }, []);

  const setSceneOverride = useCallback((scene: AIToolScene, override: AISceneOverride | null) => {
    setPreferencesState((current) => {
      const scenes = { ...current.scenes };
      if (!override || !Object.keys(override).length) delete scenes[scene];
      else scenes[scene] = override;
      const next = { ...current, scenes };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Browser storage is optional; the selected values still apply for this session.
      }
      return next;
    });
  }, []);

  const value = useMemo<AIPreferencesContextValue>(
    () => ({
      preferences,
      setPreferences,
      configFor: (scene) => resolveSceneConfig(preferences, scene),
      toolFor: (scene) => resolveSceneConfig(preferences, scene).tool,
      setSceneOverride,
    }),
    [preferences, setPreferences, setSceneOverride],
  );

  return <AIPreferencesContext.Provider value={value}>{children}</AIPreferencesContext.Provider>;
}

export function useAIPreferences() {
  const context = useContext(AIPreferencesContext);
  if (!context) throw new Error("useAIPreferences must be used within AIPreferencesProvider");
  return context;
}

export function sceneForPhase(phase: "requirement" | "development" | "testing"): AIToolScene {
  if (phase === "development") return "actionExecution";
  if (phase === "testing") return "productTesting";
  return "requirementRefinement";
}
