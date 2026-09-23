mod common;

use axum::http::Method;
use axum::response::IntoResponse;
use common::*;
use serde_json::{json, Value};

#[tokio::test]
async fn admin_endpoints_need_the_admin_scope_and_the_token_lifecycle_works_end_to_end() {
    let h = harness(
        handler(|_req| async move { ([("content-type", "application/json")], "{}").into_response() }),
        json!({}),
    )
    .await;

    let denied = h.get("/admin/status").await;
    assert_eq!(denied.status(), 403);
    let _ = denied.text().await;

    let status = h.request(Method::GET, "/admin/status").header("x-api-key", ADMIN_TOKEN).send().await.unwrap();
    assert_eq!(status.status(), 200);
    let body: Value = status.json().await.unwrap();
    assert_eq!(body["relay"]["anthropic"], json!("claude"));
    assert_eq!(body["auth"]["tokens"], json!(3));

    // 生成一个新 token → 只存哈希 → 立即可用
    let created = h
        .request(Method::POST, "/admin/tokens")
        .header("x-api-key", ADMIN_TOKEN)
        .json(&json!({ "alias": "newbie", "scopes": ["relay:anthropic"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let token = created.json::<Value>().await.unwrap()["token"].as_str().unwrap().to_string();

    let raw = std::fs::read_to_string(h.dir.path().join("tokens.json")).unwrap();
    let file: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(file["tokens"].as_array().unwrap().len(), 1);
    assert_eq!(file["tokens"][0]["alias"], json!("newbie"));
    assert!(file["tokens"][0].get("token").is_none(), "明文 token 不能落盘");
    assert!(!raw.contains(&token));

    let used = h
        .request(Method::POST, "/v1/messages")
        .header("x-api-key", &token)
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(used.status(), 200);
    let _ = used.text().await;

    let duplicate = h
        .request(Method::POST, "/admin/tokens")
        .header("x-api-key", ADMIN_TOKEN)
        .json(&json!({ "alias": "newbie" }))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), 409);
    let _ = duplicate.text().await;

    let revoked = h
        .request(Method::DELETE, "/admin/tokens/newbie")
        .header("x-api-key", ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 200);
    let _ = revoked.text().await;

    let after = h
        .request(Method::POST, "/v1/messages")
        .header("x-api-key", &token)
        .json(&tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), 401);
    let _ = after.text().await;
    h.close().await;
}

#[tokio::test]
async fn readyz_exposes_modules_and_queue_while_healthz_needs_no_auth() {
    let h = harness(
        handler(|_req| async move { ([("content-type", "application/json")], "{}").into_response() }),
        json!({}),
    )
    .await;
    let response = h.client.get(format!("{}/readyz", h.url)).send().await.unwrap();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["modules"], json!(["health", "relay", "admin"]));
    assert!(body["queue"]["providers"]["claude"].is_object());

    let health = h.client.get(format!("{}/healthz", h.url)).send().await.unwrap();
    assert_eq!(health.status(), 200);
    assert_eq!(health.json::<Value>().await.unwrap(), json!({ "ok": true }));
    h.close().await;
}

/// admin 只允许回环来源；trustProxy 打开后伪造的 X-Forwarded-For 会被当真，
/// 所以这条路径必须挡住非回环地址。
#[tokio::test]
async fn admin_rejects_non_loopback_sources_when_the_proxy_header_is_trusted() {
    let h = harness(
        handler(|_req| async move { ([("content-type", "application/json")], "{}").into_response() }),
        json!({ "server": { "host": "127.0.0.1", "port": 0, "trustProxy": true } }),
    )
    .await;
    let response = h
        .request(Method::GET, "/admin/status")
        .header("x-api-key", ADMIN_TOKEN)
        .header("x-forwarded-for", "203.0.113.7")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(error_type(response).await, "loopback_only");
    h.close().await;
}
