use super::local_upstream::UpstreamAuthKind;
use super::types::{CredentialProvider, UpstreamAuthContext};
use crate::core::paths::{expand_home, home_dir};
use crate::log_info;
use base64::Engine;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex;

// 本机 codex ChatGPT 订阅登录态（~/.codex/auth.json）→ 直连 ChatGPT 后端所需的鉴权。
// 桥接不跑 agent，只拿这套 token 把模型能力中转出去。

/// codex 的 OAuth client_id（与 auth.json 里 id_token 的 aud 一致，刷新时要用）
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_ENDPOINT: &str = "https://auth.openai.com/oauth/token";
/// access_token 剩余有效期低于这个阈值就提前刷新
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

pub struct CodexCreds {
    pub access_token: String,
    pub account_id: String,
}

fn default_auth_path() -> PathBuf {
    home_dir().join(".codex").join("auth.json")
}

/// 解析 JWT 的 exp（毫秒）。解不出来返回 0（按"需要刷新"处理）。
pub fn jwt_exp_ms(token: &str) -> i64 {
    let Some(payload) = token.split('.').nth(1) else { return 0 };
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')) else {
        return 0;
    };
    let Ok(json) = serde_json::from_slice::<Value>(&bytes) else { return 0 };
    json.get("exp").and_then(Value::as_f64).map(|exp| (exp * 1000.0) as i64).unwrap_or(0)
}

fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// 进程内串行化：避免并发请求同时触发刷新、互相覆盖 auth.json
fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

async fn read_auth(path: &Path) -> Result<Value, String> {
    let raw = tokio::fs::read_to_string(path).await.map_err(|_| {
        format!("读不到 codex 登录态 {}（桥接所在机器需先 codex login）", path.display())
    })?;
    serde_json::from_str(&raw).map_err(|_| {
        format!("读不到 codex 登录态 {}（桥接所在机器需先 codex login）", path.display())
    })
}

fn token_field(auth: &Value, name: &str) -> Option<String> {
    auth.get("tokens")?.get(name)?.as_str().map(str::to_string)
}

async fn refresh_tokens(client: &reqwest::Client, path: &Path, auth: Value) -> Result<Value, String> {
    let refresh_token = token_field(&auth, "refresh_token")
        .ok_or("auth.json 缺 refresh_token，无法刷新；请在桥接所在机器重新 codex login")?;

    let response = client
        .post(TOKEN_ENDPOINT)
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "client_id": CODEX_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "openid profile email offline_access",
        }))
        .send()
        .await
        .map_err(|_| "刷新 codex token 失败；请在桥接所在机器重新 codex login".to_string())?;
    if !response.status().is_success() {
        // 不把响应体原文带出去：可能含账号信息
        return Err(format!(
            "刷新 codex token 失败，HTTP {}；请在桥接所在机器重新 codex login",
            response.status().as_u16(),
        ));
    }
    let data: Value = response.json().await.map_err(|_| "刷新 codex token 的响应不是 JSON".to_string())?;

    let mut next = auth.clone();
    let tokens = next.get_mut("tokens").and_then(Value::as_object_mut);
    let mut fresh = match tokens {
        Some(existing) => existing.clone(),
        None => serde_json::Map::new(),
    };
    for key in ["access_token", "id_token", "refresh_token"] {
        if let Some(value) = data.get(key).and_then(Value::as_str) {
            fresh.insert(key.into(), Value::String(value.to_string()));
        }
    }
    if let Some(object) = next.as_object_mut() {
        object.insert("tokens".into(), Value::Object(fresh));
        object.insert(
            "last_refresh".into(),
            Value::String(
                time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
            ),
        );
    }

    // 原子写回：先写临时文件再 rename，避免写一半被读到
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    tokio::fs::write(&tmp, text.as_bytes()).await.map_err(|e| format!("写 auth.json 失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await;
    }
    tokio::fs::rename(&tmp, path).await.map_err(|e| format!("写 auth.json 失败：{e}"))?;
    log_info!("codex_token_refreshed", "path": path.display().to_string());
    Ok(next)
}

/// 取可用的订阅鉴权：必要时自动刷新并写回 auth.json
pub async fn get_codex_creds(client: &reqwest::Client, auth_file: Option<&str>) -> Result<CodexCreds, String> {
    let path = auth_file.map(expand_home).unwrap_or_else(default_auth_path);
    let mut auth = read_auth(&path).await?;

    if let Some(mode) = auth.get("auth_mode").and_then(Value::as_str) {
        if mode != "chatgpt" {
            return Err(format!("auth.json auth_mode={mode}，不是 chatgpt 订阅登录"));
        }
    }

    let mut access = token_field(&auth, "access_token");
    let account_id = token_field(&auth, "account_id");
    let (Some(current), Some(account_id)) = (access.clone(), account_id) else {
        return Err("auth.json 缺 access_token / account_id".into());
    };

    if jwt_exp_ms(&current) - now_ms() < REFRESH_SKEW_MS {
        let _guard = refresh_lock().lock().await;
        // 轮到自己时再读一遍：可能已被前一个请求刷过了
        let latest = read_auth(&path).await?;
        let latest_access = token_field(&latest, "access_token").unwrap_or_default();
        auth = if jwt_exp_ms(&latest_access) - now_ms() >= REFRESH_SKEW_MS {
            latest
        } else {
            refresh_tokens(client, &path, latest).await?
        };
        access = token_field(&auth, "access_token");
    }

    let access = access.ok_or("刷新后仍无 access_token")?;
    Ok(CodexCreds { access_token: access, account_id })
}

const OPENAI_PATHS: [&str; 2] = ["/v1/responses", "/v1/chat/completions"];

pub struct CodexChatGptProvider {
    pub client: reqwest::Client,
}

#[async_trait::async_trait]
impl CredentialProvider for CodexChatGptProvider {
    fn mode(&self) -> &'static str { "codex_chatgpt" }
    fn supports_path(&self, path: &str) -> bool { OPENAI_PATHS.contains(&path) }

    async fn headers(&self, ctx: &UpstreamAuthContext<'_>) -> Result<BTreeMap<String, String>, String> {
        // 本机 Codex 配置要求每个请求都带的静态头（http_headers / env_http_headers）。
        let mut headers: BTreeMap<String, String> = ctx.upstream.headers.clone();
        if let Some(auth) = &ctx.upstream.auth {
            // 本机 Codex 接的中转用的是静态令牌（experimental_bearer_token / env_key），
            // 不是 ChatGPT 登录态：只带那个令牌，ChatGPT 账号头一个都不发。
            let value = match auth.kind {
                UpstreamAuthKind::Bearer | UpstreamAuthKind::XApiKey => format!("Bearer {}", auth.value),
            };
            headers.insert("authorization".into(), value);
            return Ok(headers);
        }
        let creds = get_codex_creds(&self.client, ctx.provider.auth_file.as_deref()).await?;
        // 单账号多人共享：session_id 必须带上调用方身份，否则两个客户端发了相同的
        // x-request-id 时会落进上游同一个 session，被后端并成一段对话（串话）。
        let session_id: String = format!("{}-{}", ctx.principal.alias, ctx.request_id)
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') { c } else { '_' })
            .take(128)
            .collect();
        headers.insert("authorization".into(), format!("Bearer {}", creds.access_token));
        headers.insert("chatgpt-account-id".into(), creds.account_id);
        headers.insert("openai-beta".into(), "responses=experimental".into());
        headers.insert("originator".into(), "codex_cli_rs".into());
        headers.insert("user-agent".into(), "codex_cli_rs".into());
        headers.insert("session_id".into(), session_id);
        Ok(headers)
    }
}
