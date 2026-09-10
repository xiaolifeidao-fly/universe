mod common;

use ai_bridge_native::config::parse_config;
use ai_bridge_native::core::logger::set_silent;
use ai_bridge_native::core::paths::Env;
use ai_bridge_native::pool::runner::create_pool_runner;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 假 Hub：只实现节点会打的那几个端点，并把收到的东西记下来供断言。
#[derive(Default)]
struct HubState {
    hello: Mutex<Option<Value>>,
    /// 派下去的单元；每个只发一次。
    pending: Mutex<Vec<Value>>,
    next_calls: AtomicUsize,
    streamed: Mutex<Vec<u8>>,
    stream_headers: Mutex<Option<(String, String)>>,
    completed: Mutex<Vec<Value>>,
    enabled: Mutex<Value>,
}

async fn start_hub(state: Arc<HubState>) -> String {
    let app = Router::new()
        .route("/agent/v1/hello", post(|State(state): State<Arc<HubState>>, body: String| async move {
            *state.hello.lock().unwrap() = serde_json::from_str(&body).ok();
            let enabled = state.enabled.lock().unwrap().clone();
            axum::Json(json!({ "accepted": [], "rejected": [], "quotaEffective": {}, "enabled": enabled }))
        }))
        .route("/agent/v1/heartbeat", post(|| async {
            axum::Json(json!({ "cancel": [], "drain": [], "quotaUpdate": {}, "serverTime": 0 }))
        }))
        .route("/agent/v1/next", post(|State(state): State<Arc<HubState>>, _body: String| async move {
            state.next_calls.fetch_add(1, Ordering::SeqCst);
            let claimed = state.pending.lock().unwrap().pop();
            match claimed {
                Some(unit) => axum::Json(unit).into_response(),
                None => {
                    // 别让长轮询变成忙等：真 Hub 会挂住这条连接。
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    axum::http::StatusCode::NO_CONTENT.into_response()
                }
            }
        }))
        .route("/stream/{unit}", post(|State(state): State<Arc<HubState>>, headers: HeaderMap, body: axum::body::Bytes| async move {
            let status = headers.get("x-galaxy-upstream-status").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let encoded = headers.get("x-galaxy-upstream-headers").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            *state.stream_headers.lock().unwrap() = Some((status, encoded));
            state.streamed.lock().unwrap().extend_from_slice(&body);
            axum::Json(json!({ "ok": true }))
        }))
        .route("/agent/v1/units/{unit}/complete", post(|State(state): State<Arc<HubState>>, body: String| async move {
            if let Ok(value) = serde_json::from_str::<Value>(&body) {
                state.completed.lock().unwrap().push(value);
            }
            axum::Json(json!({ "ok": true }))
        }))
        .route("/agent/v1/units/{unit}/progress", post(|| async { axum::Json(json!({ "cancelRequested": false })) }))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { let _ = axum::serve(listener, app).await; });
    format!("http://127.0.0.1:{port}")
}

fn work_unit(hub: &str, model: Option<&str>) -> Value {
    let body = base64::engine::general_purpose::STANDARD.encode("{\"model\":\"test\"}");
    let path = base64::engine::general_purpose::STANDARD.encode("/v1/messages");
    let mut unit = json!({
        "id": "u_1", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
        "provider": "api_key", "consumerKey": "ck_1", "state": "running",
        "inputs": [{ "name": "path", "inline": path }, { "name": "body", "inline": body }],
    });
    if let Some(model) = model {
        unit["model"] = json!(model);
    }
    json!({
        "unit": unit,
        "lease": { "token": "lease_1", "expiresAt": 0, "renewSec": 60 },
        "streamURL": format!("{hub}/stream/u_1"),
        "cancel": [],
    })
}

fn enabled_lane(seats: u32, allow: Vec<&str>) -> Value {
    json!([{
        "cid": "claude", "kind": "llm.chat", "kindVersion": 1, "provider": "api_key",
        "modelsAllow": allow, "modelsDeny": [], "seats": seats, "seatConcurrency": 1,
    }])
}

struct Harness {
    hub: Arc<HubState>,
    runner: ai_bridge_native::pool::runner::PoolRunner,
    _dir: tempfile::TempDir,
}

async fn harness(upstream_status: u16, enabled: Value, unit: Option<Value>) -> Harness {
    set_silent(std::env::var("LOG_LEVEL").as_deref() != Ok("debug"));
    let dir = tempfile::tempdir().unwrap();

    let response = "data: {\"ok\":true}\n\n".to_string();
    let origin = common::start_plain_upstream(move |req| {
        let response = response.clone();
        async move {
            // 模型清单端点在这条链路上无关紧要：拿不到就降级成空清单。
            if req.uri.path().ends_with("/models") {
                return axum::http::StatusCode::NOT_FOUND.into_response();
            }
            (
                axum::http::StatusCode::from_u16(upstream_status).unwrap(),
                [("content-type", "text/event-stream"), ("retry-after", "300"), ("request-id", "req_up")],
                response,
            )
                .into_response()
        }
    })
    .await;

    let hub_state = Arc::new(HubState { enabled: Mutex::new(enabled), ..Default::default() });
    let hub = start_hub(Arc::clone(&hub_state)).await;
    if let Some(unit) = unit {
        hub_state.pending.lock().unwrap().push(unit_with_hub(unit, &hub));
    }

    let token_file = dir.path().join("node-token.json");
    std::fs::write(&token_file, json!({
        "version": 1, "nodeId": "node_1", "token": "node-secret",
        "hubURL": hub, "pairedAt": "2026-01-01T00:00:00Z",
    }).to_string()).unwrap();

    let cfg = parse_config(json!({
        "mode": "pool",
        "relay": { "enabled": false },
        "providers": { "claude": { "type": "relay", "authMode": "api_key",
            "apiKey": "upstream-secret", "baseURL": format!("{origin}/v1") } },
        "pool": { "hubURL": hub, "tokenFile": token_file, "heartbeatSec": 1, "nextWaitSec": 1,
            "contributions": [] },
    }), &Env::default())
    .expect("pool 配置");

    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let runner = create_pool_runner(cfg, Env::default(), "test".into(), http).await.expect("建运行循环");
    Harness { hub: hub_state, runner, _dir: dir }
}

fn unit_with_hub(mut unit: Value, hub: &str) -> Value {
    unit["streamURL"] = json!(format!("{hub}/stream/u_1"));
    unit
}

async fn wait_for<F: Fn() -> bool>(label: &str, condition: F) {
    for _ in 0..200 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("等不到：{label}");
}

#[tokio::test]
async fn a_claimed_unit_is_relayed_upstream_and_streamed_back_byte_for_byte() {
    let h = harness(200, enabled_lane(1, vec![]), Some(work_unit("", None))).await;
    h.runner.start().await.expect("hello");

    // hello 报的是「这台机器有什么」，不带座位与额度 —— 那些由控制台定。
    let hello = h.hub.hello.lock().unwrap().clone().expect("收到 hello");
    let contributions = hello["contributions"].as_array().unwrap();
    assert_eq!(contributions.len(), 1);
    assert_eq!(contributions[0]["cid"], json!("claude"));
    assert_eq!(contributions[0]["provider"], json!("api_key"), "路由键由 authMode 推出来");
    assert_eq!(contributions[0]["available"], json!(true));
    assert!(contributions[0].get("seats").is_none(), "座位不该由节点申报");
    assert_eq!(h.runner.lane_ids(), vec!["claude".to_string()]);

    wait_for("单元报终态", || !h.hub.completed.lock().unwrap().is_empty()).await;

    let streamed = String::from_utf8(h.hub.streamed.lock().unwrap().clone()).unwrap();
    assert_eq!(streamed, "data: {\"ok\":true}\n\n", "消费者拿到的必须是上游的原始字节");

    let (status, encoded) = h.hub.stream_headers.lock().unwrap().clone().expect("上行带了上游头");
    assert_eq!(status, "200");
    let decoded: Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(decoded["content-type"], json!("text/event-stream"));
    assert_eq!(decoded["request-id"], json!("req_up"));

    let completed = h.hub.completed.lock().unwrap().clone();
    assert_eq!(completed[0]["state"], json!("completed"));
    assert_eq!(completed[0]["lease"], json!("lease_1"));
    assert!(completed[0].get("error").is_none());
    h.runner.stop().await;
}

#[tokio::test]
async fn an_upstream_429_throttles_the_lane_and_is_reported_as_a_retryable_fault() {
    let h = harness(429, enabled_lane(1, vec![]), Some(work_unit("", None))).await;
    h.runner.start().await.expect("hello");
    wait_for("单元报终态", || !h.hub.completed.lock().unwrap().is_empty()).await;

    let completed = h.hub.completed.lock().unwrap().clone();
    assert_eq!(completed[0]["state"], json!("failed"));
    assert_eq!(completed[0]["error"]["code"], json!("upstream_429"));
    assert_eq!(completed[0]["error"]["retryable"], json!(true));
    assert_eq!(completed[0]["error"]["class"], json!("upstream_fault"));
    // 上游说了 Retry-After，这条通道要退出候选，不能立刻再去领活。
    assert_eq!(h.hub.streamed.lock().unwrap().len(), "data: {\"ok\":true}\n\n".len(),
        "429 的响应体同样要原样带回给消费者");
    h.runner.stop().await;
}

/// Hub 是路由权威，但「在我的机器上执行什么」这条边界不信任 Hub：
/// 派下来一个不在申报范围内的模型，节点必须自己挡掉。
#[tokio::test]
async fn a_unit_outside_the_declared_model_range_is_refused_without_touching_the_upstream() {
    let h = harness(200, enabled_lane(1, vec!["claude-*"]), Some(work_unit("", Some("gpt-4o")))).await;
    h.runner.start().await.expect("hello");
    wait_for("单元被拒", || !h.hub.completed.lock().unwrap().is_empty()).await;

    let completed = h.hub.completed.lock().unwrap().clone();
    assert_eq!(completed[0]["state"], json!("failed"));
    assert_eq!(completed[0]["error"]["code"], json!("capability_mismatch"));
    assert_eq!(completed[0]["error"]["retryable"], json!(true), "换台机器可能就能跑");
    assert!(h.hub.streamed.lock().unwrap().is_empty(), "根本不该碰上游");
    h.runner.stop().await;
}

/// enabled 缺字段（老版本 Hub）与空数组是两回事：前者维持现状，后者停掉所有通道。
#[tokio::test]
async fn an_absent_enabled_field_keeps_the_lanes_while_an_empty_array_drains_them() {
    let h = harness(200, json!([]), None).await;
    h.runner.start().await.expect("hello");
    assert!(h.runner.lane_ids().is_empty(), "空数组就是一条都别跑");

    let h2 = harness(200, Value::Null, None).await;
    h2.runner.start().await.expect("hello");
    assert!(h2.runner.lane_ids().is_empty(), "老版本 Hub 不下发时保持现状（本来就没有）");
    h.runner.stop().await;
    h2.runner.stop().await;
}

/// 停了就必须是真的停了：长轮询要断开，不能在 stop 之后还继续领活。
#[tokio::test]
async fn stopping_the_runner_ends_the_long_poll() {
    let h = harness(200, enabled_lane(1, vec![]), None).await;
    h.runner.start().await.expect("hello");
    wait_for("开始长轮询", || h.hub.next_calls.load(Ordering::SeqCst) > 0).await;

    h.runner.stop().await;
    let after_stop = h.hub.next_calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.hub.next_calls.load(Ordering::SeqCst), after_stop, "停了之后不该再领活");
}
