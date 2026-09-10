use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------- 上游 provider ----------
// relay              = 纯透传：把请求原样转发到上游模型 API，桥接不解析、不执行工具。
// codex_local        = 在桥接所在机器跑 codex agent（会执行命令、写文件），属 agent 模块。
// claude_code_local  = 在桥接所在机器跑 Claude Code agent，属 agent 模块。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType { Relay, CodexLocal, ClaudeCodeLocal }

impl ProviderType {
    pub fn label(self) -> &'static str {
        match self {
            ProviderType::Relay => "relay",
            ProviderType::CodexLocal => "codex_local",
            ProviderType::ClaudeCodeLocal => "claude_code_local",
        }
    }
}

// relay 的上游鉴权方式（对应 src/credentials 下的一个 CredentialProvider）：
//   codex_chatgpt = 本机 codex 订阅登录态（~/.codex/auth.json）直连 ChatGPT 后端
//   claude_oauth  = 本机 Claude Code 订阅登录态，转发 Anthropic Messages
//   api_key       = 用 apiKey 作 Bearer（转发到任意兼容 API）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode { CodexChatgpt, ClaudeOauth, ApiKey }

impl AuthMode {
    pub fn label(self) -> &'static str {
        match self {
            AuthMode::CodexChatgpt => "codex_chatgpt",
            AuthMode::ClaudeOauth => "claude_oauth",
            AuthMode::ApiKey => "api_key",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_path_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<ApprovalPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_git_repo_check: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode { ReadOnly, WorkspaceWrite, DangerFullAccess }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy { Never, OnRequest, OnFailure, Untrusted }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort { Minimal, Low, Medium, High, Xhigh }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode { Default, AcceptEdits, BypassPermissions, Plan, DontAsk, Auto }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolsPreset { ClaudeCode, None }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCodeOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, rename = "additionalDirectories", skip_serializing_if = "Option::is_none")]
    pub additional_directories: Option<Vec<String>>,
    #[serde(default, rename = "allowedTools", skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, rename = "disallowedTools", skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default, rename = "toolsPreset", skip_serializing_if = "Option::is_none")]
    pub tools_preset: Option<ToolsPreset>,
    #[serde(default, rename = "systemPrompt", skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, rename = "maxTurns", skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(rename = "type")]
    pub kind: ProviderType,
    #[serde(default, rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 上游地址。claude_oauth / codex_chatgpt 可以不写：跟着本机 Claude Code / Codex
    /// 正在用的上游走 —— 本机接了中转站就打中转站，没接就打订阅官方。
    /// 写了就是主人的明确决定，以它为准。api_key 必须写。
    #[serde(default, rename = "baseURL", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, rename = "authMode", skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,
    /// codex_chatgpt: auth.json 路径；claude_oauth: .credentials.json 路径
    #[serde(default, rename = "authFile", skip_serializing_if = "Option::is_none")]
    pub auth_file: Option<String>,
    #[serde(default, rename = "claudeKeychainService", skip_serializing_if = "Option::is_none")]
    pub claude_keychain_service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(default, rename = "modelsClientVersion", skip_serializing_if = "Option::is_none")]
    pub models_client_version: Option<String>,
    /// 仅作用于该 provider 的并发上限；不填走全局
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    #[serde(default, rename = "queueMaxSize", skip_serializing_if = "Option::is_none")]
    pub queue_max_size: Option<u32>,
    #[serde(default, rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexOptions>,
    #[serde(default, rename = "claudeCode", skip_serializing_if = "Option::is_none")]
    pub claude_code: Option<ClaudeCodeOptions>,
}

// ---------- 访问控制 ----------
// scope 决定一个 token 能碰哪些模块。"*" 是全部。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Scope {
    #[serde(rename = "relay:anthropic")] RelayAnthropic,
    #[serde(rename = "relay:openai")] RelayOpenai,
    #[serde(rename = "agent")] Agent,
    #[serde(rename = "admin")] Admin,
    #[serde(rename = "*")] All,
}

impl Scope {
    pub fn label(self) -> &'static str {
        match self {
            Scope::RelayAnthropic => "relay:anthropic",
            Scope::RelayOpenai => "relay:openai",
            Scope::Agent => "agent",
            Scope::Admin => "admin",
            Scope::All => "*",
        }
    }
}

fn default_scopes() -> Vec<Scope> { vec![Scope::RelayAnthropic, Scope::RelayOpenai] }

/// 单个访问凭据。token（明文）和 tokenHash（sha256 hex）二选一；
/// alias 用于日志/审计与 CLI 操作，必须唯一。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthToken {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, rename = "tokenHash", skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<String>,
    pub alias: String,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<Scope>,
    /// 该 token 同时在跑的请求上限；不填不限（仍受全局/provider 闸门约束）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    #[serde(default)]
    pub disabled: bool,
    /// tokenFile 里 CLI 写的时间戳；解析时保留，重写文件时不丢。
    #[serde(default, rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

fn yes() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    /// 关掉后所有请求都当 anonymous、拥有全部 scope。仅本机自用、且监听 127.0.0.1 时才这样配。
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub tokens: Vec<AuthToken>,
    /// CLI `ai-bridge token add` 维护的文件；不填走 <runtimeDir>/tokens.json
    #[serde(default, rename = "tokenFile", skip_serializing_if = "Option::is_none")]
    pub token_file: Option<String>,
    /// 允许访问的来源 IP/CIDR，空 = 不限制。示例："127.0.0.1"、"10.0.0.0/8"、"::1"
    #[serde(default, rename = "ipAllowlist")]
    pub ip_allowlist: Vec<String>,
    /// /admin/* 是否只允许 loopback 来源（即便带了 admin scope）
    #[serde(default = "yes", rename = "adminLoopbackOnly")]
    pub admin_loopback_only: bool,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self { enabled: true, tokens: vec![], token_file: None, ip_allowlist: vec![], admin_loopback_only: true }
    }
}

// ---------- 模块 ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// /v1/messages、/v1/messages/count_tokens 走哪个 provider（必须 type=relay 且有 baseURL）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic: Option<String>,
    /// /v1/responses、/v1/chat/completions 走哪个 provider
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai: Option<String>,
}

impl Default for RelayConfig {
    fn default() -> Self { Self { enabled: true, anthropic: None, openai: None } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRoute {
    #[serde(rename = "match")]
    pub pattern: String,
    pub provider: String,
    #[serde(default, rename = "rewriteTo", skip_serializing_if = "Option::is_none")]
    pub rewrite_to: Option<String>,
}

fn default_agent_header() -> String { "x-ai-agent".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// 默认关：开了意味着桥接所在机器会替客户端执行命令、写文件
    #[serde(default)]
    pub enabled: bool,
    /// 请求带这个头（值非空）时才走 agent；否则同一路径走 relay
    #[serde(default = "default_agent_header")]
    pub header: String,
    /// 顺序匹配，命中即用；支持 * 通配
    #[serde(default)]
    pub routes: Vec<ModelRoute>,
}

impl Default for AgentConfig {
    fn default() -> Self { Self { enabled: false, header: default_agent_header(), routes: vec![] } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
}

impl Default for AdminConfig {
    fn default() -> Self { Self { enabled: true } }
}

// ---------- 共享算力池（pool 模式） ----------
// pool 模式下节点只主动出站连 Hub（P-15）。这一段本进程不消费，
// 但要原样解析出来交给 pool 运行循环，所以字段与校验和 relay 段同等对待。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotaWindow { Day, Week, Month, Total }

fn default_window() -> QuotaWindow { QuotaWindow::Day }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolQuota {
    pub unit: String,
    pub limit: u64,
    #[serde(default = "default_window")]
    pub window: QuotaWindow,
    #[serde(default, rename = "resetAt", skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolSchedule {
    pub window: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

/// 本机执行器：agent 回合、ffmpeg 渲染这类「在主人机器上跑命令」的能力用它。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolExec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

fn default_kind() -> String { "llm.chat".into() }
fn one() -> u32 { 1 }
fn three() -> u32 { 3 }
fn two() -> u32 { 2 }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelFilter {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolContribution {
    pub id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "one", rename = "kindVersion")]
    pub kind_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec: Option<PoolExec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default)]
    pub models: ModelFilter,
    #[serde(default = "three")]
    pub seats: u32,
    #[serde(default = "two", rename = "seatConcurrency")]
    pub seat_concurrency: u32,
    pub quota: Vec<PoolQuota>,
    #[serde(default)]
    pub schedule: Vec<PoolSchedule>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn heartbeat_sec() -> u32 { 15 }
fn next_wait_sec() -> u32 { 25 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    #[serde(rename = "hubURL")]
    pub hub_url: String,
    #[serde(default, rename = "tokenFile", skip_serializing_if = "Option::is_none")]
    pub token_file: Option<String>,
    #[serde(default = "heartbeat_sec", rename = "heartbeatSec")]
    pub heartbeat_sec: u32,
    #[serde(default = "next_wait_sec", rename = "nextWaitSec")]
    pub next_wait_sec: u32,
    /// 契约版本。与 Hub 不一致时 hello 被拒，节点停止重试并提示升级（S-11）。
    #[serde(default = "one")]
    pub contract: u32,
    #[serde(default)]
    pub contributions: Vec<PoolContribution>,
}

// ---------- 顶层 ----------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode { Relay, Pool }

fn default_mode() -> Mode { Mode::Relay }
fn default_host() -> String { "127.0.0.1".into() }
fn default_port() -> u16 { 8787 }
fn request_timeout() -> u64 { 600_000 }
fn queue_wait_timeout() -> u64 { 30_000 }
fn stream_idle_timeout() -> u64 { 60_000 }
fn shutdown_timeout() -> u64 { 30_000 }
fn default_body_limit() -> String { "4mb".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// 默认只监听本机。要给别的机器用，显式改 0.0.0.0 并配 auth.ipAllowlist
    #[serde(default = "default_host")]
    pub host: String,
    /// 0 = 随机端口（测试用）
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "request_timeout", rename = "requestTimeoutMs")]
    pub request_timeout_ms: u64,
    #[serde(default = "queue_wait_timeout", rename = "queueWaitTimeoutMs")]
    pub queue_wait_timeout_ms: u64,
    #[serde(default = "stream_idle_timeout", rename = "streamIdleTimeoutMs")]
    pub stream_idle_timeout_ms: u64,
    #[serde(default = "shutdown_timeout", rename = "shutdownTimeoutMs")]
    pub shutdown_timeout_ms: u64,
    #[serde(default = "default_body_limit", rename = "bodyLimit")]
    pub body_limit: String,
    /// 在反向代理后面时打开，取 X-Forwarded-For 作为来源 IP
    #[serde(default, rename = "trustProxy")]
    pub trust_proxy: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(), port: default_port(),
            request_timeout_ms: request_timeout(), queue_wait_timeout_ms: queue_wait_timeout(),
            stream_idle_timeout_ms: stream_idle_timeout(), shutdown_timeout_ms: shutdown_timeout(),
            body_limit: default_body_limit(), trust_proxy: false,
        }
    }
}

fn default_level() -> String { "info".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogConfig {
    #[serde(default = "default_level")]
    pub level: String,
}

impl Default for LogConfig {
    fn default() -> Self { Self { level: default_level() } }
}

fn global_concurrency() -> u32 { 32 }
fn global_queue_max() -> u32 { 256 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConcurrencyConfig {
    #[serde(default = "global_concurrency")]
    pub global: u32,
    #[serde(default = "global_queue_max", rename = "queueMaxSize")]
    pub queue_max_size: u32,
}

impl Default for ConcurrencyConfig {
    fn default() -> Self { Self { global: global_concurrency(), queue_max_size: global_queue_max() } }
}

fn max_attempts() -> u32 { 3 }
fn base_delay() -> u64 { 500 }
fn max_delay() -> u64 { 8_000 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    #[serde(default = "max_attempts", rename = "maxAttempts")]
    pub max_attempts: u32,
    #[serde(default = "base_delay", rename = "baseDelayMs")]
    pub base_delay_ms: u64,
    #[serde(default = "max_delay", rename = "maxDelayMs")]
    pub max_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self { max_attempts: max_attempts(), base_delay_ms: base_delay(), max_delay_ms: max_delay() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// relay = 本机监听、给本机客户端用；pool = 不监听、把算力贡献给共享池。两者互斥。
    #[serde(default = "default_mode")]
    pub mode: Mode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool: Option<PoolConfig>,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub log: LogConfig,
    #[serde(default)]
    pub concurrency: ConcurrencyConfig,
    #[serde(default)]
    pub retry: RetryConfig,
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderConfig>,
    #[serde(default)]
    pub relay: RelayConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub admin: AdminConfig,
}
