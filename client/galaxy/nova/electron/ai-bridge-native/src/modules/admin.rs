use crate::app::{client_ip, json_error, BridgeState};
use crate::auth::token_store::{add_file_token, revoke_file_token};
use crate::config::schema::Scope;
use crate::core::errors::{error_body, http_error, BridgeError};
use crate::log_info;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;

/// admin 模块：运行时看状态、管 token。默认只允许 loopback + admin scope。
/// 所有写操作只动 tokenFile，不改 config.yaml。
pub fn routes() -> Router<Arc<BridgeState>> {
    Router::new()
        .route("/admin/status", get(status))
        .route("/admin/tokens", get(list_tokens).post(create_token))
        .route("/admin/tokens/{alias}", axum::routing::delete(revoke_token))
        .route("/admin/tokens/reload", post(reload_tokens))
}

fn guard(
    state: &BridgeState,
    peer: SocketAddr,
    headers: &HeaderMap,
    path: &str,
) -> Result<(), BridgeError> {
    let ip = client_ip(state, peer, headers);
    let principal = state.auth.authenticate(ip, headers, path)?;
    state.auth.require_loopback_if_configured(ip)?;
    state.auth.require_scope(&principal, Scope::Admin, path)
}

fn fail(e: BridgeError) -> Response {
    json_error(&e, error_body(e.status, &e.code, &e.message))
}

async fn status(
    State(state): State<Arc<BridgeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = guard(&state, peer, &headers, "/admin/status") {
        return fail(e);
    }
    let tokens = state.auth.tokens.read().unwrap().size();
    Json(json!({
        "ok": true,
        "pid": std::process::id(),
        "uptimeSec": state.started_at.elapsed().as_secs(),
        "queue": state.gate.stats(),
        "relay": { "anthropic": state.cfg.relay.anthropic, "openai": state.cfg.relay.openai },
        "agent": { "enabled": state.cfg.agent.enabled, "header": state.cfg.agent.header },
        "auth": { "enabled": state.auth.enabled(), "tokens": tokens, "ipAllowlist": state.auth.ip_allowlist() },
    }))
    .into_response()
}

async fn list_tokens(
    State(state): State<Arc<BridgeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = guard(&state, peer, &headers, "/admin/tokens") {
        return fail(e);
    }
    let list = state.auth.tokens.read().unwrap().list();
    Json(json!({ "tokens": list })).into_response()
}

#[derive(Deserialize)]
struct AddTokenBody {
    alias: String,
    #[serde(default = "default_scopes")]
    scopes: Vec<Scope>,
    #[serde(default)]
    concurrency: Option<u32>,
}

fn default_scopes() -> Vec<Scope> { vec![Scope::RelayAnthropic, Scope::RelayOpenai] }

async fn create_token(
    State(state): State<Arc<BridgeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err(e) = guard(&state, peer, &headers, "/admin/tokens") {
        return fail(e);
    }
    let parsed: Result<AddTokenBody, _> = serde_json::from_slice(&body);
    let Ok(payload) = parsed else {
        return fail(http_error(400, "invalid_request", "请求体不是合法的建 token 请求"));
    };
    if payload.scopes.is_empty() {
        return fail(http_error(400, "invalid_request", "scopes 不能为空"));
    }
    if state.auth.tokens.read().unwrap().has_alias(&payload.alias) {
        return fail(http_error(409, "alias_exists", format!("alias \"{}\" 已存在", payload.alias)));
    }
    let file = state.auth.tokens.read().unwrap().token_file().to_path_buf();
    let token = match add_file_token(&file, &payload.alias, &payload.scopes, payload.concurrency) {
        Ok(token) => token,
        Err(message) => return fail(http_error(400, "invalid_request", message)),
    };
    if let Err(message) = state.auth.reload_tokens() {
        return fail(http_error(500, "token_reload_failed", message));
    }
    let scopes: Vec<&str> = payload.scopes.iter().map(|s| s.label()).collect();
    log_info!("admin_token_added", "alias": payload.alias, "scopes": scopes);
    // 明文 token 只在这一次响应里出现
    (StatusCode::CREATED, Json(json!({ "alias": payload.alias, "token": token, "scopes": scopes }))).into_response()
}

async fn revoke_token(
    State(state): State<Arc<BridgeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(alias): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = guard(&state, peer, &headers, "/admin/tokens") {
        return fail(e);
    }
    let file = state.auth.tokens.read().unwrap().token_file().to_path_buf();
    match revoke_file_token(&file, &alias) {
        Ok(true) => {}
        Ok(false) => {
            return fail(http_error(404, "alias_not_found",
                format!("alias \"{alias}\" 不在 token 文件里（config 内联的 token 请改配置文件）")))
        }
        Err(message) => return fail(http_error(500, "token_write_failed", message)),
    }
    if let Err(message) = state.auth.reload_tokens() {
        return fail(http_error(500, "token_reload_failed", message));
    }
    log_info!("admin_token_revoked", "alias": alias);
    Json(json!({ "ok": true })).into_response()
}

async fn reload_tokens(
    State(state): State<Arc<BridgeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = guard(&state, peer, &headers, "/admin/tokens") {
        return fail(e);
    }
    match state.auth.reload_tokens() {
        Ok(count) => Json(json!({ "ok": true, "tokens": count })).into_response(),
        Err(message) => fail(http_error(500, "token_reload_failed", message)),
    }
}
