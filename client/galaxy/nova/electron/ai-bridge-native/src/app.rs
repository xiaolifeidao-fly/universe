use crate::auth::token_store::{resolve_token_file, TokenStore};
use crate::auth::Auth;
use crate::config::schema::{AppConfig, Mode};
use crate::core::errors::{error_body, BridgeError};
use crate::core::logger::{set_log_level, Level};
use crate::core::paths::Env;
use crate::core::queue::ConcurrencyGate;
use crate::core::request::{server_shutdown, Cancel};
use crate::credentials::CredentialRegistry;
use crate::{log_info, log_warn};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::Value;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 所有模块共享的运行时上下文。模块之间不直接依赖彼此，只经过它。
pub struct BridgeState {
    pub cfg: AppConfig,
    pub auth: Auth,
    pub gate: ConcurrencyGate,
    pub credentials: CredentialRegistry,
    pub client: reqwest::Client,
    pub env: Env,
    /// 关闭信号。每个请求的取消信号都是它的子信号，所以优雅期一过，
    /// 还在跑的流会立刻收到 503 而不是继续写下去。
    pub shutdown: Cancel,
    pub shutting_down: AtomicBool,
    pub started_at: Instant,
    pub modules: Vec<&'static str>,
}

pub fn client_ip(state: &BridgeState, peer: SocketAddr, headers: &HeaderMap) -> Option<IpAddr> {
    if state.cfg.server.trust_proxy {
        // trust proxy 打开时取 X-Forwarded-For 的最左一项，与 express 的 `trust proxy: true` 一致。
        if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = forwarded.split(',').next().map(str::trim) {
                if let Ok(ip) = first.parse::<IpAddr>() {
                    return Some(crate::auth::network::normalize(ip));
                }
            }
        }
    }
    Some(crate::auth::network::normalize(peer.ip()))
}

pub fn json_error(e: &BridgeError, body: Value) -> Response {
    let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(body)).into_response()
}

pub struct Bridge {
    pub state: Arc<BridgeState>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    serving: Option<tokio::task::JoinHandle<()>>,
    pub addr: Option<SocketAddr>,
}

/// 把配置装配成一个可监听的 HTTP 服务。不读配置文件、不碰进程信号 —— 那些在调用方。
pub async fn create_bridge(cfg: AppConfig, env: Env) -> Result<Bridge, String> {
    if cfg.mode == Mode::Pool {
        return Err("mode=pool 的运行循环还在 Node 侧，原生桥接只承接 relay 模式".into());
    }
    // agent 模块尚未迁到 Rust。悄悄忽略配置会让请求以 relay 方式跑掉，
    // 而 agent 的语义是「在本机执行命令」—— 这个差别不能默默发生。
    if cfg.agent.enabled {
        return Err("agent.enabled=true：本机 agent 模块还没迁到原生桥接，请先关掉它".into());
    }
    if let Some(level) = Level::parse(&cfg.log.level) {
        set_log_level(level);
    }

    let token_file = resolve_token_file(&cfg.auth, &env);
    let mut tokens = TokenStore::new(cfg.auth.clone(), token_file);
    tokens.load()?;
    let auth = Auth::new(cfg.auth.clone(), tokens)?;
    let gate = ConcurrencyGate::new(&cfg);

    let client = reqwest::Client::builder()
        // fetch 的 redirect: "error"：中转不跟随重定向，把它当上游异常。
        .redirect(reqwest::redirect::Policy::custom(|attempt| attempt.error("redirect not allowed")))
        .build()
        .map_err(|e| format!("建 HTTP 客户端失败：{e}"))?;
    let credentials = CredentialRegistry::new(client.clone());

    let mut modules = vec!["health"];
    if cfg.relay.enabled {
        modules.push("relay");
    }
    if cfg.admin.enabled {
        modules.push("admin");
    }
    log_info!("modules_ready", "enabled": modules);

    Ok(Bridge {
        state: Arc::new(BridgeState {
            cfg, auth, gate, credentials, client, env,
            shutdown: Cancel::new(),
            shutting_down: AtomicBool::new(false),
            started_at: Instant::now(),
            modules,
        }),
        shutdown: None,
        serving: None,
        addr: None,
    })
}

impl Bridge {
    fn router(&self) -> Router {
        let state = Arc::clone(&self.state);
        let mut router = crate::modules::health::routes();
        if state.cfg.relay.enabled {
            router = router.merge(crate::modules::relay::routes(&state));
        }
        if state.cfg.admin.enabled {
            router = router.merge(crate::modules::admin::routes());
        }
        router
            .fallback(not_found)
            .with_state(state)
    }

    pub async fn listen(&mut self) -> Result<SocketAddr, String> {
        let cfg = &self.state.cfg.server;
        let listener = tokio::net::TcpListener::bind((cfg.host.as_str(), cfg.port))
            .await
            .map_err(|e| format!("监听 {}:{} 失败：{e}", cfg.host, cfg.port))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let router = self.router();
        let serving = tokio::spawn(async move {
            let served = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move { let _ = rx.await; })
                .await;
            if let Err(e) = served {
                log_warn!("server_stopped", "message": e.to_string());
            }
        });

        self.shutdown = Some(tx);
        self.serving = Some(serving);
        self.addr = Some(addr);
        let tokens = self.state.auth.tokens.read().unwrap().size();
        log_info!("server_listen",
            "host": self.state.cfg.server.host, "port": addr.port(), "modules": self.state.modules,
            "auth": self.state.auth.enabled(), "tokens": tokens,
            "concurrency": self.state.cfg.concurrency.global,
            "queueMaxSize": self.state.cfg.concurrency.queue_max_size);
        Ok(addr)
    }

    pub async fn close(&mut self) {
        if self.state.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        log_info!("shutdown_start");
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let grace = Duration::from_millis(self.state.cfg.server.shutdown_timeout_ms);
        if tokio::time::timeout(grace, self.state.gate.on_idle()).await.is_err() {
            log_warn!("shutdown_timeout_force");
        }
        // 优雅期结束就掐断还在跑的流。只停 accept 是不够的：axum 每条连接是独立
        // 任务，长 SSE 会一直写下去，stop() 返回之后服务其实还在服务。
        self.state.shutdown.cancel(server_shutdown());
        if let Some(serving) = self.serving.take() {
            let handle = serving.abort_handle();
            if tokio::time::timeout(Duration::from_secs(2), serving).await.is_err() {
                log_warn!("shutdown_connections_force");
                handle.abort();
            }
        }
        log_info!("shutdown_done");
    }
}

async fn not_found(method: axum::http::Method, uri: axum::http::Uri) -> Response {
    log_warn!("route_not_found", "method": method.as_str(), "path": uri.path());
    (StatusCode::NOT_FOUND, Json(error_body(404, "not_found", "route not found"))).into_response()
}
