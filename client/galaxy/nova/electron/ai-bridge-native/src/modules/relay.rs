use crate::app::{client_ip, json_error, BridgeState};
use crate::config::schema::{ProviderType, Scope};
use crate::core::errors::{anthropic_error, http_error, openai_error, BridgeError};
use crate::core::proxy::{parse_body_limit, proxy_relay, RelayRequest};
use crate::core::queue::{AcquireOptions, GateGuard};
use crate::core::request::{begin_request, Cancel, RequestLifecycle};
use crate::credentials::{prepare_claude_request, resolve_upstream, WireApi};
use crate::credentials::types::UpstreamAuthContext;
use crate::{log_info, log_warn};
use axum::extract::{ConnectInfo, OriginalUri, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Instant;

// relay 模块：把 Anthropic Messages / OpenAI Responses / Chat Completions 转发到
// 用订阅登录态鉴权的上游。只补 Claude 订阅协议前缀，不执行客户端工具。

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Family { Anthropic, Openai }

#[derive(Clone, Copy)]
pub struct PathSpec {
    pub family: Family,
    pub scope: Scope,
    pub error_body: fn(u16, &str, &str) -> Value,
}

/// 路径 → (协议族, scope, 错误体形态)
pub const RELAY_PATHS: [(&str, PathSpec); 4] = [
    ("/v1/messages", PathSpec { family: Family::Anthropic, scope: Scope::RelayAnthropic, error_body: anthropic_error }),
    ("/v1/messages/count_tokens", PathSpec { family: Family::Anthropic, scope: Scope::RelayAnthropic, error_body: anthropic_error }),
    ("/v1/responses", PathSpec { family: Family::Openai, scope: Scope::RelayOpenai, error_body: openai_error }),
    ("/v1/chat/completions", PathSpec { family: Family::Openai, scope: Scope::RelayOpenai, error_body: openai_error }),
];

pub fn provider_for(state: &BridgeState, family: Family) -> Option<&String> {
    match family {
        Family::Anthropic => state.cfg.relay.anthropic.as_ref(),
        Family::Openai => state.cfg.relay.openai.as_ref(),
    }
}

pub fn routes(state: &BridgeState) -> Router<Arc<BridgeState>> {
    let mut router = Router::new();
    for (path, spec) in RELAY_PATHS {
        // 没配上游的协议族根本不挂载：请求落到全局 404，和 TS 侧一致。
        if provider_for(state, spec.family).is_none() {
            continue;
        }
        router = router.route(
            path,
            post(move |state, peer, uri, headers, body| handle(state, peer, uri, headers, body, path, spec)),
        );
    }
    router
}

/// 响应流走完（或被丢弃）时收尾：并发名额在这一刻才归还，日志也在这一刻才落。
struct RelayCompletion {
    request_id: String,
    alias: String,
    /// 上游状态码。响应头到手后才知道，而 completion 那时已经交给流持有了，
    /// 所以用一个共享格子回填。
    status: Arc<AtomicU16>,
    started: Instant,
    cancel: Cancel,
    _gate: GateGuard,
    _lifecycle: RequestLifecycle,
}

impl Drop for RelayCompletion {
    fn drop(&mut self) {
        let ms = self.started.elapsed().as_millis() as u64;
        if self.cancel.is_cancelled() {
            let reason = self.cancel.reason();
            if reason.code == "client_closed" {
                log_info!("relay_client_closed", "requestId": self.request_id, "alias": self.alias);
            } else {
                log_warn!("relay_error", "requestId": self.request_id, "alias": self.alias,
                    "status": reason.status, "code": reason.code, "message": reason.message);
            }
            return;
        }
        log_info!("relay_done", "requestId": self.request_id, "alias": self.alias,
            "status": self.status.load(Ordering::Relaxed), "ms": ms);
    }
}

async fn handle(
    State(state): State<Arc<BridgeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: axum::body::Body,
    path: &'static str,
    spec: PathSpec,
) -> Response {
    let fail = |e: BridgeError| json_error(&e, (spec.error_body)(e.status, &e.code, &e.message));

    let ip = client_ip(&state, peer, &headers);
    let principal = match state.auth.authenticate(ip, &headers, path) {
        Ok(principal) => principal,
        Err(e) => return json_error(&e, crate::core::errors::error_body(e.status, &e.code, &e.message)),
    };
    if let Err(e) = state.auth.require_scope(&principal, spec.scope, path) {
        return json_error(&e, crate::core::errors::error_body(e.status, &e.code, &e.message));
    }

    let limit = parse_body_limit(&state.cfg.server.body_limit);
    let raw_body = match axum::body::to_bytes(body, limit).await {
        Ok(bytes) => bytes,
        Err(_) => return fail(http_error(413, "payload_too_large", "request entity too large")),
    };
    // express.json 会先把体解出来；坏 JSON 在 TS 侧是 400 invalid_json，这里保持一致。
    let parsed: Option<Value> = if is_json_request(&headers) {
        match serde_json::from_slice(&raw_body) {
            Ok(value) => Some(value),
            Err(e) => return fail(http_error(400, "invalid_json", e.to_string())),
        }
    } else {
        None
    };

    let lifecycle = begin_request(
        headers.get("x-request-id").and_then(|v| v.to_str().ok()),
        state.cfg.server.request_timeout_ms,
        &state.shutdown,
    );
    let request_id = lifecycle.request_id.clone();
    let mut response = match relay(&state, &principal, &headers, &uri, path, spec, raw_body, parsed, lifecycle).await {
        Ok(response) => response,
        Err(e) => {
            if e.code == "client_closed" {
                log_info!("relay_client_closed", "requestId": request_id, "alias": principal.alias);
            } else {
                log_warn!("relay_error", "requestId": request_id, "alias": principal.alias,
                    "status": e.status, "code": e.code, "message": e.message);
            }
            fail(e)
        }
    };
    // 失败的请求同样要带 requestId：502/504 才是最需要拿它去对日志的时候。
    if let Ok(value) = axum::http::HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

fn is_json_request(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| value.split(';').next().unwrap_or("").trim().ends_with("json"))
}

#[allow(clippy::too_many_arguments)]
async fn relay(
    state: &Arc<BridgeState>,
    principal: &crate::auth::principal::Principal,
    headers: &HeaderMap,
    uri: &axum::http::Uri,
    path: &'static str,
    spec: PathSpec,
    raw_body: bytes::Bytes,
    parsed: Option<Value>,
    lifecycle: RequestLifecycle,
) -> Result<Response, BridgeError> {
    let provider_name = provider_for(state, spec.family).cloned().ok_or_else(|| {
        let family = if spec.family == Family::Anthropic { "anthropic" } else { "openai" };
        http_error(404, "relay_not_configured", format!("relay.{family} 未配置，{path} 不可用"))
    })?;
    let pc = state.cfg.providers.get(&provider_name).filter(|p| p.kind == ProviderType::Relay).ok_or_else(|| {
        http_error(500, "relay_misconfigured", format!("provider \"{provider_name}\" 不存在或不是 relay"))
    })?;

    let credential = state.credentials.resolve(pc).map_err(|m| http_error(500, "relay_misconfigured", m))?;
    if !credential.supports_path(path) {
        return Err(http_error(400, "unsupported_protocol",
            format!("authMode={} 不支持 {path}", credential.mode())));
    }

    // 上游跟着本机正在用的走：接了中转站就打中转站，没接就打订阅官方。
    let upstream = resolve_upstream(pc, &state.env)
        .await
        .map_err(|m| http_error(502, "relay_upstream_unresolved", m))?;
    if upstream.wire_api == Some(WireApi::Chat) && path == "/v1/responses" {
        return Err(http_error(400, "unsupported_protocol",
            format!("本机 Codex 中转的 wire_api 是 chat，承接不了 {path}")));
    }

    let auth_headers = credential
        .headers(&UpstreamAuthContext {
            headers,
            principal,
            request_id: &lifecycle.request_id,
            provider: pc,
            provider_name: &provider_name,
            upstream: &upstream,
            env: &state.env,
        })
        .await
        .map_err(|m| http_error(502, "relay_auth_failed", m))?;

    let gate = state
        .gate
        .acquire(AcquireOptions {
            provider_name: &provider_name,
            principal_alias: Some(&principal.alias),
            principal_limit: principal.concurrency,
            wait_timeout_ms: state.cfg.server.queue_wait_timeout_ms,
            cancel: &lifecycle.cancel,
        })
        .await?;

    let started = Instant::now();
    log_info!("relay_start",
        "requestId": lifecycle.request_id, "alias": principal.alias, "provider": provider_name,
        "authMode": credential.mode(), "path": path, "upstream": upstream.base_url,
        "model": parsed.as_ref().and_then(|b| b.get("model")).and_then(Value::as_str),
        "stream": parsed.as_ref().and_then(|b| b.get("stream")) == Some(&Value::Bool(true)));

    let request = RelayRequest {
        path: path.to_string(),
        query: uri.query().map(|q| format!("?{q}")).unwrap_or_default(),
        base_url: upstream.base_url.clone(),
        accept: headers.get(axum::http::header::ACCEPT).and_then(|v| v.to_str().ok()).map(str::to_string),
        auth_headers: auth_headers.into_iter().collect(),
        body: prepare_claude_request(raw_body, pc, &upstream),
        idle_timeout_ms: Some(state.cfg.server.stream_idle_timeout_ms),
        request_id: lifecycle.request_id.clone(),
    };

    let cancel = lifecycle.cancel.clone();
    let request_id = lifecycle.request_id.clone();
    let status = Arc::new(AtomicU16::new(0));
    let completion = RelayCompletion {
        request_id: request_id.clone(),
        alias: principal.alias.clone(),
        status: Arc::clone(&status),
        started,
        cancel: cancel.clone(),
        _gate: gate,
        _lifecycle: lifecycle,
    };
    let response = proxy_relay(&state.client, request, &cancel, completion).await?;
    status.store(response.status().as_u16(), Ordering::Relaxed);
    Ok(response)
}
