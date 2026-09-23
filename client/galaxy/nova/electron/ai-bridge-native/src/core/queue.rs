use crate::config::schema::AppConfig;
use crate::core::errors::{http_error, BridgeError};
use crate::core::request::Cancel;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// 三层闸门：
///   principal —— 每个调用方 token 自己的并发上限（可选），先挡住单个用户把大家拖垮
///   provider  —— 每个上游独立队列，一家限流不连累别家
///   global    —— 进程总并发上限，防止单机被打爆
///
/// acquire 顺序：principal → provider → global；任一满/超时就 503。release 反向释放。
struct SubQueue {
    sem: Arc<Semaphore>,
    concurrency: u32,
    max_size: u32,
    /// 排队中（还没拿到名额）的数量，等价 p-queue 的 q.size
    waiting: AtomicU32,
    /// 正在跑的数量，等价 p-queue 的 q.pending
    running: AtomicU32,
}

impl SubQueue {
    fn new(concurrency: u32, max_size: u32) -> Arc<Self> {
        Arc::new(Self {
            sem: Arc::new(Semaphore::new(concurrency as usize)),
            concurrency,
            max_size,
            waiting: AtomicU32::new(0),
            running: AtomicU32::new(0),
        })
    }
    fn snapshot(&self) -> Value {
        json!({
            "size": self.waiting.load(Ordering::Relaxed),
            "pending": self.running.load(Ordering::Relaxed),
            "concurrency": self.concurrency,
            "queueMaxSize": self.max_size,
        })
    }
    fn is_idle(&self) -> bool {
        self.waiting.load(Ordering::Relaxed) == 0 && self.running.load(Ordering::Relaxed) == 0
    }
}

/// 拿到手的一个名额。掉落即归还，所以任何提前 return / panic / 客户端断开
/// 都不会漏掉释放。
struct Slot {
    queue: Arc<SubQueue>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.queue.running.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 一次请求占住的三层名额。整体掉落时按 global → provider → principal 反向释放。
pub struct GateGuard {
    _global: Slot,
    _provider: Slot,
    _principal: Option<PrincipalSlot>,
}

struct PrincipalSlot {
    alias: String,
    principals: Arc<Mutex<HashMap<String, PrincipalState>>>,
}

impl Drop for PrincipalSlot {
    fn drop(&mut self) {
        let mut map = self.principals.lock().unwrap();
        if let Some(state) = map.get_mut(&self.alias) {
            state.pending = state.pending.saturating_sub(1);
            if state.pending == 0 {
                map.remove(&self.alias);
            }
        }
    }
}

struct PrincipalState {
    pending: u32,
    limit: u32,
}

pub struct ConcurrencyGate {
    global: Arc<SubQueue>,
    providers: HashMap<String, Arc<SubQueue>>,
    principals: Arc<Mutex<HashMap<String, PrincipalState>>>,
}

pub struct AcquireOptions<'a> {
    pub provider_name: &'a str,
    pub principal_alias: Option<&'a str>,
    pub principal_limit: Option<u32>,
    pub wait_timeout_ms: u64,
    pub cancel: &'a Cancel,
}

impl ConcurrencyGate {
    pub fn new(cfg: &AppConfig) -> Self {
        let mut providers = HashMap::new();
        for (name, pc) in &cfg.providers {
            providers.insert(
                name.clone(),
                SubQueue::new(
                    pc.concurrency.unwrap_or(cfg.concurrency.global),
                    pc.queue_max_size.unwrap_or(cfg.concurrency.queue_max_size),
                ),
            );
        }
        Self {
            global: SubQueue::new(cfg.concurrency.global, cfg.concurrency.queue_max_size),
            providers,
            principals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn stats(&self) -> Value {
        let mut providers = serde_json::Map::new();
        for (name, sub) in &self.providers {
            providers.insert(name.clone(), sub.snapshot());
        }
        let mut principals = serde_json::Map::new();
        for (alias, state) in self.principals.lock().unwrap().iter() {
            if state.pending > 0 {
                principals.insert(alias.clone(), json!({ "pending": state.pending, "concurrency": state.limit }));
            }
        }
        json!({ "global": self.global.snapshot(), "providers": providers, "principals": principals })
    }

    pub async fn acquire(&self, opts: AcquireOptions<'_>) -> Result<GateGuard, BridgeError> {
        let sub = self.providers.get(opts.provider_name).cloned().ok_or_else(|| {
            http_error(500, "unknown_provider", format!("provider not found: {}", opts.provider_name))
        })?;

        // principal 层：不排队，超了直接 429（这是调用方自己的配额）
        let principal = match (opts.principal_alias, opts.principal_limit) {
            (Some(alias), Some(limit)) if limit > 0 => {
                let mut map = self.principals.lock().unwrap();
                let state = map.entry(alias.to_string())
                    .or_insert(PrincipalState { pending: 0, limit });
                state.limit = limit;
                if state.pending >= state.limit {
                    return Err(http_error(429, "principal_concurrency_exceeded",
                        format!("too many concurrent requests for \"{alias}\"")));
                }
                state.pending += 1;
                drop(map);
                Some(PrincipalSlot { alias: alias.to_string(), principals: Arc::clone(&self.principals) })
            }
            _ => None,
        };

        if sub.waiting.load(Ordering::Relaxed) >= sub.max_size {
            return Err(http_error(503, "queue_full", format!("provider {} queue full", opts.provider_name)));
        }
        if self.global.waiting.load(Ordering::Relaxed) >= self.global.max_size {
            return Err(http_error(503, "queue_full", "global queue full"));
        }

        let provider_slot = acquire_one(&sub, opts.provider_name, opts.wait_timeout_ms, opts.cancel).await?;
        let global_slot = acquire_one(&self.global, "global", opts.wait_timeout_ms, opts.cancel).await?;
        Ok(GateGuard { _global: global_slot, _provider: provider_slot, _principal: principal })
    }

    /// 所有队列排空。关闭流程与测试用它等到在跑的请求结束。
    pub async fn on_idle(&self) {
        loop {
            let idle = self.global.is_idle() && self.providers.values().all(|s| s.is_idle());
            if idle {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

async fn acquire_one(
    sub: &Arc<SubQueue>,
    label: &str,
    wait_timeout_ms: u64,
    cancel: &Cancel,
) -> Result<Slot, BridgeError> {
    // 立刻拿得到就不算排队 —— 与 p-queue 的 size/pending 语义对齐。
    if let Ok(permit) = Arc::clone(&sub.sem).try_acquire_owned() {
        sub.running.fetch_add(1, Ordering::Relaxed);
        return Ok(Slot { queue: Arc::clone(sub), _permit: permit });
    }

    sub.waiting.fetch_add(1, Ordering::Relaxed);
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(cancel.reason()),
        permit = Arc::clone(&sub.sem).acquire_owned() => permit
            .map_err(|_| http_error(503, "queue_closed", format!("{label} queue closed"))),
        () = tokio::time::sleep(Duration::from_millis(wait_timeout_ms)) => {
            Err(http_error(503, "queue_wait_timeout", format!("{label} queue wait timeout")))
        }
    };
    sub.waiting.fetch_sub(1, Ordering::Relaxed);

    let permit = result?;
    sub.running.fetch_add(1, Ordering::Relaxed);
    Ok(Slot { queue: Arc::clone(sub), _permit: permit })
}
