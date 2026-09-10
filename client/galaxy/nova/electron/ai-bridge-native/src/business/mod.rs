pub mod delivery_task;
pub mod llm_chat;
pub mod video_edit;

use crate::core::request::Cancel;
use bytes::Bytes;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

// 通道层与节点 provider 之间的统一形状。这份类型与服务端 contract/galaxy.go 一一对应，
// 两侧同时改才算改完 —— 字段名不一致的后果是「单元派下来了但节点看不懂」。

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Primitive { Relay, Session, Job }

/// 计量。值保持来时的数字形态（执行器报的可能是小数），不强转成整数。
pub type Metering = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub store: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, rename = "contentType", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// url 是 Hub 现签的 presigned 地址，只在这一次下发里有效，不落盘。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payload {
    pub name: String,
    /// inline 从 Hub 下来时是 base64（Go 的 []byte 走 JSON 就是 base64）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<String>,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<ArtifactRef>,
    #[serde(default, rename = "contentType", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionOp { Open, Resume, Turn, Close }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkUnit {
    pub id: String,
    pub kind: String,
    #[serde(rename = "kindVersion")]
    pub kind_version: u32,
    pub primitive: Primitive,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "consumerKey")]
    pub consumer_key: String,
    /// space 是业务自己的空间。共享池按平台维度运行，这个字段只供业务回查。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    /// op 是 session 原语的子类型：open 第一回合、turn 同节点续跑、resume 跨节点续接。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<SessionOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default, rename = "affinityKey", skip_serializing_if = "Option::is_none")]
    pub affinity_key: Option<String>,
    #[serde(default, rename = "hardPin", skip_serializing_if = "Option::is_none")]
    pub hard_pin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<Payload>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<Payload>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metering: Option<Value>,
    #[serde(default)]
    pub state: String,
    #[serde(default, rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    InputFault, UpstreamFault, NodeFault, HubFault, Billing, Protocol,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnitError {
    pub class: ErrorClass,
    pub code: String,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DoneEvent {
    pub usage: Metering,
    /// contextDelta 是 session 每个回合结束交给服务端账本的结构化增量。
    /// 节点死了服务端仍要拥有完整业务上下文，靠的就是它（T-08）。
    pub context_delta: Option<Value>,
    pub workspace_ref: Option<WorkspaceRef>,
    pub checkpoint_ref: Option<ArtifactRef>,
    /// outputs 是 job 的产物引用。字节已经直传 OSS 了，这里只交引用。
    pub outputs: Option<Vec<NamedArtifact>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedArtifact {
    pub name: String,
    #[serde(rename = "ref")]
    pub reference: ArtifactRef,
}

/// provider.run 产出的事件。传输层只认这几种，业务再多也不会长出第八种。
#[derive(Debug, Clone)]
pub enum UnitEvent {
    Head { status: u16, headers: BTreeMap<String, String> },
    Chunk(Bytes),
    Done(Box<DoneEvent>),
    Error(UnitError),
}

impl UnitEvent {
    pub fn error(class: ErrorClass, code: &str, retryable: bool, message: impl Into<String>) -> Self {
        UnitEvent::Error(UnitError { class, code: code.into(), retryable, message: message.into() })
    }
    /// 把一条 NDJSON 事件包成上行字节。Hub 的写回器按行解析，所以必须带换行。
    pub fn ndjson(value: &Value) -> Self {
        UnitEvent::Chunk(Bytes::from(value.to_string() + "\n"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resources {
    pub os: String,
    pub cpu: usize,
    #[serde(rename = "memGB")]
    pub mem_gb: u64,
    pub gpu: Option<String>,
    #[serde(rename = "diskFreeGB")]
    pub disk_free_gb: u64,
    #[serde(default, rename = "netMbps", skip_serializing_if = "Option::is_none")]
    pub net_mbps: Option<u64>,
}

pub fn local_resources() -> Resources {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    Resources {
        os: std::env::consts::OS.to_string(),
        cpu: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        mem_gb: bytes_to_gb(system.total_memory()),
        gpu: None,
        // 与 TS 侧一致：这里报的其实是空闲**内存**，不是磁盘。
        // 字段名和取值对不上是既有行为，改了会让 Hub 看到的口径突变，
        // 所以先原样保留，另行确认 Hub 怎么用它再动。
        disk_free_gb: bytes_to_gb(system.free_memory()),
        net_mbps: None,
    }
}

fn bytes_to_gb(bytes: u64) -> u64 {
    ((bytes as f64) / 1024.0 / 1024.0 / 1024.0).round() as u64
}

#[derive(Debug, Clone)]
pub struct ProbeStatus {
    pub resources: Resources,
    pub upstream_ok: bool,
    pub detail: Option<String>,
}

/// Hub 侧要的产物地址与进度上报。抽成 trait 而不是直接依赖 HubClient：
/// provider 不该知道通道是怎么连上去的，测试里也就能塞一个假的进来。
#[async_trait::async_trait]
pub trait UnitCallbacks: Send + Sync {
    /// 对象键由 Hub 生成：让节点自己起名等于把「对象键不含身份信息」交给不可信的一方去守。
    async fn sign_artifact(&self, unit_id: &str, name: &str, content_type: &str, size: u64)
        -> Result<ArtifactRef, String>;
    /// 返回值是「Hub 要不要取消」。取消信号搭在进度的响应里回来（T-05）。
    async fn progress(&self, unit_id: &str, pct: f64, stage: &str, preview: Option<ArtifactRef>)
        -> Result<bool, String>;
}

/// 一个工作单元的运行环境。
pub struct UnitIo {
    /// 消费者断开或主人紧急停机时触发，provider 必须据此 abort 上游。
    pub cancel: Cancel,
    /// 这个单元的临时目录。运行循环在单元结束后整个删掉 ——
    /// 消费者的素材不该在主人机器上留过夜（约束 4）。
    pub work_dir: Option<PathBuf>,
    pub unit_id: String,
    pub cid: String,
    pub callbacks: Option<Arc<dyn UnitCallbacks>>,
}

#[derive(Debug, Clone)]
pub struct KindDecl {
    pub kind: String,
    pub versions: Vec<u32>,
    pub provider: String,
}

/// Provider 是节点侧真正干活的模块，按 (kind, provider) 装载。
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn kinds(&self) -> Vec<KindDecl>;
    async fn probe(&self) -> ProbeStatus;
    fn run(&self, unit: WorkUnit, io: UnitIo) -> BoxStream<'static, UnitEvent>;
    async fn cancel(&self, _unit_id: &str) {}
}

// ---------- 工具 ----------

pub fn inline_input(unit: &WorkUnit, name: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let payload = unit
        .inputs
        .as_ref()?
        .iter()
        .find(|item| item.name == name && item.reference.is_none())?;
    let inline = payload.inline.as_ref()?;
    base64::engine::general_purpose::STANDARD.decode(inline).ok()
}

pub fn inline_text(unit: &WorkUnit, name: &str) -> Option<String> {
    String::from_utf8(inline_input(unit, name)?).ok()
}

pub fn inline_json(unit: &WorkUnit, name: &str, fallback: Value) -> Value {
    match inline_text(unit, name) {
        Some(text) if !text.is_empty() => serde_json::from_str(&text).unwrap_or(fallback),
        _ => fallback,
    }
}

/// modelMatch 与服务端 contract.ModelMatch 同语义：deny 优先，allow 为空表示不限。
/// 两侧都要有这段逻辑：Hub 是路由权威，节点收单时必须再校验一次（原则 8）。
pub fn model_match(model: &str, allow: &[String], deny: &[String]) -> bool {
    let hit = |pattern: &String| {
        let p = pattern.trim();
        if p.is_empty() {
            return false;
        }
        if p == "*" {
            return true;
        }
        match p.strip_suffix('*') {
            Some(prefix) => model.starts_with(prefix),
            None => model == p,
        }
    };
    if deny.iter().any(hit) {
        return false;
    }
    allow.is_empty() || allow.iter().any(hit)
}
