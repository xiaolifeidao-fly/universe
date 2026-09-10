use ai_bridge_native::config::parse_config;
use ai_bridge_native::config::schema::Scope;
use ai_bridge_native::core::paths::Env;
use serde_json::{json, Value};

fn base() -> Value {
    json!({
        "providers": {
            "claude": { "type": "relay", "authMode": "claude_oauth", "baseURL": "https://api.anthropic.com/v1" },
            "local": { "type": "claude_code_local" },
        },
        "relay": { "anthropic": "claude" },
    })
}

fn with(overrides: Value) -> Value {
    let mut cfg = base();
    let map = cfg.as_object_mut().unwrap();
    for (key, value) in overrides.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    cfg
}

fn parse(raw: Value) -> Result<ai_bridge_native::config::schema::AppConfig, String> {
    parse_config(raw, &Env::default())
}

#[test]
fn defaults_are_loopback_host_auth_on_agent_off() {
    let cfg = parse(base()).unwrap();
    assert_eq!(cfg.server.host, "127.0.0.1");
    assert!(cfg.auth.enabled);
    assert!(!cfg.agent.enabled);
    assert!(cfg.admin.enabled);
}

#[test]
fn relay_must_reference_a_relay_provider_and_base_url_is_optional_only_for_subscriptions() {
    assert!(parse(with(json!({ "relay": { "anthropic": "local" } }))).unwrap_err().contains("必须是 relay"));
    assert!(parse(with(json!({ "relay": { "anthropic": "missing" } }))).unwrap_err().contains("不存在的 provider"));
    assert!(parse(with(json!({ "relay": { "enabled": true } }))).unwrap_err().contains("都没配"));
    // 订阅登录态类跟随本机 CLI 的上游，可以不写 baseURL；api_key 没有参照物，必须写。
    parse(json!({
        "providers": {
            "claude": { "type": "relay", "authMode": "claude_oauth" },
            "codex": { "type": "relay", "authMode": "codex_chatgpt" },
        },
        "relay": { "anthropic": "claude", "openai": "codex" },
    }))
    .unwrap();
    let missing_base = parse(json!({
        "providers": { "gw": { "type": "relay", "authMode": "api_key", "apiKey": "k" } },
        "relay": { "openai": "gw" },
    }))
    .unwrap_err();
    assert!(missing_base.contains("必须配置 baseURL"), "{missing_base}");
}

#[test]
fn agent_routes_must_point_at_local_agent_providers() {
    let relay_route = parse(with(json!({ "agent": { "enabled": true, "routes": [{ "match": "*", "provider": "claude" }] } })));
    assert!(relay_route.unwrap_err().contains("只能指向本机 agent"));
    let empty = parse(with(json!({ "agent": { "enabled": true, "routes": [] } })));
    assert!(empty.unwrap_err().contains("routes 为空"));
    let ok = parse(with(json!({ "agent": { "enabled": true, "routes": [{ "match": "*", "provider": "local" }] } }))).unwrap();
    assert_eq!(ok.agent.header, "x-ai-agent");
}

#[test]
fn token_entries_need_exactly_one_secret_and_unique_aliases() {
    let neither = parse(with(json!({ "auth": { "tokens": [{ "alias": "a" }] } })));
    assert!(neither.unwrap_err().starts_with("Invalid config"));
    let duplicate = parse(with(json!({ "auth": { "tokens": [
        { "alias": "a", "token": "12345678" }, { "alias": "a", "token": "87654321" },
    ] } })));
    assert!(duplicate.unwrap_err().contains("重复"));
    let both = parse(with(json!({ "auth": { "tokens": [
        { "alias": "a", "token": "12345678", "tokenHash": "0".repeat(64) },
    ] } })));
    assert!(both.unwrap_err().starts_with("Invalid config"));

    let cfg = parse_config(
        with(json!({ "auth": { "tokens": [{ "alias": "a", "token": "${T}" }] } })),
        &Env::from_pairs([("T", "env-token-1")]),
    )
    .unwrap();
    assert_eq!(cfg.auth.tokens[0].token.as_deref(), Some("env-token-1"));
    assert_eq!(cfg.auth.tokens[0].scopes, vec![Scope::RelayAnthropic, Scope::RelayOpenai]);
}

#[test]
fn pool_contributions_need_something_that_can_execute_them() {
    let pool = |contribution: Value| {
        json!({
            "mode": "pool",
            "providers": { "claude": { "type": "relay", "authMode": "claude_oauth" } },
            "relay": { "enabled": false },
            "pool": { "hubURL": "https://hub.example.com", "contributions": [contribution] },
        })
    };
    let quota = json!([{ "unit": "llm.output_tokens", "limit": 100 }]);
    parse(pool(json!({ "id": "a", "upstream": "claude", "quota": quota }))).unwrap();
    let orphan = parse(pool(json!({ "id": "a", "quota": quota })));
    assert!(orphan.unwrap_err().contains("没有任何东西能执行它"));
    let agent_turn = parse(pool(json!({ "id": "a", "kind": "delivery.task", "provider": "planner", "quota": quota })));
    assert!(agent_turn.unwrap_err().contains("必须用 exec 指定执行器命令"));
}

/// agent provider 的嵌套配置块要能完整来回：serde 默认忽略不认识的键，
/// 少一个 camelCase 重命名就会把整段配置静默吃掉。
#[test]
fn agent_provider_option_blocks_round_trip() {
    let raw = json!({
        "providers": {
            "codex": { "type": "codex_local", "codex": {
                "codexPathOverride": "/opt/codex", "workingDirectory": "~/work",
                "sandboxMode": "workspace-write", "approvalPolicy": "never",
                "skipGitRepoCheck": true, "extraConfig": { "anything": 1 },
                "defaultReasoningEffort": "low" } },
            "claude": { "type": "claude_code_local", "claudeCode": {
                "cwd": "~/work", "permissionMode": "bypassPermissions",
                "additionalDirectories": ["/tmp"], "allowedTools": ["Read"],
                "disallowedTools": ["Bash"], "toolsPreset": "claude_code",
                "systemPrompt": "hi", "maxTurns": 4 } },
        },
        "relay": { "enabled": false },
        "agent": { "enabled": true, "routes": [{ "match": "*", "provider": "codex" }] },
    });
    let cfg = parse(raw.clone()).unwrap();
    let round_tripped: Value = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
    assert_eq!(round_tripped["providers"]["codex"]["codex"], raw["providers"]["codex"]["codex"]);
    assert_eq!(round_tripped["providers"]["claude"]["claudeCode"], raw["providers"]["claude"]["claudeCode"]);
}

/// 补齐默认值后的 JSON 要能被 Node 侧直接消费，可选字段不能变成 null。
#[test]
fn serialized_config_omits_absent_optionals() {
    let cfg = parse(base()).unwrap();
    let text = serde_json::to_string(&cfg).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert!(value.get("pool").is_none());
    assert!(value["relay"].get("openai").is_none());
    assert!(value["providers"]["local"].get("baseURL").is_none());
    assert_eq!(value["server"]["bodyLimit"], json!("4mb"));
    assert_eq!(value["mode"], json!("relay"));
    assert_eq!(value["providers"]["local"]["type"], json!("claude_code_local"));
}
