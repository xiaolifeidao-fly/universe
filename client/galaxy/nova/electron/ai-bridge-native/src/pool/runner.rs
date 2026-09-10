use super::client::{
    CapabilityReport, CompleteBody, EnabledContribution, HeartbeatLane, HubClient, HubFailure,
    HubLane, NextResult,
};
use super::hub_address::HubAddressCheck;
use super::lane::{Lane, LaneConfig};
use super::models::list_models;
use super::probe::probe;
use super::token::{fingerprint, read_node_identity, resolve_node_token_file, NodeIdentity};
use crate::business::delivery_task::PlannerBridgeProvider;
use crate::business::llm_chat::RelayProvider;
use crate::business::video_edit::FfmpegLocalProvider;
use crate::business::{
    local_resources, model_match, ArtifactRef, DoneEvent, ErrorClass, Metering, Provider,
    UnitCallbacks, UnitError, UnitEvent, UnitIo, WorkUnit,
};
use crate::config::schema::{AppConfig, PoolConfig};
use crate::core::paths::Env;
use crate::core::request::Cancel;
use crate::credentials::CredentialRegistry;
use crate::{log_debug, log_error, log_info, log_warn};
use async_stream::stream;
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

// pool 模式的运行循环。
//
// 进程不 listen 任何端口（P-15）：主循环是「长轮询领活 → 跑 provider → 上行推流 → 报终态」，
// 心跳线程每 15s 一次，取消信号搭在这两条已有链路上，不单独轮询（T-05）。

const RECONNECT_MIN_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

/// 重探本机能力的间隔。
///
/// 能力可用性只在 hello 时上报，而 hello 只在启动/重连时发生 —— 于是「运行中
/// 登录态过期」和「运行中登录回来」这两件事 Hub 都看不见。这个循环把两边都补上：
/// 探到变化就主动重发一次 hello。60 秒是折中 —— 探测要读 Keychain，不是白拿的，
/// 但恢复延迟也不该长到让人以为没生效。
const HEALTH_PROBE_MS: u64 = 60_000;

/// LocalCapability 是本机对一项能力知道、而 Hub 不知道的那部分：
/// 拿哪一份订阅登录态、跑哪个可执行文件。Hub 只发「要不要、给多少」，
/// 「怎么跑」永远留在本机 —— 凭据不出本机这条就靠它。
#[derive(Debug, Clone)]
struct LocalCapability {
    cid: String,
    kind: String,
    kind_version: u32,
    /// 放置用的 provider 路由键（中转类由订阅类型推出，本机执行类是模块名）。
    route_key: String,
    build: CapabilityBuild,
}

#[derive(Debug, Clone)]
enum CapabilityBuild {
    /// 中转类：借 providers 里某一项的订阅登录态。
    Relay { config_key: String },
    Ffmpeg,
}

pub struct PoolRunner {
    inner: Arc<RunnerInner>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

struct RunnerInner {
    cfg: AppConfig,
    settings: PoolConfig,
    identity: NodeIdentity,
    bridge_version: String,
    client: Arc<HubClient>,
    credentials: Arc<CredentialRegistry>,
    http: reqwest::Client,
    env: Env,
    // 通道是**跟着 Hub 下发的集合动态增删的**，不是启动时按本地配置建好的。
    lanes: RwLock<HashMap<String, Arc<Lane>>>,
    // inventory 是本机探测到的能力，cid → 建 provider 需要的本地信息。
    // 它决定「能不能建这条通道」，Hub 决定「要不要建」。
    inventory: RwLock<HashMap<String, LocalCapability>>,
    aborts: Mutex<HashMap<String, Cancel>>,
    stopping: AtomicBool,
    loop_cancel: Cancel,
    hub_address: Mutex<HubAddressCheck>,
    last_health: Mutex<String>,
}

pub async fn create_pool_runner(
    cfg: AppConfig,
    env: Env,
    bridge_version: String,
    http: reqwest::Client,
) -> Result<PoolRunner, String> {
    let settings = cfg.pool.clone().ok_or("mode=pool 但缺少 pool 配置段")?;
    let identity = read_node_identity(&resolve_node_token_file(Some(&settings), &env))
        .await?
        .ok_or("还没有配对过。先在控制台生成配对码，再重新配对这台机器")?;
    let client = Arc::new(HubClient::new(
        settings.hub_url.clone(),
        settings.contract,
        Some(identity.token.clone()),
        Some(identity.node_id.clone()),
        http.clone(),
    ));
    let hub_address = HubAddressCheck::new(settings.hub_url.clone());
    Ok(PoolRunner {
        inner: Arc::new(RunnerInner {
            credentials: Arc::new(CredentialRegistry::new(http.clone())),
            cfg,
            settings,
            identity,
            bridge_version,
            client,
            http,
            env,
            lanes: RwLock::new(HashMap::new()),
            inventory: RwLock::new(HashMap::new()),
            aborts: Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            loop_cancel: Cancel::new(),
            hub_address: Mutex::new(hub_address),
            last_health: Mutex::new(String::new()),
        }),
        tasks: Mutex::new(vec![]),
    })
}

impl PoolRunner {
    pub async fn start(&self) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let mut attempt: u32 = 1;
        loop {
            if inner.stopping.load(Ordering::Relaxed) {
                return Ok(());
            }
            match inner.say_hello(None).await {
                Ok(()) => {
                    if attempt > 1 {
                        log_info!("pool_hello_recovered", "attempt": attempt);
                    }
                    break;
                }
                Err(failure) => {
                    if inner.stopping.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    if failure.is_contract_mismatch() {
                        // 契约不匹配是升级问题，不是网络抖动：立刻停，别把重试打成死循环。
                        log_error!("pool_contract_mismatch", "message": failure.message());
                        return Err(failure.message());
                    }
                    let message = failure.message();
                    // 令牌被拒不是网络抖动，重试多少次都不会自己好。但也**不能直接退出**：
                    // 主人很可能正在控制台里重新配对，进程活着才能在配对完之后自动接上。
                    if attempt == 1 && is_token_rejection(&message) {
                        log_error!("pool_node_token_rejected", "message": message,
                            "hint": "这台机器的节点令牌 Hub 不认了。打开 Galaxy 控制台「加入共享池」，生成配对码重新配对即可，不用回到这台机器。");
                    } else {
                        log_warn!("pool_hello_failed", "message": message, "attempt": attempt);
                    }
                    // 指数退避封顶：连不上 Hub 时不该把日志和 CPU 都刷满。
                    let wait_ms = (RECONNECT_MIN_MS << attempt.saturating_sub(1).min(6)).min(RECONNECT_MAX_MS);
                    inner.wait(wait_ms).await;
                    attempt += 1;
                }
            }
        }
        if inner.stopping.load(Ordering::Relaxed) {
            return Ok(());
        }

        let mut tasks = self.tasks.lock().unwrap();
        tasks.push(tokio::spawn(Arc::clone(&inner).heartbeat_loop()));
        tasks.push(tokio::spawn(Arc::clone(&inner).next_loop()));
        tasks.push(tokio::spawn(Arc::clone(&inner).health_loop()));
        let lanes: Vec<String> = inner.lanes.read().unwrap().keys().cloned().collect();
        log_info!("pool_started", "nodeId": inner.identity.node_id, "lanes": lanes);
        Ok(())
    }

    pub async fn stop(&self) {
        self.inner.stopping.store(true, Ordering::Relaxed);
        self.inner.loop_cancel.cancel(crate::core::errors::http_error(503, "shutdown", "shutdown"));
        for cancel in self.inner.aborts.lock().unwrap().values() {
            cancel.cancel(crate::core::errors::http_error(503, "shutdown", "shutdown"));
        }
        let handles: Vec<_> = self.tasks.lock().unwrap().drain(..).collect();
        for handle in handles {
            handle.abort();
        }
        log_info!("pool_stopped");
    }

    pub fn lane_ids(&self) -> Vec<String> {
        self.inner.lanes.read().unwrap().keys().cloned().collect()
    }
}

fn is_token_rejection(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("令牌无效") || message.contains("未授权") || message.contains("已撤销")
        || lower.contains("revoked") || lower.contains("unauthorized")
}

impl RunnerInner {
    async fn wait(&self, ms: u64) {
        tokio::select! {
            biased;
            () = self.loop_cancel.cancelled() => {}
            () = tokio::time::sleep(Duration::from_millis(ms)) => {}
        }
    }

    /// 重新探一遍本机能力。凭据会过期、ffmpeg 会被卸载，所以每次 hello 都探，不只探一次。
    async fn refresh_inventory(&self) -> Vec<CapabilityReport> {
        let probed = probe(&self.cfg, &self.credentials, &self.env).await;
        let mut next = HashMap::new();
        let mut reports = vec![];
        for capability in probed.capabilities {
            let Some(local) = local_capability(&capability, &self.cfg) else { continue };
            next.insert(local.cid.clone(), local.clone());
            // 只给「可用」的能力列模型：不可用时凭据本来就解析不了，去问上游只是白等一次超时。
            let models = match (&capability.upstream, capability.available) {
                (Some(upstream), true) => match self.cfg.providers.get(upstream) {
                    Some(provider) => {
                        let listed = list_models(upstream, provider, &self.credentials, &self.env, &self.http).await;
                        (!listed.is_empty()).then_some(listed)
                    }
                    None => None,
                },
                _ => None,
            };
            reports.push(CapabilityReport {
                cid: local.cid.clone(),
                kind: local.kind.clone(),
                kind_version: local.kind_version,
                provider: local.route_key.clone(),
                available: capability.available,
                unavailable_reason: (!capability.available).then(|| capability.detail.clone()),
                available_models: models,
            });
            if !capability.available {
                log_warn!("pool_upstream_unavailable", "cid": local.cid, "detail": capability.detail);
            }
        }
        *self.inventory.write().unwrap() = next;
        reports
    }

    fn build_provider(&self, local: &LocalCapability) -> Option<Arc<dyn Provider>> {
        match &local.build {
            CapabilityBuild::Relay { config_key } => {
                let config = self.cfg.providers.get(config_key)?.clone();
                Some(Arc::new(RelayProvider::new(
                    local.route_key.clone(),
                    config,
                    Arc::clone(&self.credentials),
                    self.http.clone(),
                    self.env.clone(),
                )))
            }
            CapabilityBuild::Ffmpeg => Some(Arc::new(FfmpegLocalProvider::new(
                local.route_key.clone(),
                None,
                vec![],
                self.http.clone(),
            ))),
        }
    }

    /// 把本地通道对齐到 Hub 下发的集合。
    ///
    /// 三种情形分开处理：
    ///   新增 —— Hub 要，本地没有：建通道（本机得真有这个能力，否则只记一条日志）
    ///   变更 —— 两边都有：**原地换配置**，不重建。重建会把 inflight 计数清零，
    ///           正在跑的请求就变成了「没人认领的并发」，闸门当场失准。
    ///   移除 —— Hub 不要了（主人关掉了）：先置 draining 停止接新单，
    ///           等在跑的跑完再真拆。
    fn apply_enabled(&self, enabled: Option<&[EnabledContribution]>) {
        // None 表示对面是老版本 Hub，没有这个字段 —— 维持现状。
        // 空数组才是「一条都别跑」。两者混同会让一次版本不匹配把所有通道停掉。
        let Some(enabled) = enabled else { return };
        let wanted: HashMap<&str, &EnabledContribution> =
            enabled.iter().map(|item| (item.cid.as_str(), item)).collect();

        for (cid, want) in &wanted {
            let local = self.inventory.read().unwrap().get(*cid).cloned();
            let Some(local) = local else {
                log_warn!("pool_enabled_not_probed", "cid": cid,
                    "hint": "控制台开着这条贡献，但本机没探测到这个能力");
                continue;
            };
            let config = lane_config(want);
            if let Some(existing) = self.lanes.read().unwrap().get(*cid) {
                existing.set_config(config);
                continue;
            }
            let Some(provider) = self.build_provider(&local) else { continue };
            self.lanes.write().unwrap().insert((*cid).to_string(), Arc::new(Lane::new(config, provider)));
            log_info!("pool_lane_added", "cid": cid, "kind": want.kind, "seats": want.seats);
        }

        let existing: Vec<(String, Arc<Lane>)> =
            self.lanes.read().unwrap().iter().map(|(k, v)| (k.clone(), Arc::clone(v))).collect();
        for (cid, lane) in existing {
            if wanted.contains_key(cid.as_str()) {
                continue;
            }
            lane.draining.store(true, Ordering::Relaxed);
            if lane.inflight() == 0 {
                self.lanes.write().unwrap().remove(&cid);
                log_info!("pool_lane_removed", "cid": cid);
            } else {
                log_info!("pool_lane_draining", "cid": cid, "inflight": lane.inflight());
            }
        }
    }

    /// reports 传进来就直接用，不再探一遍 —— healthLoop 刚探完，重复探一次
    /// 既慢又可能拿到不一致的两份结果。
    async fn say_hello(&self, reports: Option<Vec<CapabilityReport>>) -> Result<(), HubFailure> {
        let reports = match reports {
            Some(reports) => reports,
            None => self.refresh_inventory().await,
        };
        let resources = serde_json::to_value(local_resources()).unwrap_or(json!({}));
        let result = self
            .client
            .hello(&self.bridge_version, &resources, &reports, &self.loop_cancel)
            .await?;
        for rejected in &result.rejected {
            log_error!("pool_capability_rejected", "cid": rejected.cid, "reason": rejected.reason);
        }
        self.apply_enabled(result.enabled.as_deref());
        *self.last_health.lock().unwrap() = health_signature(&reports);
        let lanes = self.lanes.read().unwrap().len();
        log_info!("pool_hello",
            "nodeId": self.identity.node_id, "token": fingerprint(&self.identity.token),
            "probed": reports.len(), "enabled": lanes, "hub": self.settings.hub_url);
        if lanes == 0 {
            log_warn!("pool_nothing_enabled",
                "hint": "本机没有任何通道在跑：去控制台的「贡献授权」把要共享的能力打开并给上额度");
        }
        Ok(())
    }

    /// 定期重探，只在**变了**的时候重发 hello。
    /// 不是每次都发：hello 会让 Hub 做一次全量 inventory 同步，没变化时发它纯属浪费。
    async fn health_loop(self: Arc<Self>) {
        while !self.stopping.load(Ordering::Relaxed) {
            self.wait(HEALTH_PROBE_MS).await;
            if self.stopping.load(Ordering::Relaxed) {
                break;
            }
            let reports = self.refresh_inventory().await;
            if health_signature(&reports) == *self.last_health.lock().unwrap() {
                continue;
            }
            let unavailable: Vec<&str> =
                reports.iter().filter(|r| !r.available).map(|r| r.cid.as_str()).collect();
            log_info!("pool_health_changed", "unavailable": unavailable);
            if let Err(failure) = self.say_hello(Some(reports)).await {
                log_warn!("pool_health_probe_failed", "message": failure.message());
            }
        }
    }

    async fn heartbeat_loop(self: Arc<Self>) {
        while !self.stopping.load(Ordering::Relaxed) {
            let lanes: Vec<Arc<Lane>> = self.lanes.read().unwrap().values().cloned().collect();
            let payload: Vec<HeartbeatLane> = lanes
                .iter()
                .map(|lane| HeartbeatLane {
                    cid: lane.cid(),
                    inflight: lane.inflight(),
                    queued: 0,
                    throttled_until: lane.throttled_until_ms().and_then(iso_from_ms),
                    upstream_ok: lane.upstream_ok.load(Ordering::Relaxed),
                    paused: lane.paused.load(Ordering::Relaxed),
                })
                .collect();
            match self.client.heartbeat(&payload, &self.loop_cancel).await {
                Ok(result) => {
                    self.hub_address.lock().unwrap().check_and_log(result.hub_url.as_deref());
                    // 取消搭在心跳的响应里：延迟不超过一个上报周期（T-05）。
                    for unit_id in &result.cancel {
                        if let Some(cancel) = self.aborts.lock().unwrap().get(unit_id) {
                            cancel.cancel(crate::core::errors::http_error(499, "hub_cancelled", "hub_cancelled"));
                        }
                    }
                    for lane in &lanes {
                        lane.draining.store(result.drain.contains(&lane.cid()), Ordering::Relaxed);
                    }
                    // 主人在控制台改了什么，最迟一个心跳周期就换过来。注意它在 draining
                    // 之后：apply_enabled 会把被关掉的通道重新置成 draining，
                    // 顺序反了会被上面那个循环立刻清掉。
                    self.apply_enabled(result.enabled.as_deref());
                }
                Err(failure) => log_warn!("pool_heartbeat_failed", "message": failure.message()),
            }
            self.wait(self.settings.heartbeat_sec as u64 * 1000).await;
        }
    }

    async fn next_loop(self: Arc<Self>) {
        let mut backoff = RECONNECT_MIN_MS;
        while !self.stopping.load(Ordering::Relaxed) {
            let now = now_ms();
            let free: Vec<HubLane> = self
                .lanes
                .read()
                .unwrap()
                .values()
                .map(|lane| HubLane { cid: lane.cid(), free: lane.free(now) })
                .filter(|entry| entry.free > 0)
                .collect();
            if free.is_empty() {
                // 所有通道都满了或都在排空：别去长轮询，白占一条连接。
                self.wait(1_000).await;
                continue;
            }
            match self.client.next(&free, self.settings.next_wait_sec, &self.loop_cancel).await {
                Ok(claimed) => {
                    backoff = RECONNECT_MIN_MS;
                    let Some(claimed) = claimed else { continue };
                    for unit_id in &claimed.cancel {
                        if let Some(cancel) = self.aborts.lock().unwrap().get(unit_id) {
                            cancel.cancel(crate::core::errors::http_error(499, "hub_cancelled", "hub_cancelled"));
                        }
                    }
                    if self.stopping.load(Ordering::Relaxed) {
                        return;
                    }
                    if claimed.unit.id.is_empty() {
                        continue;
                    }
                    let inner = Arc::clone(&self);
                    tokio::spawn(async move { inner.dispatch(claimed).await });
                }
                Err(failure) => {
                    if self.stopping.load(Ordering::Relaxed) {
                        return;
                    }
                    log_warn!("pool_next_failed", "message": failure.message(), "retryInMs": backoff);
                    let jitter = (now_ms() % 500) as u64;
                    self.wait(backoff + jitter).await;
                    backoff = (backoff * 2).min(RECONNECT_MAX_MS);
                }
            }
        }
    }

    /// resolveLane 是节点侧的白名单自校验（原则 8）。Hub 是路由权威，
    /// 但「在我的机器上执行什么」这条边界不信任 Hub。
    fn resolve_lane(&self, unit: &WorkUnit) -> Option<Arc<Lane>> {
        for lane in self.lanes.read().unwrap().values() {
            let config = lane.config();
            if config.kind != unit.kind || config.kind_version != unit.kind_version {
                continue;
            }
            if config.provider != unit.provider {
                continue;
            }
            if let Some(model) = &unit.model {
                if !model_match(model, &config.models_allow, &config.models_deny) {
                    continue;
                }
            }
            return Some(Arc::clone(lane));
        }
        None
    }

    /// 跑一个工作单元。首字节之前失败可以被 Hub 改派，
    /// 之后失败只能 502 —— 已经流出去的字节收不回来（设计文档 6.2）。
    async fn dispatch(self: Arc<Self>, claimed: NextResult) {
        let unit = claimed.unit.clone();
        let lease = claimed.lease.token.clone();
        let Some(lane) = self.resolve_lane(&unit) else {
            self.client.complete(&unit.id, &CompleteBody {
                lease, state: "failed".into(),
                error: Some(UnitError { class: ErrorClass::NodeFault, code: "capability_mismatch".into(),
                    retryable: true, message: "单元不在本机任何贡献的申报范围内".into() }),
                ..Default::default()
            }).await;
            return;
        };
        if !lane.acquire(&unit.consumer_key) {
            self.client.complete(&unit.id, &CompleteBody {
                lease, state: "failed".into(),
                error: Some(UnitError { class: ErrorClass::NodeFault, code: "capability_mismatch".into(),
                    retryable: true, message: "通道已满".into() }),
                ..Default::default()
            }).await;
            return;
        }

        let cancel = self.loop_cancel.child();
        self.aborts.lock().unwrap().insert(unit.id.clone(), cancel.clone());
        let started = Instant::now();
        // 每个单元一个临时目录，结束后整个删掉：消费者的素材不该在主人机器上留过夜（约束 4）。
        let work_dir = std::env::temp_dir().join("ai-bridge-unit").join(&unit.id);
        // 续租心跳：job 可以跑两小时，租约只有 60 秒。不续的话 Hub 会判它跑丢了，
        // 把同一个任务派给另一台机器重跑一遍。
        let renew_every = Duration::from_millis(
            (claimed.lease.renew_sec.unwrap_or(60) * 500).max(15_000),
        );
        let renew = {
            let client = Arc::clone(&self.client);
            let cancel = cancel.clone();
            let unit_id = unit.id.clone();
            let lease = claimed.lease.token.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => return,
                        () = tokio::time::sleep(renew_every) => {}
                    }
                    match client.progress(&unit_id, &lease, None, true).await {
                        // 取消搭在续租的响应里回来，不单独轮询（T-05）。
                        Ok(true) => cancel.cancel(crate::core::errors::http_error(499, "hub_cancelled", "hub_cancelled")),
                        Ok(false) => {}
                        Err(message) => log_debug!("pool_renew_failed", "unitId": unit_id, "message": message),
                    }
                }
            })
        };

        self.run_unit(&claimed, &lane, cancel.clone(), work_dir.clone(), started).await;

        renew.abort();
        self.aborts.lock().unwrap().remove(&unit.id);
        lane.release(&unit.consumer_key);
        // 清场：本机不留消费者内容。删不掉只记日志，不影响这个单元已经报出去的终态。
        if let Err(e) = tokio::fs::remove_dir_all(&work_dir).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                log_warn!("pool_workdir_cleanup_failed", "unitId": unit.id, "message": e.to_string());
            }
        }
        // 日志只记 requestId / cid，不记内容也不记消费者身份。
        log_info!("pool_unit_done", "unitId": unit.id, "cid": lane.cid(),
            "ms": started.elapsed().as_millis() as u64);
    }

    async fn run_unit(
        &self,
        claimed: &NextResult,
        lane: &Arc<Lane>,
        cancel: Cancel,
        work_dir: std::path::PathBuf,
        started: Instant,
    ) {
        let unit = claimed.unit.clone();
        let lease = claimed.lease.token.clone();
        let callbacks: Arc<dyn UnitCallbacks> = Arc::new(HubCallbacks {
            client: Arc::clone(&self.client),
            lease: lease.clone(),
        });
        let io = UnitIo {
            cancel: cancel.clone(),
            work_dir: Some(work_dir),
            unit_id: unit.id.clone(),
            cid: lane.cid(),
            callbacks: Some(callbacks),
        };
        let mut events = lane.provider.run(unit.clone(), io);
        let outcome = Arc::new(Mutex::new(Outcome::default()));

        // 先等到 head：上行连接的状态码与响应头要在建连时就带上。
        let mut head: Option<(u16, std::collections::BTreeMap<String, String>)> = None;
        while let Some(event) = events.next().await {
            match event {
                UnitEvent::Head { status, headers } => {
                    if status == 429 {
                        lane.throttle(headers.get("retry-after").map(String::as_str), now_ms());
                    }
                    if status >= 400 {
                        log_warn!("pool_upstream_rejected",
                            "unitId": unit.id, "cid": lane.cid(), "status": status,
                            "requestId": headers.get("request-id"),
                            "retryAfter": headers.get("retry-after"),
                            "throttledUntil": lane.throttled_until_ms().and_then(iso_from_ms));
                    }
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

        let ms = started.elapsed().as_millis() as u64;
        // 锁不能跨 await：先把值取出来再走网络。
        let early_failure = outcome.lock().unwrap().failure.clone();
        if let Some(failure) = early_failure {
            let state = if failure.code == "unit_cancelled" { "cancelled" } else { "failed" };
            self.client.complete(&unit.id, &CompleteBody {
                lease, state: state.into(), error: Some(failure), ms: Some(ms), ..Default::default()
            }).await;
            return;
        }
        let Some((status, headers)) = head else {
            let terminal = outcome.lock().unwrap().terminal();
            self.client.complete(&unit.id, &CompleteBody {
                lease, state: "completed".into(), ms: Some(ms), ..terminal
            }).await;
            return;
        };

        // 剩下的事件就是响应字节。边收边推，背压顺着这条连接顶回上游。
        let body = {
            let outcome = Arc::clone(&outcome);
            Box::pin(stream! {
                while let Some(event) = events.next().await {
                    match event {
                        UnitEvent::Chunk(bytes) => yield Ok::<Bytes, std::io::Error>(bytes),
                        UnitEvent::Done(done) => { outcome.lock().unwrap().done = Some(*done); return; }
                        UnitEvent::Error(error) => { outcome.lock().unwrap().failure = Some(error); return; }
                        UnitEvent::Head { .. } => {}
                    }
                }
            })
        };
        let result = self.client.stream(&claimed.stream_url, status, &headers, &lease, body).await;
        let ms = started.elapsed().as_millis() as u64;

        if result.consumer_gone {
            // 410：消费者走了，立刻 abort 上游，不再烧主人的额度。
            cancel.cancel(crate::core::errors::http_error(499, "consumer_gone", "consumer_gone"));
            let usage = outcome.lock().unwrap().usage();
            self.client.complete(&unit.id, &CompleteBody {
                lease, state: "cancelled".into(), usage: Some(usage), ms: Some(ms), ..Default::default()
            }).await;
            return;
        }
        let (failure, terminal) = {
            let guard = outcome.lock().unwrap();
            (guard.failure.clone(), guard.terminal())
        };
        match failure {
            Some(failure) => {
                self.client.complete(&unit.id, &CompleteBody {
                    lease, state: "failed".into(), error: Some(failure), ms: Some(ms), ..terminal
                }).await;
            }
            None => {
                self.client.complete(&unit.id, &CompleteBody {
                    lease, state: "completed".into(), ms: Some(ms), ..terminal
                }).await;
            }
        }
    }
}

struct HubCallbacks {
    client: Arc<HubClient>,
    lease: String,
}

#[async_trait::async_trait]
impl UnitCallbacks for HubCallbacks {
    async fn sign_artifact(&self, unit_id: &str, name: &str, content_type: &str, size: u64)
        -> Result<ArtifactRef, String> {
        self.client.sign_artifact(unit_id, name, content_type, size).await
    }
    async fn progress(&self, unit_id: &str, pct: f64, stage: &str, preview: Option<ArtifactRef>)
        -> Result<bool, String> {
        let progress = json!({ "pct": pct, "stage": stage, "previewRef": preview });
        self.client.progress(unit_id, &self.lease, Some(progress), true).await
    }
}

/// 收集一次执行的终态：用量、上下文增量、产物引用。
#[derive(Default)]
struct Outcome {
    done: Option<DoneEvent>,
    failure: Option<UnitError>,
}

impl Outcome {
    fn usage(&self) -> Metering {
        self.done.as_ref().map(|done| done.usage.clone()).unwrap_or_default()
    }
    /// 终态里除状态之外的东西：用量、session 的上下文增量、job 的产物引用。
    fn terminal(&self) -> CompleteBody {
        match &self.done {
            Some(done) => CompleteBody {
                usage: Some(done.usage.clone()),
                context_delta: done.context_delta.clone(),
                workspace_ref: done.workspace_ref.clone(),
                checkpoint_ref: done.checkpoint_ref.clone(),
                outputs: done.outputs.clone(),
                ..Default::default()
            },
            None => CompleteBody { usage: Some(Metering::new()), ..Default::default() },
        }
    }
}

/// 把一条探测结果映射成「本机怎么跑它」。
///
/// cid 用配置键（中转类）或模块名（本机执行类）：它要在这台机器上唯一，
/// 而且要能在控制台上被主人认出来。
///
/// kindVersion 固定 1：适配器目前都是 v1，探测结果里没有这一项。
fn local_capability(capability: &super::probe::Capability, cfg: &AppConfig) -> Option<LocalCapability> {
    match capability.kind.as_str() {
        "llm.chat" => {
            let upstream = capability.upstream.as_ref()?;
            if !cfg.providers.contains_key(upstream) {
                return None;
            }
            Some(LocalCapability {
                cid: upstream.clone(),
                kind: capability.kind.clone(),
                kind_version: 1,
                route_key: capability.provider.clone(),
                build: CapabilityBuild::Relay { config_key: upstream.clone() },
            })
        }
        "video.edit.render" => Some(LocalCapability {
            cid: capability.provider.clone(),
            kind: capability.kind.clone(),
            kind_version: 1,
            route_key: capability.provider.clone(),
            build: CapabilityBuild::Ffmpeg,
        }),
        // delivery.task 不在这里：它的执行器是主人自己写的命令，探测不出来。
        _ => None,
    }
}

fn lane_config(want: &EnabledContribution) -> LaneConfig {
    LaneConfig {
        id: want.cid.clone(),
        kind: want.kind.clone(),
        kind_version: want.kind_version,
        provider: want.provider.clone(),
        seats: want.seats,
        seat_concurrency: want.seat_concurrency,
        models_allow: want.models_allow.clone(),
        models_deny: want.models_deny.clone(),
    }
}

/// 能力健康的指纹：cid + 可用与否 + 原因。任何一项变化都值得重发一次 hello。
///
/// 原因也参与比较：同一个 cid 从「登录态缺失」变成「登录态已过期」，对主人是
/// 不同的处置建议，界面上那句话必须跟着变。
pub fn health_signature(reports: &[CapabilityReport]) -> String {
    let mut rows: Vec<String> = reports
        .iter()
        .map(|r| format!("{}:{}:{}", r.cid, u8::from(r.available), r.unavailable_reason.clone().unwrap_or_default()))
        .collect();
    rows.sort();
    rows.join("|")
}

pub fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

fn iso_from_ms(ms: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// 未用到的执行器：主人用 exec 显式配置的 agent 回合能力由这里建。
/// 探测探不出它（命令是主人自己写的），所以只在 Hub 明确下发时才会走到。
pub fn planner_provider(name: &str, exec: crate::config::schema::PoolExec) -> Arc<dyn Provider> {
    Arc::new(PlannerBridgeProvider::new(name, exec))
}
