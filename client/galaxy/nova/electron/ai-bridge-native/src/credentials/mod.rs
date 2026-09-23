pub mod api_key;
pub mod claude_oauth;
pub mod claude_request;
pub mod codex_chatgpt;
pub mod local_upstream;
pub mod toml_lite;
pub mod types;

use crate::config::schema::{AuthMode, ProviderConfig};
use std::collections::HashMap;
use std::sync::Arc;
use types::CredentialProvider;

pub use claude_request::{is_claude_subscription, prepare_claude_request};
pub use local_upstream::{resolve_upstream, UpstreamTarget, WireApi};

/// authMode → 实现。新增上游类型时在这里登记。
pub struct CredentialRegistry {
    providers: HashMap<&'static str, Arc<dyn CredentialProvider>>,
}

impl CredentialRegistry {
    pub fn new(client: reqwest::Client) -> Self {
        let entries: Vec<Arc<dyn CredentialProvider>> = vec![
            Arc::new(claude_oauth::ClaudeOAuthProvider),
            Arc::new(codex_chatgpt::CodexChatGptProvider { client }),
            Arc::new(api_key::ApiKeyProvider),
        ];
        let providers = entries.into_iter().map(|p| (p.mode(), p)).collect();
        Self { providers }
    }

    /// relay provider 不填 authMode 时默认 codex_chatgpt（沿用 ai-sdk-client 的行为）
    pub fn resolve(&self, provider: &ProviderConfig) -> Result<Arc<dyn CredentialProvider>, String> {
        let mode = provider.auth_mode.unwrap_or(AuthMode::CodexChatgpt).label();
        self.providers.get(mode).cloned().ok_or_else(|| format!("unknown authMode: {mode}"))
    }
}
