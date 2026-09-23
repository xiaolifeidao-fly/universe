use super::client::{
    AccessDeclaration, CapabilityReport, CompleteBody, EnabledContribution, HeartbeatLane, HubClient,
    HubFailure, HubLane, InstallInfo, LeaseState, LoginCommand, NextResult, ToolCommand,
};
use super::export::{normalize_public_url, resolve_secret, ExportServer};
use super::hub_address::HubAddressCheck;
use super::lane::{Lane, LaneConfig};
use super::login::{any_login_active, login_report, start_login, submit_code};
use super::machine::machine_fingerprint;
use super::models::list_models;
use super::probe::probe;
use super::token::{fingerprint, read_node_identity, resolve_node_token_file, NodeIdentity};
use super::tools::{any_job_running, external_tool_statuses, run_tool_job, tool_job, ToolStatus};
use super::upgrade::{compare_versions, current_platform, UpgradeCommand, UpgradeState, Updater, Version};
use crate::business::llm_chat::{probe_credentials, RelayProvider};
use crate::business::video_edit::FfmpegLocalProvider;
use crate::business::{
    group_joined, local_resources, ArtifactRef, DoneEvent, ErrorClass, Metering, Provider,
    UnitCallbacks, UnitError, UnitEvent, UnitIo, WorkUnit,
};
use crate::config::schema::{AccessMode, AppConfig, AuthMode, PoolConfig, PoolExportConfig, ProviderConfig};
use crate::core::paths::Env;
use crate::core::request::Cancel;
use crate::credentials::CredentialRegistry;
use crate::pool::usage::{UpstreamUsage, UsageSnapshot};
use crate::pool::usage_probe;
use crate::{log_debug, log_error, log_info, log_warn};
use async_stream::stream;
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

// pool 模式的运行循环。
//
// poll 接入时进程不 listen 任何端口（P-15）：主循环是「长轮询领活 → 跑 provider → 上行推流 → 报终态」，
// 心跳线程每 15s 一次，取消信号搭在这两条已有链路上，不单独轮询（T-05）。
// export 接入时不跑长轮询，活由 Hub 推到 pool/export.rs 那扇门上；其余循环完全一样。

const RECONNECT_MIN_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

/// 停机时给 Hub 报在跑单元的总时限。
///
/// 这条上报是「顺手告诉一声」，不是退出的前提：Hub 连不上、网络已经断了的时候
/// 它注定送不出去，那种情况下卡住退出流程只会让用户觉得应用关不掉。
/// 说不出去就让 Hub 的等待时限去兜底，晚几十秒，但不会错。
const SHUTDOWN_REPORT_TIMEOUT: Duration = Duration::from_secs(3);

/// 重探本机能力的间隔。
///
/// 能力可用性只在 hello 时上报，而 hello 只在启动/重连时发生 —— 于是「运行中
/// 登录态过期」和「运行中登录回来」这两件事 Hub 都看不见。这个循环把两边都补上：
/// 探到变化就主动重发一次 hello。60 秒是折中 —— 探测要读 Keychain，不是白拿的，
/// 但恢复延迟也不该长到让人以为没生效。
const HEALTH_PROBE_MS: u64 = 60_000;

/// 问上游订阅余量的间隔。
///
/// 比心跳（15 秒）慢得多是故意的：这件事要起子进程，而那个数在五分钟里变不出花来。
const USAGE_PROBE_INTERVAL_MS: u64 = 5 * 60_000;

/// 问本机工具（claude / codex）版本的间隔。
///
/// 同样比心跳慢：问版本要起一次 node，查最新版还要走网络。一分钟一次够了 ——
/// 这两个数只在有人装了什么之后才变，而装完那一下会自己把缓存清掉。
const TOOLS_PROBE_INTERVAL_MS: u64 = 60_000;

/// 头一次探工具之前先等多久。同上：起子进程要避开启动那一阵。
const TOOLS_PROBE_DELAY_MS: u64 = 15_000;

/// 有工具正在装时的心跳间隔上限。
///
/// 远端那台的进度条也是从心跳里来的：15 秒一跳的话，界面上那个数一分钟只动四次，
/// 看着像卡住了。只在装东西的那几十秒里提速，平时照旧。
const TOOL_JOB_BEAT_MS: u64 = 5_000;

/// 没有 updater 时（随 Nova 分发）对升级指令的回答。契约 3.4 第 2 条的原话，控制台原样显示。
const NO_UPDATER_MESSAGE: &str = "这台机器的 ai-bridge 随 Nova 应用分发，不能远程升级，请更新 Nova";

/// 建 runner 时的可选项。默认值（distribution 空串、没有 updater）就是老行为。
#[derive(Clone, Default)]
pub struct RunnerOptions {
    /// hello 里报的分发方式：`cli`（独立部署，能自升级）/ `nova`（随 Nova 分发）。
    pub distribution: String,
    /// 远程升级用的升级器。None 表示这份 ai-bridge 不能自己换自己，收到指令只报 failed。
    ///
    /// **给了 updater 的调用方必须等 `restart_requested()`**：升级装好之后 runner 会停止领新活、
    /// 等着被重启。没人接这一棒的话，这台机器会一直挂着不干活。
    pub updater: Option<Arc<dyn Updater>>,
}

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
    /// export 接入时对外的那扇门。poll 接入时是 None —— 那种机器一个端口都不开。
    export: tokio::sync::Mutex<Option<ExportServer>>,
}

pub(crate) struct RunnerInner {
    cfg: AppConfig,
    settings: PoolConfig,
    pub(crate) identity: NodeIdentity,
    bridge_version: String,
    pub(crate) client: Arc<HubClient>,
    credentials: Arc<CredentialRegistry>,
    http: reqwest::Client,
    env: Env,
    /// 上游订阅此刻还剩多少（Claude / Codex 各一份）。
    ///
    /// 由中转请求的响应头顺手填，心跳读它报给 Hub。挂在 runner 上而不是通道上：
    /// 一个上游可能对应多条通道，而余量是**账号**的属性，不是通道的。
    pub(crate) upstream_usage: Arc<UpstreamUsage>,
    // 通道是**跟着 Hub 下发的集合动态增删的**，不是启动时按本地配置建好的。
    pub(crate) lanes: RwLock<HashMap<String, Arc<Lane>>>,
    // inventory 是本机探测到的能力，cid → 建 provider 需要的本地信息。
    // 它决定「能不能建这条通道」，Hub 决定「要不要建」。
    inventory: RwLock<HashMap<String, LocalCapability>>,
    // 在跑的单元。除了 cancel 句柄还要留着租约 —— 停机时得拿它给 Hub 报终态，
    // 没有租约那条 complete 会被当成冒领挡掉。
    aborts: Mutex<HashMap<String, Inflight>>,
    pub(crate) stopping: AtomicBool,
    loop_cancel: Cancel,
    hub_address: Mutex<HubAddressCheck>,
    last_health: Mutex<String>,
    /// 这台机器怎么接进池子：poll 自己去领活，export 等 Hub 敲门。
    ///
    /// 它在 create_pool_runner 里就定死了，运行期不变 —— 中途换接入方式意味着
    /// 要把监听、hello 声明、领活循环全部重来一遍，那还不如让进程重启一次。
    access: AccessDeclaration,
    export_config: Option<PoolExportConfig>,
    /// Hub 在 hello 里回的接入方式结论。老版本 Hub 不回，是 None。
    hub_access: Mutex<Option<String>>,
    /// 设备指纹，主人是工作室时 Hub 按它记信誉。启动时算一次：机器 id 运行期不会变。
    machine_fingerprint: Option<String>,
    /// cli / nova，hello 里原样报。
    distribution: String,
    updater: Option<Arc<dyn Updater>>,
    upgrade_gate: Mutex<UpgradeGate>,
    /// 本机那两个外部工具最近一次探到的版本。心跳读它，后台探针写它 ——
    /// 探一次要起子进程、还要问 npm 要最新版，摆进心跳循环里就是让心跳陪着等。
    tool_snapshot: Mutex<Vec<ToolStatus>>,
    /// 接手过的工具指令 id。Hub 在看到机器开工之前每次心跳都重发同一条。
    tool_seen: Mutex<HashSet<String>>,
    /// 接手过的登录指令。键里带着码本身，不只是 id —— 见 accept_login_command。
    login_seen: Mutex<HashSet<String>>,
    /// 新版本已经装好，正在为重启排空：不领新活、心跳把通道报成 paused、export 入口回 503。
    ///
    /// 和 stopping 分开：排空期间心跳、续租、终态上报都要照常走，在跑的单元得好好跑完 ——
    /// stopping 会把这些一起掐掉。
    restart_draining: AtomicBool,
    /// 「可以重启了」。watch 而不是 Notify：进程主人什么时候开始等都拿得到这个结果，
    /// 不会因为通知发在它开始等之前就错过。
    restart: tokio::sync::watch::Sender<bool>,
}

/// 升级指令的去重与互斥（契约 3.4 第 1 条）。
#[derive(Default)]
struct UpgradeGate {
    /// 接手过的指令 id。Hub 在收到 downloading 之前每次心跳都重发同一条，
    /// 不按 id 去重的话，一次升级会被下载十几遍。
    seen: HashSet<String>,
    /// 有一次升级在跑，或者已经装好在等重启。这期间新来的指令一律不接 ——
    /// 不记进 seen，等这一次失败结束后 Hub 再发来时照常处理。
    busy: bool,
}

/// 一次升级在节点这边怎么收场。
enum UpgradeEnd {
    /// 本机已经是目标版本，报 succeeded。
    AlreadyCurrent,
    /// 新版本已经换上，等进程主人重启。
    Installed,
}

/// 一个正在本机跑的单元。
#[derive(Clone)]
struct Inflight {
    cancel: Cancel,
    lease: String,
}

/// 一个单元占住的执行位。由 begin_unit 交出，必须交回 finish_unit ——
/// 丢掉它等于让那条通道永久少一个并发。
pub(crate) struct UnitSlot {
    pub(crate) lane: Arc<Lane>,
    pub(crate) cancel: Cancel,
    pub(crate) work_dir: std::path::PathBuf,
    pub(crate) started: Instant,
    renew: tokio::task::JoinHandle<()>,
    unit_id: String,
    consumer_key: String,
}

pub async fn create_pool_runner(
    cfg: AppConfig,
    env: Env,
    bridge_version: String,
    http: reqwest::Client,
) -> Result<PoolRunner, String> {
    create_pool_runner_with(cfg, env, bridge_version, http, RunnerOptions::default()).await
}

pub async fn create_pool_runner_with(
    cfg: AppConfig,
    env: Env,
    bridge_version: String,
    http: reqwest::Client,
    options: RunnerOptions,
) -> Result<PoolRunner, String> {
    let settings = cfg.pool.clone().ok_or("mode=pool 但缺少 pool 配置段")?;
    let token_file = resolve_node_token_file(Some(&settings), &env);
    let identity = read_node_identity(&token_file)
        .await?
        .ok_or("还没有配对过。先在控制台生成配对码，再重新配对这台机器")?;
    // 兜底 id 和令牌放在一起：同一份安装里重新配对，令牌换了，这个文件还在。
    let machine = token_file.parent().and_then(machine_fingerprint);
    let client = Arc::new(HubClient::new(
        settings.hub_url.clone(),
        settings.contract,
        Some(identity.token.clone()),
        Some(identity.node_id.clone()),
        http.clone(),
    ));
    let hub_address = HubAddressCheck::new(settings.hub_url.clone());
    let export_config = settings.export.clone();
    let access = resolve_access(&settings, export_config.as_ref(), &env).await;
    Ok(PoolRunner {
        inner: Arc::new(RunnerInner {
            credentials: Arc::new(CredentialRegistry::new(http.clone())),
            upstream_usage: Arc::new(UpstreamUsage::new()),
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
            access,
            export_config,
            hub_access: Mutex::new(None),
            machine_fingerprint: machine,
            distribution: options.distribution,
            updater: options.updater,
            upgrade_gate: Mutex::new(UpgradeGate::default()),
            tool_snapshot: Mutex::new(Vec::new()),
            tool_seen: Mutex::new(HashSet::new()),
            login_seen: Mutex::new(HashSet::new()),
            restart_draining: AtomicBool::new(false),
            restart: tokio::sync::watch::Sender::new(false),
        }),
        tasks: Mutex::new(vec![]),
        export: tokio::sync::Mutex::new(None),
    })
}

/// 把配置里的接入方式解析成一次可以发给 Hub 的声明。
///
/// **任何一步不成立都回落到 poll**，只留一条警告，不让进程起不来。理由是那两条
/// 路的差别只是「活是谁送来的」—— 一台配错了 export 的机器仍然能靠长轮询好好干活，
/// 而直接拒绝启动会把一个填错的地址变成「整台机器下线」。
///
/// 回落必须**说出来**：静默降级的表现是主人在控制台看到接入方式写着 poll，
/// 而他明明配的是 export，然后完全不知道该去哪儿找原因。
pub async fn resolve_access(
    settings: &PoolConfig,
    export: Option<&PoolExportConfig>,
    env: &Env,
) -> AccessDeclaration {
    if settings.access_mode != AccessMode::Export {
        return AccessDeclaration::poll();
    }
    let Some(export) = export else {
        log_warn!("pool_export_fallback",
            "reason": "accessMode=export 但缺少 pool.export 配置段",
            "hint": "补上 pool.export.publicURL，或把 accessMode 改回 poll");
        return AccessDeclaration::poll();
    };
    let url = match export.public_url.as_deref().map(normalize_public_url) {
        Some(Ok(url)) => url,
        Some(Err(message)) => {
            log_warn!("pool_export_fallback", "reason": message,
                "hint": "已按 poll 方式接入，这台机器照样能领活，只是慢一点");
            return AccessDeclaration::poll();
        }
        None => {
            log_warn!("pool_export_fallback",
                "reason": "pool.export.publicURL 没填：Hub 要靠它才能回连这台机器",
                "hint": "已按 poll 方式接入，这台机器照样能领活，只是慢一点");
            return AccessDeclaration::poll();
        }
    };
    match resolve_secret(Some(export), env).await {
        Ok(secret) => AccessDeclaration::export(url, secret),
        Err(message) => {
            log_warn!("pool_export_fallback", "reason": message,
                "hint": "已按 poll 方式接入");
            AccessDeclaration::poll()
        }
    }
}

impl PoolRunner {
    pub async fn start(&self) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        // 先开门，再 hello。顺序不能反：hello 里就把公网地址交给 Hub 了，
        // 而 Hub 收到之后可能立刻探一次健康 —— 那时候端口还没监听，
        // 主人在控制台上看到的第一眼就是一个红色的「连不上」。
        if inner.is_export() {
            self.start_export().await?;
        }
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
        // export 接入不跑领活循环：活由 Hub 推进来（见 pool/export.rs）。
        // 两条都跑会让同一台机器既被推、又去抢，队列里的单元有一半被自己抢走 ——
        // 那不算错，但白白多出一条长轮询连接，也让「这台机器到底走哪条路」
        // 在日志里再也看不清。
        // 例外是 Hub 把 export 回落成了 poll：那时候不会有人来敲门，必须自己去领。
        if !inner.is_export() || inner.hub_downgraded() {
            tasks.push(tokio::spawn(Arc::clone(&inner).next_loop()));
        }
        tasks.push(tokio::spawn(Arc::clone(&inner).health_loop()));
        tasks.push(tokio::spawn(Arc::clone(&inner).usage_probe_loop()));
        tasks.push(tokio::spawn(Arc::clone(&inner).tools_probe_loop()));
        let lanes: Vec<String> = inner.lanes.read().unwrap().keys().cloned().collect();
        log_info!("pool_started", "nodeId": inner.identity.node_id, "lanes": lanes,
            "accessMode": inner.access.mode);
        Ok(())
    }

    /// 起 export 的监听。失败就是启动失败 —— 端口占用时回落成 poll 会让主人
    /// 以为一切正常，而 Hub 那边永远回连不上（它拿到的地址是通的，只是后面
    /// 没人应答）。这种「两边都觉得自己对」的状态必须在这里就断掉。
    async fn start_export(&self) -> Result<(), String> {
        let config = self.inner.export_config.clone().unwrap_or_default();
        let secret = self
            .inner
            .access
            .endpoint
            .as_ref()
            .map(|endpoint| endpoint.secret.clone())
            .ok_or("accessMode=export 但没有可用的回连密钥")?;
        let mut server = ExportServer::new(
            Arc::clone(&self.inner),
            secret,
            self.inner.identity.node_id.clone(),
            self.inner.bridge_version.clone(),
        );
        let addr = server.listen(&config).await?;
        *self.export.lock().await = Some(server);
        log_info!("pool_export_listen",
            "host": config.host, "port": addr.port(),
            "publicURL": self.inner.access.endpoint.as_ref().map(|e| e.url.clone()));
        Ok(())
    }

    pub async fn stop(&self) {
        self.inner.stopping.store(true, Ordering::Relaxed);
        self.inner.loop_cancel.cancel(crate::core::errors::http_error(503, "shutdown", "shutdown"));

        // 先把在跑的单元连锅端下来，再回报 Hub。
        //
        // 这一步不能省。消费者的连接挂在 Hub 那一侧等我们回传，而关掉进程
        // 既不会给上行连接一个 EOF，也不会有谁替我们报终态 —— Hub 只能等它自己
        // 的时限到点，那期间对面的 SDK 就是在干转。主动说一声「我下班了」，
        // Hub 立刻就能把这次请求改派给别的机器，用户那边毫无感知。
        //
        // retryable 给 true：首字节之前 Hub 会改派，之后它自己知道不能改。
        let inflight: Vec<(String, Inflight)> = self
            .inner
            .aborts
            .lock()
            .unwrap()
            .iter()
            .map(|(unit_id, entry)| (unit_id.clone(), entry.clone()))
            .collect();
        for (_, entry) in &inflight {
            entry.cancel.cancel(crate::core::errors::http_error(503, "shutdown", "shutdown"));
        }
        if !inflight.is_empty() {
            // complete 走的是普通请求，不挂在 loop_cancel 上，上面那一刀不会把它一起废掉。
            // 整批给一个总时限：Hub 连不上的时候不能让退出流程卡在这里，
            // 那种情况下反正也说不出去，交给 Hub 的时限兜底。
            let report = futures_util::future::join_all(inflight.iter().map(|(unit_id, entry)| {
                let client = Arc::clone(&self.inner.client);
                let unit_id = unit_id.clone();
                let lease = entry.lease.clone();
                async move {
                    client
                        .complete(&unit_id, &CompleteBody {
                            lease,
                            state: "failed".into(),
                            error: Some(UnitError {
                                class: ErrorClass::NodeFault,
                                code: "node_shutdown".into(),
                                retryable: true,
                                message: "节点正在退出".into(),
                            }),
                            ..Default::default()
                        })
                        .await
                }
            }));
            if tokio::time::timeout(SHUTDOWN_REPORT_TIMEOUT, report).await.is_err() {
                log_warn!("pool_shutdown_report_timeout", "units": inflight.len() as u64);
            } else {
                log_info!("pool_shutdown_reported", "units": inflight.len() as u64);
            }
        }

        let handles: Vec<_> = self.tasks.lock().unwrap().drain(..).collect();
        for handle in handles {
            handle.abort();
        }
        // 门最后关：上面那批 complete 已经报完，这时候再有人敲门也只会拿到
        // 503 node_stopping，Hub 立刻改派 —— 比让它等一个超时好。
        if let Some(mut server) = self.export.lock().await.take() {
            server.close().await;
        }
        log_info!("pool_stopped");
    }

    pub fn lane_ids(&self) -> Vec<String> {
        self.inner.lanes.read().unwrap().keys().cloned().collect()
    }

    /// export 那扇门实际监听在哪。poll 接入时是 None。
    ///
    /// 端口可以配成 0（测试里就是），所以真实地址只有 listen 之后才知道 ——
    /// 调用方要展示「Hub 该往哪儿连」时必须读这个，不能拿配置里那个值。
    pub async fn export_addr(&self) -> Option<std::net::SocketAddr> {
        self.export.lock().await.as_ref().and_then(|server| server.addr)
    }

    /// 这台机器最终按哪种方式接入。配置写了 export 但回落成 poll 时，
    /// 这里报的是**回落之后**的那个 —— 界面要显示的是事实，不是意图。
    pub fn access_mode(&self) -> &str {
        &self.inner.access.mode
    }

    /// 各上游订阅此刻还剩多少，按路由键（claude_oauth / codex_chatgpt）。
    ///
    /// 只反映**这台机器**看到的 —— 数据是从它自己发出去的那些中转请求的响应头里
    /// 捎回来的。一次都没跑过就是空的，界面要区分「空」和「0」。
    pub fn upstream_usage(&self) -> BTreeMap<String, UsageSnapshot> {
        self.inner.upstream_usage.all()
    }

    /// export 对外声明的公网地址。poll 接入时是 None。
    pub fn public_url(&self) -> Option<String> {
        self.inner.access.endpoint.as_ref().map(|endpoint| endpoint.url.clone())
    }

    /// 远程升级把新版本装好、要求重启时返回。没有升级就一直挂着。
    ///
    /// runner 自己不重启：换进程是进程主人的事（它还得先排空、再 stop），
    /// 这里只负责把「可以重启了」这一棒交出去。
    pub async fn restart_requested(&self) {
        let mut receiver = self.inner.restart.subscribe();
        // 发送端和 runner 同寿，wait_for 只会因为值变成 true 而返回。
        let _ = receiver.wait_for(|requested| *requested).await;
    }

    /// 为重启排空：不再接新活，等在跑的单元跑完，最多等 timeout。返回到点时还剩几个没跑完。
    ///
    /// 停止接活分三处落实 —— 长轮询不再去领；心跳把每条通道报成 paused，Hub 不再往这台机器派；
    /// export 入口回 503 node_stopping，Hub 立刻改派。在跑的单元不受影响，续租、上行、终态照常。
    /// 剩下没跑完的，由接下来的 stop() 按 node_shutdown 报给 Hub 改派。
    pub async fn drain_for_restart(&self, timeout: Duration) -> usize {
        self.inner.restart_draining.store(true, Ordering::Relaxed);
        let started = Instant::now();
        let initial = self.inner.inflight_units();
        if initial > 0 {
            log_info!("pool_restart_draining", "units": initial as u64, "timeoutMs": timeout.as_millis() as u64);
        }
        loop {
            let running = self.inner.inflight_units();
            if running == 0 {
                if initial > 0 {
                    log_info!("pool_restart_drained", "ms": started.elapsed().as_millis() as u64);
                }
                return 0;
            }
            if started.elapsed() >= timeout {
                log_warn!("pool_restart_drain_timeout", "units": running as u64,
                    "hint": "等不完了，剩下的在停机时报给平台改派");
                return running;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

fn is_token_rejection(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("令牌无效") || message.contains("未授权") || message.contains("已撤销")
        || lower.contains("revoked") || lower.contains("unauthorized")
}

impl RunnerInner {
    pub(crate) fn is_export(&self) -> bool {
        self.access.endpoint.is_some()
    }

    /// 本机声明了 export，Hub 却按 poll 接入了这台机器。
    fn hub_downgraded(&self) -> bool {
        self.is_export() && self.hub_access.lock().unwrap().as_deref() == Some("poll")
    }

    /// 新版本已装好、正在为重启排空。
    pub(crate) fn draining_for_restart(&self) -> bool {
        self.restart_draining.load(Ordering::Relaxed)
    }

    /// 在本机跑着的单元数。和 stop() 报给 Hub 的是同一份登记。
    fn inflight_units(&self) -> usize {
        self.aborts.lock().unwrap().len()
    }

    /// hello 里的 platform / distribution / upgradeBlocker。blocker 每次现问：
    /// 主人把目录权限改对之后，下一次 hello 控制台上的升级按钮就该亮。
    fn install_info(&self) -> InstallInfo {
        InstallInfo {
            platform: current_platform().unwrap_or_default().to_string(),
            distribution: self.distribution.clone(),
            upgrade_blocker: self.updater.as_ref().and_then(|updater| updater.blocker()).unwrap_or_default(),
        }
    }

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
            let Some(provider) = self.build_provider(&local) else {
                // 探到了能力却建不出 provider，只可能是 providers: 里没有它引用的那一项。
                // 这里从前是静默 continue —— 于是通道数为 0，日志里却没有任何一条说得清
                // 是哪条贡献、为什么。排查只能靠猜。
                log_warn!("pool_provider_unavailable", "cid": cid, "kind": want.kind,
                    "hint": "本机探到了这个能力，但配置里找不到它要用的 providers 项，通道没建起来");
                continue;
            };
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
            .hello(
                &self.bridge_version,
                &resources,
                &reports,
                &self.access,
                self.machine_fingerprint.as_deref(),
                &self.install_info(),
                &self.loop_cancel,
            )
            .await?;
        for rejected in &result.rejected {
            log_error!("pool_capability_rejected", "cid": rejected.cid, "reason": rejected.reason);
        }
        self.apply_enabled(result.enabled.as_deref());
        if let Some(mode) = result.access_mode.as_deref() {
            *self.hub_access.lock().unwrap() = Some(mode.to_string());
            if mode == "poll" && self.is_export() {
                log_warn!("pool_export_downgraded",
                    "publicURL": self.access.endpoint.as_ref().map(|e| e.url.clone()),
                    "hint": "平台没有接受这台机器的回连信息，按 poll 接入；本机同时去长轮询领活，活不会掉在地上");
            }
        }
        *self.last_health.lock().unwrap() = health_signature(&reports);
        let lanes = self.lanes.read().unwrap().len();
        log_info!("pool_hello",
            "nodeId": self.identity.node_id, "token": fingerprint(&self.identity.token),
            "probed": reports.len(), "enabled": lanes, "hub": self.settings.hub_url,
            "accessMode": self.access.mode,
            "endpoint": self.access.endpoint.as_ref().map(|e| e.url.clone()));
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

    /// 定时问本机的 claude / codex：那个账号此刻还剩多少。
    ///
    /// 五分钟一次，而不是跟着心跳（15 秒）：这两条都要起子进程，claude 那条还要
    /// 起一个完整的 Claude Code 进程。十几秒一次地起进程，对一台正在给别人干活的
    /// 机器是实打实的打扰，而这个数本来也不会在五分钟里变出花来。
    ///
    /// 只探**这台机器真的在共享的那些上游**：只共享 codex 的机器不该被起一个
    /// claude 进程。装不着、超时、输出对不上，一律保留上一次的观测 ——
    /// 一份空快照会让界面从「剩 63%」跳成「未报」，而那两件事的处置完全不同。
    async fn usage_probe_loop(self: Arc<Self>) {
        // 启动先等一会儿：hello 还没跑完时通道是空的，这一轮什么都探不到，
        // 白起两个进程。
        self.wait(20_000).await;
        while !self.stopping.load(Ordering::Relaxed) {
            self.probe_upstream_usage().await;
            self.wait(USAGE_PROBE_INTERVAL_MS).await;
        }
    }

    async fn probe_upstream_usage(&self) {
        let route_keys: HashSet<String> =
            self.lanes.read().unwrap().values().map(|lane| lane.route_key()).collect();
        for route_key in route_keys {
            let snapshot = match route_key.as_str() {
                "claude_oauth" => usage_probe::probe_claude(&bin("AI_BRIDGE_CLAUDE_BIN", "claude")).await,
                "codex_chatgpt" => usage_probe::probe_codex(&bin("AI_BRIDGE_CODEX_BIN", "codex")).await,
                // 别的上游（api_key 之类）没有「订阅余量」这回事，不探。
                _ => continue,
            };
            let Some(snapshot) = snapshot else { continue };
            log_debug!("usage_probe_ok", "provider": route_key, "buckets": snapshot.buckets.len());
            self.upstream_usage.put(&route_key, snapshot);
        }
    }

    async fn heartbeat_loop(self: Arc<Self>) {
        while !self.stopping.load(Ordering::Relaxed) {
            let lanes: Vec<Arc<Lane>> = self.lanes.read().unwrap().values().cloned().collect();
            // 为重启排空时每条通道都报 paused：Hub 据此不再往这台机器派单，在跑的照常跑完。
            let restarting = self.draining_for_restart();
            let payload: Vec<HeartbeatLane> = lanes
                .iter()
                .map(|lane| HeartbeatLane {
                    cid: lane.cid(),
                    inflight: lane.inflight(),
                    queued: 0,
                    throttled_until: lane.throttled_until_ms().and_then(iso_from_ms),
                    upstream_ok: lane.upstream_ok.load(Ordering::Relaxed),
                    paused: restarting || lane.paused.load(Ordering::Relaxed),
                    // 按**路由键**取，不是按 cid：余量是那个上游账号的属性，
                    // 同一个账号下的几条通道看到的是同一份数。
                    usage: self.upstream_usage.get(&lane.route_key()),
                })
                .collect();
            let tools = self.tools_report();
            let logins = login_report();
            match self.client.heartbeat(&payload, &tools, &logins, &self.loop_cancel).await {
                Ok(result) => {
                    self.hub_address.lock().unwrap().check_and_log(result.hub_url.as_deref());
                    // 取消搭在心跳的响应里：延迟不超过一个上报周期（T-05）。
                    self.apply_cancels(&result.cancel);
                    for lane in &lanes {
                        lane.draining.store(result.drain.contains(&lane.cid()), Ordering::Relaxed);
                    }
                    // 主人在控制台改了什么，最迟一个心跳周期就换过来。注意它在 draining
                    // 之后：apply_enabled 会把被关掉的通道重新置成 draining，
                    // 顺序反了会被上面那个循环立刻清掉。
                    self.apply_enabled(result.enabled.as_deref());
                    if let Some(command) = result.upgrade {
                        self.accept_upgrade(command);
                    }
                    if let Some(command) = result.tool {
                        self.accept_tool_command(command);
                    }
                    if let Some(command) = result.login {
                        self.accept_login_command(command);
                    }
                }
                Err(failure) => log_warn!("pool_heartbeat_failed", "message": failure.message()),
            }
            let beat_ms = self.settings.heartbeat_sec as u64 * 1000;
            // 正在装东西就跳快一点：控制台上那个进度条是这条心跳喂的。
            //
            // 登录会话开着时同样提速，但理由更硬：claude 那条路要把主人粘回来的码
            // 送回这台机器，而心跳是 poll 节点唯一的下行。15 秒一跳的话，
            // 「粘完码到机器收到」中间平均要等七八秒，而那串码本身是有寿命的。
            let busy = any_job_running() || any_login_active();
            self.wait(if busy { beat_ms.min(TOOL_JOB_BEAT_MS) } else { beat_ms }).await;
        }
    }

    // ---------- 本机工具 ----------

    /// 定时问本机的 claude / codex 是什么版本、上游最新是什么版本。
    ///
    /// 和上游余量那条探针一个道理：要起子进程、要走网络，不能摆在心跳的路上 ——
    /// 那条路卡住多久，Hub 就多久看不到这台机器的心跳，45 秒之后它就掉出候选了。
    async fn tools_probe_loop(self: Arc<Self>) {
        // 启动先等一会儿：刚起来那几秒 hello 和通道都还在建，这时候去起两个子进程
        // 只是和它们抢。晚十几秒报上去没人会察觉 —— 这两个版本号本来就不常变。
        self.wait(TOOLS_PROBE_DELAY_MS).await;
        while !self.stopping.load(Ordering::Relaxed) {
            let mut statuses = external_tool_statuses().await;
            for status in &mut statuses {
                status.logged_in = self.probe_login_state(&status.name).await;
            }
            *self.tool_snapshot.lock().unwrap() = statuses;
            // 装完之后那一版号要尽快报上去，所以装东西期间也跟着提速。
            self.wait(if any_job_running() { TOOL_JOB_BEAT_MS } else { TOOLS_PROBE_INTERVAL_MS }).await;
        }
    }

    /// 心跳里那一份工具状态：版本取探针存下的快照，进度取此刻的实况。
    ///
    /// 两个来源分开是必须的 —— 版本一分钟才探一次，而进度每一跳都在变。
    fn tools_report(&self) -> Vec<ToolStatus> {
        let mut tools = self.tool_snapshot.lock().unwrap().clone();
        for tool in &mut tools {
            tool.job = tool_job(&tool.name);
        }
        tools
    }

    /// 接一条「装 / 升本机工具」的指令：按 id 去重，真正的活放到后台。
    ///
    /// 不判断该不该装（该不该由主人在控制台点那一下决定），只判断**认不认得**这个
    /// 工具名 —— 认不认得那张表在节点自己手里（原则 8：在我的机器上跑什么，不信 Hub）。
    fn accept_tool_command(self: &Arc<Self>, command: ToolCommand) {
        if command.id.is_empty() {
            log_warn!("pool_tool_command_without_id", "tool": command.tool,
                "hint": "工具指令没有 id，没法让 Hub 认出这一次，不执行");
            return;
        }
        if !self.tool_seen.lock().unwrap().insert(command.id.clone()) {
            return;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            match run_tool_job(&command.tool, Some(&command.id)).await {
                Ok(job) => log_info!("pool_tool_job_started", "id": command.id,
                    "tool": command.tool, "action": job.action),
                // 失败也只是记一笔：进度和原因都在下一跳心跳的 tools 里，控制台照样看得见。
                // 这里连不上任何上报通道 —— 连指令都没跑起来，也就没有 job 可报。
                Err(message) => {
                    inner.report_tool_command_failure(&command, &message);
                }
            }
        });
    }

    /// 指令根本没跑起来（工具名不认识、npm 不在 PATH 上）。
    ///
    /// 没有 job 能挂进度，所以在日志里说清楚；控制台那边由 Hub 的超时兜底
    /// —— 机器领了却一条进度都不报，那一次就按「没反应」收掉。
    fn report_tool_command_failure(&self, command: &ToolCommand, message: &str) {
        log_warn!("pool_tool_job_failed", "id": command.id, "tool": command.tool, "message": message);
    }

    // ---------- 上游登录 ----------

    /// 这个工具在本机登录了没有。None 表示本机没有对应的上游，见 ToolStatus::logged_in。
    ///
    /// 走的是和能力探测同一条路（只解析凭据、不发请求），所以它不消耗主人的额度，
    /// 也不会在上游留痕迹 —— 这一轮探针一分钟跑一次，真打上游是受不了的。
    async fn probe_login_state(&self, tool: &str) -> Option<bool> {
        let (name, provider) = provider_for_tool(&self.cfg, tool)?;
        Some(probe_credentials(provider, name, &self.credentials, &self.env).await.is_ok())
    }

    /// 接一条登录指令。两种形状：起一次登录，或者把主人粘回来的授权码送到。
    ///
    /// 去重的键带上码本身，**不能只用 id**：一次会话里 Hub 会先发「起」、再发
    /// 「这是码」，两条指令的 id 是同一个 —— 只按 id 去重的话，码会被当成重发丢掉，
    /// 主人在界面上粘了码却什么都不会发生。码粘错了再来一次同理，那是一条新的键。
    fn accept_login_command(&self, command: LoginCommand) {
        if command.id.is_empty() {
            log_warn!("pool_login_command_without_id", "tool": command.tool,
                "hint": "登录指令没有 id，没法让 Hub 认出这一次，不执行");
            return;
        }
        let key = format!("{}:{}", command.id, command.code.as_deref().unwrap_or(""));
        if !self.login_seen.lock().unwrap().insert(key) {
            return;
        }
        tokio::spawn(async move {
            match command.code.as_deref() {
                // 有码：喂给那个还卡在 stdin 上的进程。
                Some(code) => match submit_code(&command.tool, &command.id, code) {
                    Ok(()) => log_info!("pool_login_code_submitted", "id": command.id,
                        "tool": command.tool),
                    // 失败只记一笔：原因在下一跳心跳的 logins 里，控制台照样看得见。
                    Err(message) => log_warn!("pool_login_code_rejected", "id": command.id,
                        "tool": command.tool, "message": message),
                },
                None => match start_login(&command.tool, Some(&command.id)).await {
                    Ok(status) => log_info!("pool_login_started_by_hub", "id": command.id,
                        "tool": command.tool, "state": status.state),
                    Err(message) => log_warn!("pool_login_start_failed", "id": command.id,
                        "tool": command.tool, "message": message),
                },
            }
        });
    }

    // ---------- 远程升级 ----------

    /// 接一条升级指令：按 id 去重，一次只跑一个，真正的活放到后台 —— 下载可能要几十秒，
    /// 心跳不能停，停了 Hub 会把这台机器判成离线，连带着在跑的单元一起改派。
    fn accept_upgrade(self: &Arc<Self>, command: UpgradeCommand) {
        if command.id.is_empty() {
            log_warn!("pool_upgrade_without_id", "version": command.version,
                "hint": "升级指令没有 id，没法上报结果，不执行");
            return;
        }
        {
            let mut gate = self.upgrade_gate.lock().unwrap();
            if gate.seen.contains(&command.id) {
                return;
            }
            // 正在退出或已经在为重启排空的进程不再开始新的升级：它马上就不在了。
            if gate.busy || self.stopping.load(Ordering::Relaxed) || self.draining_for_restart() {
                log_debug!("pool_upgrade_deferred", "id": command.id, "hint": "已有一次升级在跑，或者进程正要重启");
                return;
            }
            gate.seen.insert(command.id.clone());
            gate.busy = true;
        }
        let inner = Arc::clone(self);
        tokio::spawn(async move { inner.run_upgrade(command).await });
    }

    async fn run_upgrade(self: Arc<Self>, command: UpgradeCommand) {
        log_info!("pool_upgrade_started", "id": command.id, "version": command.version,
            "from": self.bridge_version, "platform": command.platform);
        match self.upgrade_steps(&command).await {
            Ok(UpgradeEnd::Installed) => {
                // 闸门不放开：新版本已经换上，这个进程只剩重启一件事，再来的指令一律不接。
            }
            Ok(UpgradeEnd::AlreadyCurrent) => {
                let message = format!("已经是 {}", self.bridge_version);
                log_info!("pool_upgrade_already_current", "id": command.id, "version": command.version);
                self.report_upgrade(&command.id, UpgradeState::Succeeded, &message).await;
                self.upgrade_gate.lock().unwrap().busy = false;
            }
            Err(message) => {
                // 任何一步失败：临时文件已经随 PreparedUpgrade 删掉，旧文件没动（或已还原），
                // 进程照常干活。
                log_warn!("pool_upgrade_failed", "id": command.id, "version": command.version, "message": message);
                self.report_upgrade(&command.id, UpgradeState::Failed, &message).await;
                self.upgrade_gate.lock().unwrap().busy = false;
            }
        }
    }

    /// 契约 3.4 的第 2–7 步。Err 里是给控制台看的人话。
    async fn upgrade_steps(&self, command: &UpgradeCommand) -> Result<UpgradeEnd, String> {
        let Some(updater) = self.updater.clone() else {
            return Err(NO_UPDATER_MESSAGE.into());
        };
        let target = command.version.as_str();
        if Version::parse(target).is_none() {
            return Err(format!("升级指令里的版本号不合法：{target}"));
        }
        match compare_versions(target, &self.bridge_version) {
            None => return Err(format!("本机版本号 {} 认不出来，判断不了这是不是升级", self.bridge_version)),
            Some(std::cmp::Ordering::Equal) => return Ok(UpgradeEnd::AlreadyCurrent),
            Some(std::cmp::Ordering::Less) => {
                return Err(format!("不降级：本机已经是 {}，比 {target} 新", self.bridge_version));
            }
            Some(std::cmp::Ordering::Greater) => {}
        }
        let local = current_platform().unwrap_or("认不出来的平台");
        if command.platform != local {
            return Err(format!("安装包是 {} 的，这台机器是 {local}", command.platform));
        }
        if let Some(blocker) = updater.blocker() {
            return Err(blocker);
        }
        // 先验签名再报 downloading：签名不对的指令，连「正在下载」都不该在控制台上出现过。
        updater.verify(command)?;

        self.report_step(command, UpgradeState::Downloading, &format!("正在下载 {target}")).await?;
        // 停机时别等下载：丢掉这个 future 就是中止，临时目录和 tar 子进程随之清理。
        let prepared = tokio::select! {
            biased;
            () = self.loop_cancel.cancelled() => return Err("节点正在退出，升级中断了；重新发起一次即可".into()),
            prepared = updater.prepare(command) => prepared?,
        };

        self.report_step(command, UpgradeState::Installing, &format!("正在安装 {target}")).await?;
        let installed = updater.install(prepared).await?;
        log_info!("pool_upgrade_installed", "id": command.id, "version": target,
            "path": installed.to_string_lossy());

        // 顺序是有讲究的：先停止接新活，再说「正在重启」，最后才让进程主人去重启 ——
        // 反过来的话，主人可能在 restarting 这条上报发出去之前就已经 exec 了。
        self.restart_draining.store(true, Ordering::Relaxed);
        self.report_upgrade(&command.id, UpgradeState::Restarting,
            &format!("{target} 已装好，等在跑的单元结束后重启")).await;
        self.restart.send_replace(true);
        Ok(UpgradeEnd::Installed)
    }

    /// 报一步进度；Hub 明说不认这条指令（过期了）就不再往下做。
    ///
    /// 网络不通只记日志、照做不误（契约 3.4 第 9 条）。但 accepted=false 是 Hub 明确的回答：
    /// 这条指令已经被判超时或被新指令顶替了，控制台上显示的是失败 —— 这时候再把机器重启一次，
    /// 主人只会看到一台莫名其妙重启了的机器。
    async fn report_step(&self, command: &UpgradeCommand, state: UpgradeState, message: &str) -> Result<(), String> {
        if self.report_upgrade(&command.id, state, message).await == Some(false) {
            return Err("平台已经不认这条升级指令（超时或被新的指令顶替），这次不升级".into());
        }
        Ok(())
    }

    /// 返回 Hub 认不认；没说出去是 None。
    async fn report_upgrade(&self, id: &str, state: UpgradeState, message: &str) -> Option<bool> {
        match self.client.report_upgrade(id, state, message).await {
            Ok(accepted) => {
                if !accepted {
                    log_warn!("pool_upgrade_report_stale", "id": id, "state": state.label());
                }
                Some(accepted)
            }
            Err(error) => {
                log_warn!("pool_upgrade_report_failed", "id": id, "state": state.label(), "message": error);
                None
            }
        }
    }

    async fn next_loop(self: Arc<Self>) {
        let mut backoff = RECONNECT_MIN_MS;
        while !self.stopping.load(Ordering::Relaxed) {
            if self.draining_for_restart() {
                // 在为重启排空：不去领活。进程马上就要被换掉，领来的活只能再还回去。
                self.wait(1_000).await;
                continue;
            }
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
                    self.apply_cancels(&claimed.cancel);
                    if self.stopping.load(Ordering::Relaxed) {
                        return;
                    }
                    if claimed.unit.id.is_empty() {
                        continue;
                    }
                    if self.draining_for_restart() {
                        // 排空开始之前就挂上的那条长轮询，可能在排空之后才领回一个单元。
                        // 不跑，立刻还给 Hub 改派 —— 跑到一半被重启打断，消费者要多等一整轮。
                        self.hand_back(&claimed).await;
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

    /// 处理一份取消清单，返回真正打断了几个。
    ///
    /// 两条接入方式都要它：poll 那边取消搭在心跳与续租的响应里回来，
    /// export 那边 Hub 可以直接敲 /node/v1/cancel。语义必须完全一致 ——
    /// 「消费者走了就立刻停手，别再烧主人的额度」这件事不该有两种实现。
    pub(crate) fn apply_cancels(&self, unit_ids: &[String]) -> usize {
        let aborts = self.aborts.lock().unwrap();
        let mut stopped = 0;
        for unit_id in unit_ids {
            if let Some(inflight) = aborts.get(unit_id) {
                inflight
                    .cancel
                    .cancel(crate::core::errors::http_error(499, "hub_cancelled", "hub_cancelled"));
                stopped += 1;
            }
        }
        stopped
    }

    /// 把一个领到了、但不打算跑的单元还给 Hub：failed + node_shutdown + retryable，
    /// 和 stop() 报在跑单元是同一个说法，Hub 立刻改派。
    async fn hand_back(&self, claimed: &NextResult) {
        log_info!("pool_unit_handed_back", "unitId": claimed.unit.id, "reason": "restarting");
        self.client
            .complete(&claimed.unit.id, &CompleteBody {
                lease: claimed.lease.token.clone(),
                state: "failed".into(),
                error: Some(UnitError {
                    class: ErrorClass::NodeFault,
                    code: "node_shutdown".into(),
                    retryable: true,
                    message: "节点正在重启升级".into(),
                }),
                ..Default::default()
            })
            .await;
    }

    /// 建一份回调（产物签名 + 进度上报）。两条路都要，形状一样。
    pub(crate) fn callbacks(&self, lease: String) -> HubCallbacks {
        HubCallbacks { client: Arc::clone(&self.client), lease }
    }

    /// 上游响应头到手时该记的那几件事：429 进冷却，4xx 留一条日志。
    ///
    /// 抽出来是因为 export 那条路同样要做 —— 漏掉的话，一台 export 机器被上游
    /// 限流之后不会进冷却，Hub 会继续往它身上派单，每一条都是 429。
    pub(crate) fn observe_head(
        &self,
        lane: &Arc<Lane>,
        unit_id: &str,
        status: u16,
        headers: &std::collections::BTreeMap<String, String>,
    ) {
        if status == 429 {
            lane.throttle(headers.get("retry-after").map(String::as_str), now_ms());
        }
        if status >= 400 {
            log_warn!("pool_upstream_rejected",
                "unitId": unit_id, "cid": lane.cid(), "status": status,
                "requestId": headers.get("request-id"),
                "retryAfter": headers.get("retry-after"),
                "throttledUntil": lane.throttled_until_ms().and_then(iso_from_ms));
        }
    }

    /// resolveLane 是节点侧的白名单自校验（原则 8）。Hub 是路由权威，
    /// 但「在我的机器上执行什么」这条边界不信任 Hub。
    pub(crate) fn resolve_lane(&self, unit: &WorkUnit) -> Option<Arc<Lane>> {
        for lane in self.lanes.read().unwrap().values() {
            let config = lane.config();
            if config.kind != unit.kind || config.kind_version != unit.kind_version {
                continue;
            }
            if config.provider != unit.provider {
                continue;
            }
            // 分组是范围上唯一的闸（2026-09-22 起，模型通配名单已撤）：名单为空是
            // 「不限」，单元没带分组（没有模型的请求、还没建分组的模型）同样放行 ——
            // 把「不知道」当成「不接」，会让这两类单在本机全部被判成能力不符。
            if !group_joined(&config.groups, unit.group.as_deref()) {
                continue;
            }
            return Some(Arc::clone(lane));
        }
        None
    }

    /// 一个单元在本机的执行位：通道、取消信号、临时目录、续租任务。
    ///
    /// 抽出来是因为**两条接入方式都要它**。poll 那边是自己领活之后占位，
    /// export 那边是 Hub 敲门之后占位 —— 占的是同一个位子，收尾也是同一套。
    /// 两边各写一份的下场是其中一份忘了 release，那条通道的并发就永久少一个。
    pub(crate) fn begin_unit(
        self: &Arc<Self>,
        unit: &WorkUnit,
        lease: &str,
        renew_sec: Option<u64>,
    ) -> Result<UnitSlot, UnitError> {
        // resolveLane 是节点侧的白名单自校验（原则 8）：Hub 是路由权威，
        // 但「在我的机器上执行什么」这条边界不信任 Hub。
        let Some(lane) = self.resolve_lane(unit) else {
            return Err(UnitError {
                class: ErrorClass::NodeFault, code: "capability_mismatch".into(),
                retryable: true, message: "单元不在本机任何贡献的申报范围内".into(),
            });
        };
        // 检查与登记在同一把锁下，否则两个并发 dispatch 会同时通过。
        let mut aborts = self.aborts.lock().unwrap();
        if aborts.contains_key(&unit.id) {
            return Err(UnitError {
                class: ErrorClass::NodeFault, code: "unit_already_running".into(),
                retryable: true, message: "相同工作单元已在本机执行".into(),
            });
        }
        if !lane.acquire(&unit.consumer_key) {
            return Err(UnitError {
                class: ErrorClass::NodeFault, code: "capability_mismatch".into(),
                retryable: true, message: "通道已满".into(),
            });
        }

        let cancel = self.loop_cancel.child();
        aborts.insert(unit.id.clone(), Inflight { cancel: cancel.clone(), lease: lease.to_string() });
        drop(aborts);
        // 每个单元一个临时目录，结束后整个删掉：消费者的素材不该在主人机器上留过夜（约束 4）。
        let work_dir = std::env::temp_dir().join("ai-bridge-unit").join(&unit.id);
        // 续租心跳：job 可以跑两小时，租约只有 60 秒。不续的话 Hub 会判它跑丢了，
        // 把同一个任务派给另一台机器重跑一遍。
        let lease_ttl = Duration::from_secs(renew_sec.unwrap_or(60).max(1));
        let renew_every = std::cmp::max(lease_ttl / 2, Duration::from_secs(1));
        let renew = {
            let client = Arc::clone(&self.client);
            let cancel = cancel.clone();
            let unit_id = unit.id.clone();
            let lease = lease.to_string();
            tokio::spawn(async move {
                let mut last_confirmed = Instant::now();
                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => return,
                        () = tokio::time::sleep(renew_every) => {}
                    }
                    match client.confirm_lease(&unit_id, &lease).await {
                        // 取消搭在续租的响应里回来，不单独轮询（T-05）。
                        Ok(LeaseState::Cancelled) => {
                            cancel.cancel(crate::core::errors::http_error(499, "hub_cancelled", "hub_cancelled"));
                            return;
                        }
                        Ok(LeaseState::Lost) => {
                            log_warn!("pool_lease_lost", "unitId": unit_id);
                            cancel.cancel(crate::core::errors::http_error(409, "lease_lost", "租约已失效"));
                            return;
                        }
                        Ok(LeaseState::Valid) => last_confirmed = Instant::now(),
                        Err(message) => {
                            log_debug!("pool_renew_failed", "unitId": unit_id, "message": message);
                            // Hub 暂时不可达时允许一个租期的抖动；超过后就已无法
                            // 证明所有权，必须停止上游，否则 Hub 改派后两边会同时执行。
                            if last_confirmed.elapsed() >= lease_ttl {
                                log_warn!("pool_lease_confirmation_expired", "unitId": unit_id);
                                cancel.cancel(crate::core::errors::http_error(
                                    409, "lease_lost", "超过一个租期未能确认租约",
                                ));
                                return;
                            }
                        }
                    }
                }
            })
        };
        Ok(UnitSlot {
            lane, cancel, work_dir, renew,
            started: Instant::now(),
            unit_id: unit.id.clone(),
            consumer_key: unit.consumer_key.clone(),
        })
    }

    /// 收尾：停续租、摘登记、还并发、删临时目录。
    pub(crate) async fn finish_unit(&self, slot: UnitSlot) {
        slot.renew.abort();
        self.aborts.lock().unwrap().remove(&slot.unit_id);
        slot.lane.release(&slot.consumer_key);
        // 清场：本机不留消费者内容。删不掉只记日志，不影响这个单元已经报出去的终态。
        if let Err(e) = tokio::fs::remove_dir_all(&slot.work_dir).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                log_warn!("pool_workdir_cleanup_failed", "unitId": slot.unit_id, "message": e.to_string());
            }
        }
        // 日志只记 requestId / cid，不记内容也不记消费者身份。
        log_info!("pool_unit_done", "unitId": slot.unit_id, "cid": slot.lane.cid(),
            "ms": slot.started.elapsed().as_millis() as u64);
    }

    /// 跑一个工作单元。首字节之前失败可以被 Hub 改派，
    /// 之后失败只能 502 —— 已经流出去的字节收不回来（设计文档 6.2）。
    async fn dispatch(self: Arc<Self>, claimed: NextResult) {
        let unit = claimed.unit.clone();
        let lease = claimed.lease.token.clone();
        let slot = match self.begin_unit(&unit, &lease, claimed.lease.renew_sec) {
            Ok(slot) => slot,
            Err(error) => {
                // 新的重复派发不得用自己的租约把正在执行的原单元报成失败。
                if error.code == "unit_already_running" {
                    log_warn!("pool_duplicate_unit_ignored", "unitId": unit.id);
                    return;
                }
                // 这两种失败发生在登记进 aborts 之前，stop() 根本看不见它们，
                // 所以必须自己报 —— 不报的话 Hub 只能等时限到点。
                self.client.complete(&unit.id, &CompleteBody {
                    lease, state: "failed".into(), error: Some(error), ..Default::default()
                }).await;
                return;
            }
        };
        // 领取后可能经过排队或卡顿；真正碰上游前再同步验租。
        // 无法证明租约有效时 fail closed，避免一份已改派的单元重复计费。
        match self.client.confirm_lease(&unit.id, &lease).await {
            Ok(LeaseState::Valid) => {}
            Ok(LeaseState::Cancelled) => {
                self.report_terminal(&unit.id, &CompleteBody {
                    lease, state: "cancelled".into(), ..Default::default()
                }).await;
                self.finish_unit(slot).await;
                return;
            }
            Ok(LeaseState::Lost) => {
                log_warn!("pool_lease_rejected_before_upstream", "unitId": unit.id);
                self.finish_unit(slot).await;
                return;
            }
            Err(message) => {
                log_warn!("pool_lease_check_failed", "unitId": unit.id, "message": message.clone());
                self.report_terminal(&unit.id, &CompleteBody {
                    lease, state: "failed".into(),
                    error: Some(UnitError {
                        class: ErrorClass::NodeFault, code: "lease_check_failed".into(),
                        retryable: true, message,
                    }),
                    ..Default::default()
                }).await;
                self.finish_unit(slot).await;
                return;
            }
        }
        let lane = Arc::clone(&slot.lane);
        self.run_unit(&claimed, &lane, slot.cancel.clone(), slot.work_dir.clone(), slot.started).await;
        self.finish_unit(slot).await;
    }

    /// 报终态。停机时让路 —— stop() 已经替所有在跑的单元统一报过一次，
    /// 这里再报一遍只会被 Hub 以「单元已结束」挡回来，白留一条告警日志。
    ///
    /// 只有走到这里的单元才适用：dispatch 在登记进 aborts 之前就失败的那两种
    /// （不在申报范围、通道已满）stop() 根本看不见，它们必须自己报。
    pub(crate) async fn report_terminal(&self, unit_id: &str, body: &CompleteBody) {
        if self.stopping.load(Ordering::Relaxed) {
            return;
        }
        // 明确失租后只做本地收尾，不再用已失效的所有权报终态。
        let lease_lost = self.aborts.lock().unwrap().get(unit_id)
            .map(|inflight| inflight.cancel.is_cancelled()
                && inflight.cancel.reason().code == "lease_lost")
            .unwrap_or(false);
        if lease_lost {
            log_debug!("pool_terminal_skipped_after_lease_loss", "unitId": unit_id);
            return;
        }
        self.client.complete(unit_id, body).await;
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
        let callbacks: Arc<dyn UnitCallbacks> = Arc::new(self.callbacks(lease.clone()));
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
                    self.observe_head(lane, &unit.id, status, &headers);
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
            self.report_terminal(&unit.id, &CompleteBody {
                lease, state: state.into(), error: Some(failure), ms: Some(ms), ..Default::default()
            }).await;
            return;
        }
        let Some((status, headers)) = head else {
            let terminal = outcome.lock().unwrap().terminal();
            self.report_terminal(&unit.id, &CompleteBody {
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
            self.report_terminal(&unit.id, &CompleteBody {
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
                self.report_terminal(&unit.id, &CompleteBody {
                    lease, state: "failed".into(), error: Some(failure), ms: Some(ms), ..terminal
                }).await;
            }
            None => {
                self.report_terminal(&unit.id, &CompleteBody {
                    lease, state: "completed".into(), ms: Some(ms), ..terminal
                }).await;
            }
        }
    }
}

pub(crate) struct HubCallbacks {
    pub(crate) client: Arc<HubClient>,
    pub(crate) lease: String,
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
pub(crate) struct Outcome {
    pub(crate) done: Option<DoneEvent>,
    pub(crate) failure: Option<UnitError>,
}

impl Outcome {
    pub(crate) fn usage(&self) -> Metering {
        self.done.as_ref().map(|done| done.usage.clone()).unwrap_or_default()
    }
    /// 终态里除状态之外的东西：用量、session 的上下文增量、job 的产物引用。
    pub(crate) fn terminal(&self) -> CompleteBody {
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
/// 本机配置里负责这个工具的那个上游。
///
/// 工具名和 authMode 是一一对应的（claude → claude_oauth，codex → codex_chatgpt）：
/// 「登录 claude」问的就是「claude_oauth 那个上游的凭据还能用吗」。
///
/// 配了多个同 authMode 的上游时取撞见的第一个。那种配法本来就少见，而这里要答的是
/// 「这台机器上的 claude 登录了没」—— 那是一份**本机凭据**，几个上游共用同一份。
fn provider_for_tool<'a>(cfg: &'a AppConfig, tool: &str) -> Option<(&'a String, &'a ProviderConfig)> {
    let wanted = match tool {
        "claude" => AuthMode::ClaudeOauth,
        "codex" => AuthMode::CodexChatgpt,
        _ => return None,
    };
    cfg.providers.iter().find(|(_, provider)| provider.auth_mode == Some(wanted))
}

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
        // delivery.task 不在这里：它的执行器是主人自己写的命令（pool.contributions[].exec），
        // 「机器上有什么」推断不出来。于是配了 delivery.task 贡献的机器不会建出通道，
        // Hub 下发时只会记一条 pool_enabled_not_probed —— 这是从 TS 原样带过来的现状，
        // 不是移植漏掉的。PlannerBridgeProvider 已经就位，等执行器侧的 --stdio 入口落地
        // 再把这条能力接上（见 doc/galaxy 的「尚未实现」）。
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
        groups: want.groups.clone(),
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

/// 探针要跑哪个可执行文件。
///
/// 默认就是 PATH 里的 claude / codex。留一个环境变量出口，是因为 bridge 常常被
/// 当成守护进程跑（LaunchAgent、systemd），那种环境里的 PATH 和主人登录时的
/// 不是一回事 —— 表现是「我明明装了 claude」而探针一直说找不到。
fn bin(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn iso_from_ms(ms: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}
