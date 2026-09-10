use crate::auth::principal::Principal;
use crate::config::schema::ProviderConfig;
use crate::core::paths::Env;
use crate::credentials::local_upstream::UpstreamTarget;
use axum::http::HeaderMap;
use std::collections::BTreeMap;

/// 上游凭据提供者：给一次 relay 请求算出要发给上游的鉴权/身份头。
/// 每种 authMode 一个实现；新增一种上游（比如别家订阅）= 新增一个文件并在 mod.rs 注册。
pub struct UpstreamAuthContext<'a> {
    /// 客户端请求头。用 HeaderMap 而不是传输层的请求对象：pool 模式下这次请求是从 Hub
    /// 的工作单元里还原出来的，凭据层不该被传输方式绑住。
    pub headers: &'a HeaderMap,
    pub principal: &'a Principal,
    pub request_id: &'a str,
    pub provider: &'a ProviderConfig,
    pub provider_name: &'a str,
    /// 这次要打的上游（resolve_upstream 的结果）。带 auth 表示本机接的是中转站、
    /// 令牌就是它，凭据提供者不再去读订阅登录态。
    pub upstream: &'a UpstreamTarget,
    pub env: &'a Env,
}

impl UpstreamAuthContext<'_> {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty())
    }
}

#[async_trait::async_trait]
pub trait CredentialProvider: Send + Sync {
    fn mode(&self) -> &'static str;
    /// 这个 provider 接受哪些客户端路径；返回 false 时 relay 直接 400，不去碰凭据
    fn supports_path(&self, path: &str) -> bool;
    async fn headers(&self, ctx: &UpstreamAuthContext<'_>) -> Result<BTreeMap<String, String>, String>;
}
