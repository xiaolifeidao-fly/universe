#![allow(dead_code)]
use ai_bridge_native::app::{create_bridge, Bridge};
use ai_bridge_native::config::parse_config;
use ai_bridge_native::core::logger::set_silent;
use ai_bridge_native::core::paths::Env;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, Uri};
use axum::response::Response;
use serde_json::{json, Value};
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tempfile::TempDir;

pub const CLIENT_TOKEN: &str = "client-test-secret-0001";
pub const ADMIN_TOKEN: &str = "admin-test-secret-0001";
pub const OPENAI_ONLY_TOKEN: &str = "openai-only-secret-0001";

pub struct UpstreamRequest {
    pub method: Method,
    pub uri: Uri,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl UpstreamRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    /// 请求行里客户端看到的那一段：路径 + 查询串。
    pub fn url(&self) -> String {
        self.uri.path_and_query().map(|v| v.to_string()).unwrap_or_default()
    }
}

pub type UpstreamFuture = Pin<Box<dyn Future<Output = Response> + Send>>;
pub type UpstreamHandler = Arc<dyn Fn(UpstreamRequest) -> UpstreamFuture + Send + Sync>;

pub fn handler<F, Fut>(f: F) -> UpstreamHandler
where
    F: Fn(UpstreamRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Response> + Send + 'static,
{
    Arc::new(move |req| Box::pin(f(req)))
}

pub struct Harness {
    pub url: String,
    pub upstream_origin: String,
    pub dir: TempDir,
    pub auth_file: std::path::PathBuf,
    calls: Arc<AtomicUsize>,
    pub bridge: Bridge,
    pub client: reqwest::Client,
}

impl Harness {
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    /// 不带调用凭据。reqwest 的 header() 是追加不是替换，所以要换 token 的用例
    /// 必须从这里起手，否则两个 x-api-key 里生效的是先加的那个。
    pub fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.url))
            .header("content-type", "application/json")
    }
    pub fn authed(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.request(method, path).header("x-api-key", CLIENT_TOKEN)
    }
    pub async fn post(&self, path: &str, body: impl Into<reqwest::Body>) -> reqwest::Response {
        self.authed(Method::POST, path).body(body).send().await.expect("bridge post")
    }
    pub async fn post_json(&self, path: &str, body: &Value) -> reqwest::Response {
        self.post(path, serde_json::to_string(body).unwrap()).await
    }
    pub async fn get(&self, path: &str) -> reqwest::Response {
        self.authed(Method::GET, path).send().await.expect("bridge get")
    }
    pub async fn close(mut self) {
        self.bridge.close().await;
    }
}

/// 与 TS 侧 test/helpers.ts 同形的测试装置：一个假上游 + 一座桥。
pub async fn harness(upstream: UpstreamHandler, overrides: Value) -> Harness {
    harness_with_env(upstream, overrides, vec![]).await
}

pub async fn harness_with_env(
    upstream: UpstreamHandler,
    overrides: Value,
    extra_env: Vec<(String, String)>,
) -> Harness {
    set_silent(std::env::var("LOG_LEVEL").as_deref() != Ok("debug"));
    let dir = tempfile::tempdir().expect("tempdir");
    let auth_file = dir.path().join("credentials.json");
    let expires = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64 + 600_000;
    std::fs::write(
        &auth_file,
        serde_json::to_vec(&json!({ "claudeAiOauth": {
            "accessToken": "upstream-test-secret", "expiresAt": expires, "scopes": ["user:inference"],
        } }))
        .unwrap(),
    )
    .unwrap();

    let calls = Arc::new(AtomicUsize::new(0));
    let origin = start_upstream(upstream, Arc::clone(&calls)).await;

    let mut env: Vec<(String, String)> = vec![
        ("AI_BRIDGE_RUNTIME_DIR".into(), dir.path().to_string_lossy().into_owned()),
    ];
    env.extend(extra_env);
    let env = Env::from_pairs(env);

    let mut raw = json!({
        "server": { "host": "127.0.0.1", "port": 0 },
        "concurrency": { "global": 2, "queueMaxSize": 4 },
        "retry": { "maxAttempts": 1 },
        "auth": {
            "enabled": true,
            "tokens": [
                { "token": CLIENT_TOKEN, "alias": "test", "scopes": ["relay:anthropic", "relay:openai"], "concurrency": 1 },
                { "token": ADMIN_TOKEN, "alias": "admin", "scopes": ["*"] },
                { "token": OPENAI_ONLY_TOKEN, "alias": "openai-only", "scopes": ["relay:openai"] },
            ],
        },
        "providers": {
            "claude": { "type": "relay", "authMode": "claude_oauth", "authFile": auth_file, "baseURL": format!("{origin}/v1"), "concurrency": 2 },
            "codex": { "type": "relay", "authMode": "api_key", "apiKey": "codex-test-secret", "baseURL": format!("{origin}/codex") },
        },
        "relay": { "enabled": true, "anthropic": "claude", "openai": "codex" },
        "agent": { "enabled": false },
        "admin": { "enabled": true },
    });
    merge(&mut raw, overrides);

    let cfg = parse_config(raw, &env).expect("test config");
    let mut bridge = create_bridge(cfg, env).await.expect("create bridge");
    let addr = bridge.listen().await.expect("listen");

    Harness {
        url: format!("http://127.0.0.1:{}", addr.port()),
        upstream_origin: origin,
        dir,
        auth_file,
        calls,
        bridge,
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
    }
}

/// 顶层键整体替换，与 TS 侧 `overrides.auth ?? {...}` 的语义一致。
fn merge(base: &mut Value, overrides: Value) {
    let (Some(base), Value::Object(overrides)) = (base.as_object_mut(), overrides) else { return };
    for (key, value) in overrides {
        base.insert(key, value);
    }
}

pub async fn start_upstream(handler: UpstreamHandler, calls: Arc<AtomicUsize>) -> String {
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let handler = Arc::clone(&handler);
        let calls = Arc::clone(&calls);
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let (parts, body) = req.into_parts();
            let body = axum::body::to_bytes(body, 64 * 1024 * 1024).await.unwrap_or_default();
            handler(UpstreamRequest {
                method: parts.method,
                uri: parts.uri,
                headers: parts.headers,
                body,
            })
            .await
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("upstream bind");
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://127.0.0.1:{}", addr.port())
}

pub fn tool_request() -> Value {
    json!({
        "model": "claude-sonnet-4-5", "max_tokens": 64,
        "system": [{ "type": "text", "text": "Client system", "cache_control": { "type": "ephemeral" } }],
        "messages": [
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "tool_1", "name": "Read", "input": { "path": "测试.txt" } }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "tool_1", "content": "local client result" }] },
        ],
        "tools": [{ "name": "Read", "input_schema": { "type": "object", "properties": { "path": { "type": "string" } } } }],
        "thinking": { "type": "adaptive" }, "metadata": { "user_id": "client-session" },
    })
}

pub async fn error_type(response: reqwest::Response) -> String {
    let body: Value = response.json().await.expect("error body is json");
    body.pointer("/error/type").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// 只需要一条通道存在、不真的跑单元时用的占位 provider。
pub fn fake_provider() -> std::sync::Arc<dyn ai_bridge_native::business::Provider> {
    use ai_bridge_native::business::*;
    struct Fake;
    #[async_trait::async_trait]
    impl Provider for Fake {
        fn kinds(&self) -> Vec<KindDecl> { vec![] }
        async fn probe(&self) -> ProbeStatus {
            ProbeStatus { resources: local_resources(), upstream_ok: true, detail: None }
        }
        fn run(&self, _unit: WorkUnit, _io: UnitIo) -> futures_util::stream::BoxStream<'static, UnitEvent> {
            Box::pin(futures_util::stream::empty())
        }
    }
    std::sync::Arc::new(Fake)
}

/// 不带鉴权、不建桥的裸上游：给 provider 层的用例用。
pub async fn start_plain_upstream<F, Fut>(handler: F) -> String
where
    F: Fn(UpstreamRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Response> + Send + 'static,
{
    start_upstream(self::handler(handler), Arc::new(AtomicUsize::new(0))).await
}

pub fn relay_provider_config(
    auth_mode: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> ai_bridge_native::config::schema::ProviderConfig {
    use ai_bridge_native::config::schema::*;
    ProviderConfig {
        kind: ProviderType::Relay,
        api_key: api_key.map(str::to_string),
        base_url: base_url.map(str::to_string),
        auth_mode: Some(match auth_mode {
            "claude_oauth" => AuthMode::ClaudeOauth,
            "codex_chatgpt" => AuthMode::CodexChatgpt,
            _ => AuthMode::ApiKey,
        }),
        auth_file: None, claude_keychain_service: None, models: None, models_client_version: None,
        concurrency: None, queue_max_size: None, timeout_ms: None, codex: None, claude_code: None,
    }
}
