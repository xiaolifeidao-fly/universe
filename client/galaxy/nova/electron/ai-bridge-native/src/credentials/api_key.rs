use super::types::{CredentialProvider, UpstreamAuthContext};
use std::collections::BTreeMap;

/// 最朴素的上游鉴权：配置里的 apiKey 作 Bearer。转发到任意 OpenAI/Anthropic 兼容网关时用。
pub struct ApiKeyProvider;

#[async_trait::async_trait]
impl CredentialProvider for ApiKeyProvider {
    fn mode(&self) -> &'static str { "api_key" }
    fn supports_path(&self, _path: &str) -> bool { true }
    async fn headers(&self, ctx: &UpstreamAuthContext<'_>) -> Result<BTreeMap<String, String>, String> {
        let mut headers = BTreeMap::new();
        if let Some(key) = &ctx.provider.api_key {
            headers.insert("authorization".into(), format!("Bearer {key}"));
        }
        Ok(headers)
    }
}
