"use client";

/**
 * 预设环境目录。版本要求和分系统命令与插件侧 ENVIRONMENT_PRESETS 保持一致，改动要两边一起改。
 *
 * macOS 和 Windows 的命令名、包管理器都不一样（Windows 上根本没有 python3），
 * 所以两套命令分开列，实际跑哪一套由本机插件按自己所在系统决定。
 */
export interface EnvironmentCommands {
  macos: string;
  windows: string;
}

export interface EnvironmentPreset {
  id: string;
  label: string;
  requirement: string;
  minimumVersion?: string;
  probe: EnvironmentCommands;
  install: EnvironmentCommands;
}

const EMPTY_COMMANDS: EnvironmentCommands = { macos: "", windows: "" };

export const ENVIRONMENT_PRESETS: EnvironmentPreset[] = [
  {
    id: "python",
    label: "Python",
    requirement: "3.11 及以上",
    minimumVersion: "3.11",
    probe: { macos: "python3 --version", windows: "py -3 --version" },
    install: { macos: "brew install python@3.12", windows: "winget install --id Python.Python.3.12 -e" },
  },
  {
    id: "node",
    label: "Node.js",
    requirement: "22.0 及以上",
    minimumVersion: "22.0",
    probe: { macos: "node --version", windows: "node --version" },
    install: { macos: "brew install node@22", windows: "winget install --id OpenJS.NodeJS.LTS -e" },
  },
  {
    id: "go",
    label: "Go",
    requirement: "1.21 及以上",
    minimumVersion: "1.21",
    probe: { macos: "go version", windows: "go version" },
    install: { macos: "brew install go", windows: "winget install --id GoLang.Go -e" },
  },
];

export const GIT_PRESET: EnvironmentPreset = {
  id: "__git__",
  label: "Git",
  requirement: "",
  probe: { macos: "git --version", windows: "git --version" },
  install: { macos: "brew install git", windows: "winget install --id Git.Git -e" },
};

/** 把偏好里存的标识翻成可展示的明细，自定义项没有版本下限和现成命令。 */
export function describeEnvironment(value: string): EnvironmentPreset {
  const preset = ENVIRONMENT_PRESETS.find((item) => item.id === value.trim().toLocaleLowerCase());
  return preset ?? { id: value, label: value, requirement: "", probe: EMPTY_COMMANDS, install: EMPTY_COMMANDS };
}
