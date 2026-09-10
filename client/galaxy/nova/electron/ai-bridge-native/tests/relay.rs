mod common;

use ai_bridge_native::core::paths::Env;
use ai_bridge_native::credentials::claude_oauth::{claude_keychain_service, get_claude_creds, parse_claude_credentials};
use axum::body::Body;
use futures_util::StreamExt;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use common::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn json_response(body: &str) -> Response {
    ([("content-type", "application/json")], body.to_string()).into_response()
}

#[test]
fn credentials_validate_expiry_scope_and_malformed_input_without_leaking_tokens() {
    let ok = parse_claude_credentials(
        &json!({ "claudeAiOauth": { "accessToken": "valid", "expiresAt": 200, "scopes": ["user:inference"] } }).to_string(),
        100,
    );
    assert_eq!(ok.unwrap().access_token, "valid");

    let cases = [
        "secret-invalid-json".to_string(),
        "{}".to_string(),
        json!({ "claudeAiOauth": { "accessToken": "SECRET", "expiresAt": 1 } }).to_string(),
        json!({ "claudeAiOauth": { "accessToken": "SECRET", "expiresAt": "bad" } }).to_string(),
        json!({ "claudeAiOauth": { "accessToken": "SECRET", "scopes": ["user:profile"] } }).to_string(),
    ];
    for raw in cases {
        // 不给 ClaudeCreds 派生 Debug：断言失败时不该把凭据打进测试输出。
        let message = parse_claude_credentials(&raw, 1_000).map(|_| ()).expect_err("应当被拒");
        assert!(!message.contains("SECRET") && !message.contains("secret-invalid-json"), "泄露了凭据：{message}");
    }

    assert_eq!(claude_keychain_service(&Env::default()), "Claude Code-credentials");
    let custom = claude_keychain_service(&Env::from_pairs([("CLAUDE_CONFIG_DIR", "/custom")]));
    assert!(custom.starts_with("Claude Code-credentials-") && custom.len() == "Claude Code-credentials-".len() + 8);
    assert_eq!(
        claude_keychain_service(&Env::from_pairs([
            ("CLAUDE_CONFIG_DIR", "/custom"), ("CLAUDE_SECURESTORAGE_CONFIG_DIR", ""),
        ])),
        "Claude Code-credentials",
    );
}

#[tokio::test]
async fn messages_preserve_raw_body_tool_history_and_oauth_headers() {
    let seen = Arc::new(tokio::sync::Mutex::new(None::<(String, String, Vec<(String, String)>)>));
    let output = json!({ "type": "message", "content": [{ "type": "tool_use", "id": "tool_2", "name": "Read", "input": { "path": "local.txt" } }], "stop_reason": "tool_use" }).to_string();
    let captured = Arc::clone(&seen);
    let expected = output.clone();
    let h = harness(
        handler(move |req| {
            let captured = Arc::clone(&captured);
            let output = expected.clone();
            async move {
                let headers = req.headers.iter()
                    .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or_default().to_string()))
                    .collect();
                *captured.lock().await = Some((req.url(), req.text(), headers));
                json_response(&output)
            }
        }),
        json!({}),
    )
    .await;

    // 客户端发的原始字节（带缩进和尾换行）必须一字节不改地到上游。
    let raw = serde_json::to_string_pretty(&tool_request()).unwrap() + "\n";
    let response = h
        .authed(Method::POST, "/v1/messages?beta=true")
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "custom-beta,oauth-2025-04-20")
        .header("x-ai-agent", "1")
        .header("user-agent", "actual-local-client")
        .header("x-app", "cli")
        .header("x-claude-code-session-id", "local-session")
        .header("x-stainless-lang", "js")
        .header("x-stainless-runtime-version", "v26.3.0")
        .header("anthropic-dangerous-direct-browser-access", "true")
        .header("cookie", "client-cookie-must-not-leak")
        .body(raw.clone())
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    assert!(response.headers().get("x-request-id").is_some());
    assert_eq!(response.text().await.unwrap(), output);

    let guard = seen.lock().await;
    let (url, body, headers) = guard.as_ref().expect("上游收到请求");
    let find = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    assert_eq!(url, "/v1/messages?beta=true");
    assert_eq!(body, &raw);
    assert_eq!(find("authorization"), Some("Bearer upstream-test-secret"));
    assert_eq!(find("x-api-key"), None);
    assert_eq!(find("x-ai-agent"), None);
    assert_eq!(find("cookie"), None);
    assert_eq!(find("anthropic-beta"), Some("custom-beta,oauth-2025-04-20"));
    assert_eq!(find("user-agent"), Some("actual-local-client"));
    assert_eq!(find("x-claude-code-session-id"), Some("local-session"));
    assert_eq!(find("x-stainless-lang"), Some("js"));
    assert_eq!(find("anthropic-dangerous-direct-browser-access"), Some("true"));
    drop(guard);
    assert_eq!(h.calls(), 1);
    h.close().await;
}

#[tokio::test]
async fn sse_is_byte_transparent_across_split_utf8_chunks() {
    let data = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"测试\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    let h = harness(
        handler(move |req| async move {
            let parsed: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(parsed["stream"], json!(true));
            // 按 7 字节切开，正好把多字节字符劈成两半。
            let bytes = data.as_bytes().to_vec();
            let chunks: Vec<Result<Vec<u8>, std::io::Error>> =
                bytes.chunks(7).map(|c| Ok(c.to_vec())).collect();
            (
                [("content-type", "text/event-stream")],
                Body::from_stream(futures_util::stream::iter(chunks)),
            )
                .into_response()
        }),
        json!({}),
    )
    .await;

    let mut body = tool_request();
    body["stream"] = json!(true);
    let response = h.post_json("/v1/messages", &body).await;
    assert!(response.headers()["content-type"].to_str().unwrap().contains("text/event-stream"));
    assert_eq!(response.text().await.unwrap(), data);
    h.close().await;
}

#[tokio::test]
async fn count_tokens_uses_anthropic_upstream_unchanged() {
    let h = harness(
        handler(|req| async move {
            assert_eq!(req.uri.path(), "/v1/messages/count_tokens");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&req.body).unwrap(),
                json!({ "model": "claude-sonnet-4-5", "messages": [] }),
            );
            json_response("{\"input_tokens\":123}")
        }),
        json!({}),
    )
    .await;
    let response = h
        .post_json("/v1/messages/count_tokens", &json!({ "model": "claude-sonnet-4-5", "messages": [] }))
        .await;
    assert_eq!(response.json::<serde_json::Value>().await.unwrap(), json!({ "input_tokens": 123 }));
    h.close().await;
}

#[tokio::test]
async fn openai_paths_go_to_the_openai_relay_with_api_key_auth() {
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let captured = Arc::clone(&seen);
    let h = harness(
        handler(move |req| {
            let captured = Arc::clone(&captured);
            async move {
                assert_eq!(req.header("authorization"), Some("Bearer codex-test-secret"));
                captured.lock().await.push(req.url());
                json_response(&req.text())
            }
        }),
        json!({}),
    )
    .await;

    let first = h.post_json("/v1/responses", &json!({ "model": "gpt-test", "input": "hello" })).await;
    assert_eq!(
        first.json::<serde_json::Value>().await.unwrap(),
        json!({ "model": "gpt-test", "input": "hello" }),
    );
    let second = h.post_json("/v1/chat/completions", &json!({ "model": "gpt-test", "messages": [] })).await;
    assert_eq!(second.status(), 200);
    let _ = second.text().await;
    assert_eq!(*seen.lock().await, vec!["/codex/responses", "/codex/chat/completions"]);
    h.close().await;
}

#[tokio::test]
async fn upstream_429_request_id_and_rate_limit_headers_are_preserved() {
    let h = harness(
        handler(|_req| async move {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [
                    ("content-type", "application/json"),
                    ("retry-after", "7"),
                    ("request-id", "req_upstream"),
                    ("anthropic-ratelimit-requests-remaining", "0"),
                    ("x-should-retry", "true"),
                ],
                "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"limited\"}}",
            )
                .into_response()
        }),
        json!({}),
    )
    .await;
    let response = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["retry-after"], "7");
    assert_eq!(response.headers()["request-id"], "req_upstream");
    assert_eq!(response.headers()["anthropic-ratelimit-requests-remaining"], "0");
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert_eq!(error_type(response).await, "rate_limit_error");
    h.close().await;
}

#[tokio::test]
async fn expired_credentials_fail_before_upstream_and_refresh_is_picked_up_without_restart() {
    let h = harness(handler(|_req| async move { json_response("{\"ok\":true}") }), json!({})).await;
    std::fs::write(
        &h.auth_file,
        json!({ "claudeAiOauth": { "accessToken": "expired-secret", "expiresAt": 1 } }).to_string(),
    )
    .unwrap();

    let failed = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(failed.status(), 502);
    assert_eq!(h.calls(), 0);
    let body: serde_json::Value = failed.json().await.unwrap();
    assert_eq!(body["error"]["type"], "relay_auth_failed");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("已过期"), "{message}");
    assert!(!message.contains("expired-secret"));

    let fresh = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64 + 60_000;
    std::fs::write(
        &h.auth_file,
        json!({ "claudeAiOauth": { "accessToken": "new-secret", "expiresAt": fresh } }).to_string(),
    )
    .unwrap();
    let creds = get_claude_creds(Some(&h.auth_file.to_string_lossy()), None, &Env::default()).await.unwrap();
    assert_eq!(creds.access_token, "new-secret");

    let ok = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(ok.status(), 200);
    let _ = ok.text().await;
    assert_eq!(h.calls(), 1);
    h.close().await;
}

#[tokio::test]
async fn missing_or_invalid_token_is_401_before_touching_upstream_and_bearer_works() {
    let h = harness(handler(|_req| async move { json_response("{}") }), json!({})).await;

    let missing = h
        .client
        .post(format!("{}/v1/messages", h.url))
        .header("content-type", "application/json")
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 401);
    assert_eq!(error_type(missing).await, "missing_token");

    let wrong = h
        .request(Method::POST, "/v1/messages")
        .header("x-api-key", "nope-nope-nope")
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    let _ = wrong.text().await;
    assert_eq!(h.calls(), 0);

    let bearer = h
        .client
        .post(format!("{}/v1/messages", h.url))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {CLIENT_TOKEN}"))
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(bearer.status(), 200);
    let _ = bearer.text().await;
    assert_eq!(h.calls(), 1);
    h.close().await;
}

#[tokio::test]
async fn openai_only_token_is_refused_on_the_anthropic_path() {
    let h = harness(handler(|_req| async move { json_response("{}") }), json!({})).await;
    let denied = h
        .request(Method::POST, "/v1/messages")
        .header("x-api-key", OPENAI_ONLY_TOKEN)
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    assert_eq!(error_type(denied).await, "insufficient_scope");

    let allowed = h
        .request(Method::POST, "/v1/responses")
        .header("x-api-key", OPENAI_ONLY_TOKEN)
        .json(&json!({ "input": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), 200);
    let _ = allowed.text().await;
    assert_eq!(h.calls(), 1);
    h.close().await;
}

#[tokio::test]
async fn hashed_tokens_in_config_authenticate() {
    use ai_bridge_native::auth::token_store::hash_token;
    let plain = "hashed-client-secret-0001";
    let h = harness(
        handler(|_req| async move { json_response("{}") }),
        json!({ "auth": { "enabled": true, "tokens": [
            { "tokenHash": hash_token(plain), "alias": "hashed", "scopes": ["relay:anthropic"] },
        ] } }),
    )
    .await;
    let response = h
        .request(Method::POST, "/v1/messages")
        .header("x-api-key", plain)
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let _ = response.text().await;
    let aliases: Vec<String> =
        h.bridge.state.auth.tokens.read().unwrap().list().into_iter().map(|t| t.alias).collect();
    assert_eq!(aliases, vec!["hashed".to_string()]);
    h.close().await;
}

#[tokio::test]
async fn per_principal_concurrency_rejects_the_second_concurrent_request() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let release = Arc::clone(&gate);
    let h = harness(
        handler(move |_req| {
            let gate = Arc::clone(&gate);
            async move {
                gate.notified().await;
                json_response("{}")
            }
        }),
        json!({}),
    )
    .await;

    // 请求发出去后要跟 h 的后续调用并行，所以从 client 直接建，不借 h。
    let pending = h
        .client
        .post(format!("{}/v1/messages", h.url))
        .header("content-type", "application/json")
        .header("x-api-key", CLIENT_TOKEN)
        .json(&tool_request())
        .send();
    let first = tokio::spawn(pending);
    // 等第一条真正到达上游
    while h.calls() < 1 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let second = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(second.status(), 429);
    assert_eq!(error_type(second).await, "principal_concurrency_exceeded");

    release.notify_waiters();
    let first = first.await.unwrap().unwrap();
    assert_eq!(first.status(), 200);
    let _ = first.text().await;
    h.bridge.state.gate.on_idle().await;
    h.close().await;
}

#[tokio::test]
async fn ip_allowlist_rejects_sources_outside_the_list() {
    let h = harness(
        handler(|_req| async move { json_response("{}") }),
        json!({ "auth": { "enabled": true, "ipAllowlist": ["10.0.0.0/8"],
            "tokens": [{ "token": CLIENT_TOKEN, "alias": "test", "scopes": ["*"] }] } }),
    )
    .await;
    let denied = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(denied.status(), 403);
    assert_eq!(error_type(denied).await, "ip_not_allowed");

    let health = h.client.get(format!("{}/healthz", h.url)).send().await.unwrap();
    assert_eq!(health.status(), 200);
    h.close().await;
}

#[tokio::test]
async fn request_timeout_aborts_a_stalled_upstream_and_releases_the_slot() {
    let h = harness(
        handler(|_req| async move { std::future::pending::<Response>().await }),
        json!({ "server": { "host": "127.0.0.1", "port": 0, "requestTimeoutMs": 100, "streamIdleTimeoutMs": 5000 } }),
    )
    .await;
    let response = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(response.status(), 504);
    assert_eq!(error_type(response).await, "request_timeout");
    h.bridge.state.gate.on_idle().await;
    h.close().await;
}

#[tokio::test]
async fn idle_timeout_before_headers_returns_504() {
    let h = harness(
        handler(|_req| async move { std::future::pending::<Response>().await }),
        json!({ "server": { "host": "127.0.0.1", "port": 0, "requestTimeoutMs": 5000, "streamIdleTimeoutMs": 100 } }),
    )
    .await;
    let response = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(response.status(), 504);
    assert_eq!(error_type(response).await, "stream_idle_timeout");
    h.close().await;
}

/// 失败的请求同样要带 requestId，客户端给了就沿用 —— 502/504 才是最需要拿它对日志的时候。
#[tokio::test]
async fn error_responses_still_carry_the_request_id() {
    let h = harness(
        handler(|_req| async move { std::future::pending::<Response>().await }),
        json!({ "server": { "host": "127.0.0.1", "port": 0, "requestTimeoutMs": 100, "streamIdleTimeoutMs": 5000 } }),
    )
    .await;
    let generated = h.post_json("/v1/messages", &tool_request()).await;
    assert_eq!(generated.status(), 504);
    assert!(generated.headers().get("x-request-id").is_some());

    let echoed = h
        .authed(Method::POST, "/v1/messages")
        .header("x-request-id", "caller-supplied-id")
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(echoed.status(), 504);
    assert_eq!(echoed.headers()["x-request-id"], "caller-supplied-id");
    h.close().await;
}

/// 「停了」必须是真的停了：端口放掉，并且优雅关闭等不到的那条流也被掐断。
///
/// serve 任务如果只是被 detach，stop() 返回之后它还会继续往客户端写。
#[tokio::test]
async fn closing_the_bridge_releases_the_port_and_kills_a_stream_it_cannot_drain() {
    let h = harness(
        handler(|_req| async move {
            let stream = futures_util::stream::once(async { Ok::<_, std::io::Error>(b"data: {}\n\n".to_vec()) })
                .chain(futures_util::stream::once(async {
                    std::future::pending::<()>().await;
                    Ok(Vec::new())
                }));
            ([("content-type", "text/event-stream")], Body::from_stream(stream)).into_response()
        }),
        json!({ "server": { "host": "127.0.0.1", "port": 0, "shutdownTimeoutMs": 200 } }),
    )
    .await;
    let addr = h.bridge.addr.expect("已监听");

    let mut body = tool_request();
    body["stream"] = json!(true);
    let mut streaming = h.post_json("/v1/messages", &body).await;
    let _ = streaming.chunk().await.unwrap();

    h.close().await;
    let rebound = tokio::net::TcpListener::bind(addr).await;
    assert!(rebound.is_ok(), "关闭后端口仍被占用：{:?}", rebound.err());

    // 客户端这边的流必须已经结束（正常结束或报错都行），不能还挂着等下一块。
    let ended = tokio::time::timeout(Duration::from_secs(2), streaming.chunk()).await;
    match ended {
        Ok(Ok(None)) | Ok(Err(_)) => {}
        other => panic!("stop() 之后流还活着：{other:?}"),
    }
}

#[tokio::test]
async fn truncated_upstream_sse_is_reported_as_a_broken_stream() {
    let h = harness(
        handler(|_req| async move {
            // 先把响应头和第一个事件发出去，隔一会儿再断 —— 客户端已经开始读了才断，
            // 才是「看起来正常、其实截断」的那种情况。
            let chunks = futures_util::stream::once(async {
                Ok::<_, std::io::Error>("event: message_start\ndata: {}\n\n".as_bytes().to_vec())
            })
            .chain(futures_util::stream::once(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Err(std::io::Error::other("upstream died"))
            }));
            ([("content-type", "text/event-stream")], Body::from_stream(chunks)).into_response()
        }),
        json!({}),
    )
    .await;
    let mut body = tool_request();
    body["stream"] = json!(true);
    let response = h.post_json("/v1/messages", &body).await;
    assert_eq!(response.status(), 200);
    // 中途断掉的流不能表现成正常读完。
    assert!(response.text().await.is_err(), "被截断的 SSE 应当以错误结束");
    h.bridge.state.gate.on_idle().await;
    h.close().await;
}

#[tokio::test]
async fn client_disconnect_cancels_the_upstream_and_releases_concurrency() {
    struct Signal(Arc<tokio::sync::Notify>);
    impl Drop for Signal {
        fn drop(&mut self) {
            self.0.notify_waiters();
        }
    }
    let closed = Arc::new(tokio::sync::Notify::new());
    let notify = Arc::clone(&closed);
    let waiting = closed.notified();

    let h = harness(
        handler(move |_req| {
            let signal = Signal(Arc::clone(&notify));
            async move {
                let stream = futures_util::stream::once(async move { Ok::<_, std::io::Error>("data: {}\n\n".as_bytes().to_vec()) })
                    .chain(futures_util::stream::unfold(signal, |signal| async move {
                        // 上游一直挂着，直到桥接把连接断开、这个流被丢弃。
                        std::future::pending::<()>().await;
                        Some((Ok(Vec::new()), signal))
                    }));
                ([("content-type", "text/event-stream")], Body::from_stream(stream)).into_response()
            }
        }),
        json!({}),
    )
    .await;

    let mut body = tool_request();
    body["stream"] = json!(true);
    let mut response = h.post_json("/v1/messages", &body).await;
    let _first = response.chunk().await.unwrap();
    drop(response);

    tokio::time::timeout(Duration::from_secs(2), waiting).await.expect("上游没有被断开");
    tokio::time::timeout(Duration::from_secs(2), h.bridge.state.gate.on_idle())
        .await
        .expect("并发名额没有归还");
    h.close().await;
}

#[tokio::test]
async fn unconfigured_relay_family_and_unknown_routes_are_404() {
    let h = harness(
        handler(|_req| async move { json_response("{}") }),
        json!({ "relay": { "enabled": true, "anthropic": "claude" } }),
    )
    .await;
    let responses = h.post_json("/v1/responses", &json!({ "input": "x" })).await;
    assert_eq!(responses.status(), 404);
    let _ = responses.text().await;
    let unknown = h.post_json("/v1/images/generations", &json!({})).await;
    assert_eq!(unknown.status(), 404);
    let _ = unknown.text().await;
    assert_eq!(h.calls(), 0);
    h.close().await;
}

#[tokio::test]
async fn provider_without_base_url_follows_the_local_claude_code_relay() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(tokio::sync::Mutex::new(None::<(String, Option<String>, Option<String>, Option<String>)>));
    let captured = Arc::clone(&seen);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);

    // provider 故意不写 baseURL、authFile 指向不存在的文件：
    // 地址与令牌都得从「本机 Claude Code 的配置」里来，订阅登录态根本不该被读。
    let h = harness_with_env(
        handler(move |req| {
            let captured = Arc::clone(&captured);
            let counter = Arc::clone(&counter);
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                *captured.lock().await = Some((
                    req.url(),
                    req.header("authorization").map(str::to_string),
                    req.header("x-api-key").map(str::to_string),
                    req.header("anthropic-beta").map(str::to_string),
                ));
                json_response("{\"type\":\"message\",\"content\":[]}")
            }
        }),
        json!({ "providers": {
            "claude": { "type": "relay", "authMode": "claude_oauth",
                        "authFile": dir.path().join("missing.json") },
            "codex": { "type": "relay", "authMode": "api_key", "apiKey": "x", "baseURL": "https://unused.example.com/v1" },
        } }),
        vec![("CLAUDE_CONFIG_DIR".into(), dir.path().to_string_lossy().into_owned())],
    )
    .await;

    // 用假上游冒充「本机 Claude Code 接的中转站」。
    std::fs::write(
        dir.path().join("settings.json"),
        json!({ "env": { "ANTHROPIC_BASE_URL": h.upstream_origin, "ANTHROPIC_AUTH_TOKEN": "relay-token" } }).to_string(),
    )
    .unwrap();

    let response = h
        .authed(Method::POST, "/v1/messages")
        .header("anthropic-beta", "custom-beta")
        .json(&json!({ "model": "claude-sonnet-4-5", "max_tokens": 8, "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let _ = response.text().await;

    let guard = seen.lock().await;
    let (url, authorization, api_key, beta) = guard.as_ref().expect("上游收到请求");
    assert_eq!(url, "/v1/messages");
    assert_eq!(authorization.as_deref(), Some("Bearer relay-token"));
    assert_eq!(api_key.as_deref(), None);
    // 中转令牌不加 oauth beta
    assert_eq!(beta.as_deref(), Some("custom-beta"));
    drop(guard);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    h.close().await;
}
