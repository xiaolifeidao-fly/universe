use crate::business::llm_chat::probe_upstream;
use crate::business::{local_resources, Resources};
use crate::config::schema::{AppConfig, ProviderType};
use crate::core::paths::Env;
use crate::credentials::CredentialRegistry;
use serde::Serialize;

// 能力探测（P-02）：看看本机有什么可以贡献。
//
// 探测结果只供主人挑选，不会自动申报 —— 「机器上装了 Claude Code」和
// 「我愿意把 Claude 订阅共享出去」是两件事，中间必须有主人的一次点头。

#[derive(Debug, Clone, Serialize)]
pub struct UpstreamTargetInfo {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Capability {
    pub kind: String,
    pub provider: String,
    pub available: bool,
    /// 人话，给控制台看：这条能力实际会打到哪，或者为什么用不了。契约里是必填。
    pub detail: String,
    /// upstream 是 providers 里的配置键。provider 只是路由键（authMode 推出来的），
    /// 两个 provider 可能推出同一个路由键，落成贡献时要靠 upstream 才知道借哪一份凭据。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// 这条能力实际会打到哪：本机正在用的中转站，或订阅官方。只在可用时有。
    #[serde(rename = "upstreamTarget", skip_serializing_if = "Option::is_none")]
    pub upstream_target: Option<UpstreamTargetInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub resources: Resources,
    pub capabilities: Vec<Capability>,
}

pub async fn probe(cfg: &AppConfig, credentials: &CredentialRegistry, env: &Env) -> ProbeResult {
    let mut capabilities = vec![];
    for (name, provider) in &cfg.providers {
        if provider.kind != ProviderType::Relay {
            continue;
        }
        let Some(auth_mode) = provider.auth_mode else { continue };
        // 只解析上游地址与凭据，不发请求：探测不该消耗主人的额度，也不该在上游留痕迹。
        // 地址跟着本机正在用的走：接了中转站就是中转站，没接就是订阅官方。
        match probe_upstream(provider, name, credentials, env).await {
            Ok(target) => {
                // detail 在 BridgeCapability 契约里是必填，任何分支都不能少。
                capabilities.push(Capability {
                    kind: "llm.chat".into(),
                    provider: auth_mode.label().into(),
                    available: true,
                    detail: format!("providers.{name} → {}（{}）", target.base_url, target.source),
                    upstream: Some(name.clone()),
                    upstream_target: Some(UpstreamTargetInfo { base_url: target.base_url, source: target.source }),
                });
            }
            Err(message) => capabilities.push(Capability {
                kind: "llm.chat".into(),
                provider: auth_mode.label().into(),
                available: false,
                detail: format!("providers.{name}: {message}"),
                upstream: Some(name.clone()),
                upstream_target: None,
            }),
        }
    }
    // 本机执行类能力目前一个都不探：
    //
    // · video.edit.render（ffmpeg）—— 实现是完整的，但产品上暂时不把视频渲染算力
    //   放进共享池，控制台也不展示它。探它只是白起一个 `ffmpeg -version` 子进程，
    //   而健康重探每 60 秒一次，这个开销没有任何人受益。
    //
    // · delivery.task —— 执行器是主人自己写的命令（exec），「机器上有什么」根本
    //   推断不出来，而且 delivery-task-planner 侧的 --stdio 入口还没做。
    ProbeResult { resources: local_resources(), capabilities }
}
