use crate::core::errors::{http_error, BridgeError};
use crate::core::request::{stream_idle_timeout, Cancel};
use crate::log_debug;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode};
use bytes::Bytes;
use futures_util::StreamExt;
use std::time::Duration;

/// 上游响应里原样带回给客户端的头（限流/重试提示与请求追踪）
const PASSTHROUGH_RESPONSE_HEADERS: [&str; 3] = ["request-id", "retry-after", "x-should-retry"];

fn should_passthrough_header(name: &str) -> bool {
    PASSTHROUGH_RESPONSE_HEADERS.contains(&name)
        || name.starts_with("anthropic-ratelimit-")
        || name.starts_with("x-ratelimit-")
}

pub struct RelayRequest {
    /// 客户端请求路径，如 /v1/messages
    pub path: String,
    /// 原样带上的查询串，含前导 ?；没有就是空串
    pub query: String,
    /// 上游前缀，可带 path（如 https://chatgpt.com/backend-api/codex）
    pub base_url: String,
    pub accept: Option<String>,
    /// 鉴权及上游所需的额外头
    pub auth_headers: Vec<(String, String)>,
    /// 订阅协议适配后的请求体，逐字节转发
    pub body: Bytes,
    pub idle_timeout_ms: Option<u64>,
    pub request_id: String,
}

/// 纯透传：把客户端请求原样转发到上游模型 API，再把上游响应（含 SSE 流）原样写回。
/// 请求体与响应不做协议转换，工具调用始终交给客户端。
///
/// `keep` 是要跟着响应流一起活着的东西（并发名额、请求生命周期）：流结束或被
/// 丢弃时一并掉落，所以客户端中途断开也不会漏掉释放。
pub async fn proxy_relay<K: Send + 'static>(
    client: &reqwest::Client,
    req: RelayRequest,
    cancel: &Cancel,
    keep: K,
) -> Result<Response<Body>, BridgeError> {
    // 路径拼接：剥掉客户端的 /v1 前缀，接到上游 baseURL 后面。
    //   anthropic: baseURL=.../v1                + /messages   → .../v1/messages
    //   chatgpt:   baseURL=/backend-api/codex    + /responses  → /backend-api/codex/responses
    let base = req.base_url.trim_end_matches('/');
    let sub_path = req.path.strip_prefix("/v1").filter(|rest| rest.starts_with('/')).unwrap_or(&req.path);
    let url = format!("{base}{sub_path}{}", req.query);

    // 只带白名单头：客户端的 authorization / x-api-key / cookie 一律不转发
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let accept = req.accept.as_deref().unwrap_or("text/event-stream");
    if let Ok(value) = HeaderValue::from_str(accept) {
        headers.insert(axum::http::header::ACCEPT, value);
    }
    for (name, value) in &req.auth_headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name.as_str()), HeaderValue::from_str(value)) {
            headers.insert(name, value);
        }
    }

    log_debug!("relay_forward", "requestId": req.request_id, "url": url, "bytes": req.body.len());

    let idle = req.idle_timeout_ms.map(Duration::from_millis);
    let send = client.post(&url).headers(headers).body(req.body).send();

    // 静默计时从发出请求就开始：上游连头都不给的情况同样算超时（504）。
    let upstream = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(cancel.reason()),
        () = optional_sleep(idle) => return Err(stream_idle_timeout()),
        result = send => result.map_err(upstream_error)?,
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = Response::builder().status(status);
    {
        let out_headers = out.headers_mut().expect("response builder headers");
        if let Some(ct) = upstream.headers().get(reqwest::header::CONTENT_TYPE) {
            if let Ok(value) = HeaderValue::from_bytes(ct.as_bytes()) {
                out_headers.insert(axum::http::header::CONTENT_TYPE, value);
            }
        }
        for (name, value) in upstream.headers() {
            if !should_passthrough_header(name.as_str()) {
                continue;
            }
            if let (Ok(name), Ok(value)) =
                (HeaderName::try_from(name.as_str()), HeaderValue::from_bytes(value.as_bytes()))
            {
                out_headers.insert(name, value);
            }
        }
        out_headers.insert(axum::http::header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
        out_headers.insert(HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no"));
    }

    struct StreamState<K> {
        inner: std::pin::Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<Bytes>> + Send>>,
        cancel: Cancel,
        idle: Option<Duration>,
        _keep: K,
    }

    let state = StreamState {
        inner: Box::pin(upstream.bytes_stream()),
        cancel: cancel.clone(),
        idle,
        _keep: keep,
    };

    // pipeline 语义：上游中途断流时让流以错误结束，客户端看到的是坏掉的流，
    // 而不是一个看起来正常完成的响应。
    let body = futures_util::stream::unfold(state, |mut state| async move {
        let next = tokio::select! {
            biased;
            () = state.cancel.cancelled() => Some(Err(state.cancel.reason())),
            () = optional_sleep(state.idle) => Some(Err(stream_idle_timeout())),
            chunk = state.inner.next() => match chunk {
                Some(Ok(bytes)) => Some(Ok(bytes)),
                Some(Err(e)) => Some(Err(upstream_error(e))),
                None => None,
            },
        };
        next.map(|item| (item, state))
    });

    out.body(Body::from_stream(body)).map_err(|e| http_error(500, "relay_response_failed", e.to_string()))
}

async fn optional_sleep(duration: Option<Duration>) {
    match duration {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending().await,
    }
}

fn upstream_error(e: reqwest::Error) -> BridgeError {
    // 不把上游 URL / 响应体带进错误：可能含账号信息。
    let code = if e.is_timeout() { "upstream_timeout" } else if e.is_connect() { "upstream_unreachable" } else { "upstream_failed" };
    http_error(502, code, e.without_url().to_string())
}

/// `bodyLimit: "30mb"` 这种人写的大小。认不出来时退回默认 4mb。
pub fn parse_body_limit(raw: &str) -> usize {
    let text = raw.trim().to_ascii_lowercase();
    let digits = text.trim_end_matches(|c: char| c.is_ascii_alphabetic()).trim();
    let unit = text[digits.len()..].trim();
    let Ok(value) = digits.parse::<f64>() else { return 4 * 1024 * 1024 };
    let scale: f64 = match unit {
        "" | "b" => 1.0,
        "kb" | "k" => 1024.0,
        "mb" | "m" => 1024.0 * 1024.0,
        "gb" | "g" => 1024.0 * 1024.0 * 1024.0,
        _ => return 4 * 1024 * 1024,
    };
    (value * scale) as usize
}
