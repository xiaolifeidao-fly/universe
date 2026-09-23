//! 上游订阅余量的存放处：各上游此刻还剩多少，按路由键（claude_oauth / codex_chatgpt）。
//!
//! 回答的是「这台机器上的 Claude / Codex **账号自己**还剩多少」，和主人在控制台
//! 设的那份额度是两回事：那份是「打算放多少出去」，这份是「上游实际还让跑多少」。
//! 前者填得比后者宽的话，机器会在上游那儿撞限流，而平台这边看到的是「还剩大半」。
//!
//! 数从哪来见 usage_probe.rs：**问本机装着的 claude / codex 自己**，
//! 也就是 `claude /usage` 和 codex `/status` 屏幕上那两个数。
//!
//! 曾经试过另一条路：从中转响应的限流头里捎。那条路有三个躲不开的限制 ——
//! 机器闲着时不更新（而「此刻还剩多少」恰恰是闲着时最想知道的）、只在别人派活
//! 进来时才触发（主人自己用不经过这里）、而且只能拿到上游恰好放在响应头里的东西。
//! 它给不出「5 小时窗口还剩多少、这一周还剩多少」这两个数，所以整条撤掉了，
//! 没留成第二个数据来源 —— 两个来源喂同一个字段，界面会在两种形状之间跳。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::RwLock;

/// 一个限流窗口此刻的状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UsageBucket {
    /// 窗口在上游那边叫什么，原样保留：Claude 是「Current session」这种人话，
    /// Codex 是 primary / secondary。不翻译 —— 上游加一种没见过的窗口时，
    /// 显示它的真名比归进一个「其它」有用。
    pub bucket: String,
    /// 归一化之后的窗口记法：`5h` / `7d`。认不出来就没有这个字段。
    /// 两家靠它对齐，界面才排得到一起。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<i64>,
    /// **已用**占比（0–100）。
    ///
    /// 统一存已用，不存剩余：Claude 报的是已用（`17% used`），Codex 的屏幕上
    /// 显示的是剩余（`63% left`）。两边各存各的说法，就一定有某一处会转反 ——
    /// 而转反之后数字看着仍然合理，没人会发现。换算留给界面，只算一次。
    #[serde(rename = "usedPercent", skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// 归零时刻。Codex 给的是 unix 秒（采集时已转成 RFC3339），Claude 给的是
    /// 「Sep 23 at 8pm (Asia/Shanghai)」这种人话 —— **原样保留**，
    /// 硬解成时间戳解错了比不解更糟。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// 一个上游此刻的余量快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UsageSnapshot {
    /// 各个窗口。空快照不会被写进来（见 UpstreamUsage::put）。
    pub buckets: Vec<UsageBucket>,
    /// 采集时顺手留下的原始材料：Claude 是 /usage 的正文，Codex 是套餐名。
    /// 归一化认不出来的东西靠它，也是事后改解析时唯一能对照的真东西。
    pub raw: BTreeMap<String, String>,
    /// 观测时刻，RFC3339。**必须一路带到界面上** —— 探针五分钟才跑一次，
    /// 而且可能连着几轮都没采到（CLI 没装、超时），那时界面上的数就是旧的。
    #[serde(rename = "observedAt")]
    pub observed_at: String,
    /// 这份数怎么来的。目前只有 probe：问本机的 claude / codex 自己。
    pub source: String,
}

/// 各上游的余量快照。探针写，心跳与 status 读。
#[derive(Debug, Default)]
pub struct UpstreamUsage {
    inner: RwLock<HashMap<String, UsageSnapshot>>,
}

impl UpstreamUsage {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记一份新的快照。
    ///
    /// **空的不写**：探针这一轮没采到（CLI 没装、超时、输出格式变了）时，
    /// 上一次的观测要留着。用一份空快照盖掉，界面会从「剩 63%」跳成「未报」——
    /// 而这两件事在运营眼里的处置完全不同。
    pub fn put(&self, provider: &str, snapshot: UsageSnapshot) {
        if snapshot.buckets.is_empty() {
            return;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(used: f64) -> UsageSnapshot {
        UsageSnapshot {
            buckets: vec![UsageBucket {
                bucket: "Current session".into(),
                window: Some("5h".into()),
                used_percent: Some(used),
                ..Default::default()
            }],
            raw: BTreeMap::new(),
            observed_at: "2026-09-21T02:00:00Z".into(),
            source: "probe".into(),
        }
    }

    /// 探针这一轮没采到时，上一次的观测要留着。
    /// 盖成空的话，界面会从「剩 63%」跳成「未报」—— 两件事的处置完全不同。
    #[test]
    fn empty_snapshot_does_not_clear_previous() {
        let usage = UpstreamUsage::new();
        usage.put("claude_oauth", snapshot(17.0));
        usage.put("claude_oauth", UsageSnapshot::default());
        assert_eq!(usage.get("claude_oauth").unwrap().buckets[0].used_percent, Some(17.0));
    }

    /// 新的一轮覆盖旧的。
    #[test]
    fn newer_snapshot_replaces_older() {
        let usage = UpstreamUsage::new();
        usage.put("claude_oauth", snapshot(17.0));
        usage.put("claude_oauth", snapshot(42.0));
        assert_eq!(usage.get("claude_oauth").unwrap().buckets[0].used_percent, Some(42.0));
    }

    /// 两个上游各存各的，互不覆盖。
    #[test]
    fn keeps_upstreams_apart() {
        let usage = UpstreamUsage::new();
        usage.put("claude_oauth", snapshot(17.0));
        usage.put("codex_chatgpt", snapshot(37.0));
        assert_eq!(usage.get("claude_oauth").unwrap().buckets[0].used_percent, Some(17.0));
        assert_eq!(usage.get("codex_chatgpt").unwrap().buckets[0].used_percent, Some(37.0));
        assert_eq!(usage.all().len(), 2);
    }

    /// 没采到过的上游是 None，不是一份全零的快照。
    #[test]
    fn unknown_upstream_is_none() {
        assert!(UpstreamUsage::new().get("claude_oauth").is_none());
    }
}
