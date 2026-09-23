mod common;

use ai_bridge_native::config::parse_config;
use ai_bridge_native::core::logger::set_silent;
use ai_bridge_native::core::paths::Env;
use ai_bridge_native::pool::runner::{create_pool_runner, PoolRunner};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// export 接入：Hub 主动敲门送活，节点在同一条响应里把上游字节回过去。
//
// 这里的「Hub」是测试自己扮的一个 reqwest 客户端 —— 那正是真 Hub 的
// exportdispatch 干的事。断言集中在两条边界上：
//   · 门锁：没有正确的回连密钥，一个字节都拿不到，而且每条响应都要能自证身份
//   · 语义一致：走这条路跑出来的结果，必须和长轮询那条一模一样（原始字节 + 终态）

const SECRET: &str = "export-secret-for-tests-0123456789";

#[derive(Default)]
struct HubState {
    next_calls: AtomicUsize,
    completed: Mutex<Vec<Value>>,
    enabled: Mutex<Value>,
}

async fn start_hub(state: Arc<HubState>) -> String {
    let app = Router::new()
        .route("/agent/v1/hello", post(|State(state): State<Arc<HubState>>, _body: String| async move {
            let enabled = state.enabled.lock().unwrap().clone();
            axum::Json(json!({ "accepted": [], "rejected": [], "quotaEffective": {}, "enabled": enabled }))
        }))
        .route("/agent/v1/heartbeat", post(|| async {
            axum::Json(json!({ "cancel": [], "drain": [], "quotaUpdate": {}, "serverTime": 0 }))
        }))
        // export 接入的机器不该来领活。留着这条路由就是为了能断言它一次都没被打过。
        .route("/agent/v1/next", post(|State(state): State<Arc<HubState>>, _body: String| async move {
            state.next_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            axum::http::StatusCode::NO_CONTENT.into_response()
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

fn execute_body(group: Option<&str>) -> Value {
    let body = base64::engine::general_purpose::STANDARD.encode("{\"model\":\"test\"}");
    let path = base64::engine::general_purpose::STANDARD.encode("/v1/messages");
    let mut unit = json!({
        "id": "u_export_1", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
        "provider": "api_key", "consumerKey": "ck_1", "state": "running",
        "inputs": [{ "name": "path", "inline": path }, { "name": "body", "inline": body }],
    });
    if let Some(group) = group {
        unit["model"] = json!("claude-sonnet-5");
        unit["group"] = json!(group);
    }
    json!({
        "unit": unit,
        "lease": { "token": "lease_export_1", "renewSec": 60 },
        "streamURL": "",
        "cancel": [],
    })
}

fn enabled_lane(groups: Vec<&str>) -> Value {
    json!([{
        "cid": "claude", "kind": "llm.chat", "kindVersion": 1, "provider": "api_key",
        "groups": groups, "seats": 1, "seatConcurrency": 1,
    }])
}

struct Harness {
    hub: Arc<HubState>,
    runner: PoolRunner,
    client: reqwest::Client,
    _dir: tempfile::TempDir,
}

impl Harness {
    async fn base(&self) -> String {
        let addr = self.runner.export_addr().await.expect("export 已监听");
        format!("http://127.0.0.1:{}", addr.port())
    }
}

/// public_url 传 None 表示故意不配，用来验证回落。
async fn harness(enabled: Value, public_url: Option<&str>) -> Harness {
    set_silent(std::env::var("LOG_LEVEL").as_deref() != Ok("debug"));
    let dir = tempfile::tempdir().unwrap();

    let response = "data: {\"ok\":true}\n\n".to_string();
    let origin = common::start_plain_upstream(move |req| {
        let response = response.clone();
        async move {
            if req.uri.path().ends_with("/models") {
                return axum::http::StatusCode::NOT_FOUND.into_response();
            }
            (
                axum::http::StatusCode::OK,
                [("content-type", "text/event-stream"), ("request-id", "req_up")],
                response,
            )
                .into_response()
        }
    })
    .await;

    let hub_state = Arc::new(HubState { enabled: Mutex::new(enabled), ..Default::default() });
    let hub = start_hub(Arc::clone(&hub_state)).await;

    let token_file = dir.path().join("node-token.json");
    std::fs::write(&token_file, json!({
        "version": 1, "nodeId": "node_export", "token": "node-secret",
        "hubURL": hub, "pairedAt": "2026-01-01T00:00:00Z",
    }).to_string()).unwrap();

    let mut export = json!({ "host": "127.0.0.1", "port": 0, "secret": SECRET });
    if let Some(url) = public_url {
        export["publicURL"] = json!(url);
    }
    let cfg = parse_config(json!({
        "mode": "pool",
        "relay": { "enabled": false },
        "providers": { "claude": { "type": "relay", "authMode": "api_key",
            "apiKey": "upstream-secret", "baseURL": format!("{origin}/v1") } },
        "pool": { "hubURL": hub, "tokenFile": token_file, "heartbeatSec": 1, "nextWaitSec": 1,
            "accessMode": "export", "export": export, "contributions": [] },
    }), &Env::default())
    .expect("pool 配置");

    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let runner = create_pool_runner(cfg, Env::default(), "test".into(), http).await.expect("建运行循环");
    Harness {
        hub: hub_state,
        runner,
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        _dir: dir,
    }
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

/// 一次完整的回连派单：Hub 推进来，节点跑上游，字节原样从同一条响应回去，
/// 终态照旧走节点主动出站那条路上报。
#[tokio::test]
async fn a_pushed_unit_streams_the_upstream_bytes_back_on_the_same_response() {
    let h = harness(enabled_lane(vec![]), Some("https://box.example.com:8788")).await;
    h.runner.start().await.expect("hello");
    assert_eq!(h.runner.access_mode(), "export");
    assert_eq!(h.runner.public_url().as_deref(), Some("https://box.example.com:8788"));

    let base = h.base().await;
    let response = h
        .client
        .post(format!("{base}/node/v1/execute"))
        .header("authorization", format!("Bearer {SECRET}"))
        .json(&execute_body(None))
        .send()
        .await
        .expect("回连成功");

    assert_eq!(response.status().as_u16(), 200);
    // 自证头：Hub 在读任何字节之前先看它。少了它，一个填错的公网地址就能
    // 把别的服务的响应当成节点的回传送给消费者。
    assert_eq!(response.headers().get("x-galaxy-node").unwrap(), "node_export");
    assert_eq!(response.headers().get("x-galaxy-upstream-status").unwrap(), "200");
    let encoded = response.headers().get("x-galaxy-upstream-headers").unwrap().to_str().unwrap().to_string();
    let decoded: Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(decoded["content-type"], json!("text/event-stream"));
    assert_eq!(decoded["request-id"], json!("req_up"));

    let text = response.text().await.unwrap();
    assert_eq!(text, "data: {\"ok\":true}\n\n", "消费者拿到的必须是上游的原始字节");

    wait_for("单元报终态", || !h.hub.completed.lock().unwrap().is_empty()).await;
    let completed = h.hub.completed.lock().unwrap().clone();
    assert_eq!(completed[0]["state"], json!("completed"));
    assert_eq!(completed[0]["lease"], json!("lease_export_1"));

    // export 接入的机器不去领活：两条都跑只会白占一条长轮询连接，
    // 还让「这台机器到底走哪条路」在日志里看不清。
    assert_eq!(h.hub.next_calls.load(Ordering::SeqCst), 0);
    h.runner.stop().await;
}

/// 门锁。密钥不对时什么都拿不到，但**响应仍然要能自证身份** ——
/// 漏了自证头，Hub 那边会把「密钥配错了」显示成「回连到的不是这台节点」，
/// 主人拿着这句话查不出任何东西。
#[tokio::test]
async fn a_wrong_secret_is_refused_and_the_response_still_identifies_the_node() {
    let h = harness(enabled_lane(vec![]), Some("https://box.example.com:8788")).await;
    h.runner.start().await.expect("hello");
    let base = h.base().await;

    for (label, header) in [
        ("密钥不对", Some("Bearer wrong-secret-with-the-same-len-01")),
        ("没带密钥", None),
    ] {
        let mut request = h.client.post(format!("{base}/node/v1/execute")).json(&execute_body(None));
        if let Some(header) = header {
            request = request.header("authorization", header);
        }
        let response = request.send().await.expect(label);
        assert_eq!(response.status().as_u16(), 401, "{label}");
        assert_eq!(response.headers().get("x-galaxy-node").unwrap(), "node_export", "{label}");
    }

    // 健康探测也是同一把锁：它同时是 Hub 判断「这个地址后面是不是你」的依据。
    let health = h
        .client
        .get(format!("{base}/node/v1/health"))
        .header("authorization", format!("Bearer {SECRET}"))
        .send()
        .await
        .expect("健康探测");
    assert_eq!(health.headers().get("x-galaxy-node").unwrap(), "node_export");
    let payload: Value = health.json().await.unwrap();
    assert_eq!(payload["ok"], json!(true));
    assert_eq!(payload["nodeId"], json!("node_export"));
    assert_eq!(payload["lanes"], json!(["claude"]));
    h.runner.stop().await;
}

/// 分组自校验在这条路上同样有效：Hub 是路由权威，但「在我的机器上执行什么」
/// 这条边界不信任 Hub。拒绝要用 409 —— Hub 据此改派，而不是当成单元本身有问题。
#[tokio::test]
async fn a_unit_outside_the_joined_groups_is_refused_with_409() {
    let h = harness(enabled_lane(vec!["mg_STD"]), Some("https://box.example.com:8788")).await;
    h.runner.start().await.expect("hello");
    let base = h.base().await;

    let response = h
        .client
        .post(format!("{base}/node/v1/execute"))
        .header("authorization", format!("Bearer {SECRET}"))
        .json(&execute_body(Some("mg_DEEP")))
        .send()
        .await
        .expect("回连成功");
    assert_eq!(response.status().as_u16(), 409);
    assert_eq!(response.headers().get("x-galaxy-retryable").unwrap(), "1");
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["error"]["code"], json!("capability_mismatch"));

    // 这次派单根本没落地，不该有终态 —— 再报一次只会撞上「单元已结束」。
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(h.hub.completed.lock().unwrap().is_empty());
    h.runner.stop().await;
}

/// 配了 export 却没给公网地址：回落成 poll，机器照常干活。
///
/// 直接拒绝启动是更「干净」的做法，但代价不对等 —— 一行填错的地址会变成
/// 整台机器下线，而回落最多是慢一点领到活。
#[tokio::test]
async fn export_without_a_public_url_falls_back_to_polling() {
    let h = harness(enabled_lane(vec![]), None).await;
    h.runner.start().await.expect("hello");
    assert_eq!(h.runner.access_mode(), "poll", "没有公网地址就不是 export");
    assert!(h.runner.export_addr().await.is_none(), "回落之后不该开任何端口");
    wait_for("回落之后照常长轮询", || h.hub.next_calls.load(Ordering::SeqCst) > 0).await;
    h.runner.stop().await;
}
