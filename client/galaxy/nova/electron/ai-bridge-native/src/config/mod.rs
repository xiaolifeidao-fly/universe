pub mod schema;

use crate::core::paths::{default_config_path, Env};
use schema::*;
use serde_json::Value;
use std::path::Path;

/// 把 `${ENV_VAR}` 占位符替换成环境变量的值；缺失时替换成空串，
/// 具体字段是否必填交给结构校验判。
fn expand_env(value: Value, env: &Env) -> Value {
    match value {
        Value::String(s) => Value::String(expand_env_str(&s, env)),
        Value::Array(items) => Value::Array(items.into_iter().map(|v| expand_env(v, env)).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, expand_env(v, env))).collect())
        }
        other => other,
    }
}

fn expand_env_str(raw: &str, env: &Env) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = raw[i + 2..].find('}') {
                let name = &raw[i + 2..i + 2 + end];
                if !name.is_empty()
                    && name.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
                {
                    out.push_str(env.get(name).unwrap_or(""));
                    i += 2 + end + 1;
                    continue;
                }
            }
        }
        let ch = raw[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

// ---------- 结构校验 ----------
// serde 管得住类型和必填，管不住 zod 里那些 min / regex / url / refine。
// 这一层把它们补上，错误前缀与 TS 一致（测试按 /Invalid config/ 匹配）。

fn invalid(message: impl AsRef<str>) -> String {
    format!("Invalid config: {}", message.as_ref())
}

fn require_url(field: &str, value: &str) -> Result<(), String> {
    reqwest::Url::parse(value).map(|_| ()).map_err(|_| invalid(format!("{field} 不是合法 URL：{value}")))
}

fn require_positive(field: &str, value: u64) -> Result<(), String> {
    if value == 0 { return Err(invalid(format!("{field} 必须是正整数"))) }
    Ok(())
}

fn require_nonempty(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() { return Err(invalid(format!("{field} 不能为空"))) }
    Ok(())
}

fn is_alias(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn validate_auth_token(t: &AuthToken) -> Result<(), String> {
    if !is_alias(&t.alias) {
        return Err(invalid(format!("auth token alias 不合法：{}", t.alias)));
    }
    match (&t.token, &t.token_hash) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(invalid(format!("token 与 tokenHash 必须且只能填一个（alias={}）", t.alias)))
        }
        (Some(token), None) if token.chars().count() < 8 => {
            return Err(invalid(format!("token 至少 8 个字符（alias={}）", t.alias)))
        }
        (None, Some(hash)) if !is_sha256_hex(hash) => {
            return Err(invalid(format!("tokenHash 必须是 64 位小写 sha256 hex（alias={}）", t.alias)))
        }
        _ => {}
    }
    if t.scopes.is_empty() {
        return Err(invalid(format!("token scopes 不能为空（alias={}）", t.alias)));
    }
    if let Some(c) = t.concurrency {
        require_positive(&format!("token concurrency（alias={}）", t.alias), c as u64)?;
    }
    Ok(())
}

fn validate_provider(name: &str, p: &ProviderConfig) -> Result<(), String> {
    if let Some(url) = &p.base_url {
        require_url(&format!("providers.{name}.baseURL"), url)?;
    }
    if let Some(service) = &p.claude_keychain_service {
        require_nonempty(&format!("providers.{name}.claudeKeychainService"), service)?;
    }
    if let Some(models) = &p.models {
        for m in models {
            require_nonempty(&format!("providers.{name}.models"), m)?;
        }
    }
    if let Some(v) = &p.models_client_version {
        require_nonempty(&format!("providers.{name}.modelsClientVersion"), v)?;
    }
    for (field, value) in [("concurrency", p.concurrency), ("queueMaxSize", p.queue_max_size)] {
        if let Some(v) = value {
            require_positive(&format!("providers.{name}.{field}"), v as u64)?;
        }
    }
    if let Some(v) = p.timeout_ms {
        require_positive(&format!("providers.{name}.timeoutMs"), v)?;
    }
    Ok(())
}

fn validate_pool_shape(pool: &PoolConfig) -> Result<(), String> {
    require_url("pool.hubURL", &pool.hub_url)?;
    require_positive("pool.heartbeatSec", pool.heartbeat_sec as u64)?;
    if !(1..=30).contains(&pool.next_wait_sec) {
        return Err(invalid("pool.nextWaitSec 必须在 1..30 之间"));
    }
    require_positive("pool.contract", pool.contract as u64)?;
    for c in &pool.contributions {
        if !is_alias(&c.id) {
            return Err(invalid(format!("pool.contributions id 不合法：{}", c.id)));
        }
        require_nonempty(&format!("贡献 \"{}\" 的 kind", c.id), &c.kind)?;
        require_positive(&format!("贡献 \"{}\" 的 kindVersion", c.id), c.kind_version as u64)?;
        require_positive(&format!("贡献 \"{}\" 的 seats", c.id), c.seats as u64)?;
        require_positive(&format!("贡献 \"{}\" 的 seatConcurrency", c.id), c.seat_concurrency as u64)?;
        if c.quota.is_empty() {
            return Err(invalid(format!("贡献 \"{}\" 至少要有一条 quota", c.id)));
        }
        for q in &c.quota {
            require_nonempty(&format!("贡献 \"{}\" 的 quota.unit", c.id), &q.unit)?;
            require_positive(&format!("贡献 \"{}\" 的 quota.limit", c.id), q.limit)?;
        }
        for s in &c.schedule {
            if !is_time_window(&s.window) {
                return Err(invalid(format!("贡献 \"{}\" 的 schedule.window 不合法：{}", c.id, s.window)));
            }
        }
        if let Some(exec) = &c.exec {
            require_nonempty(&format!("贡献 \"{}\" 的 exec.command", c.id), &exec.command)?;
            if let Some(v) = exec.timeout_ms {
                require_positive(&format!("贡献 \"{}\" 的 exec.timeoutMs", c.id), v)?;
            }
        }
    }
    Ok(())
}

/// "22:00-08:00" 这种区间；跨零点合法。等价 TS 的 /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/。
fn is_time_window(raw: &str) -> bool {
    let Some((from, to)) = raw.split_once('-') else { return false };
    [from, to].iter().all(|part| {
        let Some((h, m)) = part.split_once(':') else { return false };
        (1..=2).contains(&h.len()) && h.bytes().all(|c| c.is_ascii_digit())
            && m.len() == 2 && m.bytes().all(|c| c.is_ascii_digit())
    })
}

fn validate_shape(cfg: &AppConfig) -> Result<(), String> {
    require_nonempty("server.host", &cfg.server.host)?;
    for (field, value) in [
        ("requestTimeoutMs", cfg.server.request_timeout_ms),
        ("queueWaitTimeoutMs", cfg.server.queue_wait_timeout_ms),
        ("streamIdleTimeoutMs", cfg.server.stream_idle_timeout_ms),
        ("shutdownTimeoutMs", cfg.server.shutdown_timeout_ms),
    ] {
        require_positive(&format!("server.{field}"), value)?;
    }
    require_nonempty("server.bodyLimit", &cfg.server.body_limit)?;
    crate::core::logger::Level::parse(&cfg.log.level)
        .ok_or_else(|| invalid(format!("log.level 只能是 debug/info/warn/error，收到 {}", cfg.log.level)))?;
    require_positive("concurrency.global", cfg.concurrency.global as u64)?;
    require_positive("concurrency.queueMaxSize", cfg.concurrency.queue_max_size as u64)?;
    require_positive("retry.maxAttempts", cfg.retry.max_attempts as u64)?;
    require_positive("retry.baseDelayMs", cfg.retry.base_delay_ms)?;
    require_positive("retry.maxDelayMs", cfg.retry.max_delay_ms)?;
    for t in &cfg.auth.tokens {
        validate_auth_token(t)?;
    }
    for entry in &cfg.auth.ip_allowlist {
        require_nonempty("auth.ipAllowlist", entry)?;
    }
    for (name, p) in &cfg.providers {
        validate_provider(name, p)?;
    }
    for field in [&cfg.relay.anthropic, &cfg.relay.openai].into_iter().flatten() {
        require_nonempty("relay provider 名", field)?;
    }
    require_nonempty("agent.header", &cfg.agent.header)?;
    for r in &cfg.agent.routes {
        require_nonempty("agent.routes.match", &r.pattern)?;
        require_nonempty("agent.routes.provider", &r.provider)?;
    }
    if let Some(pool) = &cfg.pool {
        validate_pool_shape(pool)?;
    }
    Ok(())
}

// ---------- 一致性校验 ----------
// 配置文件之外的一致性校验：引用的 provider 必须存在且类型对得上。

/// 订阅登录态类的 provider 可以不写 baseURL：地址跟着本机 Claude Code / Codex
/// 正在用的上游走。api_key 没有这种「本机正在用的」参照物，必须显式写。
fn needs_explicit_base_url(auth_mode: Option<AuthMode>) -> bool {
    !matches!(auth_mode, Some(AuthMode::ClaudeOauth) | Some(AuthMode::CodexChatgpt))
}

fn assert_relay_provider(who: &str, name: &str, p: &ProviderConfig) -> Result<(), String> {
    if p.kind != ProviderType::Relay {
        return Err(format!("{who} 引用的 provider \"{name}\" 必须是 relay（当前 type={}）", p.kind.label()));
    }
    if p.base_url.is_none() && needs_explicit_base_url(p.auth_mode) {
        return Err(format!(
            "{who} 引用的 provider \"{name}\" 是 authMode={}，必须配置 baseURL（只有 claude_oauth / codex_chatgpt 可以省略，自动跟随本机 CLI 的上游）",
            p.auth_mode.map(AuthMode::label).unwrap_or("api_key"),
        ));
    }
    Ok(())
}

pub fn validate_config(cfg: &AppConfig) -> Result<(), String> {
    for (field, name) in [("relay.anthropic", &cfg.relay.anthropic), ("relay.openai", &cfg.relay.openai)] {
        let Some(name) = name else { continue };
        let p = cfg.providers.get(name)
            .ok_or_else(|| format!("{field} 引用了不存在的 provider \"{name}\""))?;
        assert_relay_provider(field, name, p)?;
    }
    if cfg.relay.enabled && cfg.relay.anthropic.is_none() && cfg.relay.openai.is_none() {
        return Err("relay.enabled=true 但 relay.anthropic / relay.openai 都没配".into());
    }
    for r in &cfg.agent.routes {
        let p = cfg.providers.get(&r.provider).ok_or_else(|| {
            format!("agent.routes \"{}\" 引用了不存在的 provider \"{}\"", r.pattern, r.provider)
        })?;
        if p.kind == ProviderType::Relay {
            return Err(format!(
                "agent.routes \"{}\" 引用的 provider \"{}\" 是 relay，agent 路由只能指向本机 agent provider",
                r.pattern, r.provider,
            ));
        }
    }
    if cfg.agent.enabled && cfg.agent.routes.is_empty() {
        return Err("agent.enabled=true 但 agent.routes 为空".into());
    }
    if cfg.mode == Mode::Pool {
        let pool = cfg.pool.as_ref().ok_or("mode=pool 但缺少 pool 配置段")?;
        let mut ids = std::collections::HashSet::new();
        for c in &pool.contributions {
            if !ids.insert(c.id.as_str()) {
                return Err(format!("pool.contributions 里 id \"{}\" 重复", c.id));
            }
            // 中转类能力靠 upstream 借订阅登录态；本机执行类能力靠 exec 跑命令。
            // 两者必须二选一：都不填的话，这条贡献申报上去也没人能执行它。
            if let Some(upstream) = &c.upstream {
                let p = cfg.providers.get(upstream)
                    .ok_or_else(|| format!("贡献 \"{}\" 引用了不存在的 provider \"{upstream}\"", c.id))?;
                assert_relay_provider(&format!("贡献 \"{}\"", c.id), upstream, p)?;
                if p.auth_mode.is_none() {
                    return Err(format!(
                        "贡献 \"{}\" 引用的 provider \"{upstream}\" 缺少 authMode，无法推出路由键", c.id,
                    ));
                }
            } else if c.provider.is_some() {
                // 本机执行类能力：exec 只在需要自定义命令时填（ffmpeg 默认走 PATH），
                // 但 agent 回合那种「跑什么完全由主人决定」的能力必须显式给命令。
                if c.kind == "delivery.task" && c.exec.is_none() {
                    return Err(format!("贡献 \"{}\" 是 agent 回合，必须用 exec 指定执行器命令", c.id));
                }
            } else {
                return Err(format!("贡献 \"{}\" 既没有 upstream 也没有 provider，没有任何东西能执行它", c.id));
            }
        }
        // 这里**不再**要求配置里有启用的贡献：共享哪几种由主人在控制台定，
        // 节点得先跑起来、先 hello 上去，主人才可能在控制台看到这台机器有什么。
    }
    let mut aliases = std::collections::HashSet::new();
    for t in &cfg.auth.tokens {
        if !aliases.insert(t.alias.as_str()) {
            return Err(format!("auth.tokens 里 alias \"{}\" 重复", t.alias));
        }
    }
    Ok(())
}

pub fn parse_config(raw: Value, env: &Env) -> Result<AppConfig, String> {
    let expanded = expand_env(raw, env);
    let cfg: AppConfig = serde_json::from_value(expanded).map_err(|e| invalid(e.to_string()))?;
    validate_shape(&cfg)?;
    validate_config(&cfg)?;
    Ok(cfg)
}

pub fn load_config(config_path: Option<&Path>, env: &Env) -> Result<AppConfig, String> {
    let owned;
    let file = match config_path {
        Some(p) => p,
        None => { owned = default_config_path(env); &owned }
    };
    if !file.exists() {
        return Err(format!("Config file not found: {}（先运行 ai-bridge init）", file.display()));
    }
    let text = std::fs::read_to_string(file)
        .map_err(|e| format!("读不到配置文件 {}：{e}", file.display()))?;
    let raw: Value = serde_yaml::from_str(&text)
        .map_err(|e| invalid(format!("YAML 解析失败：{e}")))?;
    parse_config(if raw.is_null() { Value::Object(Default::default()) } else { raw }, env)
}
