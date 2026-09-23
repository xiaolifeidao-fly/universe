mod common;

use ai_bridge_native::auth::principal::Principal;
use ai_bridge_native::core::paths::Env;
use ai_bridge_native::credentials::codex_chatgpt::CodexChatGptProvider;
use ai_bridge_native::credentials::local_upstream::{UpstreamAuth, UpstreamAuthKind};
use ai_bridge_native::credentials::types::{CredentialProvider, UpstreamAuthContext};
use ai_bridge_native::credentials::UpstreamTarget;
use axum::http::HeaderMap;
use common::relay_provider_config;
use std::collections::BTreeMap;

/// exp 在很远的将来，免得测试去刷新 token。
const FAKE_JWT: &str = "eyJhbGciOiJub25lIn0.eyJleHAiOiA5OTk5OTk5OTk5fQ.sig";

fn headers_of(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.insert(
            axum::http::HeaderName::try_from(*name).unwrap(),
            axum::http::HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

fn target(auth: Option<UpstreamAuth>) -> UpstreamTarget {
    UpstreamTarget {
        base_url: "https://upstream.example/codex".into(),
        source: "测试".into(),
        auth,
        headers: BTreeMap::new(),
        wire_api: None,
    }
}

/// 写一份能通过校验的 codex 登录态，返回 auth.json 的路径。
fn fake_auth_file(dir: &tempfile::TempDir) -> String {
    let path = dir.path().join("auth.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": { "access_token": FAKE_JWT, "account_id": "acct-1" }
        })
        .to_string(),
    )
    .unwrap();
    path.to_string_lossy().into_owned()
}

async fn call(
    auth_file: Option<String>,
    upstream: UpstreamTarget,
    client_headers: HeaderMap,
    request_id: &str,
) -> BTreeMap<String, String> {
    let mut provider = relay_provider_config("codex_chatgpt", None, None);
    provider.auth_file = auth_file;
    let principal = Principal { alias: "ck_test".into(), ..Principal::anonymous() };
    let env = Env::default();
    CodexChatGptProvider { client: reqwest::Client::new() }
        .headers(&UpstreamAuthContext {
            headers: &client_headers,
            principal: &principal,
            request_id,
            provider: &provider,
            provider_name: "codex",
            upstream: &upstream,
            env: &env,
        })
        .await
        .expect("应当算得出头")
}

/// 客户端的 Codex 协议头要原样到上游 —— 丢了它们，响应就不再与直连一致，
/// 而会话那几个还决定上游的前缀缓存往哪台机器路由。
#[tokio::test]
async fn codex_protocol_headers_reach_upstream_on_both_branches() {
    let client = headers_of(&[
        ("session-id", "01a0-bfb9-conversation"),
        ("thread-id", "01a0-bfb9-conversation"),
        ("x-client-request-id", "01a0-bfb9-turn"),
        ("x-codex-window-id", "01a0-bfb9-conversation:0"),
        ("x-codex-beta-features", "remote_compaction_v2"),
        ("x-openai-internal-codex-responses-lite", "true"),
        ("originator", "codex_exec"),
        ("user-agent", "codex_exec/0.154.0"),
    ]);

    // 接中转那一支：只换鉴权，协议头照样要带过去。
    let bearer = call(
        None,
        target(Some(UpstreamAuth { kind: UpstreamAuthKind::Bearer, value: "tok".into() })),
        client.clone(),
        "rid-1",
    )
    .await;
    assert_eq!(bearer.get("authorization").map(String::as_str), Some("Bearer tok"));

    // 订阅登录那一支：自己造的 originator / user-agent 要让位给客户端真实的值。
    let dir = tempfile::tempdir().unwrap();
    let subscription = call(Some(fake_auth_file(&dir)), target(None), client.clone(), "rid-1").await;
    assert_eq!(subscription.get("chatgpt-account-id").map(String::as_str), Some("acct-1"));

    for headers in [&bearer, &subscription] {
        for (name, value) in [
            ("session-id", "01a0-bfb9-conversation"),
            ("x-codex-window-id", "01a0-bfb9-conversation:0"),
            ("x-codex-beta-features", "remote_compaction_v2"),
            ("x-openai-internal-codex-responses-lite", "true"),
            ("originator", "codex_exec"),
            ("user-agent", "codex_exec/0.154.0"),
        ] {
            assert_eq!(headers.get(name).map(String::as_str), Some(value), "{name} 没带到上游");
        }
    }
}

/// session_id 要跟着会话走，不是跟着请求走：每个请求换一个新值，上游就会把
/// 同一条对话的连续请求散到不同机器上，前缀缓存只剩公共开头能命中。
#[tokio::test]
async fn legacy_session_id_follows_the_conversation_not_the_request() {
    let dir = tempfile::tempdir().unwrap();
    let auth_file = fake_auth_file(&dir);
    let client = headers_of(&[("session-id", "01a0-bfb9-conversation")]);

    let first = call(Some(auth_file.clone()), target(None), client.clone(), "rid-1").await;
    let second = call(Some(auth_file.clone()), target(None), client, "rid-2").await;
    assert_eq!(first.get("session_id"), second.get("session_id"), "同一条会话的两次请求应当同值");
    assert_eq!(
        first.get("session_id").map(String::as_str),
        Some("ck_test-01a0-bfb9-conversation"),
        "要带调用方身份前缀，避免单账号多人共享时串话",
    );

    // 不是 Codex 的调用方没有会话可言：退回请求 id，维持原来的行为。
    let anonymous = call(Some(auth_file), target(None), HeaderMap::new(), "rid-3").await;
    assert_eq!(anonymous.get("session_id").map(String::as_str), Some("ck_test-rid-3"));
}

/// originator 不在就说明对面不是 Codex：它的 user-agent 不能单独透上去，
/// 否则上游看到的是「别家 SDK 的 UA + 我们造的 originator」这种对不上的组合。
#[tokio::test]
async fn a_foreign_user_agent_alone_does_not_reach_upstream() {
    let dir = tempfile::tempdir().unwrap();
    let client = headers_of(&[("user-agent", "OpenAI/Python 1.2.3")]);
    let headers = call(Some(fake_auth_file(&dir)), target(None), client, "rid-1").await;
    assert_eq!(headers.get("user-agent").map(String::as_str), Some("codex_cli_rs"));
    assert_eq!(headers.get("originator").map(String::as_str), Some("codex_cli_rs"));
}
