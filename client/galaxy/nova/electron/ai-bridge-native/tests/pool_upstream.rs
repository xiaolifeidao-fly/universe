mod common;

use ai_bridge_native::business::{ErrorClass, UnitEvent, UnitIo, WorkUnit};
use ai_bridge_native::business::llm_chat::RelayProvider;
use ai_bridge_native::core::paths::Env;
use ai_bridge_native::core::request::Cancel;
use ai_bridge_native::credentials::CredentialRegistry;
use ai_bridge_native::pool::usage::UpstreamUsage;
use axum::response::IntoResponse;
use base64::Engine;
use common::*;
use futures_util::StreamExt;
use serde_json::json;
use std::sync::Arc;

/// 派下来的单元跑完之后，消费者拿到的字节必须和上游一模一样，
/// 终态还要能把「谁的错、能不能重派」说清楚。
async fn run_case(status: u16) {
    let original = if status == 429 {
        json!({ "type": "error", "error": { "type": "rate_limit_error", "message": "Error" }, "request_id": "req_test" }).to_string()
    } else {
        "data: {\"message\":\"original bytes\"}\n\n".to_string()
    };
    let content_type = if status == 429 { "application/json" } else { "text/event-stream" };
    let body = original.clone();
    let origin = start_plain_upstream(move |_req| {
        let body = body.clone();
        async move {
            (
                axum::http::StatusCode::from_u16(status).unwrap(),
                [("content-type", content_type), ("request-id", "req_test"), ("retry-after", "300")],
                body,
            )
                .into_response()
        }
    })
    .await;

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let usage = Arc::new(UpstreamUsage::new());
    let provider = RelayProvider::new(
        "test",
        relay_provider_config("api_key", Some("test"), Some(&format!("{origin}/v1"))),
        Arc::new(CredentialRegistry::new(client.clone())),
        client,
        Env::default(),
        Arc::clone(&usage),
    );
    let unit: WorkUnit = serde_json::from_value(json!({
        "id": "u_test", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
        "provider": "test", "consumerKey": "ck_test", "state": "running",
        "inputs": [{ "name": "body",
            "inline": base64::engine::general_purpose::STANDARD.encode("{\"model\":\"test\"}") }],
    }))
    .unwrap();

    use ai_bridge_native::business::Provider;
    let mut events = provider.run(unit, UnitIo {
        cancel: Cancel::new(), work_dir: None,
        unit_id: "u_test".into(), cid: "test".into(), callbacks: None,
    });

    let mut collected = vec![];
    while let Some(event) = events.next().await {
        collected.push(event);
    }

    let UnitEvent::Head { status: seen, headers } = &collected[0] else {
        panic!("第一件事必须是 head，收到 {:?}", collected[0]);
    };
    assert_eq!(*seen, status);
    assert_eq!(headers.get("content-type").map(String::as_str), Some(content_type));
    assert_eq!(headers.get("request-id").map(String::as_str), Some("req_test"));
    assert_eq!(headers.get("retry-after").map(String::as_str), Some("300"));

    let streamed: Vec<u8> = collected
        .iter()
        .filter_map(|event| match event {
            UnitEvent::Chunk(bytes) => Some(bytes.to_vec()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(String::from_utf8(streamed).unwrap(), original, "响应字节必须原样带回");

    match collected.last().unwrap() {
        UnitEvent::Done(_) => assert!(status < 400, "HTTP {status} 不该报成功"),
        UnitEvent::Error(error) => {
            assert!(status >= 400, "HTTP {status} 不该报失败");
            assert_eq!(error.class, ErrorClass::UpstreamFault);
            let expected = if status == 429 { "upstream_429" } else if status >= 500 { "upstream_5xx" } else { "upstream_rejected" };
            assert_eq!(error.code, expected);
            assert_eq!(error.retryable, status == 429 || status >= 500);
            assert!(error.message.contains("req_test"), "错误里要带上游的 request-id");
        }
        other => panic!("终态不该是 {other:?}"),
    }
}

#[tokio::test]
async fn upstream_200_streams_through_and_completes() { run_case(200).await }
#[tokio::test]
async fn upstream_400_is_a_non_retryable_upstream_fault() { run_case(400).await }
#[tokio::test]
async fn upstream_401_is_a_non_retryable_upstream_fault() { run_case(401).await }
#[tokio::test]
async fn upstream_429_is_retryable() { run_case(429).await }
#[tokio::test]
async fn upstream_503_is_retryable() { run_case(503).await }

#[tokio::test]
async fn a_missing_body_fails_before_touching_the_upstream() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let provider = RelayProvider::new(
        "test",
        relay_provider_config("api_key", Some("test"), Some("http://127.0.0.1:1/v1")),
        Arc::new(CredentialRegistry::new(client.clone())),
        client,
        Env::default(),
        Arc::new(UpstreamUsage::new()),
    );
    let unit: WorkUnit = serde_json::from_value(json!({
        "id": "u_test", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
        "provider": "test", "consumerKey": "ck_test", "state": "running",
    }))
    .unwrap();
    use ai_bridge_native::business::Provider;
    let mut events = provider.run(unit, UnitIo {
        cancel: Cancel::new(), work_dir: None,
        unit_id: "u_test".into(), cid: "test".into(), callbacks: None,
    });
    let first = events.next().await.expect("要有一条事件");
    match first {
        UnitEvent::Error(error) => {
            assert_eq!(error.class, ErrorClass::InputFault);
            assert_eq!(error.code, "invalid_body");
            assert!(!error.retryable, "输入错了改派到别的机器也一样错");
        }
        other => panic!("应当直接报输入错误，收到 {other:?}"),
    }
}

/// 上游余量是**顺手**收下来的：跑一条真的中转请求，响应头里的限流项就该落进
/// UpstreamUsage，不需要任何额外的上游调用。
///
/// 这条用例走的是完整的 provider.run 路径 —— 单测只验了解析器，这里验的是
/// 「解析器真的被接在那个位置上」。这两件事分开断过一次之后，把 observe 挪错地方
/// （比如挪到只有非流式响应才走到的分支里）才会被拦住。
#[tokio::test]
async fn relaying_a_request_captures_upstream_ratelimit_headers() {
    let origin = start_plain_upstream(move |_req| async move {
        (
            axum::http::StatusCode::OK,
            [
                ("content-type", "text/event-stream"),
                ("anthropic-ratelimit-unified-5h-limit", "1000000"),
                ("anthropic-ratelimit-unified-5h-remaining", "250000"),
                ("anthropic-ratelimit-unified-status", "allowed_warning"),
                // 非限流头不该跟着进去：这份东西要随心跳上报。
                ("request-id", "req_test"),
            ],
            "data: {}\n\n".to_string(),
        )
            .into_response()
    })
    .await;

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let usage = Arc::new(UpstreamUsage::new());
    let provider = RelayProvider::new(
        "claude_oauth",
        relay_provider_config("api_key", Some("test"), Some(&format!("{origin}/v1"))),
        Arc::new(CredentialRegistry::new(client.clone())),
        client,
        Env::default(),
        Arc::clone(&usage),
    );
    let unit: WorkUnit = serde_json::from_value(json!({
        "id": "u_test", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
        "provider": "claude_oauth", "consumerKey": "ck_test", "state": "running",
        "inputs": [{ "name": "body",
            "inline": base64::engine::general_purpose::STANDARD.encode("{\"model\":\"test\"}") }],
    }))
    .unwrap();

    use ai_bridge_native::business::Provider;
    let mut events = provider.run(unit, UnitIo {
        cancel: Cancel::new(), work_dir: None,
        unit_id: "u_test".into(), cid: "relay_claude".into(), callbacks: None,
    });
    while events.next().await.is_some() {}

    // 按**路由键**存，不是按 cid：余量是那个上游账号的属性。
    let snapshot = usage.get("claude_oauth").expect("跑完一条请求就该有快照");
    assert_eq!(snapshot.source, "headers");
    assert!(!snapshot.observed_at.is_empty(), "观测时刻不能是空的 —— 界面靠它说明数有多旧");
    assert!(
        !snapshot.raw.contains_key("request-id"),
        "只收限流头，别把别的响应头一起报上去：{:?}",
        snapshot.raw
    );

    let five = snapshot
        .buckets
        .iter()
        .find(|bucket| bucket.window.as_deref() == Some("5h"))
        .expect("5 小时那一桶");
    assert_eq!(five.limit, Some(1_000_000));
    assert_eq!(five.remaining, Some(250_000));
    assert_eq!(five.used_percent, Some(75.0));
}
