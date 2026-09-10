use crate::config::schema::{AuthMode, ProviderConfig};
use crate::credentials::local_upstream::UpstreamTarget;
use bytes::Bytes;
use serde_json::Value;

/// Claude 订阅的 Messages 接口要求这段协议前缀；只有 OAuth token 不足以调用。
/// 它不启用本地 agent 或工具执行。客户端 system 与工具历史仍由上游模型处理。
pub const CLAUDE_OAUTH_SYSTEM: &str = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_SYSTEM: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

pub fn is_claude_subscription(provider: &ProviderConfig, upstream: &UpstreamTarget) -> bool {
    if provider.auth_mode != Some(AuthMode::ClaudeOauth) || upstream.auth.is_some() {
        return false;
    }
    reqwest::Url::parse(&upstream.base_url)
        .map(|u| u.origin().ascii_serialization() == "https://api.anthropic.com")
        .unwrap_or(false)
}

/// 只补官方订阅协议要求的 system 前缀：API key / 自定义中转不改，已完整的 CLI 请求不改。
pub fn prepare_claude_request(body: Bytes, provider: &ProviderConfig, upstream: &UpstreamTarget) -> Bytes {
    if !is_claude_subscription(provider, upstream) {
        return body;
    }
    let Ok(Value::Object(mut payload)) = serde_json::from_slice::<Value>(&body) else { return body };

    let blocks = match payload.get("system") {
        None | Some(Value::Null) => vec![],
        Some(Value::String(text)) => {
            if text.is_empty() { vec![] } else { vec![serde_json::json!({ "type": "text", "text": text })] }
        }
        Some(Value::Array(items)) => items.clone(),
        // 非法 system 仍交给上游校验，不悄悄吞掉输入错误。
        Some(_) => return body,
    };
    let already_prefixed = blocks.iter().any(|block| {
        block.get("type").and_then(Value::as_str) == Some("text")
            && block.get("text").and_then(Value::as_str).is_some_and(|text| {
                text.starts_with(CLAUDE_OAUTH_SYSTEM) || text.starts_with(CLAUDE_CODE_SYSTEM)
            })
    });
    if already_prefixed {
        return body;
    }

    let mut next = vec![serde_json::json!({ "type": "text", "text": CLAUDE_OAUTH_SYSTEM })];
    next.extend(blocks);
    payload.insert("system".into(), Value::Array(next));
    match serde_json::to_vec(&Value::Object(payload)) {
        Ok(bytes) => Bytes::from(bytes),
        Err(_) => body,
    }
}
