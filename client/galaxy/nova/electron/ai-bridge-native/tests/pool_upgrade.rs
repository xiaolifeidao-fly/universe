mod common;

use ai_bridge_native::config::parse_config;
use ai_bridge_native::core::logger::set_silent;
use ai_bridge_native::core::paths::Env;
use ai_bridge_native::pool::runner::{create_pool_runner_with, PoolRunner, RunnerOptions};
use ai_bridge_native::pool::upgrade::{current_platform, PreparedUpgrade, UpgradeCommand, Updater, PLATFORMS};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// 远程升级在 runner 这一侧的行为：收指令、去重、按顺序上报、装好之后排空等重启。
//
// 换文件本身（下载、验签、解包、试跑、替换）在 src/pool/upgrade.rs 的测试里对着真包、真 tar 跑；
// 这里用一个只记账的假升级器，断言的是「什么时候调它、调几次、怎么跟 Hub 说」。

const SECRET: &str = "export-secret-for-tests-0123456789";

/// 假 Hub。心跳里的升级指令一直带着 —— 真 Hub 在收到 downloading 之前就是这么重发的。
#[derive(Default)]
struct HubState {
    hello: Mutex<Option<Value>>,
    heartbeats: Mutex<Vec<Value>>,
    reports: Mutex<Vec<Value>>,
    upgrade: Mutex<Option<Value>>,
    next_calls: AtomicUsize,
    /// 立刻派下去的单元。
    pending: Mutex<Vec<Value>>,
    /// 第一次长轮询领走它之后挂住，等测试放行才返回：模拟「排空开始前就挂上的那条长轮询」。
    held_unit: Mutex<Option<Value>>,
    release_held: tokio::sync::Notify,
    completed: Mutex<Vec<Value>>,
    enabled: Mutex<Value>,
}

async fn start_hub(state: Arc<HubState>) -> String {
    let app = Router::new()
        .route("/agent/v1/hello", post(|State(state): State<Arc<HubState>>, body: String| async move {
            *state.hello.lock().unwrap() = serde_json::from_str(&body).ok();
            let enabled = state.enabled.lock().unwrap().clone();
            axum::Json(json!({ "accepted": [], "rejected": [], "enabled": enabled }))
        }))
        .route("/agent/v1/heartbeat", post(|State(state): State<Arc<HubState>>, body: String| async move {
            if let Ok(value) = serde_json::from_str::<Value>(&body) {
                state.heartbeats.lock().unwrap().push(value);
            }
            let mut response = json!({ "cancel": [], "drain": [], "serverTime": 0 });
            // 没有指令时整个字段省略（契约 3.2）。
            let upgrade = state.upgrade.lock().unwrap().clone();
            if let Some(upgrade) = upgrade {
                response["upgrade"] = upgrade;
            }
            axum::Json(response)
        }))
        .route("/agent/v1/upgrade/report", post(|State(state): State<Arc<HubState>>, body: String| async move {
            if let Ok(value) = serde_json::from_str::<Value>(&body) {
                state.reports.lock().unwrap().push(value);
            }
            axum::Json(json!({ "accepted": true }))
        }))
        .route("/agent/v1/next", post(|State(state): State<Arc<HubState>>, _body: String| async move {
            state.next_calls.fetch_add(1, Ordering::SeqCst);
            let held = state.held_unit.lock().unwrap().take();
            if let Some(unit) = held {
                state.release_held.notified().await;
                return axum::Json(unit).into_response();
            }
            let pending = state.pending.lock().unwrap().pop();
            match pending {
                Some(unit) => axum::Json(unit).into_response(),
                None => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    StatusCode::NO_CONTENT.into_response()
                }
            }
        }))
        .route("/stream/{unit}", post(|_body: axum::body::Bytes| async { axum::Json(json!({ "ok": true })) }))
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
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://127.0.0.1:{port}")
}

/// 只记账的升级器。
#[derive(Default)]
struct FakeUpdater {
    calls: Mutex<Vec<String>>,
    blocker: Option<String>,
    prepare_error: Option<String>,
}

impl FakeUpdater {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Updater for FakeUpdater {
    fn blocker(&self) -> Option<String> {
        self.blocker.clone()
    }
    fn verify(&self, command: &UpgradeCommand) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("verify {}", command.version));
        Ok(())
    }
    async fn prepare(&self, command: &UpgradeCommand) -> Result<PreparedUpgrade, String> {
        self.calls.lock().unwrap().push(format!("prepare {}", command.version));
        match &self.prepare_error {
            Some(message) => Err(message.clone()),
            None => Ok(PreparedUpgrade::new(command.version.clone(), "/nowhere/ai-bridge")),
        }
    }
    async fn install(&self, prepared: PreparedUpgrade) -> Result<PathBuf, String> {
        self.calls.lock().unwrap().push(format!("install {}", prepared.version));
        Ok(PathBuf::from("/opt/ai-bridge/ai-bridge"))
    }
}

struct Setup {
    version: &'static str,
    distribution: &'static str,
    updater: Option<Arc<dyn Updater>>,
    export: bool,
    upstream_delay: Duration,
}

impl Default for Setup {
    fn default() -> Self {
        Self { version: "0.2.0", distribution: "cli", updater: None, export: false, upstream_delay: Duration::ZERO }
    }
}

struct Harness {
    hub: Arc<HubState>,
    hub_url: String,
    runner: PoolRunner,
    /// 真正打到上游的单元请求数（不算模型清单）。
    upstream_calls: Arc<AtomicUsize>,
    client: reqwest::Client,
    _dir: tempfile::TempDir,
}

async fn harness(setup: Setup) -> Harness {
    set_silent(std::env::var("LOG_LEVEL").as_deref() != Ok("debug"));
    let dir = tempfile::tempdir().unwrap();

    let upstream_calls = Arc::new(AtomicUsize::new(0));
    let origin = {
        let calls = Arc::clone(&upstream_calls);
        let delay = setup.upstream_delay;
        common::start_plain_upstream(move |req| {
            let calls = Arc::clone(&calls);
            async move {
                if req.uri.path().ends_with("/models") {
                    return StatusCode::NOT_FOUND.into_response();
                }
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(delay).await;
                (StatusCode::OK, [("content-type", "text/event-stream")], "data: {\"ok\":true}\n\n").into_response()
            }
        })
        .await
    };

    let hub_state = Arc::new(HubState { enabled: Mutex::new(enabled_lane()), ..Default::default() });
    let hub = start_hub(Arc::clone(&hub_state)).await;

    let token_file = dir.path().join("node-token.json");
    std::fs::write(&token_file, json!({
        "version": 1, "nodeId": "node_up", "token": "node-secret",
        "hubURL": hub, "pairedAt": "2026-01-01T00:00:00Z",
    }).to_string()).unwrap();

    let mut pool = json!({
        "hubURL": hub, "tokenFile": token_file, "heartbeatSec": 1, "nextWaitSec": 1, "contributions": [],
    });
    if setup.export {
        pool["accessMode"] = json!("export");
        pool["export"] = json!({
            "host": "127.0.0.1", "port": 0, "secret": SECRET, "publicURL": "https://box.example.com:8788",
        });
    }
    let cfg = parse_config(json!({
        "mode": "pool",
        "relay": { "enabled": false },
        "providers": { "claude": { "type": "relay", "authMode": "api_key",
            "apiKey": "upstream-secret", "baseURL": format!("{origin}/v1") } },
        "pool": pool,
    }), &Env::default())
    .expect("pool 配置");

    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let options = RunnerOptions { distribution: setup.distribution.into(), updater: setup.updater };
    let runner = create_pool_runner_with(cfg, Env::default(), setup.version.into(), http, options)
        .await
        .expect("建运行循环");
    Harness {
        hub: hub_state,
        hub_url: hub,
        runner,
        upstream_calls,
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        _dir: dir,
    }
}

fn enabled_lane() -> Value {
    json!([{
        "cid": "claude", "kind": "llm.chat", "kindVersion": 1, "provider": "api_key",
        "modelsAllow": [], "modelsDeny": [], "seats": 1, "seatConcurrency": 1,
    }])
}

fn work_unit(hub: &str) -> Value {
    let body = base64::engine::general_purpose::STANDARD.encode("{\"model\":\"test\"}");
    let path = base64::engine::general_purpose::STANDARD.encode("/v1/messages");
    json!({
        "unit": {
            "id": "u_1", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
            "provider": "api_key", "consumerKey": "ck_1", "state": "running",
            "inputs": [{ "name": "path", "inline": path }, { "name": "body", "inline": body }],
        },
        "lease": { "token": "lease_1", "expiresAt": 0, "renewSec": 60 },
        "streamURL": format!("{hub}/stream/u_1"),
        "cancel": [],
    })
}

fn platform() -> &'static str {
    current_platform().expect("测试机的平台要认得出来")
}

fn command(id: &str, version: &str, platform: &str) -> Value {
    json!({
        "id": id, "version": version, "platform": platform,
        "url": "https://bucket.oss-cn-hangzhou.aliyuncs.com/galaxy/ai-bridge/pkg.tar.gz?Signature=secret",
        "sha256": "29497afb2668d3c372667f69ff807863db4201b937de100d7cb4826c05ee527e",
        "size": 3072128,
        "signature": "c2lnbmF0dXJl",
    })
}

fn states(hub: &HubState) -> Vec<String> {
    hub.reports.lock().unwrap().iter().map(|report| report["state"].as_str().unwrap_or("").to_string()).collect()
}

fn report_for(hub: &HubState, id: &str) -> Option<Value> {
    hub.reports.lock().unwrap().iter().find(|report| report["id"] == json!(id)).cloned()
}

fn heartbeat_count(hub: &HubState) -> usize {
    hub.heartbeats.lock().unwrap().len()
}

/// 心跳一秒一次，等得起几秒。
async fn wait_for<F: Fn() -> bool>(label: &str, condition: F) {
    for _ in 0..400 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("等不到：{label}");
}

/// 一次完整的远程升级：按 downloading → installing → restarting 上报，装好之后停止接活、
/// 要求重启；Hub 在这之后仍然重发同一条指令，节点不能再下载安装一遍。
#[tokio::test]
async fn an_upgrade_is_carried_out_once_then_the_node_drains_and_asks_to_be_restarted() {
    let updater = Arc::new(FakeUpdater::default());
    let h = harness(Setup { updater: Some(updater.clone()), ..Default::default() }).await;
    *h.hub.upgrade.lock().unwrap() = Some(command("ug_1", "0.3.0", platform()));
    h.runner.start().await.expect("hello");

    let hello = h.hub.hello.lock().unwrap().clone().expect("收到 hello");
    assert_eq!(hello["platform"], json!(platform()));
    assert_eq!(hello["distribution"], json!("cli"));
    assert_eq!(hello["upgradeBlocker"], json!(""), "空串 = 可以升级");

    tokio::time::timeout(Duration::from_secs(10), h.runner.restart_requested())
        .await
        .expect("装好之后要求重启");
    assert_eq!(states(&h.hub), vec!["downloading", "installing", "restarting"]);
    for report in h.hub.reports.lock().unwrap().iter() {
        assert_eq!(report["id"], json!("ug_1"));
        assert!(report["message"].as_str().unwrap().contains("0.3.0"), "{report}");
        assert!(!report.to_string().contains("secret"), "上报里不能带下载地址：{report}");
    }
    assert_eq!(updater.calls(), vec!["verify 0.3.0", "prepare 0.3.0", "install 0.3.0"]);

    // Hub 还在每次心跳里重发同一条指令。
    let seen = heartbeat_count(&h.hub);
    wait_for("又过了两次心跳", || heartbeat_count(&h.hub) >= seen + 2).await;
    assert_eq!(updater.calls().len(), 3, "重发的同一条指令不能再下载安装一遍");
    assert_eq!(states(&h.hub).len(), 3, "也不能再报一遍");

    // 排空：心跳里每条通道都是 paused，长轮询不再去领活。
    let last = h.hub.heartbeats.lock().unwrap().last().cloned().unwrap();
    let lanes = last["lanes"].as_array().expect("心跳带通道");
    assert!(!lanes.is_empty());
    assert!(lanes.iter().all(|lane| lane["paused"] == json!(true)), "{last}");
    let polls = h.hub.next_calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert!(h.hub.next_calls.load(Ordering::SeqCst) <= polls + 1, "排空期间不该再去领活");

    // 一个单元都没在跑：排空立刻结束。restart_requested 可以反复问，答案不变。
    assert_eq!(h.runner.drain_for_restart(Duration::from_secs(1)).await, 0);
    tokio::time::timeout(Duration::from_millis(100), h.runner.restart_requested()).await.expect("结果留得住");
    h.runner.stop().await;
}

/// 随 Nova 分发的 bridge 没有升级器：说清楚该怎么办，只说一次，照常干活。
#[tokio::test]
async fn without_an_updater_the_node_says_it_ships_with_nova_and_keeps_working() {
    let h = harness(Setup { distribution: "nova", ..Default::default() }).await;
    *h.hub.upgrade.lock().unwrap() = Some(command("ug_nova", "0.3.0", platform()));
    h.runner.start().await.expect("hello");

    let hello = h.hub.hello.lock().unwrap().clone().expect("收到 hello");
    assert_eq!(hello["distribution"], json!("nova"));
    assert_eq!(hello["upgradeBlocker"], json!(""));
    assert_eq!(hello["platform"], json!(platform()));

    wait_for("报了结果", || !h.hub.reports.lock().unwrap().is_empty()).await;
    let seen = heartbeat_count(&h.hub);
    wait_for("又过了两次心跳", || heartbeat_count(&h.hub) >= seen + 2).await;
    let reports = h.hub.reports.lock().unwrap().clone();
    assert_eq!(reports.len(), 1, "同一条指令只报一次：{reports:?}");
    assert_eq!(reports[0]["state"], json!("failed"));
    assert_eq!(reports[0]["message"], json!("这台机器的 ai-bridge 随 Nova 应用分发，不能远程升级，请更新 Nova"));

    assert!(tokio::time::timeout(Duration::from_millis(300), h.runner.restart_requested()).await.is_err(),
        "没升级就不该要求重启");
    let last = h.hub.heartbeats.lock().unwrap().last().cloned().unwrap();
    assert!(last["lanes"].as_array().unwrap().iter().all(|lane| lane["paused"] == json!(false)), "{last}");
    h.runner.stop().await;
}

/// 已经是目标版本、目标比本机旧、包不是这个平台的、版本号不合法：都轮不到升级器，
/// 各自报一次该报的状态。一条结束之后下一条照常处理。
#[tokio::test]
async fn same_version_downgrade_foreign_platform_and_bad_version_are_settled_without_the_updater() {
    let updater = Arc::new(FakeUpdater::default());
    let h = harness(Setup { updater: Some(updater.clone()), ..Default::default() }).await;
    h.runner.start().await.expect("hello");

    let foreign = PLATFORMS.iter().find(|name| **name != platform()).unwrap();
    let cases = [
        ("ug_same", "0.2.0", platform(), "succeeded", "已经是 0.2.0"),
        ("ug_down", "0.1.9", platform(), "failed", "不降级"),
        ("ug_foreign", "0.3.0", *foreign, "failed", *foreign),
        ("ug_bad", "latest", platform(), "failed", "版本号不合法"),
    ];
    for (id, version, target_platform, state, needle) in cases {
        *h.hub.upgrade.lock().unwrap() = Some(command(id, version, target_platform));
        wait_for(id, || report_for(&h.hub, id).is_some()).await;
        let report = report_for(&h.hub, id).unwrap();
        assert_eq!(report["state"], json!(state), "{id}: {report}");
        assert!(report["message"].as_str().unwrap().contains(needle), "{id}: {report}");
    }
    assert!(updater.calls().is_empty(), "这几种情况都轮不到下载：{:?}", updater.calls());
    assert_eq!(states(&h.hub).len(), cases.len(), "每条只报一次");
    assert!(tokio::time::timeout(Duration::from_millis(300), h.runner.restart_requested()).await.is_err());
    h.runner.stop().await;
}

/// 升级器说此刻升级不了（目录不可写、没有公钥）：hello 里报出去，指令来了原样报 failed，一步都不做。
#[tokio::test]
async fn a_blocked_updater_is_reported_in_hello_and_as_the_failure() {
    let blocker = "可执行文件所在目录 /usr/local/bin 对运行 ai-bridge 的用户不可写";
    let updater = Arc::new(FakeUpdater { blocker: Some(blocker.into()), ..Default::default() });
    let h = harness(Setup { updater: Some(updater.clone()), ..Default::default() }).await;
    *h.hub.upgrade.lock().unwrap() = Some(command("ug_blocked", "0.3.0", platform()));
    h.runner.start().await.expect("hello");

    let hello = h.hub.hello.lock().unwrap().clone().expect("收到 hello");
    assert_eq!(hello["upgradeBlocker"], json!(blocker));
    wait_for("报了结果", || !h.hub.reports.lock().unwrap().is_empty()).await;
    let report = report_for(&h.hub, "ug_blocked").unwrap();
    assert_eq!(report["state"], json!("failed"));
    assert_eq!(report["message"], json!(blocker));
    assert!(updater.calls().is_empty(), "升级不了就连签名都不必验");
    h.runner.stop().await;
}

/// 准备阶段失败（sha256 对不上、试跑不过）：报 failed，不要求重启，通道不暂停，
/// 之后来的新指令照常处理。
#[tokio::test]
async fn a_failed_preparation_is_reported_and_the_node_keeps_working_and_accepts_the_next_command() {
    let updater = Arc::new(FakeUpdater { prepare_error: Some("sha256 对不上：包在路上被换过".into()), ..Default::default() });
    let h = harness(Setup { updater: Some(updater.clone()), ..Default::default() }).await;
    *h.hub.upgrade.lock().unwrap() = Some(command("ug_1", "0.3.0", platform()));
    h.runner.start().await.expect("hello");

    wait_for("失败报上去", || states(&h.hub).contains(&"failed".to_string())).await;
    assert_eq!(states(&h.hub), vec!["downloading", "failed"]);
    assert_eq!(report_for(&h.hub, "ug_1").unwrap()["state"], json!("downloading"));
    let failed = h.hub.reports.lock().unwrap()[1].clone();
    assert_eq!(failed["message"], json!("sha256 对不上：包在路上被换过"));
    assert_eq!(updater.calls(), vec!["verify 0.3.0", "prepare 0.3.0"], "准备失败就不能去装");
    assert!(tokio::time::timeout(Duration::from_millis(300), h.runner.restart_requested()).await.is_err());

    let seen = heartbeat_count(&h.hub);
    wait_for("失败之后的心跳", || heartbeat_count(&h.hub) >= seen + 1).await;
    let last = h.hub.heartbeats.lock().unwrap().last().cloned().unwrap();
    assert!(last["lanes"].as_array().unwrap().iter().all(|lane| lane["paused"] == json!(false)), "{last}");

    // 主人在控制台上再点一次升级：新的 id，照常接。
    *h.hub.upgrade.lock().unwrap() = Some(command("ug_2", "0.3.0", platform()));
    wait_for("第二次升级开始", || report_for(&h.hub, "ug_2").is_some()).await;
    wait_for("第二次也失败", || states(&h.hub).len() == 4).await;
    assert_eq!(states(&h.hub), vec!["downloading", "failed", "downloading", "failed"]);
    h.runner.stop().await;
}

/// 排空要等在跑的单元跑完，但不无限等：到点就返回还剩几个，剩下的交给 stop() 报给 Hub 改派。
#[tokio::test]
async fn draining_waits_for_the_unit_in_flight_and_gives_up_at_the_timeout() {
    let h = harness(Setup { upstream_delay: Duration::from_millis(1_200), ..Default::default() }).await;
    h.hub.pending.lock().unwrap().push(work_unit(&h.hub_url));
    h.runner.start().await.expect("hello");
    wait_for("单元打到了上游", || h.upstream_calls.load(Ordering::SeqCst) == 1).await;

    assert_eq!(h.runner.drain_for_restart(Duration::from_millis(200)).await, 1, "到点了单元还在跑");
    let started = Instant::now();
    assert_eq!(h.runner.drain_for_restart(Duration::from_secs(5)).await, 0, "等得起就等它跑完");
    assert!(started.elapsed() < Duration::from_secs(5));
    wait_for("单元报终态", || !h.hub.completed.lock().unwrap().is_empty()).await;
    assert_eq!(h.hub.completed.lock().unwrap()[0]["state"], json!("completed"), "排空不打断在跑的单元");
    h.runner.stop().await;
}

/// 排空开始之前就挂上的那条长轮询，可能在排空之后才领回一个单元：不跑，
/// 按 node_shutdown 立刻还给 Hub 改派，上游一次都不打。
#[tokio::test]
async fn a_unit_claimed_by_a_long_poll_already_in_flight_is_handed_back_while_draining() {
    let h = harness(Setup::default()).await;
    *h.hub.held_unit.lock().unwrap() = Some(work_unit(&h.hub_url));
    h.runner.start().await.expect("hello");
    wait_for("长轮询挂上了", || h.hub.next_calls.load(Ordering::SeqCst) >= 1).await;

    assert_eq!(h.runner.drain_for_restart(Duration::from_millis(100)).await, 0);
    h.hub.release_held.notify_one();
    wait_for("单元被还回去", || !h.hub.completed.lock().unwrap().is_empty()).await;

    let completed = h.hub.completed.lock().unwrap()[0].clone();
    assert_eq!(completed["state"], json!("failed"));
    assert_eq!(completed["lease"], json!("lease_1"));
    assert_eq!(completed["error"]["code"], json!("node_shutdown"));
    assert_eq!(completed["error"]["retryable"], json!(true), "Hub 要能立刻改派");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.upstream_calls.load(Ordering::SeqCst), 0, "还回去的单元不该碰上游");
    h.runner.stop().await;
}

/// export 接入的机器排空时，Hub 敲门送活拿到的是 503 node_stopping —— 和正在退出一个说法，Hub 立刻改派。
#[tokio::test]
async fn export_turns_new_work_away_with_503_while_draining_for_restart() {
    let h = harness(Setup { export: true, ..Default::default() }).await;
    h.runner.start().await.expect("hello");
    let addr = h.runner.export_addr().await.expect("export 已监听");

    h.runner.drain_for_restart(Duration::from_millis(100)).await;
    let body = {
        let mut unit = work_unit(&h.hub_url);
        unit["streamURL"] = json!("");
        unit
    };
    let response = h
        .client
        .post(format!("http://127.0.0.1:{}/node/v1/execute", addr.port()))
        .header("authorization", format!("Bearer {SECRET}"))
        .json(&body)
        .send()
        .await
        .expect("回连成功");
    assert_eq!(response.status().as_u16(), 503);
    assert_eq!(response.headers().get("x-galaxy-node").unwrap(), "node_up", "错误响应也要自证身份");
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["error"]["code"], json!("node_stopping"));
    assert_eq!(h.upstream_calls.load(Ordering::SeqCst), 0);
    h.runner.stop().await;
}
