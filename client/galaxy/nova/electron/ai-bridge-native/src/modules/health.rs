use crate::app::BridgeState;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// 存活/就绪探针。不需要鉴权（也不泄露任何配置细节，只有队列计数）。
pub fn routes() -> Router<Arc<BridgeState>> {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({ "ok": true })) }))
        .route("/readyz", get(readyz))
}

async fn readyz(State(state): State<Arc<BridgeState>>) -> impl IntoResponse {
    if state.shutting_down.load(Ordering::Relaxed) {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "reason": "shutting_down" })),
        );
    }
    (
        axum::http::StatusCode::OK,
        Json(json!({
            "ok": true,
            "modules": state.modules,
            "queue": state.gate.stats(),
            "health": { "relay": {
                "anthropic": state.cfg.relay.anthropic,
                "openai": state.cfg.relay.openai,
            } },
        })),
    )
}
