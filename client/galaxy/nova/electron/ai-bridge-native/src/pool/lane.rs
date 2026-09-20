use crate::business::Provider;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// 一条通道的运行期配置。
///
/// 它**不是**本地配置文件里的那个 PoolContribution：共享什么、共享多少现在由主人
/// 在控制台定，Hub 每次心跳下发一份，节点照着建通道。这里只留 Lane 真正用得上的
/// 那几项，免得为了造一条通道去凑一个完整的配置对象。
#[derive(Debug, Clone)]
pub struct LaneConfig {
    pub id: String,
    pub kind: String,
    pub kind_version: u32,
    /// 放置用的 provider 路由键。节点侧的白名单自校验要拿它比对派下来的单元。
    pub provider: String,
    pub seats: u32,
    pub seat_concurrency: u32,
    pub models_allow: Vec<String>,
    pub models_deny: Vec<String>,
}

#[derive(Default)]
struct LaneState {
    inflight: u32,
    per_consumer: HashMap<String, u32>,
}

/// 一条通道 = 一个贡献在节点侧的运行态。座位、并发、排空、限流都按它算。
///
/// 这里的并发闸门与 core/queue.rs 的三层闸门是两回事：那一层管的是本机客户端，
/// 这一层管的是共享池派下来的单元，两者的上限由主人分别配置。
pub struct Lane {
    // config 是可变的：主人在控制台改座位或模型范围时原地换掉，不重建通道 ——
    // 重建会把 inflight 计数清零，正在跑的请求就成了没人认领的并发。
    config: RwLock<LaneConfig>,
    state: Mutex<LaneState>,
    pub draining: AtomicBool,
    pub paused: AtomicBool,
    pub upstream_ok: AtomicBool,
    /// 0 表示没有冷却。
    throttled_until_ms: AtomicI64,
    pub provider: Arc<dyn Provider>,
}

impl Lane {
    pub fn new(config: LaneConfig, provider: Arc<dyn Provider>) -> Self {
        Self {
            config: RwLock::new(config),
            state: Mutex::new(LaneState::default()),
            draining: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            upstream_ok: AtomicBool::new(true),
            throttled_until_ms: AtomicI64::new(0),
            provider,
        }
    }

    pub fn cid(&self) -> String {
        self.config.read().unwrap().id.clone()
    }
    /// 放置用的 provider 路由键（claude_oauth / codex_chatgpt）。
    /// 上游余量按它取 —— 那是账号的属性，不是通道的，同一个账号下的几条通道共用一份。
    pub fn route_key(&self) -> String {
        self.config.read().unwrap().provider.clone()
    }
    pub fn config(&self) -> LaneConfig {
        self.config.read().unwrap().clone()
    }
    pub fn set_config(&self, config: LaneConfig) {
        *self.config.write().unwrap() = config;
    }
    pub fn inflight(&self) -> u32 {
        self.state.lock().unwrap().inflight
    }
    pub fn throttled_until_ms(&self) -> Option<i64> {
        match self.throttled_until_ms.load(Ordering::Relaxed) {
            0 => None,
            value => Some(value),
        }
    }
    pub fn set_throttled_until_ms(&self, value: Option<i64>) {
        self.throttled_until_ms.store(value.unwrap_or(0), Ordering::Relaxed);
    }

    /// 这条通道的总并发：座位数 × 单座位并发。
    pub fn capacity(&self) -> u32 {
        let config = self.config.read().unwrap();
        config.seats * config.seat_concurrency
    }

    /// 这一轮 next 要报给 Hub 的空位数。排空 / 暂停 / 凭据失效时报 0，
    /// Hub 就不会再往这条队列上派单，在跑的照常跑完。
    pub fn free(&self, now_ms: i64) -> u32 {
        if self.draining.load(Ordering::Relaxed)
            || self.paused.load(Ordering::Relaxed)
            || !self.upstream_ok.load(Ordering::Relaxed)
        {
            return 0;
        }
        if self.throttled_until_ms.load(Ordering::Relaxed) > now_ms {
            return 0;
        }
        self.capacity().saturating_sub(self.inflight())
    }

    /// Retry-After 支持秒数和 HTTP 日期。并发中的旧响应不能缩短已有冷却。
    pub fn throttle(&self, retry_after: Option<&str>, now_ms: i64) {
        let raw = retry_after.map(str::trim).filter(|value| !value.is_empty());
        let parsed = raw.and_then(|raw| match raw.parse::<f64>() {
            Ok(seconds) if is_plain_seconds(raw) => Some(now_ms + (seconds * 1000.0) as i64),
            _ => parse_http_date_ms(raw),
        });
        let until = match parsed {
            Some(value) if value > now_ms && value <= 8_640_000_000_000_000 => value,
            _ => now_ms + 120_000,
        };
        let current = self.throttled_until_ms.load(Ordering::Relaxed);
        self.throttled_until_ms.store(current.max(until), Ordering::Relaxed);
    }

    /// 占一个执行位。单个消费者在这条通道上的并行数不能超过 seatConcurrency，
    /// 否则一个人就能把整台机器占满。
    pub fn acquire(&self, consumer_key: &str) -> bool {
        let capacity = self.capacity();
        let seat_concurrency = self.config.read().unwrap().seat_concurrency;
        let mut state = self.state.lock().unwrap();
        if state.inflight >= capacity {
            return false;
        }
        let used = state.per_consumer.get(consumer_key).copied().unwrap_or(0);
        if used >= seat_concurrency {
            return false;
        }
        state.per_consumer.insert(consumer_key.to_string(), used + 1);
        state.inflight += 1;
        true
    }

    pub fn release(&self, consumer_key: &str) {
        let mut state = self.state.lock().unwrap();
        let used = state.per_consumer.get(consumer_key).copied().unwrap_or(1).saturating_sub(1);
        if used == 0 {
            state.per_consumer.remove(consumer_key);
        } else {
            state.per_consumer.insert(consumer_key.to_string(), used);
        }
        state.inflight = state.inflight.saturating_sub(1);
    }
}

/// 等价 TS 的 /^\d+(\.\d+)?$/：只有纯数字才按「秒」解释。
fn is_plain_seconds(raw: &str) -> bool {
    let mut parts = raw.splitn(2, '.');
    let whole = parts.next().unwrap_or("");
    if whole.is_empty() || !whole.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(fraction) => !fraction.is_empty() && fraction.bytes().all(|c| c.is_ascii_digit()),
    }
}

/// Retry-After 的 HTTP 日期形态，例如 `Tue, 15 Nov 1994 12:45:26 GMT`。
pub fn parse_http_date_ms(raw: &str) -> Option<i64> {
    use time::format_description::well_known::Rfc2822;
    // RFC 2822 的解析器不收 `GMT` 这个废弃时区名，而 HTTP 日期恰好只用它。
    let normalized = raw.trim().replace(" GMT", " +0000").replace(" UTC", " +0000");
    let parsed = time::OffsetDateTime::parse(&normalized, &Rfc2822).ok()?;
    Some((parsed.unix_timestamp_nanos() / 1_000_000) as i64)
}
