use crate::app::{create_bridge, Bridge};
use crate::auth::token_store::{add_file_token, read_token_file, resolve_token_file, revoke_file_token, TokenStore};
use crate::business::llm_chat::probe_credentials;
use crate::config::load_config;
use crate::config::schema::{AppConfig, Mode, Scope};
use crate::core::logger;
use crate::core::paths::{default_config_path, Env};
use crate::credentials::CredentialRegistry;
use crate::pool::client::HubClient;
use crate::pool::probe::probe;
use crate::pool::runner::{create_pool_runner, PoolRunner};
use crate::pool::setup::{login_command, open_terminal, origin_of, write_pool_connection};
use crate::pool::token::{read_node_identity, resolve_node_token_file, write_node_identity, NodeIdentity};
use crate::pool::tools::{tool_statuses, upgrade_tool};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

fn err(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message.into())
}

fn to_json(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(|e| err(e.to_string()))
}

/// 顶层的 null 一律去掉。TS 侧这些字段是 `undefined`，JSON.stringify 会直接省略；
/// 发一个显式的 null 过去会让渲染层多一种要判的形态。
fn prune_nulls(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.retain(|_, item| !item.is_null());
    }
    value
}

#[napi(object)]
pub struct CreatedToken {
    pub alias: String,
    /// 明文 token 只在这一次返回里出现，落盘的只有 sha256。
    pub token: String,
    pub scopes: Vec<String>,
}

#[derive(Default)]
struct Runtime {
    relay: Option<Bridge>,
    pool: Option<Arc<PoolRunner>>,
    state: RunState,
    last_error: Option<String>,
    /// 每次启停自增。异步的 pool hello 回来时靠它判断自己是不是已经过时了。
    generation: u64,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum RunState {
    #[default]
    Stopped,
    Starting,
    Running,
    Error,
}

impl RunState {
    fn label(self) -> &'static str {
        match self {
            RunState::Stopped => "stopped",
            RunState::Starting => "starting",
            RunState::Running => "running",
            RunState::Error => "error",
        }
    }
}

/// Nova 的私有 worker 通道调用的原生桥接。
///
/// 不监听任何管理端口，也不装进程信号钩子：生命周期完全由调用方（Electron
/// UtilityProcess 里的薄 JS 壳）驱动。relay 与 pool 两种模式都在这里，
/// 按配置里的 mode 分流。
#[napi]
pub struct NativeBridge {
    config_path: PathBuf,
    bridge_version: String,
    env: Env,
    http: reqwest::Client,
    runtime: Arc<Mutex<Runtime>>,
}

#[napi]
impl NativeBridge {
    /// `configPath` 不传时按 AI_BRIDGE_CONFIG / XDG 习惯推。
    /// `bridgeVersion` 由 Node 侧读自己的 package.json 传进来 —— 桌面版随 Nova 分发，
    /// 原生模块自己找不到那个文件。
    #[napi(constructor)]
    pub fn new(config_path: Option<String>, bridge_version: Option<String>) -> Self {
        let env = Env::from_process();
        logger::init_from_env(&env);
        let path = config_path.map(PathBuf::from).unwrap_or_else(|| default_config_path(&env));
        Self {
            config_path: path,
            bridge_version: bridge_version.unwrap_or_else(|| "0.0.0".into()),
            env,
            http: reqwest::Client::new(),
            runtime: Arc::new(Mutex::new(Runtime::default())),
        }
    }

    #[napi(getter)]
    pub fn config_path(&self) -> String {
        self.config_path.to_string_lossy().into_owned()
    }

    /// 解析并校验配置，返回补齐默认值后的 JSON。
    ///
    /// Node 侧读同一份结果，配置只有这一处解析源头。
    #[napi]
    pub fn load_config_json(&self) -> Result<String> {
        to_json(&self.config()?)
    }

    // ---------- 生命周期 ----------

    #[napi]
    pub async fn start(&self) -> Result<String> {
        let mut runtime = self.runtime.lock().await;
        self.start_locked(&mut runtime).await?;
        drop(runtime);
        self.status_json().await
    }

    #[napi]
    pub async fn stop(&self) -> Result<String> {
        let mut runtime = self.runtime.lock().await;
        self.stop_locked(&mut runtime).await;
        drop(runtime);
        self.status_json().await
    }

    #[napi]
    pub async fn restart(&self) -> Result<String> {
        let mut runtime = self.runtime.lock().await;
        self.stop_locked(&mut runtime).await;
        self.start_locked(&mut runtime).await?;
        drop(runtime);
        self.status_json().await
    }

    /// `{ state, mode, paired, nodeId, hubURL, error?, configPath, queue? }`
    #[napi]
    pub async fn get_status(&self) -> Result<String> {
        self.status_json().await
    }

    /// 本机现状：配置位置、平台地址、机器资源、探测到的能力、是否已配对。
    #[napi]
    pub async fn get_state(&self) -> Result<String> {
        let cfg = self.config()?;
        let credentials = CredentialRegistry::new(self.http.clone());
        let result = probe(&cfg, &credentials, &self.env).await;
        let identity = self.identity(&cfg).await;
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        to_json(&prune_nulls(json!({
            "configPath": self.config_path(),
            "hubURL": cfg.pool.as_ref().map(|p| p.hub_url.clone()).unwrap_or_default(),
            "displayName": host_name(),
            "resources": {
                "platform": std::env::consts::OS,
                "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
                "totalMemMB": system.total_memory() / 1_048_576,
                "freeMemMB": system.free_memory() / 1_048_576,
            },
            "capabilities": result.capabilities,
            "paired": identity.is_some(),
            "nodeId": identity.as_ref().map(|i| i.node_id.clone()),
        })))
    }

    /// Nova 用它确认「这台机器上的桥接还在，而且绑的是同一个平台」。
    #[napi]
    pub async fn ping(&self, hub_url: Option<String>) -> Result<String> {
        let cfg = self.config()?;
        let identity = self.identity(&cfg).await;
        let configured = cfg.pool.as_ref().map(|p| p.hub_url.clone()).unwrap_or_default();
        let mut out = json!({
            "running": true, "resident": true,
            "paired": identity.is_some(),
            "nodeId": identity.as_ref().map(|i| i.node_id.clone()),
            "hubURL": configured,
        });
        if let (Some(asked), false) = (hub_url.as_deref(), configured.is_empty()) {
            out["hubMatches"] = json!(origin_of(asked) == origin_of(&configured));
        }
        to_json(&prune_nulls(out))
    }

    // ---------- 配对 ----------

    /// 用一次性配对码换长期节点令牌，写盘并把配置切到 pool 模式。
    #[napi]
    pub async fn pair(
        &self,
        code: String,
        display_name: Option<String>,
        hub_url: Option<String>,
    ) -> Result<String> {
        let cfg = self.config()?;
        let configured = cfg.pool.as_ref().map(|p| p.hub_url.clone());
        let hub = hub_url.or_else(|| configured.clone()).ok_or_else(|| err("请填写平台地址"))?;
        let parsed = reqwest::Url::parse(&hub).map_err(|_| err("平台地址必须是 HTTP(S) 地址"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(err("平台地址必须是 HTTP(S) 地址"));
        }
        if let Some(existing) = configured.as_deref().filter(|value| !value.is_empty()) {
            if origin_of(&hub) != origin_of(existing) {
                return Err(err("本机已绑定其他平台，请先修改 Nova 本机配置"));
            }
        }

        let file = resolve_node_token_file(cfg.pool.as_ref(), &self.env);
        let previous = read_node_identity(&file).await.map_err(err)?;
        let client = HubClient::new(hub.clone(), cfg.pool.as_ref().map(|p| p.contract).unwrap_or(1),
            None, None, self.http.clone());
        let display = display_name.filter(|name| !name.is_empty()).unwrap_or_else(host_name);
        let paired = client
            .pair(&code, &display, &self.bridge_version, previous.as_ref().map(|i| i.node_id.as_str()))
            .await
            .map_err(|e| err(e.message))?;

        let mut runtime = self.runtime.lock().await;
        self.stop_locked(&mut runtime).await;
        write_node_identity(&file, &NodeIdentity {
            version: 1,
            node_id: paired.node_id.clone(),
            token: paired.token,
            hub_url: hub.clone(),
            paired_at: now_iso(),
        })
        .await
        .map_err(err)?;
        // 配置切到 pool 模式并指向**这次**配对的平台，不是配对前那一个。
        let backup = write_pool_connection(&self.config_path, &hub).await;
        // 配对已经提交；启动失败仍然在 getStatus 里看得见，不回滚配对。
        let _ = self.start_locked(&mut runtime).await;
        drop(runtime);

        to_json(&json!({
            "nodeId": paired.node_id,
            "tokenFile": file.to_string_lossy(),
            "configPath": self.config_path(),
            "backup": backup.map_err(err)?,
            "restarting": true,
        }))
    }

    /// 拉起上游的交互式登录。命令只认固定表，调用方只能传上游的名字。
    #[napi]
    pub async fn start_upstream_login(&self, name: String) -> Result<String> {
        let cfg = self.config()?;
        let provider = cfg.providers.get(&name)
            .ok_or_else(|| err(format!("本机配置里没有这个上游：{name}")))?;
        let argv = provider
            .auth_mode
            .and_then(|mode| login_command(mode.label()))
            .ok_or_else(|| err(format!("{name} 没有可拉起的登录命令")))?;
        let command = argv.join(" ");
        let credentials = CredentialRegistry::new(self.http.clone());
        match probe_credentials(provider, &name, &credentials, &self.env).await {
            Ok(()) => to_json(&json!({ "command": command, "launched": false, "alreadyAuthorized": true })),
            Err(_) => to_json(&json!({ "command": command, "launched": open_terminal(&command) })),
        }
    }

    // ---------- 本机工具 ----------

    #[napi]
    pub async fn get_tools(&self) -> Result<String> {
        to_json(&tool_statuses(&self.bridge_version).await)
    }

    #[napi]
    pub async fn upgrade_tool(&self, name: String) -> Result<String> {
        let command = upgrade_tool(&name).map_err(err)?;
        to_json(&json!({ "command": command }))
    }

    // ---------- token ----------

    /// token 的增删查改只动 tokenFile，桥接没在跑也能用 —— 桌面端在停止状态下
    /// 一样要能给同事签一个新的调用凭据。
    #[napi]
    pub async fn list_tokens(&self) -> Result<String> {
        to_json(&self.token_store()?.list())
    }

    #[napi]
    pub async fn create_token(
        &self,
        alias: String,
        scopes: Vec<String>,
        concurrency: Option<u32>,
    ) -> Result<CreatedToken> {
        let parsed = parse_scopes(&scopes)?;
        let store = self.token_store()?;
        if store.has_alias(&alias) {
            return Err(err("token alias already exists"));
        }
        let file = store.token_file().to_path_buf();
        let token = add_file_token(&file, &alias, &parsed, concurrency).map_err(err)?;
        self.reload_running_tokens().await?;
        Ok(CreatedToken { alias, token, scopes })
    }

    #[napi]
    pub async fn revoke_token(&self, alias: String) -> Result<bool> {
        let file = self.token_file()?;
        let removed = revoke_file_token(&file, &alias).map_err(err)?;
        self.reload_running_tokens().await?;
        Ok(removed)
    }

    #[napi]
    pub async fn reload_tokens(&self) -> Result<()> {
        self.reload_running_tokens().await
    }

    /// 只做格式检查，不返回内容：桌面端拿它判断 tokenFile 有没有被手改坏。
    #[napi]
    pub fn verify_token_file(&self) -> Result<u32> {
        let file = self.token_file()?;
        Ok(read_token_file(&file).map_err(err)?.tokens.len() as u32)
    }
}

// ---------- 内部实现 ----------

impl NativeBridge {
    fn config(&self) -> Result<AppConfig> {
        load_config(Some(&self.config_path), &self.env).map_err(err)
    }

    async fn identity(&self, cfg: &AppConfig) -> Option<NodeIdentity> {
        let file = resolve_node_token_file(cfg.pool.as_ref(), &self.env);
        let identity = read_node_identity(&file).await.ok().flatten()?;
        // 换过平台之后旧的令牌不算数：hubURL 对不上就当没配对。
        let configured = cfg.pool.as_ref().map(|p| p.hub_url.as_str()).unwrap_or_default();
        (identity.hub_url == configured).then_some(identity)
    }

    async fn start_locked(&self, runtime: &mut Runtime) -> Result<()> {
        if matches!(runtime.state, RunState::Running | RunState::Starting) {
            return Ok(());
        }
        let cfg = self.config()?;
        runtime.generation += 1;
        let generation = runtime.generation;
        runtime.last_error = None;
        runtime.state = RunState::Starting;

        let started = match cfg.mode {
            Mode::Pool => self.start_pool(runtime, cfg, generation).await,
            Mode::Relay => self.start_relay(runtime, cfg).await,
        };
        if let Err(message) = started {
            runtime.state = RunState::Error;
            runtime.last_error = Some(message.clone());
            self.stop_parts(runtime).await;
            return Err(err(message));
        }
        Ok(())
    }

    async fn start_relay(&self, runtime: &mut Runtime, cfg: AppConfig) -> std::result::Result<(), String> {
        let mut bridge = create_bridge(cfg, self.env.clone()).await?;
        bridge.listen().await?;
        runtime.relay = Some(bridge);
        runtime.state = RunState::Running;
        Ok(())
    }

    async fn start_pool(
        &self,
        runtime: &mut Runtime,
        cfg: AppConfig,
        generation: u64,
    ) -> std::result::Result<(), String> {
        let runner = Arc::new(
            create_pool_runner(cfg, self.env.clone(), self.bridge_version.clone(), self.http.clone()).await?,
        );
        runtime.pool = Some(Arc::clone(&runner));
        // hello 可能重试好几分钟。绝不能让 IPC 的这一次回复等在 Hub 上。
        let shared = Arc::clone(&self.runtime);
        tokio::spawn(async move {
            let result = runner.start().await;
            let mut runtime = shared.lock().await;
            if runtime.generation != generation {
                return;
            }
            match result {
                Ok(()) => runtime.state = RunState::Running,
                Err(message) => {
                    runtime.state = RunState::Error;
                    runtime.last_error = Some(message);
                }
            }
        });
        Ok(())
    }

    async fn stop_locked(&self, runtime: &mut Runtime) {
        runtime.generation += 1;
        self.stop_parts(runtime).await;
        runtime.state = RunState::Stopped;
        runtime.last_error = None;
    }

    async fn stop_parts(&self, runtime: &mut Runtime) {
        if let Some(pool) = runtime.pool.take() {
            pool.stop().await;
        }
        if let Some(mut relay) = runtime.relay.take() {
            relay.close().await;
        }
    }

    async fn status_json(&self) -> Result<String> {
        let cfg = self.config()?;
        let identity = self.identity(&cfg).await;
        let runtime = self.runtime.lock().await;
        let queue = runtime.relay.as_ref().map(|bridge| bridge.state.gate.stats());
        let mut out = json!({
            "state": runtime.state.label(),
            "mode": if cfg.mode == Mode::Pool { "pool" } else { "relay" },
            "paired": identity.is_some(),
            "nodeId": identity.as_ref().map(|i| i.node_id.clone()),
            "hubURL": cfg.pool.as_ref().map(|p| p.hub_url.clone()).unwrap_or_default(),
            "configPath": self.config_path(),
        });
        if let Some(error) = &runtime.last_error {
            out["error"] = json!(error);
        }
        if let Some(queue) = queue {
            out["queue"] = queue;
        }
        to_json(&prune_nulls(out))
    }

    fn token_file(&self) -> Result<PathBuf> {
        let cfg = self.config()?;
        Ok(resolve_token_file(&cfg.auth, &self.env))
    }

    fn token_store(&self) -> Result<TokenStore> {
        let cfg = self.config()?;
        let file = resolve_token_file(&cfg.auth, &self.env);
        let mut store = TokenStore::new(cfg.auth, file);
        store.load().map_err(err)?;
        Ok(store)
    }

    async fn reload_running_tokens(&self) -> Result<()> {
        let runtime = self.runtime.lock().await;
        if let Some(bridge) = runtime.relay.as_ref() {
            bridge.state.auth.reload_tokens().map_err(err)?;
        }
        Ok(())
    }
}

fn parse_scopes(scopes: &[String]) -> Result<Vec<Scope>> {
    if scopes.is_empty() {
        return Err(err("scopes 不能为空"));
    }
    scopes
        .iter()
        .map(|raw| match raw.as_str() {
            "relay:anthropic" => Ok(Scope::RelayAnthropic),
            "relay:openai" => Ok(Scope::RelayOpenai),
            "agent" => Ok(Scope::Agent),
            "admin" => Ok(Scope::Admin),
            "*" => Ok(Scope::All),
            other => Err(err(format!("未知的 scope：{other}"))),
        })
        .collect()
}

fn host_name() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "unknown".into())
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// 独立的配置解析入口：Node 侧在没建桥接实例时也要能校验一份配置。
#[napi]
pub fn parse_config_json(yaml: String) -> Result<String> {
    let env = Env::from_process();
    let raw: Value = serde_yaml::from_str(&yaml)
        .map_err(|e| err(format!("Invalid config: YAML 解析失败：{e}")))?;
    let raw = if raw.is_null() { Value::Object(Default::default()) } else { raw };
    let cfg = crate::config::parse_config(raw, &env).map_err(err)?;
    to_json(&cfg)
}
