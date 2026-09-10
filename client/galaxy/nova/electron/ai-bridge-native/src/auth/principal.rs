use crate::config::schema::Scope;
use serde::Serialize;
use std::collections::HashSet;

/// 一次请求的调用方身份。认证后挂在请求扩展上，后续所有 handler / 日志只用它，不再碰 token。
#[derive(Debug, Clone)]
pub struct Principal {
    pub alias: String,
    pub scopes: HashSet<Scope>,
    /// 该 principal 的并发上限，None = 不限
    pub concurrency: Option<u32>,
    /// 来源：inline 配置、token 文件，或 auth.enabled=false 时的 anonymous
    pub source: PrincipalSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalSource { Config, File, Anonymous }

impl Principal {
    pub fn anonymous() -> Self {
        Self {
            alias: "anonymous".into(),
            scopes: HashSet::from([Scope::All]),
            concurrency: None,
            source: PrincipalSource::Anonymous,
        }
    }
    pub fn has_scope(&self, scope: Scope) -> bool {
        self.scopes.contains(&Scope::All) || self.scopes.contains(&scope)
    }
}
