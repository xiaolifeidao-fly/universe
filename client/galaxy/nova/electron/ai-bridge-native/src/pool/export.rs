use super::client::CompleteBody;
use super::runner::{Outcome, RunnerInner};
use crate::business::{UnitCallbacks, UnitEvent, UnitIo, WorkUnit};
use crate::config::schema::PoolExportConfig;
use crate::core::errors::error_body;
use crate::core::paths::{expand_home, runtime_dir, Env};
use crate::{log_info, log_warn};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;

// export 接入：节点把自己暴露在一个公网地址上，Hub 主动敲门送活。
//
// 它和长轮询那条路只差**一步**：活是谁送来的。领到活之后的一切 ——
// 白名单自校验、占并发、跑 provider、续租、报终态 —— 走的是同一套代码
// （runner 的 begin_unit / finish_unit / report_terminal）。这条边界必须守住：
// 一旦两条路各自实现一遍执行流程，计量和失败语义迟早会分家。
//
// 和 relay 模式那个本机监听也不是一回事：relay 服务的是本机客户端，说的是
// Anthropic / OpenAI 协议；这里服务的只有 Hub 一个调用方，说的是共享池的单元协议。
// 两者可以同时开，端口也各是各的。

/// 节点在每一次响应里出示的自证头。**每条响应都要带**，包括错误和健康探测。
///
/// 它是 Hub 那边 SSRF 的闸：回连地址是主人自己填的，Hub 在读任何字节之前
/// 先看这个头对不对得上。少了它，一个填成云元数据地址的 endpoint 就能把
/// Hub 读到的东西原样送给消费者。
const NODE_HEADER: &str = "X-Galaxy-Node";

/// 回传给 Hub 的字节缓冲深度。
///
/// 有界是有意的：Hub 收得慢时 send().await 会挂住，背压顺着这条 channel
/// 一路顶回上游的 fetch —— 这正是长轮询那边靠 chunked 上行天然得到的效果。
/// 无界 channel 会让一个慢消费者把节点的内存吃光。
const CHUNK_BUFFER: usize = 16;

pub struct ExportState {
    runner: Arc<RunnerInner>,
    secret: String,
    node_id: String,
    bridge_version: String,
}

impl ExportState {
    /// 逐字节等时比较。回连密钥就是这台机器的门锁，短路比较会把它的长度和
    /// 前缀顺着响应时间漏出去。
    fn authorized(&self, headers: &HeaderMap) -> bool {
        let presented = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().strip_prefix("Bearer ").unwrap_or(value).trim())
            .unwrap_or("");
        if presented.is_empty() || presented.len() != self.secret.len() {
            return false;
        }
        presented.as_bytes().ct_eq(self.secret.as_bytes()).into()
    }
}

pub struct ExportServer {
    state: Arc<ExportState>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    serving: Option<tokio::task::JoinHandle<()>>,
    pub addr: Option<SocketAddr>,
}

impl ExportServer {
    pub(crate) fn new(runner: Arc<RunnerInner>, secret: String, node_id: String, bridge_version: String) -> Self {
        Self {
            state: Arc::new(ExportState { runner, secret, node_id, bridge_version }),
            shutdown: None,
            serving: None,
            addr: None,
        }
    }

    pub async fn listen(&mut self, config: &PoolExportConfig) -> Result<SocketAddr, String> {
        let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port))
            .await
            .map_err(|e| format!("监听 {}:{} 失败：{e}", config.host, config.port))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;

        let router = Router::new()
            .route("/node/v1/health", get(health))
            .route("/node/v1/execute", post(execute))
            .route("/node/v1/cancel", post(cancel))
            .fallback(not_found)
            .with_state(Arc::clone(&self.state));

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let serving = tokio::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await;
            if let Err(e) = served {
                log_warn!("pool_export_stopped", "message": e.to_string());
            }
        });
        self.shutdown = Some(tx);
        self.serving = Some(serving);
        self.addr = Some(addr);
        Ok(addr)
    }

    pub async fn close(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(serving) = self.serving.take() {
            let handle = serving.abort_handle();
            if tokio::time::timeout(std::time::Duration::from_secs(2), serving).await.is_err() {
                handle.abort();
            }
        }
    }
}

// ---------- 路由 ----------

/// health 回答的不是「我活着吗」（那看心跳），而是「你的公网入口通不通」。
///
/// 所以它必须带自证头：主人最常见的配错是把地址填成了另一台机器或另一个服务，
/// 那种情况下对面照样会回 200，只有这个头能分辨。
async fn health(State(state): State<Arc<ExportState>>, headers: HeaderMap) -> Response {
    if !state.authorized(&headers) {
        return reject(&state, StatusCode::UNAUTHORIZED, "export_unauthorized", "回连密钥不对");
    }
    let lanes: Vec<String> = state.runner.lanes.read().unwrap().keys().cloned().collect();
    let inflight: u32 = state.runner.lanes.read().unwrap().values().map(|lane| lane.inflight()).sum();
    let mut response = Json(json!({
        "ok": !state.runner.stopping.load(Ordering::Relaxed),
        "nodeId": state.node_id,
        "bridgeVersion": state.bridge_version,
        "lanes": lanes,
        "inflight": inflight,
    }))
    .into_response();
    stamp(&state, &mut response);
    response
}

#[derive(Debug, Deserialize)]
struct ExecuteBody {
    unit: WorkUnit,
    lease: LeaseBody,
    /// cancel 是搭车下发的取消清单，与长轮询一致。
    #[serde(default)]
    cancel: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct LeaseBody {
    #[serde(default)]
    token: String,
    #[serde(default, rename = "renewSec")]
    renew_sec: Option<u64>,
}

/// execute 是 Hub 送活进来的那扇门。
///
/// 响应就是上游的字节流本身：状态码与响应头搭在自定义头上（与长轮询那条
/// 反向上行的约定完全一样），body 是原样对拷的字节。这样 Hub 两条路上收到的
/// 东西形状一致，对拷代码只有一份。
async fn execute(State(state): State<Arc<ExportState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.authorized(&headers) {
        return reject(&state, StatusCode::UNAUTHORIZED, "export_unauthorized", "回连密钥不对");
    }
    if state.runner.stopping.load(Ordering::Relaxed) {
        // 503 让 Hub 知道换一台机器就行，不是这个单元本身有问题。
        return reject(&state, StatusCode::SERVICE_UNAVAILABLE, "node_stopping", "节点正在退出");
    }
    if state.runner.draining_for_restart() {
        // 为重启排空：对 Hub 来说和正在退出是一回事 —— 这台机器马上就不在了，换一台。
        return reject(&state, StatusCode::SERVICE_UNAVAILABLE, "node_stopping", "节点正在重启升级");
    }
    let parsed: ExecuteBody = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(e) => return reject(&state, StatusCode::BAD_REQUEST, "invalid_body", &format!("单元解析失败：{e}")),
    };
    // 取消清单先处理：它可能就是这次请求的**主要目的**（Hub 顺路捎带），
    // 放在后面处理会被下面任何一条 return 跳过。
    state.runner.apply_cancels(&parsed.cancel);

    let unit = parsed.unit;
    if unit.id.is_empty() {
        return reject(&state, StatusCode::BAD_REQUEST, "invalid_body", "单元缺少 id");
    }
    let lease = parsed.lease.token.clone();
    let slot = match state.runner.begin_unit(&unit, &lease, parsed.lease.renew_sec) {
        Ok(slot) => slot,
        Err(error) => {
            // 409：这台机器现在接不了（通道满、不在申报范围）。Hub 据此改派，
            // 而不是把它当成单元本身的错误。
            //
            // 这里**不报终态**：单元还没登记进 aborts，Hub 拿到 409 就知道
            // 这次派单没落地，会自己走改派。再报一次 complete 只会撞上
            // 「单元已结束」，白留一条告警。
            let mut response = reject(&state, StatusCode::CONFLICT, &error.code, &error.message);
            response.headers_mut().insert("x-galaxy-retryable",
                HeaderValue::from_static("1"));
            return response;
        }
    };

    let io = UnitIo {
        cancel: slot.cancel.clone(),
        work_dir: Some(slot.work_dir.clone()),
        unit_id: unit.id.clone(),
        cid: slot.lane.cid(),
        callbacks: Some(Arc::new(state.runner.callbacks(lease.clone())) as Arc<dyn UnitCallbacks>),
    };
    let mut events = slot.lane.provider.run(unit.clone(), io);
    let outcome = Arc::new(Mutex::new(Outcome::default()));

    // 先等到 head：状态码与响应头要在这条 HTTP 响应的头部就带上。
    let mut head: Option<(u16, BTreeMap<String, String>)> = None;
    while let Some(event) = events.next().await {
        match event {
            UnitEvent::Head { status, headers } => {
                state.runner.observe_head(&slot.lane, &unit.id, status, &headers);
                head = Some((status, headers));
                break;
            }
            UnitEvent::Error(error) => {
                outcome.lock().unwrap().failure = Some(error);
                break;
            }
            UnitEvent::Done(done) => {
                outcome.lock().unwrap().done = Some(*done);
                break;
            }
            UnitEvent::Chunk(_) => {}
        }
    }

    let ms = slot.started.elapsed().as_millis() as u64;
    let early_failure = outcome.lock().unwrap().failure.clone();
    if let Some(failure) = early_failure {
        let retryable = failure.retryable;
        let message = failure.message.clone();
        let state_name = if failure.code == "unit_cancelled" { "cancelled" } else { "failed" };
        state.runner.report_terminal(&unit.id, &CompleteBody {
            lease, state: state_name.into(), error: Some(failure), ms: Some(ms), ..Default::default()
        }).await;
        state.runner.finish_unit(slot).await;
        // 首字节都没到，Hub 还能改派。用 502 而不是 409：单元确实被接下并跑过了，
        // 只是上游没给出响应 —— 两者在 Hub 的日志里要分得开。
        let status = if retryable { StatusCode::BAD_GATEWAY } else { StatusCode::UNPROCESSABLE_ENTITY };
        return reject(&state, status, "upstream_failed", &message);
    }

    let Some((status, upstream_headers)) = head else {
        // 一个字节都没有的成功回合（session 的空回合就是这样）。
        // 终态照报，响应给一个空 body —— Hub 那边不发 Head 就永远等不到状态码。
        let terminal = outcome.lock().unwrap().terminal();
        state.runner.report_terminal(&unit.id, &CompleteBody {
            lease, state: "completed".into(), ms: Some(ms), ..terminal
        }).await;
        state.runner.finish_unit(slot).await;
        let mut response = Response::new(Body::empty());
        stamp(&state, &mut response);
        set_upstream(&mut response, 200, &BTreeMap::new());
        return response;
    };

    // 剩下的事件就是响应字节。转发任务和这条响应之间用一条有界 channel 连着：
    // Hub 收得慢就在 send 上挂住，背压顺着顶回上游；Hub 断开则 receiver 被丢弃，
    // send 立刻失败 —— 那是我们感知「消费者走了」最快的一条路，比等一个心跳周期
    // 的 cancel 快得多。
    let (sender, receiver) = tokio::sync::mpsc::channel::<Bytes>(CHUNK_BUFFER);
    let runner = Arc::clone(&state.runner);
    let unit_id = unit.id.clone();
    tokio::spawn(async move {
        let mut gone = false;
        while let Some(event) = events.next().await {
            match event {
                UnitEvent::Chunk(bytes) => {
                    if sender.send(bytes).await.is_err() {
                        gone = true;
                        break;
                    }
                }
                UnitEvent::Done(done) => {
                    outcome.lock().unwrap().done = Some(*done);
                    break;
                }
                UnitEvent::Error(error) => {
                    outcome.lock().unwrap().failure = Some(error);
                    break;
                }
                UnitEvent::Head { .. } => {}
            }
        }
        drop(sender);
        let ms = slot.started.elapsed().as_millis() as u64;
        if gone {
            // Hub 把连接关了：立刻 abort 上游，不再烧主人的额度。
            slot.cancel.cancel(crate::core::errors::http_error(499, "consumer_gone", "consumer_gone"));
            let usage = outcome.lock().unwrap().usage();
            runner.report_terminal(&unit_id, &CompleteBody {
                lease, state: "cancelled".into(), usage: Some(usage), ms: Some(ms), ..Default::default()
            }).await;
            runner.finish_unit(slot).await;
            return;
        }
        let (failure, terminal) = {
            let guard = outcome.lock().unwrap();
            (guard.failure.clone(), guard.terminal())
        };
        match failure {
            Some(failure) => {
                let state_name = if failure.code == "unit_cancelled" { "cancelled" } else { "failed" };
                runner.report_terminal(&unit_id, &CompleteBody {
                    lease, state: state_name.into(), error: Some(failure), ms: Some(ms), ..terminal
                }).await;
            }
            None => {
                runner.report_terminal(&unit_id, &CompleteBody {
                    lease, state: "completed".into(), ms: Some(ms), ..terminal
                }).await;
            }
        }
        runner.finish_unit(slot).await;
    });

    let stream = async_stream::stream! {
        let mut receiver = receiver;
        while let Some(chunk) = receiver.recv().await {
            yield Ok::<Bytes, std::io::Error>(chunk);
        }
    };
    let mut response = Response::new(Body::from_stream(stream));
    stamp(&state, &mut response);
    set_upstream(&mut response, status, &upstream_headers);
    response
}

#[derive(Debug, Deserialize)]
struct CancelBody {
    #[serde(default)]
    units: Vec<String>,
}

/// cancel 是取消的**快路**。慢路（搭在心跳响应里的 cancel 清单）照旧有效 ——
/// 这里只是让消费者一断开，节点在几毫秒内就停手，而不是等下一个心跳周期。
async fn cancel(State(state): State<Arc<ExportState>>, headers: HeaderMap, body: Bytes) -> Response {
    if !state.authorized(&headers) {
        return reject(&state, StatusCode::UNAUTHORIZED, "export_unauthorized", "回连密钥不对");
    }
    let parsed: CancelBody = serde_json::from_slice(&body).unwrap_or(CancelBody { units: vec![] });
    let stopped = state.runner.apply_cancels(&parsed.units);
    let mut response = Json(json!({ "cancelled": stopped })).into_response();
    stamp(&state, &mut response);
    response
}

async fn not_found(State(state): State<Arc<ExportState>>) -> Response {
    reject(&state, StatusCode::NOT_FOUND, "not_found", "route not found")
}

// ---------- 响应工具 ----------

/// 每条响应都盖上自证头。**没有例外** —— Hub 在读任何字节之前先看它，
/// 错误响应上漏了这个头，那条错误在 Hub 那边会变成一句无从查起的
/// 「回连到的不是这台节点」。
fn stamp(state: &ExportState, response: &mut Response) {
    if let Ok(value) = HeaderValue::from_str(&state.node_id) {
        response.headers_mut().insert(NODE_HEADER, value);
    }
}

fn set_upstream(response: &mut Response, status: u16, headers: &BTreeMap<String, String>) {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(headers).unwrap_or_default());
    let headers_mut = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&status.to_string()) {
        headers_mut.insert("x-galaxy-upstream-status", value);
    }
    if let Ok(value) = HeaderValue::from_str(&encoded) {
        headers_mut.insert("x-galaxy-upstream-headers", value);
    }
    headers_mut.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
}

fn reject(state: &ExportState, status: StatusCode, code: &str, message: &str) -> Response {
    let mut response = (status, Json(error_body(status.as_u16(), code, message))).into_response();
    stamp(state, &mut response);
    response
}

// ---------- 密钥与对外地址 ----------

/// 回连密钥的落点。不配就放在状态目录里，与 node-token.json 同一处。
pub fn resolve_secret_file(config: Option<&PoolExportConfig>, env: &Env) -> PathBuf {
    match config.and_then(|c| c.secret_file.as_deref()) {
        Some(path) => expand_home(path),
        None => runtime_dir(env).join("export-secret"),
    }
}

/// 取回连密钥：配置里写了就用它，否则读密钥文件，文件不存在就生成一把。
///
/// 自动生成是有意的默认：这串东西没人需要背下来，让它默认就是一把足够长的
/// 随机密钥，比让每个人自己想一个（然后想出 `123456`）安全得多。
/// 生成之后落盘 0600，重启照旧 —— 每次重启换一把会让 Hub 手里的那份立刻失效。
pub async fn resolve_secret(config: Option<&PoolExportConfig>, env: &Env) -> Result<String, String> {
    if let Some(secret) = config.and_then(|c| c.secret.as_deref()).map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(secret.to_string());
    }
    let file = resolve_secret_file(config, env);
    match tokio::fs::read_to_string(&file).await {
        Ok(raw) => {
            let trimmed = raw.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读不到回连密钥文件 {}：{e}", file.display())),
    }
    let generated = generate_secret();
    write_private(&file, generated.as_bytes()).await?;
    log_info!("pool_export_secret_created", "file": file.to_string_lossy().into_owned());
    Ok(generated)
}

fn generate_secret() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnpqrstvwxyz";
    let mut rng = rand::thread_rng();
    (0..40).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await;
        }
    }
    tokio::fs::write(path, bytes).await.map_err(|e| format!("写 {} 失败：{e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

/// 规范化对外声明的公网地址：去掉尾斜杠，拒掉几种一看就不该放行的写法。
///
/// 这里拦一遍，Hub 那边还会再拦一遍。两处都要有：本机拦住能在主人还站在机器前
/// 的时候就报错，而不是等他去控制台上看一台永远没活的机器。
pub fn normalize_public_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("pool.export.publicURL 没填：Hub 要靠它才能回连这台机器".into());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| "pool.export.publicURL 不是合法 URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("pool.export.publicURL 必须是 http 或 https".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("pool.export.publicURL 不能带用户名密码".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("pool.export.publicURL 缺少主机名".into());
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    // 0.0.0.0 是「监听所有网卡」，不是一个可访问的地址。Hub 拿着它只会连到自己身上。
    if bare == "0.0.0.0" || bare == "::" {
        return Err("pool.export.publicURL 不能是 0.0.0.0：那是监听地址，不是别人访问你的地址".into());
    }
    // 与 Hub 那边同一条规则，本机先拦：两边规则不一致时，这台机器会以为自己是
    // export，Hub 却把它回落成 poll —— 本机拦住才能在主人还站在机器前面时就报错。
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        let link_local = match ip {
            std::net::IpAddr::V4(v4) => v4.is_link_local(),
            std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        };
        if link_local {
            return Err("pool.export.publicURL 不能是链路本地地址（169.254.x.x / fe80::）".into());
        }
    }
    let origin = parsed.origin().ascii_serialization();
    let path = parsed.path().trim_end_matches('/');
    Ok(format!("{origin}{path}"))
}

