use super::{
    inline_input, inline_json, inline_text, local_resources, ErrorClass, KindDecl, Metering,
    ProbeStatus, Provider, UnitEvent, UnitIo, WorkUnit,
};
use crate::auth::principal::Principal;
use crate::config::schema::ProviderConfig;
use crate::core::paths::Env;
use crate::credentials::types::UpstreamAuthContext;
use crate::credentials::{prepare_claude_request, resolve_upstream, CredentialRegistry, WireApi};
use crate::log_debug;
use async_stream::stream;
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

// llm.chat 的节点 provider：补齐订阅协议要求后转发请求，响应逐字节透传。
//
// 与 relay 模块的区别只有「请求从哪来」：那边是本机客户端直连，这边是 Hub 派下来的
// 工作单元。凭据、订阅协议适配和响应透传的语义完全一致，上游凭据一样不出本机。

const ANTHROPIC_PATHS: [&str; 2] = ["/v1/messages", "/v1/messages/count_tokens"];

pub struct RelayProvider {
    /// name 是路由键里的 provider：claude_oauth / codex_chatgpt。
    name: String,
    provider: ProviderConfig,
    credentials: Arc<CredentialRegistry>,
    client: reqwest::Client,
    env: Env,
}

impl RelayProvider {
    pub fn new(
        name: impl Into<String>,
        provider: ProviderConfig,
        credentials: Arc<CredentialRegistry>,
        client: reqwest::Client,
        env: Env,
    ) -> Self {
        Self { name: name.into(), provider, credentials, client, env }
    }
}

#[async_trait::async_trait]
impl Provider for RelayProvider {
    fn kinds(&self) -> Vec<KindDecl> {
        vec![KindDecl { kind: "llm.chat".into(), versions: vec![1], provider: self.name.clone() }]
    }

    async fn probe(&self) -> ProbeStatus {
        let resources = local_resources();
        // 只解析上游与凭据，不发请求：探测不该消耗主人的额度，也不该在上游留下痕迹。
        match probe_credentials(&self.provider, &self.name, &self.credentials, &self.env).await {
            Ok(()) => ProbeStatus { resources, upstream_ok: true, detail: None },
            Err(detail) => ProbeStatus { resources, upstream_ok: false, detail: Some(detail) },
        }
    }

    fn run(&self, unit: WorkUnit, io: UnitIo) -> BoxStream<'static, UnitEvent> {
        let name = self.name.clone();
        let config = self.provider.clone();
        let credentials = Arc::clone(&self.credentials);
        let client = self.client.clone();
        let env = self.env.clone();

        Box::pin(stream! {
            let path = inline_text(&unit, "path").unwrap_or_else(|| "/v1/messages".into());
            let Some(body) = inline_input(&unit, "body") else {
                yield UnitEvent::error(ErrorClass::InputFault, "invalid_body", false, "工作单元缺少请求体");
                return;
            };
            let client_headers = inline_json(&unit, "headers", Value::Object(Default::default()));

            let credential = match credentials.resolve(&config) {
                Ok(credential) => credential,
                Err(message) => {
                    yield UnitEvent::error(ErrorClass::NodeFault, "capability_mismatch", true, message);
                    return;
                }
            };
            // 收单侧再校验一次：Hub 是路由权威，但本机执行边界由本机自己守（原则 8）。
            if !credential.supports_path(&path) {
                yield UnitEvent::error(ErrorClass::NodeFault, "capability_mismatch", true,
                    format!("{} 不支持 {path}", credential.mode()));
                return;
            }

            // 上游跟着本机正在用的走：接了中转站就打中转站，没接就打订阅官方。
            // 每个单元重新解析，主人改完 CLI 配置不用重启桥接。
            let upstream = match resolve_upstream(&config, &env).await {
                Ok(upstream) => upstream,
                Err(message) => {
                    yield UnitEvent::error(ErrorClass::NodeFault, "credentials_unavailable", true, message);
                    return;
                }
            };
            if upstream.wire_api == Some(WireApi::Chat) && path == "/v1/responses" {
                yield UnitEvent::error(ErrorClass::NodeFault, "capability_mismatch", true,
                    format!("本机 Codex 中转的 wire_api 是 chat，承接不了 {path}"));
                return;
            }
            let request_body = prepare_claude_request(Bytes::from(body), &config, &upstream);
            // 消费者对节点是匿名的：这里只有 ck_… 这个匿名标识，没有任何身份信息（C-12）。
            let principal = Principal { alias: unit.consumer_key.clone(), ..Principal::anonymous() };
            let headers = to_header_map(&client_headers);
            let auth_headers = match credential
                .headers(&UpstreamAuthContext {
                    headers: &headers,
                    principal: &principal,
                    request_id: &unit.id,
                    provider: &config,
                    provider_name: &name,
                    upstream: &upstream,
                    env: &env,
                })
                .await
            {
                Ok(headers) => headers,
                // 凭据失效：这条贡献要标成 upstreamOK=false 并通知主人（P-12）。
                Err(message) => {
                    yield UnitEvent::error(ErrorClass::NodeFault, "credentials_unavailable", true, message);
                    return;
                }
            };

            let url = format!(
                "{}{}",
                upstream.base_url,
                path.strip_prefix("/v1").filter(|rest| rest.starts_with('/')).unwrap_or(&path),
            );
            let accept = if ANTHROPIC_PATHS.contains(&path.as_str()) {
                "text/event-stream"
            } else {
                "text/event-stream, application/json"
            };
            let mut request = client.post(&url)
                .header("content-type", "application/json")
                .header("accept", accept);
            for (key, value) in &auth_headers {
                request = request.header(key.as_str(), value.as_str());
            }

            let response = tokio::select! {
                biased;
                () = io.cancel.cancelled() => {
                    yield UnitEvent::error(ErrorClass::Protocol, "unit_cancelled", false, "已取消");
                    return;
                }
                result = request.body(request_body).send() => result,
            };
            let response = match response {
                Ok(response) => response,
                Err(e) => {
                    yield UnitEvent::error(ErrorClass::UpstreamFault, "upstream_timeout", true,
                        e.without_url().to_string());
                    return;
                }
            };

            let status = response.status().as_u16();
            let head_headers = passthrough_headers(response.headers());
            yield UnitEvent::Head { status, headers: head_headers.clone() };
            let failure = upstream_failure(status, &head_headers);

            // 边收边吐：不缓冲整段响应，背压顺着 Hub 一路顶回上游。
            let mut bytes_total: usize = 0;
            let mut body_stream = response.bytes_stream();
            loop {
                let next = tokio::select! {
                    biased;
                    () = io.cancel.cancelled() => {
                        yield UnitEvent::error(ErrorClass::Protocol, "unit_cancelled", false, "已取消");
                        return;
                    }
                    chunk = body_stream.next() => chunk,
                };
                match next {
                    Some(Ok(chunk)) => {
                        bytes_total += chunk.len();
                        yield UnitEvent::Chunk(chunk);
                    }
                    Some(Err(e)) => {
                        yield UnitEvent::error(ErrorClass::UpstreamFault, "upstream_timeout", true,
                            e.without_url().to_string());
                        return;
                    }
                    None => break,
                }
            }
            log_debug!("relay_upstream_done", "unitId": io.unit_id, "status": status, "bytes": bytes_total, "url": url);
            // usage 交给 Hub 从流里解析。节点这里不重复解析一遍：
            // 自报值只用于对账，多算一次也不会更可信。
            match failure {
                Some(event) => yield event,
                None => yield UnitEvent::Done(Box::new(super::DoneEvent { usage: Metering::new(), ..Default::default() })),
            }
        })
    }
}

/// 只解析上游与凭据，不发请求。成功时把解析到的上游一并交出去 ——
/// 调用方普遍还要拿它去写 detail，让它们各自再解析一遍既慢又可能拿到两份结果。
pub async fn probe_upstream(
    provider: &ProviderConfig,
    name: &str,
    credentials: &CredentialRegistry,
    env: &Env,
) -> Result<crate::credentials::UpstreamTarget, String> {
    let credential = credentials.resolve(provider)?;
    let upstream = resolve_upstream(provider, env).await?;
    credential
        .headers(&UpstreamAuthContext {
            headers: &HeaderMap::new(),
            principal: &Principal::anonymous(),
            request_id: "probe",
            provider,
            provider_name: name,
            upstream: &upstream,
            env,
        })
        .await?;
    Ok(upstream)
}

pub async fn probe_credentials(
    provider: &ProviderConfig,
    name: &str,
    credentials: &CredentialRegistry,
    env: &Env,
) -> Result<(), String> {
    probe_upstream(provider, name, credentials, env).await.map(|_| ())
}

fn to_header_map(value: &Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let Some(map) = value.as_object() else { return headers };
    for (name, value) in map {
        let Some(value) = value.as_str() else { continue };
        if let (Ok(name), Ok(value)) =
            (HeaderName::try_from(name.to_ascii_lowercase().as_str()), HeaderValue::from_str(value))
        {
            headers.insert(name, value);
        }
    }
    headers
}

/// 带回给消费者的上游头：限流提示与请求追踪。其余一律不带。
fn passthrough_headers(headers: &reqwest::header::HeaderMap) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        let keep = matches!(lower.as_str(), "content-type" | "request-id" | "retry-after" | "x-should-retry")
            || lower.starts_with("anthropic-ratelimit-")
            || lower.starts_with("x-ratelimit-");
        if keep {
            if let Ok(value) = value.to_str() {
                out.insert(lower, value.to_string());
            }
        }
    }
    out
}

fn upstream_failure(status: u16, headers: &BTreeMap<String, String>) -> Option<UnitEvent> {
    if status < 400 {
        return None;
    }
    let request_id = headers.get("request-id");
    let code = if status == 429 {
        "upstream_429"
    } else if status >= 500 {
        "upstream_5xx"
    } else {
        "upstream_rejected"
    };
    let retryable = (status == 429 || status >= 500)
        && headers.get("x-should-retry").map(String::as_str) != Some("false");
    Some(UnitEvent::error(
        ErrorClass::UpstreamFault,
        code,
        retryable,
        match request_id {
            Some(id) => format!("上游返回 HTTP {status}，request-id: {id}"),
            None => format!("上游返回 HTTP {status}"),
        },
    ))
}
