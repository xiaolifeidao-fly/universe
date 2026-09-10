use ai_bridge_native::config::schema::{AuthMode, ProviderConfig, ProviderType};
use ai_bridge_native::core::paths::Env;
use ai_bridge_native::credentials::local_upstream::{
    resolve_claude_upstream, resolve_codex_upstream, resolve_upstream, UpstreamAuthKind, WireApi,
};
use ai_bridge_native::credentials::toml_lite::parse_toml_lite;
use serde_json::json;
use std::path::{Path, PathBuf};

// 上游地址跟着本机正在用的走：接了中转站就打中转站，没接就打订阅官方。

/// 不存在的托管配置路径：测试机上真有 managed-settings.json 也不该影响结果。
fn no_managed() -> &'static Path {
    Path::new("/nonexistent/managed-settings.json")
}

fn relay_provider(auth_mode: AuthMode, base_url: Option<&str>) -> ProviderConfig {
    ProviderConfig {
        kind: ProviderType::Relay, api_key: None, base_url: base_url.map(str::to_string),
        auth_mode: Some(auth_mode), auth_file: None, claude_keychain_service: None, models: None,
        models_client_version: None, concurrency: None, queue_max_size: None, timeout_ms: None,
        codex: None, claude_code: None,
    }
}

fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

#[test]
fn toml_lite_reads_headers_quoted_dotted_keys_arrays_bools_and_comments() {
    let parsed = parse_toml_lite(
        r#"
model_provider = "custom"   # 注释里有 = 和 [括号]
model = 'gpt-6-astra'
disable_response_storage = true
notify = ["/Applications/Some App.app/x", "turn-ended"]
retry.count = 3

[model_providers]

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://8.216.60.153:8787/v1"
headers = { "X-Foo" = "a, b", bar = 1 }

[projects."/Users/fly/Documents/develop"]
trust_level = "trusted"

[[servers]]
host = "a"
[[servers]]
host = "b"
"#,
    );
    assert_eq!(parsed["model_provider"], json!("custom"));
    assert_eq!(parsed["model"], json!("gpt-6-astra"));
    assert_eq!(parsed["disable_response_storage"], json!(true));
    assert_eq!(parsed["notify"], json!(["/Applications/Some App.app/x", "turn-ended"]));
    assert_eq!(parsed["retry"], json!({ "count": 3 }));
    let custom = &parsed["model_providers"]["custom"];
    assert_eq!(custom["base_url"], json!("http://8.216.60.153:8787/v1"));
    assert_eq!(custom["requires_openai_auth"], json!(true));
    assert_eq!(custom["headers"], json!({ "X-Foo": "a, b", "bar": 1 }));
    assert_eq!(parsed["projects"]["/Users/fly/Documents/develop"]["trust_level"], json!("trusted"));
    assert_eq!(parsed["servers"], json!([{ "host": "a" }, { "host": "b" }]));
}

#[tokio::test]
async fn codex_custom_relay_with_openai_auth_changes_address_only() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "config.toml", r#"
model_provider = "custom"
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://relay.local:8787/v1/"
"#);
    let env = Env::from_pairs([("CODEX_HOME", home.path().to_string_lossy().into_owned())]);
    let target = resolve_codex_upstream(None, &env).await.unwrap();
    assert_eq!(target.base_url, "http://relay.local:8787/v1");
    assert_eq!(target.wire_api, Some(WireApi::Responses));
    assert!(target.auth.is_none(), "仍用 ChatGPT 登录态，不带别的令牌");
    assert!(target.source.contains("中转"), "{}", target.source);
}

#[tokio::test]
async fn codex_bearer_token_wins_and_static_headers_come_along() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "config.toml", r#"
model_provider = "custom"
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://8.216.60.153:8787/v1"
experimental_bearer_token = "bridge-token-1"
http_headers = { "X-Team" = "galaxy" }
env_http_headers = { "X-From-Env" = "MY_HEADER", "X-Missing" = "NOT_SET" }
"#);
    let env = Env::from_pairs([
        ("CODEX_HOME", home.path().to_string_lossy().into_owned()),
        ("MY_HEADER", "env-value".into()),
    ]);
    let target = resolve_codex_upstream(None, &env).await.unwrap();
    assert_eq!(target.base_url, "http://8.216.60.153:8787/v1");
    let auth = target.auth.expect("静态令牌优先，不用 ChatGPT 登录态");
    assert_eq!(auth.kind, UpstreamAuthKind::Bearer);
    assert_eq!(auth.value, "bridge-token-1");
    assert_eq!(target.headers.get("x-team").map(String::as_str), Some("galaxy"));
    assert_eq!(target.headers.get("x-from-env").map(String::as_str), Some("env-value"));
    assert_eq!(target.headers.len(), 2);
}

#[tokio::test]
async fn codex_env_key_is_read_and_a_missing_one_is_reported_clearly() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "config.toml", r#"
model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example.com/v1"
env_key = "GW_API_KEY"
"#);
    let home_var = home.path().to_string_lossy().into_owned();
    let env = Env::from_pairs([("CODEX_HOME", home_var.clone()), ("GW_API_KEY", "gw-secret".into())]);
    let target = resolve_codex_upstream(None, &env).await.unwrap();
    assert_eq!(target.auth.unwrap().value, "gw-secret");
    assert_eq!(target.wire_api, Some(WireApi::Chat), "codex 自定义 provider 的 wire_api 默认是 chat");

    let bare = Env::from_pairs([("CODEX_HOME", home_var)]);
    let message = resolve_codex_upstream(None, &bare).await.unwrap_err();
    assert!(message.contains("GW_API_KEY"), "{message}");
}

#[tokio::test]
async fn codex_without_a_relay_is_the_official_subscription() {
    let home = tempfile::tempdir().unwrap();
    let env = Env::from_pairs([("CODEX_HOME", home.path().to_string_lossy().into_owned())]);
    let official = resolve_codex_upstream(None, &env).await.unwrap();
    assert_eq!(official.base_url, "https://chatgpt.com/backend-api/codex");
    assert!(official.auth.is_none());
    assert!(official.source.contains("官方"), "{}", official.source);

    write(home.path(), "config.toml", "chatgpt_base_url = \"https://cg.example.com/backend-api/\"\n");
    let overridden = resolve_codex_upstream(None, &env).await.unwrap();
    assert_eq!(overridden.base_url, "https://cg.example.com/backend-api/codex");

    // authFile 指到哪，config.toml 就在它旁边。
    let other = tempfile::tempdir().unwrap();
    write(other.path(), "config.toml", "chatgpt_base_url = \"https://other.example.com/api\"\n");
    let auth_file = other.path().join("auth.json").to_string_lossy().into_owned();
    let by_auth_file = resolve_codex_upstream(Some(&auth_file), &env).await.unwrap();
    assert_eq!(by_auth_file.base_url, "https://other.example.com/api/codex");
}

#[tokio::test]
async fn claude_settings_relay_uses_the_token_next_to_it_and_official_stays_on_the_subscription() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "settings.json", &json!({
        "env": { "ANTHROPIC_BASE_URL": "https://relay.example.com/", "ANTHROPIC_AUTH_TOKEN": "relay-token" },
    }).to_string());
    let config_dir = dir.path().to_string_lossy().into_owned();

    let relay = resolve_claude_upstream(
        &Env::from_pairs([("CLAUDE_CONFIG_DIR", config_dir.clone())]),
        Some(no_managed()),
    ).await;
    assert_eq!(relay.base_url, "https://relay.example.com/v1");
    let auth = relay.auth.expect("中转要带同处的令牌");
    assert_eq!(auth.kind, UpstreamAuthKind::Bearer);
    assert_eq!(auth.value, "relay-token");
    assert!(relay.source.contains("settings.json"), "{}", relay.source);

    // 官方地址 + 环境里有 API key：这条路的定义就是「本机订阅」，不用 key。
    let missing = dir.path().join("missing").to_string_lossy().into_owned();
    let official = resolve_claude_upstream(
        &Env::from_pairs([
            ("CLAUDE_CONFIG_DIR", missing.clone()),
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com".into()),
            ("ANTHROPIC_API_KEY", "sk-x".into()),
        ]),
        Some(no_managed()),
    ).await;
    assert_eq!(official.base_url, "https://api.anthropic.com/v1");
    assert!(official.auth.is_none());

    // 什么都没配 = 官方。
    let bare = resolve_claude_upstream(&Env::from_pairs([("CLAUDE_CONFIG_DIR", missing)]), Some(no_managed())).await;
    assert_eq!(bare.base_url, "https://api.anthropic.com/v1");
}

#[tokio::test]
async fn claude_env_relay_handles_api_key_existing_v1_suffix_and_custom_headers() {
    let dir = tempfile::tempdir().unwrap();
    let target = resolve_claude_upstream(
        &Env::from_pairs([
            ("CLAUDE_CONFIG_DIR", dir.path().to_string_lossy().into_owned()),
            ("ANTHROPIC_BASE_URL", "http://127.0.0.1:9000/v1".into()),
            ("ANTHROPIC_API_KEY", "key-1".into()),
            ("ANTHROPIC_CUSTOM_HEADERS", "X-Team: galaxy\nbad line\nX-Empty:  ".into()),
        ]),
        Some(no_managed()),
    ).await;
    assert_eq!(target.base_url, "http://127.0.0.1:9000/v1", "不叠成 /v1/v1");
    let auth = target.auth.unwrap();
    assert_eq!(auth.kind, UpstreamAuthKind::XApiKey);
    assert_eq!(auth.value, "key-1");
    assert_eq!(target.headers.get("x-team").map(String::as_str), Some("galaxy"));
    assert_eq!(target.headers.len(), 1);
    assert!(target.source.contains("环境变量"), "{}", target.source);
}

#[tokio::test]
async fn managed_settings_win_over_user_settings() {
    let dir = tempfile::tempdir().unwrap();
    let managed = write(dir.path(), "managed-settings.json",
        &json!({ "env": { "ANTHROPIC_BASE_URL": "https://managed.example.com" } }).to_string());
    write(dir.path(), "settings.json",
        &json!({ "env": { "ANTHROPIC_BASE_URL": "https://user.example.com" } }).to_string());
    let target = resolve_claude_upstream(
        &Env::from_pairs([("CLAUDE_CONFIG_DIR", dir.path().to_string_lossy().into_owned())]),
        Some(&managed),
    ).await;
    assert_eq!(target.base_url, "https://managed.example.com/v1");
}

#[tokio::test]
async fn explicit_base_url_wins_and_api_key_without_one_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "settings.json",
        &json!({ "env": { "ANTHROPIC_BASE_URL": "https://relay.example.com" } }).to_string());
    let env = Env::from_pairs([("CLAUDE_CONFIG_DIR", dir.path().to_string_lossy().into_owned())]);

    let explicit = resolve_upstream(
        &relay_provider(AuthMode::ClaudeOauth, Some("https://fixed.example.com/v1/")),
        &env,
    ).await.unwrap();
    assert_eq!(explicit.base_url, "https://fixed.example.com/v1");
    assert!(explicit.auth.is_none());

    let message = resolve_upstream(&relay_provider(AuthMode::ApiKey, None), &env).await.unwrap_err();
    assert!(message.contains("必须配置 baseURL"), "{message}");
}
