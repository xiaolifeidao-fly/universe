use crate::core::errors::BridgeError;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// 一次请求的取消信号，等价 TS 侧的 AbortSignal + abort reason。
///
/// 触发者有三个：客户端断开（499 client_closed）、总超时（504 request_timeout）、
/// 上游静默超时（504 stream_idle_timeout）。谁先到算谁的，reason 只记第一个。
#[derive(Clone)]
pub struct Cancel {
    token: CancellationToken,
    reason: Arc<Mutex<Option<BridgeError>>>,
    /// 派生信号会跟着父一起取消，原因也从父那里取 —— 关服务时在跑的流要知道
    /// 自己是被关掉的，而不是被客户端断开的。
    parent: Option<Arc<Cancel>>,
}

impl Default for Cancel {
    fn default() -> Self { Self::new() }
}

impl Cancel {
    pub fn new() -> Self {
        Self { token: CancellationToken::new(), reason: Arc::new(Mutex::new(None)), parent: None }
    }
    pub fn cancel(&self, reason: BridgeError) {
        {
            let mut slot = self.reason.lock().unwrap();
            if slot.is_none() {
                *slot = Some(reason);
            }
        }
        self.token.cancel();
    }
    pub fn is_cancelled(&self) -> bool { self.token.is_cancelled() }
    pub async fn cancelled(&self) { self.token.cancelled().await }
    /// 取消原因：自己的优先，其次父的；都没有时按客户端断开处理 —— 唯一会
    /// 不带 reason 取消的就是响应流被 hyper 丢弃那条路径。
    pub fn reason(&self) -> BridgeError {
        if let Some(reason) = self.reason.lock().unwrap().clone() {
            return reason;
        }
        match &self.parent {
            Some(parent) => parent.reason(),
            None => client_closed(),
        }
    }
    /// 派生一个子信号：父取消时子跟着取消，子自己取消不影响父。
    pub fn child(&self) -> Cancel {
        Self {
            token: self.token.child_token(),
            reason: Arc::new(Mutex::new(None)),
            parent: Some(Arc::new(self.clone())),
        }
    }
}

pub fn client_closed() -> BridgeError {
    BridgeError::new(499, "client_closed", "client_closed")
}

pub fn request_timeout() -> BridgeError {
    BridgeError::new(504, "request_timeout", "request timeout")
}

pub fn stream_idle_timeout() -> BridgeError {
    BridgeError::new(504, "stream_idle_timeout", "relay upstream idle timeout")
}

pub fn server_shutdown() -> BridgeError {
    BridgeError::new(503, "server_shutdown", "bridge is shutting down")
}

/// 每个业务请求共享的生命周期：requestId + 取消信号。
/// 总超时的计时器挂在 lifecycle 上，`_guard` 掉落时自动停。
pub struct RequestLifecycle {
    pub request_id: String,
    pub cancel: Cancel,
    _timer: DropGuard,
}

struct DropGuard(Option<tokio::task::JoinHandle<()>>);

impl Drop for DropGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

pub fn begin_request(
    incoming_request_id: Option<&str>,
    request_timeout_ms: u64,
    shutdown: &Cancel,
) -> RequestLifecycle {
    let request_id = incoming_request_id
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(64).collect::<String>())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let cancel = shutdown.child();
    let timer = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(request_timeout_ms)).await;
            cancel.cancel(request_timeout());
        })
    };
    RequestLifecycle { request_id, cancel, _timer: DropGuard(Some(timer)) }
}
