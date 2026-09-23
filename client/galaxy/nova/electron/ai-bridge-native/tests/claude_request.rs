use ai_bridge_native::config::schema::{AuthMode, ProviderConfig, ProviderType};
use ai_bridge_native::credentials::claude_request::{prepare_claude_request, CLAUDE_OAUTH_SYSTEM};
use ai_bridge_native::credentials::local_upstream::{UpstreamAuth, UpstreamAuthKind, UpstreamTarget};
use bytes::Bytes;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn provider(auth_mode: AuthMode) -> ProviderConfig {
    ProviderConfig {
        kind: ProviderType::Relay, api_key: None, base_url: None, auth_mode: Some(auth_mode),
        auth_file: None, claude_keychain_service: None, models: None, models_client_version: None,
        concurrency: None, queue_max_size: None, timeout_ms: None, codex: None, claude_code: None,
    }
}

fn upstream(base_url: &str) -> UpstreamTarget {
    UpstreamTarget {
        base_url: base_url.into(), source: "test".into(), auth: None,
        headers: BTreeMap::new(), wire_api: None,
    }
}

fn request() -> Value {
    json!({
        "model": "claude-sonnet-5", "max_tokens": 256, "stream": true,
        "messages": [
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "lookup", "input": { "q": "test" } }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "result" }] },
        ],
        "tools": [{ "name": "lookup", "input_schema": { "type": "object" } }],
    })
}

#[test]
fn subscription_prepends_protocol_context_while_preserving_system_history_and_tools() {
    let claude = provider(AuthMode::ClaudeOauth);
    let target = upstream("https://api.anthropic.com/v1");
    let systems = [
        Value::Null,
        json!(""),
        json!("Answer in Chinese"),
        json!([{ "type": "text", "text": "custom", "cache_control": { "type": "ephemeral" } }]),
    ];
    for system in systems {
        let mut body = request();
        if !system.is_null() {
            body["system"] = system.clone();
        }
        let raw = Bytes::from(serde_json::to_vec(&body).unwrap());
        let prepared = prepare_claude_request(raw, &claude, &target);
        let parsed: Value = serde_json::from_slice(&prepared).unwrap();

        assert_eq!(parsed["system"][0]["text"], json!(CLAUDE_OAUTH_SYSTEM));
        assert_eq!(parsed["messages"], request()["messages"]);
        assert_eq!(parsed["tools"], request()["tools"]);
        assert_eq!(parsed["max_tokens"], json!(256));
        assert_eq!(parsed["stream"], json!(true));
        let tail: Vec<Value> = parsed["system"].as_array().unwrap()[1..].to_vec();
        match &system {
            Value::String(text) if !text.is_empty() => {
                assert_eq!(tail, vec![json!({ "type": "text", "text": text })])
            }
            Value::Array(items) => assert_eq!(&tail, items),
            _ => assert!(tail.is_empty()),
        }
        // 已经补过的请求再过一次不会叠第二段。
        assert_eq!(prepare_claude_request(prepared.clone(), &claude, &target), prepared);
    }
}

#[test]
fn complete_cli_bodies_and_non_subscription_traffic_stay_byte_identical() {
    let claude = provider(AuthMode::ClaudeOauth);
    let target = upstream("https://api.anthropic.com/v1");
    for text in [CLAUDE_OAUTH_SYSTEM, "You are Claude Code, Anthropic's official CLI for Claude."] {
        let mut body = request();
        body["system"] = json!([{ "type": "text", "text": text }]);
        let raw = Bytes::from(serde_json::to_string_pretty(&body).unwrap() + "\n");
        assert_eq!(prepare_claude_request(raw.clone(), &claude, &target), raw);
    }

    let raw = Bytes::from(serde_json::to_vec(&request()).unwrap());
    assert_eq!(prepare_claude_request(raw.clone(), &provider(AuthMode::ApiKey), &target), raw);
    assert_eq!(prepare_claude_request(raw.clone(), &claude, &upstream("https://custom.example/v1")), raw);
    let mut relayed = upstream("https://api.anthropic.com/v1");
    relayed.auth = Some(UpstreamAuth { kind: UpstreamAuthKind::Bearer, value: "test".into() });
    assert_eq!(prepare_claude_request(raw.clone(), &claude, &relayed), raw);

    for invalid in ["{", "null", "[]", "{\"system\":123}"] {
        let bytes = Bytes::from(invalid);
        assert_eq!(prepare_claude_request(bytes.clone(), &claude, &target), bytes);
    }
    // system: null 等于没写，仍然补前缀。
    let nulled = Bytes::from("{\"system\":null}");
    let prepared = prepare_claude_request(nulled, &claude, &target);
    let parsed: Value = serde_json::from_slice(&prepared).unwrap();
    assert_eq!(parsed["system"][0]["text"], json!(CLAUDE_OAUTH_SYSTEM));
}
