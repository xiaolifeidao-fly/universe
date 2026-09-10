use crate::business::{ArtifactRef, Metering, NamedArtifact, UnitError, WorkUnit, WorkspaceRef};
use crate::core::errors::{http_error, BridgeError};
use crate::core::request::Cancel;
use crate::log_warn;
use bytes::Bytes;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

// Hub 的几个端点。节点主动出站，Hub 永不主动连节点（T-01）。
//
// 传输是「长轮询领活 + chunked 上行 + 短请求报终态」，帧语义与传输解耦：
// 将来换 WebSocket 只要换掉这个文件（T-06）。

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
pub struct HubLane {
    pub cid: String,
    pub free: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatLane {
    pub cid: String,
    pub inflight: u32,
    pub queued: u32,
    #[serde(rename = "throttledUntil")]
    pub throttled_until: Option<String>,
    #[serde(rename = "upstreamOK")]
    pub upstream_ok: bool,
    pub paused: bool,
}

/// 上报给 Hub 的一项**本机能力**。
///
/// 注意它不再带座位、额度、模型范围 —— 那些是「共享多少」，由主人在控制台定，
/// 节点报什么都不作数。这里只回答「这台机器有什么、现在能不能干」。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CapabilityReport {
    pub cid: String,
    pub kind: String,
    #[serde(rename = "kindVersion")]
    pub kind_version: u32,
    pub provider: String,
    pub available: bool,
    #[serde(rename = "unavailableReason", skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// 上游可用的模型名。控制台拿它当「只放/不放这些模型」的候选项。
    ///
    /// 字段名不能叫 models：Hub 的 ContributionInput 上已经有一个 models，而且是
    /// `{allow, deny}` 对象 —— 发数组过去反序列化直接失败，整个 hello 就挂了。
    #[serde(rename = "availableModels", skip_serializing_if = "Option::is_none")]
    pub available_models: Option<Vec<String>>,
}

/// Hub 下发的**生效配置**：主人开着、且本机报了可用的那些能力，连同座位、
/// 额度、模型范围和挂机时段。节点按它建通道。
#[derive(Debug, Clone, Deserialize)]
pub struct EnabledContribution {
    pub cid: String,
    pub kind: String,
    #[serde(rename = "kindVersion")]
    pub kind_version: u32,
    pub provider: String,
    #[serde(default, rename = "modelsAllow")]
    pub models_allow: Vec<String>,
    #[serde(default, rename = "modelsDeny")]
    pub models_deny: Vec<String>,
    pub seats: u32,
    #[serde(rename = "seatConcurrency")]
    pub seat_concurrency: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RejectedCapability {
    pub cid: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HelloResult {
    #[serde(default)]
    pub rejected: Vec<RejectedCapability>,
    /// enabled 可选是有意义的：字段缺失表示对面是老版本 Hub，节点应当维持现状；
    /// 空数组才表示「一条都别跑」。两者混同会让一次版本不匹配把所有通道停掉。
    #[serde(default)]
    pub enabled: Option<Vec<EnabledContribution>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HeartbeatResult {
    /// 平台公布的节点接入地址；旧版 Hub 不返回。
    #[serde(default, rename = "hubUrl")]
    pub hub_url: Option<String>,
    #[serde(default)]
    pub cancel: Vec<String>,
    #[serde(default)]
    pub drain: Vec<String>,
    #[serde(default)]
    pub enabled: Option<Vec<EnabledContribution>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Lease {
    pub token: String,
    #[serde(default, rename = "renewSec")]
    pub renew_sec: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NextResult {
    pub unit: WorkUnit,
    pub lease: Lease,
    #[serde(rename = "streamURL")]
    pub stream_url: String,
    #[serde(default)]
    pub cancel: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PairedNode {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub token: String,
}

/// 契约版本与 Hub 不一致。这是升级问题，不是网络抖动：调用方必须停止重试（S-11）。
#[derive(Debug, Clone)]
pub struct ContractMismatch(pub String);

#[derive(Debug)]
pub enum HubFailure {
    ContractMismatch(String),
    Rejected(BridgeError),
}

impl HubFailure {
    pub fn message(&self) -> String {
        match self {
            HubFailure::ContractMismatch(message) => message.clone(),
            HubFailure::Rejected(error) => error.message.clone(),
        }
    }
    pub fn is_contract_mismatch(&self) -> bool {
        matches!(self, HubFailure::ContractMismatch(_))
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CompleteBody {
    pub lease: String,
    /// completed | failed | cancelled
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<UnitError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Metering>,
    #[serde(rename = "contextDelta", skip_serializing_if = "Option::is_none")]
    pub context_delta: Option<Value>,
    #[serde(rename = "workspaceRef", skip_serializing_if = "Option::is_none")]
    pub workspace_ref: Option<WorkspaceRef>,
    #[serde(rename = "checkpointRef", skip_serializing_if = "Option::is_none")]
    pub checkpoint_ref: Option<ArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<NamedArtifact>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
}

pub struct HubClient {
    base_url: String,
    contract_version: u32,
    token: Option<String>,
    node_id: Option<String>,
    client: reqwest::Client,
}

impl HubClient {
    pub fn new(
        base_url: impl Into<String>,
        contract_version: u32,
        token: Option<String>,
        node_id: Option<String>,
        client: reqwest::Client,
    ) -> Self {
        Self { base_url: base_url.into(), contract_version, token, node_id, client }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    fn request(&self, path: &str) -> reqwest::RequestBuilder {
        let mut builder = self
            .client
            .post(self.url(path))
            .header("content-type", "application/json")
            .header("x-galaxy-contract", self.contract_version.to_string());
        if let Some(token) = &self.token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(node_id) = &self.node_id {
            builder = builder.header("x-galaxy-node", node_id);
        }
        builder
    }

    /// 用配对码换长期节点令牌。明文只在这一次返回。
    ///
    /// previous_node_id 是这台机器**上一次**配对拿到的 nodeId。Hub 每次配对都新建节点，
    /// 不把旧的告诉它，同一台机器每重配一次就在控制台多一个永远离线的僵尸。
    /// Hub 会校验它属于同一个主人才退役，传错了只是不生效，不会伤到别人的机器。
    pub async fn pair(
        &self,
        code: &str,
        display_name: &str,
        bridge_version: &str,
        previous_node_id: Option<&str>,
    ) -> Result<PairedNode, BridgeError> {
        let mut body = json!({
            "code": code, "displayName": display_name, "bridgeVersion": bridge_version,
        });
        if let Some(previous) = previous_node_id {
            body["previousNodeId"] = json!(previous);
        }
        let response = self
            .client
            .post(self.url("/agent/v1/pair"))
            .header("content-type", "application/json")
            .header("x-galaxy-contract", self.contract_version.to_string())
            .timeout(REQUEST_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;
        let status = response.status().as_u16();
        let payload = read_json(response).await;
        if !(200..300).contains(&status) {
            return Err(hub_error(status, &payload));
        }
        serde_json::from_value(payload)
            .map_err(|e| http_error(502, "hub_rejected", format!("配对响应不合法：{e}")))
    }

    /// hello 是全量替换：这次没申报的贡献，Hub 立刻看不到。
    pub async fn hello(
        &self,
        bridge_version: &str,
        resources: &Value,
        contributions: &[CapabilityReport],
        cancel: &Cancel,
    ) -> Result<HelloResult, HubFailure> {
        let body = json!({
            "bridgeVersion": bridge_version,
            "contract": self.contract_version,
            "resources": resources,
            "contributions": contributions,
        });
        let response = self.send_cancellable("/agent/v1/hello", &body, Some(REQUEST_TIMEOUT), cancel).await?;
        let status = response.status().as_u16();
        let payload = read_json(response).await;
        if status == 426 {
            return Err(HubFailure::ContractMismatch(
                message_of(&payload).unwrap_or_else(|| "契约版本不一致，请升级 ai-bridge".into()),
            ));
        }
        if !(200..300).contains(&status) {
            return Err(HubFailure::Rejected(hub_error(status, &payload)));
        }
        Ok(serde_json::from_value(payload).unwrap_or_default())
    }

    pub async fn heartbeat(
        &self,
        lanes: &[HeartbeatLane],
        cancel: &Cancel,
    ) -> Result<HeartbeatResult, HubFailure> {
        let response = self
            .send_cancellable("/agent/v1/heartbeat", &json!({ "lanes": lanes }), Some(REQUEST_TIMEOUT), cancel)
            .await?;
        let status = response.status().as_u16();
        let payload = read_json(response).await;
        if !(200..300).contains(&status) {
            return Err(HubFailure::Rejected(hub_error(status, &payload)));
        }
        Ok(serde_json::from_value(payload).unwrap_or_default())
    }

    /// 长轮询。204 表示这一轮没活，立刻再来一轮。
    ///
    /// POST 而不是 GET：通道列表在请求体里，而领活会占租约、扣并发，本来也不是只读操作。
    pub async fn next(
        &self,
        lanes: &[HubLane],
        wait_seconds: u32,
        cancel: &Cancel,
    ) -> Result<Option<NextResult>, HubFailure> {
        let path = format!("/agent/v1/next?waitSeconds={wait_seconds}");
        let response = self.send_cancellable(&path, &json!({ "lanes": lanes }), None, cancel).await?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok(None);
        }
        let payload = read_json(response).await;
        if !(200..300).contains(&status) {
            return Err(HubFailure::Rejected(hub_error(status, &payload)));
        }
        serde_json::from_value(payload)
            .map(Some)
            .map_err(|e| HubFailure::Rejected(http_error(502, "hub_rejected", format!("派单响应不合法：{e}"))))
    }

    /// 上行推流。一次响应一条连接，边收上游边推，背压顺着这条连接顶回上游。
    /// 返回 consumer_gone 表示消费者已经走了，调用方必须立刻 abort 上游。
    pub async fn stream(
        &self,
        stream_url: &str,
        status: u16,
        headers: &BTreeMap<String, String>,
        lease: &str,
        body: BoxStream<'static, Result<Bytes, std::io::Error>>,
    ) -> StreamOutcome {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(headers).unwrap_or_default());
        let mut builder = self
            .client
            .post(stream_url)
            .header("content-type", "application/octet-stream")
            .header("x-galaxy-contract", self.contract_version.to_string())
            .header("x-galaxy-lease", lease)
            .header("x-galaxy-upstream-status", status.to_string())
            .header("x-galaxy-upstream-headers", encoded);
        if let Some(token) = &self.token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(node_id) = &self.node_id {
            builder = builder.header("x-galaxy-node", node_id);
        }
        let response = match builder.body(reqwest::Body::wrap_stream(body)).send().await {
            Ok(response) => response,
            Err(e) => {
                log_warn!("pool_stream_failed", "message": e.without_url().to_string());
                return StreamOutcome { ok: false, consumer_gone: false };
            }
        };
        if response.status().as_u16() == 410 {
            return StreamOutcome { ok: false, consumer_gone: true };
        }
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let payload = read_json(response).await;
            log_warn!("pool_stream_rejected", "status": status, "message": message_of(&payload));
            return StreamOutcome { ok: false, consumer_gone: false };
        }
        StreamOutcome { ok: true, consumer_gone: false }
    }

    /// 申请上传产物的地址。GB 级产物直传 OSS，Hub 不经手字节（约束 3）。
    pub async fn sign_artifact(
        &self,
        unit_id: &str,
        name: &str,
        content_type: &str,
        size: u64,
    ) -> Result<ArtifactRef, String> {
        let body = json!({ "name": name, "contentType": content_type, "size": size });
        let response = self
            .request(&format!("/agent/v1/units/{unit_id}/artifacts"))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let status = response.status().as_u16();
        let payload = read_json(response).await;
        if !(200..300).contains(&status) {
            return Err(message_of(&payload).unwrap_or_else(|| format!("Hub 返回 {status}")));
        }
        serde_json::from_value(payload).map_err(|e| e.to_string())
    }

    pub async fn progress(
        &self,
        unit_id: &str,
        lease: &str,
        progress: Option<Value>,
        renew: bool,
    ) -> Result<bool, String> {
        let mut body = json!({ "lease": lease, "renew": renew });
        if let Some(progress) = progress {
            body["progress"] = progress;
        }
        let response = self
            .request(&format!("/agent/v1/units/{unit_id}/progress"))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let status = response.status().as_u16();
        let payload = read_json(response).await;
        if !(200..300).contains(&status) {
            return Err(message_of(&payload).unwrap_or_else(|| format!("Hub 返回 {status}")));
        }
        Ok(payload.get("cancelRequested").and_then(Value::as_bool).unwrap_or(false))
    }

    pub async fn complete(&self, unit_id: &str, body: &CompleteBody) {
        let response = self
            .request(&format!("/agent/v1/units/{unit_id}/complete"))
            .json(body)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                let status = response.status().as_u16();
                let payload = read_json(response).await;
                log_warn!("pool_complete_rejected",
                    "unitId": unit_id, "status": status, "message": message_of(&payload));
            }
            Err(e) => {
                log_warn!("pool_complete_rejected", "unitId": unit_id, "message": e.without_url().to_string());
            }
        }
    }

    async fn send_cancellable(
        &self,
        path: &str,
        body: &Value,
        timeout: Option<Duration>,
        cancel: &Cancel,
    ) -> Result<reqwest::Response, HubFailure> {
        let mut builder = self.request(path).json(body);
        if let Some(timeout) = timeout {
            builder = builder.timeout(timeout);
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(HubFailure::Rejected(cancel.reason())),
            result = builder.send() => result.map_err(|e| HubFailure::Rejected(transport_error(e))),
        }
    }
}

pub struct StreamOutcome {
    pub ok: bool,
    pub consumer_gone: bool,
}

async fn read_json(response: reqwest::Response) -> Value {
    let text = response.text().await.unwrap_or_default();
    if text.is_empty() {
        return json!({});
    }
    serde_json::from_str(&text).unwrap_or_else(|_| {
        json!({ "message": text.chars().take(512).collect::<String>() })
    })
}

fn message_of(payload: &Value) -> Option<String> {
    for key in ["message", "error"] {
        if let Some(text) = payload.get(key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }
    None
}

fn hub_error(status: u16, payload: &Value) -> BridgeError {
    http_error(status, "hub_rejected", message_of(payload).unwrap_or_else(|| format!("Hub 返回 {status}")))
}

fn transport_error(e: reqwest::Error) -> BridgeError {
    // 不带 URL：Hub 地址可能含自建部署的内网信息。
    http_error(502, "hub_unreachable", e.without_url().to_string())
}
