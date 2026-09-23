use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 进程环境的只读快照。显式传递而不是到处读 `std::env`，
/// 便于测试，也让「哪些行为受环境影响」在签名上看得见。
#[derive(Debug, Clone, Default)]
pub struct Env(HashMap<String, String>);

impl Env {
    pub fn from_process() -> Self {
        Self(std::env::vars().collect())
    }
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where I: IntoIterator<Item = (K, V)>, K: Into<String>, V: Into<String> {
        Self(pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect())
    }
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }
    /// 去掉首尾空白后仍非空才算「配了」。TS 侧多处 `?.trim()` 是同一语义。
    pub fn trimmed(&self, key: &str) -> Option<&str> {
        self.get(key).map(str::trim).filter(|v| !v.is_empty())
    }
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// `~` 与 `~/...` 展开成家目录；其余原样返回。
pub fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        return home_dir();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(p)
}

/// 桥接服务在用户机器上的落点，遵循 XDG 习惯：
///   配置：~/.config/ai-bridge/config.yaml
///   状态：~/.local/state/ai-bridge/（tokens.json、node-token.json）
/// 都可以被环境变量覆盖，方便一台机器跑多个实例或做测试。
pub fn config_dir(env: &Env) -> PathBuf {
    if let Some(dir) = env.get("AI_BRIDGE_CONFIG_DIR") {
        return expand_home(dir);
    }
    let xdg = env
        .get("XDG_CONFIG_HOME")
        .map(expand_home)
        .unwrap_or_else(|| home_dir().join(".config"));
    xdg.join("ai-bridge")
}

pub fn default_config_path(env: &Env) -> PathBuf {
    if let Some(file) = env.get("AI_BRIDGE_CONFIG") {
        return expand_home(file);
    }
    config_dir(env).join("config.yaml")
}

pub fn runtime_dir(env: &Env) -> PathBuf {
    if let Some(dir) = env.get("AI_BRIDGE_RUNTIME_DIR") {
        return expand_home(dir);
    }
    let xdg = env
        .get("XDG_STATE_HOME")
        .map(expand_home)
        .unwrap_or_else(|| home_dir().join(".local").join("state"));
    xdg.join("ai-bridge")
}

pub fn to_string_lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
