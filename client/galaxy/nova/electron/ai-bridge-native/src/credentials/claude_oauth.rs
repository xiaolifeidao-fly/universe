use super::claude_request::is_claude_subscription;
use super::local_upstream::UpstreamAuthKind;
use super::types::{CredentialProvider, UpstreamAuthContext};
use crate::core::paths::{expand_home, home_dir, Env};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

pub struct ClaudeCreds {
    pub access_token: String,
}

/// 不把原始 JSON、子进程 stderr 或 token 放进异常/日志。
pub fn parse_claude_credentials(raw: &str, now_ms: i64) -> Result<ClaudeCreds, String> {
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|_| "Claude 登录态不是有效 JSON；请运行 claude auth login".to_string())?;
    let oauth = parsed.get("claudeAiOauth");

    let access_token = oauth
        .and_then(|v| v.get("accessToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or("Claude 登录态缺少 claudeAiOauth.accessToken；请运行 claude auth login")?;

    if let Some(expires) = oauth.and_then(|v| v.get("expiresAt")).filter(|v| !v.is_null()) {
        let expires = expires
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or("Claude 登录态 expiresAt 无效；请运行 claude auth login")?;
        if expires <= now_ms as f64 {
            return Err("Claude access token 已过期；请通过 Claude Code 更新登录态（claude auth login）".into());
        }
    }

    if let Some(scopes) = oauth.and_then(|v| v.get("scopes")).and_then(Value::as_array) {
        if !scopes.iter().any(|s| s.as_str() == Some("user:inference")) {
            return Err("Claude 登录态缺少 user:inference 权限；请运行 claude auth login".into());
        }
    }
    Ok(ClaudeCreds { access_token: access_token.to_string() })
}

pub fn claude_keychain_service(env: &Env) -> String {
    // `??` 语义：SECURESTORAGE 存在就用它（哪怕是空串），否则退到 CONFIG_DIR；
    // 空串再落到「无后缀」。空串与未设置在这里不是一回事。
    let config_dir = env
        .get("CLAUDE_SECURESTORAGE_CONFIG_DIR")
        .or_else(|| env.get("CLAUDE_CONFIG_DIR"))
        .filter(|value| !value.is_empty());
    match config_dir {
        Some(dir) => {
            let normalized: String = dir.nfc().collect();
            let digest = hex::encode(Sha256::digest(normalized.as_bytes()));
            format!("Claude Code-credentials-{}", &digest[..8])
        }
        None => "Claude Code-credentials".into(),
    }
}

async fn read_credentials_file(path: &Path) -> Result<ClaudeCreds, String> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .map_err(|_| "无法读取 Claude 凭据文件；检查 authFile 或先运行 claude auth login".to_string())?;
    parse_claude_credentials(&raw, now_ms())
}

fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// 每次请求重新读取，Claude Code 更新登录后无需重启桥接。
/// 不运行 Claude agent，不刷新/写回 OAuth 凭据，避免与 Claude Code 的 token 轮换互相覆盖。
/// 读取顺序：authFile → CLAUDE_CODE_OAUTH_TOKEN → macOS Keychain → $CLAUDE_CONFIG_DIR/.credentials.json
pub async fn get_claude_creds(
    auth_file: Option<&str>,
    keychain_service: Option<&str>,
    env: &Env,
) -> Result<ClaudeCreds, String> {
    if let Some(file) = auth_file {
        return read_credentials_file(&expand_home(file)).await;
    }
    if let Some(token) = env.trimmed("CLAUDE_CODE_OAUTH_TOKEN") {
        return Ok(ClaudeCreds { access_token: token.to_string() });
    }
    #[cfg(target_os = "macos")]
    if let Some(raw) = read_macos_keychain(keychain_service, env).await {
        return parse_claude_credentials(&raw, now_ms());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = keychain_service;

    let dir = env.get("CLAUDE_CONFIG_DIR").map(expand_home).unwrap_or_else(|| home_dir().join(".claude"));
    read_credentials_file(&dir.join(".credentials.json")).await
}

#[cfg(target_os = "macos")]
async fn read_macos_keychain(service: Option<&str>, env: &Env) -> Option<String> {
    let username = env
        .get("USER")
        .map(str::to_string)
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default();
    let account = if !username.is_empty()
        && username.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        username
    } else {
        "claude-code-user".to_string()
    };
    let service = service.map(str::to_string).unwrap_or_else(|| claude_keychain_service(env));
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-a", &account, "-s", &service, "-w"])
            .output(),
    )
    .await;
    // Keychain 不可用时退回文件存储；不输出 security 的错误内容。
    let output = output.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!raw.is_empty()).then_some(raw)
}

const ANTHROPIC_PATHS: [&str; 2] = ["/v1/messages", "/v1/messages/count_tokens"];

/// 透传给上游的客户端头：会话、SDK 协议头。不硬编码任何 Claude CLI 版本。
const PASSTHROUGH_HEADERS: [&str; 12] = [
    "user-agent", "x-app", "x-claude-code-session-id",
    "anthropic-dangerous-direct-browser-access",
    "x-stainless-arch", "x-stainless-lang", "x-stainless-os",
    "x-stainless-package-version", "x-stainless-retry-count",
    "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout",
];

pub struct ClaudeOAuthProvider;

#[async_trait::async_trait]
impl CredentialProvider for ClaudeOAuthProvider {
    fn mode(&self) -> &'static str { "claude_oauth" }
    fn supports_path(&self, path: &str) -> bool { ANTHROPIC_PATHS.contains(&path) }

    async fn headers(&self, ctx: &UpstreamAuthContext<'_>) -> Result<BTreeMap<String, String>, String> {
        // 保持客户端给的 beta 顺序：Set 的插入序在 TS 侧是可观察的。
        let mut betas: Vec<String> = ctx
            .header("anthropic-beta")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .collect();
        let mut add_beta = |value: &str| {
            if !betas.iter().any(|b| b == value) {
                betas.push(value.to_string());
            }
        };

        // 本机 Claude Code 配置里要求每个请求都带的静态头（ANTHROPIC_CUSTOM_HEADERS）。
        let mut headers: BTreeMap<String, String> = ctx.upstream.headers.clone();
        headers.insert(
            "anthropic-version".into(),
            ctx.header("anthropic-version").unwrap_or("2023-06-01").to_string(),
        );

        match &ctx.upstream.auth {
            // 本机 Claude Code 接的是中转站：用它配好的令牌，不碰订阅登录态，
            // 也不加 oauth beta —— 那个头只对 OAuth token 有意义。
            Some(auth) => match auth.kind {
                UpstreamAuthKind::Bearer => {
                    headers.insert("authorization".into(), format!("Bearer {}", auth.value));
                }
                UpstreamAuthKind::XApiKey => {
                    headers.insert("x-api-key".into(), auth.value.clone());
                }
            },
            None => {
                let creds = get_claude_creds(
                    ctx.provider.auth_file.as_deref(),
                    ctx.provider.claude_keychain_service.as_deref(),
                    ctx.env,
                )
                .await?;
                headers.insert("authorization".into(), format!("Bearer {}", creds.access_token));
                add_beta("oauth-2025-04-20");
                if is_claude_subscription(ctx.provider, ctx.upstream) {
                    add_beta("claude-code-20250219");
                }
            }
        }

        if !betas.is_empty() {
            headers.insert("anthropic-beta".into(), betas.join(","));
        }
        for name in PASSTHROUGH_HEADERS {
            if let Some(value) = ctx.header(name) {
                headers.insert(name.to_string(), value.to_string());
            }
        }
        Ok(headers)
    }
}
