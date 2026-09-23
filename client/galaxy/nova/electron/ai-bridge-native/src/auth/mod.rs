pub mod network;
pub mod principal;
pub mod token_store;

use crate::config::schema::{AuthConfig, Scope};
use crate::core::errors::{http_error, BridgeError};
use crate::log_warn;
use axum::http::HeaderMap;
use network::{is_loopback, IpAllowlist};
use principal::Principal;
use std::net::IpAddr;
use std::sync::RwLock;
use token_store::TokenStore;

/// 从请求里取 token：优先 Authorization: Bearer <token>，再 x-api-key。
/// 两个头都是主流 SDK 会自动带的（OpenAI SDK 用 Bearer，Anthropic SDK 用 x-api-key）。
pub fn extract_token(headers: &HeaderMap) -> Option<String> {
    if let Some(authz) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        let authz = authz.trim();
        if !authz.is_empty() {
            let bearer = authz.get(..7).filter(|p| p.eq_ignore_ascii_case("bearer "));
            return Some(match bearer {
                Some(_) => authz[7..].trim().to_string(),
                None => authz.to_string(),
            });
        }
    }
    headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// 认证 + 授权 + admin 的 loopback 限制。三件事都只读配置和 TokenStore，
/// 不碰传输层，所以 relay / admin / 未来的模块共用同一份。
pub struct Auth {
    cfg: AuthConfig,
    allowlist: IpAllowlist,
    pub tokens: RwLock<TokenStore>,
}

impl Auth {
    pub fn new(cfg: AuthConfig, tokens: TokenStore) -> Result<Self, String> {
        let allowlist = IpAllowlist::new(&cfg.ip_allowlist)?;
        if !cfg.enabled {
            log_warn!("auth_disabled", "message": "auth.enabled=false，鉴权已关闭，任何能连上的人都有全部权限。仅本机自用（host=127.0.0.1）时才这样配。");
        }
        Ok(Self { cfg, allowlist, tokens: RwLock::new(tokens) })
    }

    pub fn enabled(&self) -> bool { self.cfg.enabled }
    pub fn ip_allowlist(&self) -> &[String] { &self.cfg.ip_allowlist }

    /// 网络策略 + 认证。返回这次请求的调用方身份，失败即 401/403。
    pub fn authenticate(&self, ip: Option<IpAddr>, headers: &HeaderMap, path: &str) -> Result<Principal, BridgeError> {
        if !self.allowlist.allows(ip) {
            log_warn!("auth_ip_rejected", "ip": ip.map(|v| v.to_string()), "path": path);
            return Err(http_error(403, "ip_not_allowed", "source address not allowed"));
        }
        if !self.cfg.enabled {
            return Ok(Principal::anonymous());
        }
        let Some(token) = extract_token(headers) else {
            return Err(http_error(401, "missing_token",
                "missing API token (Authorization: Bearer <token> or x-api-key)"));
        };
        match self.tokens.read().unwrap().verify(&token) {
            Some(principal) => Ok(principal),
            None => {
                let prefix: String = token.chars().take(6).collect();
                log_warn!("auth_rejected", "ip": ip.map(|v| v.to_string()), "path": path, "tokenPrefix": prefix);
                Err(http_error(401, "invalid_token", "invalid API token"))
            }
        }
    }

    pub fn require_scope(&self, principal: &Principal, scope: Scope, path: &str) -> Result<(), BridgeError> {
        if principal.has_scope(scope) {
            return Ok(());
        }
        log_warn!("auth_forbidden", "alias": principal.alias, "scope": scope.label(), "path": path);
        Err(http_error(403, "insufficient_scope", format!("token lacks scope \"{}\"", scope.label())))
    }

    pub fn require_loopback_if_configured(&self, ip: Option<IpAddr>) -> Result<(), BridgeError> {
        if self.cfg.admin_loopback_only && !is_loopback(ip) {
            return Err(http_error(403, "loopback_only", "admin endpoints are only reachable from localhost"));
        }
        Ok(())
    }

    pub fn reload_tokens(&self) -> Result<usize, String> {
        let mut store = self.tokens.write().unwrap();
        store.load()?;
        Ok(store.size())
    }
}
