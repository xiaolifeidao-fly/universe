//! 上游订阅的余量：从中转响应的限流头里捎回来，存在内存里，随心跳报给 Hub。
//!
//! 回答的是「这台机器上的 Claude / Codex **账号自己**还剩多少」，和主人在控制台
//! 设的那份额度是两回事：那份是「打算放多少出去」，这份是「上游实际还让跑多少」。
//! 前者填得比后者宽的话，机器会在上游那儿撞限流，而平台这边看到的是「还剩大半」。
//!
//! **不打上游**：数据全部来自本来就要发的那些请求的响应头，一个额外的请求都不发。
//! 代价是机器闲着的时候这个数不会更新 —— 所以每份快照都带着观测时刻，
//! 界面必须把它显示出来，不能让人把一个几小时前的数读成此刻的余量。
//!
//! **原样存，认得出来的才归一**：上游回哪几个头、叫什么名字，是它说了算而且会变。
//! 所以 `raw` 一律原样带上，`buckets` 只是尽力而为的解析 —— 解不出来就空着，
//! 空着比猜一个 0 出来强得多：0 会被读成「用完了」。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::RwLock;

/// 限流头的厂商前缀。去掉它之后剩下的部分才是「哪个桶 + 哪一项」。
const VENDOR_PREFIXES: [&str; 3] = ["anthropic-ratelimit-", "x-ratelimit-", "ratelimit-"];

/// 一项在名字里的角色。
///
/// 两家的顺序是反的 —— Anthropic 是 `…-tokens-remaining`（角色在后），
/// OpenAI 是 `…-remaining-tokens`（角色在前）。所以不能按位置取，
/// 只能在各段里找出这个角色词，**剩下的才是桶名**。这样两种顺序、
/// 以及将来任何一种没见过的桶名，都不用改代码就能认出来。
const ROLES: [&str; 6] = ["limit", "remaining", "reset", "used", "status", "retry"];

/// 一个限流桶此刻的状态。桶名原样保留（unified-5h / requests / tokens / …）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UsageBucket {
    /// 桶名，去掉厂商前缀与角色词之后剩下的部分。空的话是 `default`。
    pub bucket: String,
    /// 从桶名里认出来的时间窗，如 `5h` / `7d`。认不出来就没有这个字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<i64>,
    /// 已用占比（0–100）。上游直接给了就用它的，没给而 limit 与 remaining 都是数字时自己算。
    #[serde(rename = "usedPercent", skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// 归零时刻，**原样**的字符串：可能是 unix 秒、ISO 时间，也可能是 `6ms` 这种时长。
    /// 不强行统一成一种 —— 解错一个时刻比原样摆着更糟。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<String>,
    /// 上游自己给的状态词，如 allowed / allowed_warning / rejected。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// 一个上游此刻的余量快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UsageSnapshot {
    /// 认出来的桶，按桶名排序。解不出来时是空数组 —— 空数组和「没有快照」不一样。
    pub buckets: Vec<UsageBucket>,
    /// 原样的限流头（键已小写）。归一化认不出来的东西全靠它，
    /// 也是事后补解析器时唯一能对照的真实报文。
    pub raw: BTreeMap<String, String>,
    /// 观测时刻，RFC3339。**必须一路带到界面上** —— 闲置的机器这个数会一直是旧的。
    #[serde(rename = "observedAt")]
    pub observed_at: String,
    /// 这份数从哪来。目前只有 headers：本来就要发的请求，顺手把响应头收下来。
    pub source: String,
}

/// 各上游的余量快照，按路由键（claude_oauth / codex_chatgpt）存。
///
/// 用 RwLock 而不是把它塞进已有的状态：写入发生在每一条中转请求的收尾，
/// 读取发生在心跳和 status —— 读远多于写，而且两边谁也不该等对方。
#[derive(Debug, Default)]
pub struct UpstreamUsage {
    inner: RwLock<HashMap<String, UsageSnapshot>>,
}

impl UpstreamUsage {
    pub fn new() -> Self {
        Self::default()
    }

    /// 收一份响应头。没有一个限流头就**什么都不做** —— 不能用一份空快照
    /// 覆盖掉上一次真实的观测：那会让界面从「剩 12%」跳成「未知」。
    pub fn observe<S: AsRef<str>>(&self, provider: &str, headers: &BTreeMap<String, S>) {
        let raw: BTreeMap<String, String> = headers
            .iter()
            .filter(|(name, _)| name.contains("ratelimit"))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.as_ref().to_string()))
            .collect();
        if raw.is_empty() {
            return;
        }
        let snapshot = UsageSnapshot {
            buckets: parse_buckets(&raw),
            raw,
            observed_at: now_rfc3339(),
            source: "headers".into(),
        };
        self.inner.write().unwrap().insert(provider.to_string(), snapshot);
    }

    pub fn get(&self, provider: &str) -> Option<UsageSnapshot> {
        self.inner.read().unwrap().get(provider).cloned()
    }

    /// 全部上游的快照，给 status 用。
    pub fn all(&self) -> BTreeMap<String, UsageSnapshot> {
        self.inner.read().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
}

/// 把限流头按桶归拢。
///
/// 做法是「找角色词、剩下的当桶名」，不是按一张已知头名的清单去匹配：
/// 那张清单今天写对了，上游改个名字就静默失效，而失效的样子是界面上的
/// 「剩余：未知」—— 没有任何人会因此收到一条错误。
fn parse_buckets(raw: &BTreeMap<String, String>) -> Vec<UsageBucket> {
    let mut grouped: BTreeMap<String, UsageBucket> = BTreeMap::new();
    for (name, value) in raw {
        let Some((bucket_name, role)) = split_bucket_role(name) else { continue };
        let entry = grouped.entry(bucket_name.clone()).or_insert_with(|| UsageBucket {
            bucket: bucket_name.clone(),
            window: window_of(&bucket_name),
            ..Default::default()
        });
        match role.as_str() {
            "limit" => entry.limit = parse_number(value),
            "remaining" => entry.remaining = parse_number(value),
            "used" => {
                // used 有两种写法：绝对数量，或者带不带 % 的占比。
                // 带 % 的一律当占比 —— 「已用 87%」和「已用 87 个」差着两个数量级。
                if value.contains('%') {
                    entry.used_percent = parse_float(value);
                } else {
                    entry.used = parse_number(value);
                }
            }
            "reset" | "retry" => entry.reset = Some(value.clone()),
            "status" => entry.status = Some(value.clone()),
            _ => {}
        }
    }
    let mut buckets: Vec<UsageBucket> = grouped.into_values().collect();
    for bucket in &mut buckets {
        fill_used_percent(bucket);
    }
    buckets
}

/// 上游没直接给占比时，用上限和余量算一个出来。两者都得是数字，而且上限要大于 0。
fn fill_used_percent(bucket: &mut UsageBucket) {
    if bucket.used_percent.is_some() {
        return;
    }
    let (Some(limit), Some(remaining)) = (bucket.limit, bucket.remaining) else { return };
    if limit <= 0 {
        return;
    }
    let used = (limit - remaining).max(0);
    bucket.used_percent = Some((used as f64) * 100.0 / (limit as f64));
}

/// 从头名里切出（桶名, 角色）。不是限流头、或者找不到角色词就返回 None。
fn split_bucket_role(name: &str) -> Option<(String, String)> {
    let lower = name.to_ascii_lowercase();
    let rest = VENDOR_PREFIXES.iter().find_map(|prefix| lower.strip_prefix(prefix))?;
    let parts: Vec<&str> = rest.split('-').filter(|part| !part.is_empty()).collect();
    let position = parts.iter().position(|part| ROLES.contains(part))?;
    let role = parts[position].to_string();
    let bucket: Vec<&str> = parts
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != position)
        .map(|(_, part)| *part)
        .collect();
    let bucket = if bucket.is_empty() { "default".to_string() } else { bucket.join("-") };
    Some((bucket, role))
}

/// 桶名里有没有一段长得像时间窗（5h / 7d / 1w / 30d）。有就单独拎出来，
/// 界面按它排「5 小时」和「一周」两栏；没有就不猜。
fn window_of(bucket: &str) -> Option<String> {
    bucket.split('-').find_map(|part| {
        let (digits, unit) = part.split_at(part.find(|c: char| !c.is_ascii_digit())?);
        if digits.is_empty() || !matches!(unit, "h" | "d" | "w" | "m" | "s") {
            return None;
        }
        Some(part.to_string())
    })
}

/// 数字。带千分位逗号、带 % 的都先剥掉；剥不出数字就返回 None，不返回 0。
fn parse_number(value: &str) -> Option<i64> {
    parse_float(value).map(|number| number as i64)
}

fn parse_float(value: &str) -> Option<f64> {
    let cleaned: String =
        value.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// Anthropic 的角色词在后（…-tokens-remaining）。
    #[test]
    fn parses_anthropic_shape() {
        let raw = headers(&[
            ("anthropic-ratelimit-unified-5h-limit", "1000000"),
            ("anthropic-ratelimit-unified-5h-remaining", "250000"),
            ("anthropic-ratelimit-unified-5h-reset", "2026-09-20T18:00:00Z"),
            ("anthropic-ratelimit-unified-status", "allowed_warning"),
        ]);
        let buckets = parse_buckets(&raw);
        let five = buckets.iter().find(|b| b.bucket == "unified-5h").expect("认出 5 小时那一桶");
        assert_eq!(five.window.as_deref(), Some("5h"));
        assert_eq!(five.limit, Some(1_000_000));
        assert_eq!(five.remaining, Some(250_000));
        assert_eq!(five.used_percent, Some(75.0));
        assert_eq!(five.reset.as_deref(), Some("2026-09-20T18:00:00Z"));
        let unified = buckets.iter().find(|b| b.bucket == "unified").expect("状态单独一桶");
        assert_eq!(unified.status.as_deref(), Some("allowed_warning"));
    }

    /// OpenAI 的角色词在前（…-remaining-tokens）。同一套代码要都认得。
    #[test]
    fn parses_openai_shape() {
        let raw = headers(&[
            ("x-ratelimit-limit-tokens", "400000"),
            ("x-ratelimit-remaining-tokens", "399000"),
            ("x-ratelimit-reset-tokens", "6ms"),
        ]);
        let buckets = parse_buckets(&raw);
        let tokens = buckets.iter().find(|b| b.bucket == "tokens").expect("认出 tokens 桶");
        assert_eq!(tokens.limit, Some(400_000));
        assert_eq!(tokens.remaining, Some(399_000));
        assert_eq!(tokens.reset.as_deref(), Some("6ms"));
    }

    /// 没见过的桶名照样归拢 —— 解析器认的是形状，不是一张写死的头名清单。
    #[test]
    fn groups_unknown_buckets() {
        let raw = headers(&[
            ("anthropic-ratelimit-opus-7d-remaining", "12"),
            ("anthropic-ratelimit-opus-7d-limit", "100"),
        ]);
        let buckets = parse_buckets(&raw);
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].bucket, "opus-7d");
        assert_eq!(buckets[0].window.as_deref(), Some("7d"));
        assert_eq!(buckets[0].used_percent, Some(88.0));
    }

    /// 解不出数字时留空，**不要落成 0** —— 0 会被读成「用完了」。
    #[test]
    fn keeps_unparsable_values_empty() {
        let raw = headers(&[("anthropic-ratelimit-unified-remaining", "unknown")]);
        let buckets = parse_buckets(&raw);
        assert_eq!(buckets[0].remaining, None);
        assert_eq!(buckets[0].used_percent, None);
    }

    /// 一份没有限流头的响应不能把上一次真实观测覆盖掉。
    #[test]
    fn empty_headers_do_not_clear_previous() {
        let usage = UpstreamUsage::new();
        usage.observe("claude_oauth", &headers(&[("anthropic-ratelimit-unified-remaining", "5")]));
        usage.observe("claude_oauth", &headers(&[("content-type", "application/json")]));
        let snapshot = usage.get("claude_oauth").expect("上一次的快照还在");
        assert_eq!(snapshot.buckets[0].remaining, Some(5));
    }

    /// 非限流头不进 raw：这份东西要随心跳上报，不该夹带别的响应头。
    #[test]
    fn raw_only_keeps_ratelimit_headers() {
        let usage = UpstreamUsage::new();
        usage.observe(
            "codex_chatgpt",
            &headers(&[
                ("x-ratelimit-remaining-requests", "3"),
                ("request-id", "req_abc"),
                ("content-type", "text/event-stream"),
            ]),
        );
        let snapshot = usage.get("codex_chatgpt").unwrap();
        assert_eq!(snapshot.raw.len(), 1);
        assert!(snapshot.raw.contains_key("x-ratelimit-remaining-requests"));
        assert_eq!(snapshot.source, "headers");
    }

    /// 两个上游各存各的，互不覆盖。
    #[test]
    fn keeps_upstreams_apart() {
        let usage = UpstreamUsage::new();
        usage.observe("claude_oauth", &headers(&[("anthropic-ratelimit-unified-remaining", "1")]));
        usage.observe("codex_chatgpt", &headers(&[("x-ratelimit-remaining-tokens", "2")]));
        assert_eq!(usage.get("claude_oauth").unwrap().buckets[0].remaining, Some(1));
        assert_eq!(usage.get("codex_chatgpt").unwrap().buckets[0].remaining, Some(2));
        assert_eq!(usage.all().len(), 2);
    }
}
