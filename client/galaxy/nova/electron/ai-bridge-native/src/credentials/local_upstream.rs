use crate::config::schema::{AuthMode, ProviderConfig};
use crate::core::paths::{expand_home, home_dir, Env};
use crate::credentials::toml_lite::parse_toml_lite;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// 上游地址跟着**本机正在用的**那一个走。
///
/// 桥接是借这台机器的 Claude Code / Codex 订阅登录态干活的。这台机器自己如果接的是
/// 别家中转站（Codex 的 config.toml 里 model_provider 指向自定义 base_url，或 Claude Code
/// 的 settings.json / 环境变量里配了 ANTHROPIC_BASE_URL），那份登录态很可能只在那个
/// 中转站上有效，硬打官方地址反而 401。反过来没配中转就是订阅官方，直连即可。
///
/// 所以 provider 不写 baseURL 时，这里按各家 CLI 自己的读法把地址解析出来；
/// 写了 baseURL 就是主人的明确决定，一律以它为准。每次请求重新读，改完配置不用重启。
pub const OFFICIAL_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
/// Codex 的 chatgpt_base_url 默认值；订阅登录态打的是它下面的 /codex。
pub const OFFICIAL_CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpstreamAuthKind { Bearer, XApiKey }

#[derive(Debug, Clone)]
pub struct UpstreamAuth {
    pub kind: UpstreamAuthKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireApi { Responses, Chat }

#[derive(Debug, Clone)]
pub struct UpstreamTarget {
    /// 已含协议前缀路径：anthropic 以 /v1 结尾，codex 以 /codex 或中转自己的 /v1 结尾。
    /// 请求路径去掉客户端的 /v1 后直接接上去。
    pub base_url: String,
    /// 人话，给日志与控制台看：从哪读来的。
    pub source: String,
    /// 本机接中转站用的令牌。空表示用订阅登录态（凭据提供者自己去读）。
    pub auth: Option<UpstreamAuth>,
    /// 本机 CLI 配置里要求每个请求都带的静态头（Codex 的 http_headers / env_http_headers，
    /// Claude Code 的 ANTHROPIC_CUSTOM_HEADERS）。中转站的鉴权常常就藏在这里。
    pub headers: BTreeMap<String, String>,
    /// Codex 自定义 provider 的协议：chat 只能走 /v1/chat/completions。
    pub wire_api: Option<WireApi>,
}

/// 按 provider 解析上游。配置里写了 baseURL 就用它，不看本机 CLI 的配置。
pub async fn resolve_upstream(provider: &ProviderConfig, env: &Env) -> Result<UpstreamTarget, String> {
    if let Some(base) = &provider.base_url {
        return Ok(UpstreamTarget {
            base_url: trim_slash(base),
            source: "配置 baseURL".into(),
            auth: None,
            headers: BTreeMap::new(),
            wire_api: None,
        });
    }
    match provider.auth_mode {
        Some(AuthMode::ClaudeOauth) => Ok(resolve_claude_upstream(env, None).await),
        Some(AuthMode::CodexChatgpt) => resolve_codex_upstream(provider.auth_file.as_deref(), env).await,
        other => Err(format!(
            "authMode={} 的 provider 必须配置 baseURL",
            other.map(AuthMode::label).unwrap_or("api_key"),
        )),
    }
}

// ---------- Claude Code ----------

const CLAUDE_ENV_KEYS: [&str; 4] = [
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS",
];

struct EnvLayer {
    name: &'static str,
    env: BTreeMap<String, String>,
}

pub fn claude_config_dir(env: &Env) -> PathBuf {
    match env.get("CLAUDE_CONFIG_DIR") {
        Some(dir) => expand_home(dir),
        None => home_dir().join(".claude"),
    }
}

/// 企业托管配置。它的优先级最高：主人自己改不动，桥接也不该绕过去。
pub fn managed_settings_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(r"C:\ProgramData\ClaudeCode\managed-settings.json")
    } else {
        PathBuf::from("/etc/claude-code/managed-settings.json")
    }
}

async fn read_settings_env(path: &std::path::Path) -> Option<BTreeMap<String, String>> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    // settings.json 写坏了是 Claude Code 自己的问题；这里当没有，退到下一层。
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let env = parsed.get("env")?.as_object()?;
    Some(pick_claude_env(env))
}

fn pick_claude_env(source: &Map<String, Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for key in CLAUDE_ENV_KEYS {
        if let Some(value) = source.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                out.insert(key.to_string(), value.to_string());
            }
        }
    }
    out
}

fn pick_process_env(env: &Env) -> BTreeMap<String, String> {
    CLAUDE_ENV_KEYS
        .iter()
        .filter_map(|key| env.trimmed(key).map(|v| ((*key).to_string(), v.to_string())))
        .collect()
}

/// Claude Code 的上游读法：managed-settings.json > ~/.claude/settings.json 的 env > 进程环境变量。
///
/// 官方地址 → 订阅登录态直连，忽略环境里的 API key（那是「本机订阅」这条路的定义）。
/// 中转地址 → 用同一套配置里的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY；一个都没有
/// 就仍然带订阅登录态过去（有些中转本来就是拿 OAuth token 透传的）。
pub async fn resolve_claude_upstream(env: &Env, managed_override: Option<&std::path::Path>) -> UpstreamTarget {
    let mut layers: Vec<EnvLayer> = vec![];
    let managed_path = managed_override.map(PathBuf::from).unwrap_or_else(managed_settings_path);
    if let Some(found) = read_settings_env(&managed_path).await {
        layers.push(EnvLayer { name: "managed-settings.json", env: found });
    }
    if let Some(found) = read_settings_env(&claude_config_dir(env).join("settings.json")).await {
        layers.push(EnvLayer { name: "settings.json", env: found });
    }
    layers.push(EnvLayer { name: "环境变量", env: pick_process_env(env) });

    let base_layer = layers.iter().find(|layer| layer.env.contains_key("ANTHROPIC_BASE_URL"));
    let raw_base = base_layer
        .and_then(|layer| layer.env.get("ANTHROPIC_BASE_URL"))
        .cloned()
        .unwrap_or_else(|| OFFICIAL_ANTHROPIC_BASE_URL.to_string());
    let base_url = with_v1(&raw_base);
    if is_official_anthropic(&raw_base) {
        return UpstreamTarget {
            base_url,
            source: "Anthropic 官方（本机订阅）".into(),
            auth: None,
            headers: BTreeMap::new(),
            wire_api: None,
        };
    }

    let auth = find_claude_auth(&layers);
    let headers = layers
        .iter()
        .find_map(|layer| layer.env.get("ANTHROPIC_CUSTOM_HEADERS"))
        .map(|raw| parse_custom_headers(raw))
        .unwrap_or_default();
    UpstreamTarget {
        base_url,
        source: format!(
            "本机 Claude Code 中转（{} ANTHROPIC_BASE_URL）",
            base_layer.map(|layer| layer.name).unwrap_or("环境变量"),
        ),
        auth,
        headers,
        wire_api: None,
    }
}

/// ANTHROPIC_CUSTOM_HEADERS 的格式是每行一个 "Name: Value"。
fn parse_custom_headers(raw: &str) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    for line in raw.split('\n') {
        let line = line.trim_end_matches('\r');
        let Some(colon) = line.find(':') else { continue };
        if colon == 0 {
            continue;
        }
        let name = line[..colon].trim().to_ascii_lowercase();
        let value = line[colon + 1..].trim();
        if !name.is_empty() && !value.is_empty() {
            headers.insert(name, value.to_string());
        }
    }
    headers
}

fn find_claude_auth(layers: &[EnvLayer]) -> Option<UpstreamAuth> {
    for layer in layers {
        if let Some(value) = layer.env.get("ANTHROPIC_AUTH_TOKEN") {
            return Some(UpstreamAuth { kind: UpstreamAuthKind::Bearer, value: value.clone() });
        }
        if let Some(value) = layer.env.get("ANTHROPIC_API_KEY") {
            return Some(UpstreamAuth { kind: UpstreamAuthKind::XApiKey, value: value.clone() });
        }
    }
    None
}

pub fn is_official_anthropic(url: &str) -> bool {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h == "api.anthropic.com")).unwrap_or(false)
}

/// Claude Code 是把 /v1/messages 直接接在 ANTHROPIC_BASE_URL 后面的；
/// 这里也这么接，只是有人手滑写了 /v1 结尾时不叠成 /v1/v1。
fn with_v1(url: &str) -> String {
    let base = trim_slash(url);
    if base.ends_with("/v1") { base } else { format!("{base}/v1") }
}

// ---------- Codex ----------

pub fn codex_home(auth_file: Option<&str>, env: &Env) -> PathBuf {
    if let Some(file) = auth_file {
        return expand_home(file).parent().map(PathBuf::from).unwrap_or_else(home_dir);
    }
    match env.get("CODEX_HOME") {
        Some(dir) => expand_home(dir),
        None => home_dir().join(".codex"),
    }
}

/// Codex 的上游读法（config.toml）：
///
///   model_provider = "xxx" 且 [model_providers.xxx] 有 base_url → 本机接的是中转。
///     鉴权按 Codex 自己的优先级：
///       experimental_bearer_token → 静态 Bearer（常见于接另一台 ai-bridge）；
///       requires_openai_auth = true → ChatGPT 登录态，头和直连官方一样；
///       env_key → 从环境变量取 Bearer；都没有就不带鉴权。
///     http_headers / env_http_headers 是每个请求都带的静态头，原样跟着走。
///     wire_api 默认 chat；只有 responses 才能承接 /v1/responses。
///   没有自定义 provider → 订阅官方：chatgpt_base_url（默认 chatgpt.com/backend-api/）+ codex。
pub async fn resolve_codex_upstream(auth_file: Option<&str>, env: &Env) -> Result<UpstreamTarget, String> {
    let home = codex_home(auth_file, env);
    // 没有 config.toml 就是全默认：订阅官方。
    let config = match tokio::fs::read_to_string(home.join("config.toml")).await {
        Ok(text) => parse_toml_lite(&text),
        Err(_) => Map::new(),
    };

    let provider_id = string_of(config.get("model_provider")).unwrap_or_else(|| "openai".to_string());
    let providers = as_table(config.get("model_providers"));
    let custom = as_table(providers.get(&provider_id));
    let custom_base = string_of(custom.get("base_url"));

    if provider_id != "openai" {
        if let Some(custom_base) = custom_base {
            let wire_api = match custom.get("wire_api").and_then(Value::as_str) {
                Some("responses") => WireApi::Responses,
                _ => WireApi::Chat,
            };
            let mut auth = None;
            if let Some(bearer) = string_of(custom.get("experimental_bearer_token")) {
                auth = Some(UpstreamAuth { kind: UpstreamAuthKind::Bearer, value: bearer });
            } else if custom.get("requires_openai_auth") != Some(&Value::Bool(true)) {
                if let Some(env_key) = string_of(custom.get("env_key")) {
                    let value = env.trimmed(&env_key).ok_or_else(|| {
                        format!("本机 Codex 中转 {provider_id} 需要环境变量 {env_key}，当前为空")
                    })?;
                    auth = Some(UpstreamAuth { kind: UpstreamAuthKind::Bearer, value: value.to_string() });
                }
            }
            let mut headers = BTreeMap::new();
            for (name, value) in as_table(custom.get("http_headers")) {
                if let Some(value) = value.as_str().map(str::trim).filter(|v| !v.is_empty()) {
                    headers.insert(name.to_ascii_lowercase(), value.to_string());
                }
            }
            for (name, env_name) in as_table(custom.get("env_http_headers")) {
                if let Some(value) = env_name.as_str().and_then(|key| env.trimmed(key)) {
                    headers.insert(name.to_ascii_lowercase(), value.to_string());
                }
            }
            return Ok(UpstreamTarget {
                base_url: trim_slash(&custom_base),
                source: format!("本机 Codex 中转（config.toml model_provider={provider_id}）"),
                auth,
                headers,
                wire_api: Some(wire_api),
            });
        }
    }

    let chatgpt_base = string_of(config.get("chatgpt_base_url"));
    Ok(UpstreamTarget {
        base_url: format!("{}/codex", trim_slash(chatgpt_base.as_deref().unwrap_or(OFFICIAL_CHATGPT_BASE_URL))),
        source: if chatgpt_base.is_some() {
            "本机 Codex 中转（config.toml chatgpt_base_url）".into()
        } else {
            "ChatGPT 官方（本机订阅）".into()
        },
        auth: None,
        headers: BTreeMap::new(),
        wire_api: Some(WireApi::Responses),
    })
}

fn string_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

fn as_table(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

pub fn trim_slash(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}
