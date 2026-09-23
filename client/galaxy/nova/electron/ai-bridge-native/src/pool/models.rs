use crate::config::schema::{AuthMode, ProviderConfig};
use crate::core::paths::{expand_home, home_dir, runtime_dir, Env};
use crate::credentials::types::UpstreamAuthContext;
use crate::credentials::{resolve_upstream, CredentialRegistry, UpstreamTarget};
use crate::{log_info, log_warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 上游可用模型清单。
///
/// 控制台的「只放这些模型 / 不放这些模型」以前只能手敲，主人得自己记住上游有什么。
/// 这里把清单探出来上报给 Hub，控制台拿它当候选项。
///
/// **这是唯一一处会真的打上游的探测**，和 probe.rs 那条「只解析凭据、不发请求」的
/// 原则是例外关系，所以要说清楚为什么可以接受：
///   · /models 不消耗任何 token 额度，只是一次鉴权过的 GET；
///   · 结果缓存 6 小时，hello 再频繁也不会变成对上游的压力；
///   · 失败一律降级成空清单，绝不让它影响能力探测的结果。
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// 失败缓存短一些：上游临时抽风不该让候选项空掉半天。
const FAILURE_TTL: Duration = Duration::from_secs(10 * 60);
const TIMEOUT: Duration = Duration::from_secs(8);
const PERSISTENT_CACHE_VERSION: u32 = 1;
const PERSISTENT_CACHE_FILE: &str = "models-cache.json";
/// Codex 后端按主版本过滤模型：0.x 给空清单，>= 1 给完整的。
const DEFAULT_CODEX_CLIENT_VERSION: &str = "1.0.0";

struct Entry {
    at: Instant,
    ttl: Duration,
    models: Vec<String>,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default, Deserialize, Serialize)]
struct PersistentCache {
    version: u32,
    entries: HashMap<String, PersistentEntry>,
}

#[derive(Clone, Deserialize, Serialize)]
struct PersistentEntry {
    #[serde(rename = "expiresAtMs")]
    expires_at_ms: u64,
    models: Vec<String>,
}

fn persistent_cache_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 只给测试用：清掉进程内缓存。不删磁盘文件，便于模拟进程重启。
pub fn clear_model_cache() {
    cache().lock().unwrap().clear();
}

pub async fn list_models(
    name: &str,
    provider: &ProviderConfig,
    credentials: &CredentialRegistry,
    env: &Env,
    client: &reqwest::Client,
) -> Vec<String> {
    // 配置里声明了就以它为准，一次上游都不打。
    if let Some(models) = provider.models.as_ref().filter(|m| !m.is_empty()) {
        return models.clone();
    }
    // Codex 优先读 CLI 自己的本地缓存，见 codex_cached_models 的说明。
    if provider.auth_mode == Some(AuthMode::CodexChatgpt) {
        let cached = codex_cached_models(provider, env).await;
        if !cached.is_empty() {
            return cached;
        }
    }
    // 键里带实际上游地址：同名 provider 切换官方 / 中转后不得复用旧清单。
    let upstream = match resolve_upstream(provider, env).await {
        Ok(upstream) => upstream,
        Err(message) => {
            log_warn!("pool_models_unavailable", "provider": name, "message": message);
            return vec![];
        }
    };
    let key = persistent_key(name, provider, &upstream);
    if let Some(hit) = cache().lock().unwrap().get(&key) {
        if hit.at.elapsed() < hit.ttl {
            return hit.models.clone();
        }
    }
    if let Some((models, remaining)) = load_persistent(&key, env).await {
        cache().lock().unwrap().insert(key.clone(), Entry {
            at: Instant::now(), ttl: remaining, models: models.clone(),
        });
        log_info!("pool_models_from_persistent_cache", "provider": name, "count": models.len());
        return models;
    }

    match fetch_models(name, provider, credentials, env, client, &upstream).await {
        Ok(models) => {
            cache().lock().unwrap().insert(key.clone(), Entry {
                at: Instant::now(), ttl: TTL, models: models.clone(),
            });
            store_persistent(key, models.clone(), TTL, env).await;
            log_info!("pool_models_listed", "provider": name, "count": models.len());
            models
        }
        Err(message) => {
            // 降级成空清单，不往上抛：模型候选项是锦上添花，不能拖垮能力探测。
            log_warn!("pool_models_unavailable", "provider": name, "message": message);
            cache().lock().unwrap().insert(key.clone(), Entry {
                at: Instant::now(), ttl: FAILURE_TTL, models: vec![],
            });
            store_persistent(key, vec![], FAILURE_TTL, env).await;
            vec![]
        }
    }
}

async fn fetch_models(
    name: &str,
    provider: &ProviderConfig,
    credentials: &CredentialRegistry,
    env: &Env,
    client: &reqwest::Client,
    upstream: &UpstreamTarget,
) -> Result<Vec<String>, String> {
    let credential = credentials.resolve(provider)?;
    let headers = credential
        .headers(&UpstreamAuthContext {
            headers: &axum::http::HeaderMap::new(),
            principal: &crate::auth::principal::Principal {
                alias: "models".into(),
                ..crate::auth::principal::Principal::anonymous()
            },
            request_id: "models",
            provider,
            provider_name: name,
            upstream: &upstream,
            env,
        })
        .await?;

    let mut url = reqwest::Url::parse(&format!("{}/models", upstream.base_url))
        .map_err(|e| format!("模型清单地址不合法：{e}"))?;
    if provider.auth_mode == Some(AuthMode::CodexChatgpt) {
        url.query_pairs_mut().append_pair(
            "client_version",
            provider.models_client_version.as_deref().unwrap_or(DEFAULT_CODEX_CLIENT_VERSION),
        );
    }
    let mut request = client.get(url).header("accept", "application/json").timeout(TIMEOUT);
    for (key, value) in &headers {
        request = request.header(key.as_str(), value.as_str());
    }
    let response = request.send().await.map_err(|e| e.without_url().to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let payload: Value = response.json().await.map_err(|e| e.without_url().to_string())?;
    Ok(parse_models(&payload))
}

fn persistent_key(name: &str, provider: &ProviderConfig, upstream: &UpstreamTarget) -> String {
    serde_json::to_string(&(
        name,
        provider.auth_mode.unwrap_or(AuthMode::CodexChatgpt).label(),
        upstream.base_url.as_str(),
    ))
    .unwrap_or_else(|_| name.to_string())
}

async fn load_persistent(key: &str, env: &Env) -> Option<(Vec<String>, Duration)> {
    let path = runtime_dir(env).join(PERSISTENT_CACHE_FILE);
    let raw = tokio::fs::read(&path).await.ok()?;
    let saved: PersistentCache = match serde_json::from_slice(&raw) {
        Ok(saved) => saved,
        Err(error) => {
            log_warn!("pool_models_cache_invalid",
                "path": path.to_string_lossy(), "message": error.to_string());
            return None;
        }
    };
    if saved.version != PERSISTENT_CACHE_VERSION {
        return None;
    }
    let entry = saved.entries.get(key)?;
    let remaining_ms = entry.expires_at_ms.saturating_sub(unix_ms());
    if remaining_ms == 0 {
        return None;
    }
    Some((entry.models.clone(), Duration::from_millis(remaining_ms)))
}

async fn store_persistent(key: String, models: Vec<String>, ttl: Duration, env: &Env) {
    let _guard = persistent_cache_lock().lock().await;
    let dir = runtime_dir(env);
    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        log_warn!("pool_models_cache_write_failed",
            "path": dir.to_string_lossy(), "message": error.to_string());
        return;
    }
    let path = dir.join(PERSISTENT_CACHE_FILE);
    let now = unix_ms();
    let mut saved = match tokio::fs::read(&path).await {
        Ok(raw) => serde_json::from_slice::<PersistentCache>(&raw).unwrap_or_default(),
        Err(_) => PersistentCache::default(),
    };
    if saved.version != PERSISTENT_CACHE_VERSION {
        saved = PersistentCache { version: PERSISTENT_CACHE_VERSION, entries: HashMap::new() };
    }
    saved.entries.retain(|_, entry| entry.expires_at_ms > now);
    saved.entries.insert(key, PersistentEntry {
        expires_at_ms: now.saturating_add(ttl.as_millis().min(u128::from(u64::MAX)) as u64),
        models,
    });
    let bytes = match serde_json::to_vec(&saved) {
        Ok(bytes) => bytes,
        Err(error) => {
            log_warn!("pool_models_cache_write_failed",
                "path": path.to_string_lossy(), "message": error.to_string());
            return;
        }
    };
    // 同目录写临时文件后再原子替换，避免强制退出留下半个 JSON。
    let temporary = dir.join(format!(".{PERSISTENT_CACHE_FILE}.{}.tmp", std::process::id()));
    let result = async {
        tokio::fs::write(&temporary, bytes).await?;
        tokio::fs::rename(&temporary, &path).await
    }.await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        log_warn!("pool_models_cache_write_failed",
            "path": path.to_string_lossy(), "message": error.to_string());
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

/// 兼容三种形状：OpenAI / Anthropic 的 `{data:[{id}]}`、少数网关的 `{models:["..."]}`，
/// 以及 Codex 后端的 `{models:[{slug}]}` —— 最后这个用 slug 不用 id，漏掉它的话
/// 请求明明成功了，解析出来还是空。认不出来就当空：猜错的模型名比没有更糟，
/// 主人会照着它配出一条永远匹配不上的规则，然后以为是共享池坏了。
pub fn parse_models(payload: &Value) -> Vec<String> {
    let rows = payload
        .get("data")
        .filter(|v| v.is_array())
        .or_else(|| payload.get("models").filter(|v| v.is_array()))
        .and_then(Value::as_array);
    let Some(rows) = rows else { return vec![] };
    let mut out: Vec<String> = vec![];
    for row in rows {
        let id = match row {
            Value::String(text) => Some(text.as_str()),
            other => other.get("id").or_else(|| other.get("slug")).and_then(Value::as_str),
        };
        if let Some(id) = id.map(str::trim).filter(|v| !v.is_empty()) {
            out.push(id.to_string());
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// 读 Codex CLI 自己维护的模型缓存（`~/.codex/models_cache.json`）。
///
/// 为什么不走 HTTP：`chatgpt.com/backend-api/codex/models` 返回的**不是**客户端
/// 模型选择器那份清单。选择器那份是 CLI 自己拉下来缓存在本地的，这里直接读它，
/// 和用户在 codex 里 `/model` 看到的完全一致。
async fn codex_cached_models(provider: &ProviderConfig, env: &Env) -> Vec<String> {
    // authFile 指到哪儿，缓存就在它旁边；没配就走默认的 CODEX_HOME / ~/.codex。
    let home = match provider.auth_file.as_deref() {
        Some(file) => expand_home(file).parent().map(std::path::Path::to_path_buf).unwrap_or_else(home_dir),
        None => match env.get("CODEX_HOME") {
            Some(dir) => expand_home(dir),
            None => home_dir().join(".codex"),
        },
    };
    // 没装 CLI、没跑过、或者格式变了：交给调用方退回 HTTP。
    let Ok(raw) = tokio::fs::read_to_string(home.join("models_cache.json")).await else {
        return vec![];
    };
    let listed = parse_codex_cache(&raw);
    if !listed.is_empty() {
        log_info!("pool_models_from_codex_cache", "count": listed.len());
    }
    listed
}

/// 从 models_cache.json 里挑出用户能选的模型。两条判据都不能少：
///   · visibility == "list" —— `hide` 的是内部用途（gpt-reserve、codex-auto-review），
///     放进候选项只会让主人配出一条本不该有的规则；
///   · 按 priority 升序 —— 和 CLI 选择器里的顺序一致，主人对得上号。
///
/// 格式变了就返回空，交给调用方退回 HTTP。这是别人家的私有缓存格式，
/// 哪天字段改名不该让整条能力探测跟着挂。
pub fn parse_codex_cache(raw: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else { return vec![] };
    let Some(rows) = parsed.get("models").and_then(Value::as_array) else { return vec![] };
    let mut listed: Vec<(f64, String)> = rows
        .iter()
        .filter(|row| row.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|row| {
            let slug = row.get("slug").and_then(Value::as_str)?.trim();
            if slug.is_empty() {
                return None;
            }
            Some((row.get("priority").and_then(Value::as_f64).unwrap_or(0.0), slug.to_string()))
        })
        .collect();
    listed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    listed.into_iter().map(|(_, slug)| slug).collect()
}
