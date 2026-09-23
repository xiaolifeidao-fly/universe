//! 上游订阅余量的采集：问本机装着的 `claude` / `codex` 自己。
//!
//! 它们各自都知道「这个账号 5 小时窗口还剩多少、这一周还剩多少」—— 那正是
//! `claude /usage` 和 codex 的 `/status` 屏幕上的东西。与其去猜上游的 HTTP 端点
//! （猜错的表现是界面上静默的一片空白），不如直接问已经知道答案的那个程序。
//!
//! 两条都**不花 token**：claude 那条是客户端侧的斜杠命令（实测 0 input / 0 output），
//! codex 那条是 app-server 协议里的一次用量读取，都不触发模型推理。
//!
//! 也都**不需要我们碰凭据**：两个 CLI 读的是它们自己的登录态，令牌不经过这里。
//!
//! 前提是那台机器上真的装着对应的 CLI —— 对共享者来说这是成立的：
//! 没装 Claude Code 就没有 Claude 订阅可共享。装不着、超时、输出对不上，
//! 一律当成「这次没采到」，**保留上一次的观测**，不写一份空的进去。

use crate::pool::usage::{UsageBucket, UsageSnapshot};
use crate::{log_debug, log_warn};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// 单次探测的上限。
///
/// claude 那条要起一个完整的 Claude Code 进程，实测十几秒；codex 那条快得多。
/// 给足 60 秒是因为**超时的代价只是这一轮没采到**（下一轮 5 分钟后再来），
/// 而卡死的代价是一个永远不退出的子进程挂在共享者机器上。
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// 探针跑出来的快照都标这个来源，和别的采集方式区分开。
const PROBE_SOURCE: &str = "probe";

/// 问 Claude Code 自己：5 小时窗口和周额度各用掉多少。
///
/// `claude -p "/usage"` 是**客户端侧**的斜杠命令，不发模型请求。`--output-format json`
/// 只是把那段人类可读的文本塞进 result 字段 —— 数字仍然只在文本里，所以下面要解文本。
/// 解不动就返回 None：宁可这一轮没有，也不要把一段解错的数字当成余量。
pub async fn probe_claude(command: &str) -> Option<UsageSnapshot> {
    let output = run(command, &["-p", "/usage", "--output-format", "json"]).await?;
    let payload: Value = serde_json::from_slice(&output).ok()?;
    let text = payload.get("result")?.as_str()?;
    let buckets = parse_claude_usage(text);
    if buckets.is_empty() {
        // 命令跑通了但一行都没解出来 —— 多半是 Claude Code 换了输出格式。
        // 把原文记下来（它不含凭据，就是屏幕上那段字），下次照着改解析。
        log_warn!("usage_probe_claude_unparsed", "text": truncate(text, 400),
            "hint": "claude /usage 的输出格式变了，解析要跟着改");
        return None;
    }
    Some(UsageSnapshot {
        buckets,
        raw: [("claude.usage".to_string(), truncate(text, 1200))].into_iter().collect(),
        observed_at: now_rfc3339(),
        source: PROBE_SOURCE.into(),
    })
}

/// 把 `claude /usage` 的正文解成桶。
///
/// 认的是这种行：
///   Current session: 17% used · resets Sep 21 at 2:50pm (Asia/Shanghai)
///   Current week (all models): 58% used · resets Sep 23 at 8pm (Asia/Shanghai)
///
/// 按「冒号 + 百分比 + used」的形状认，不写死标题文字：Claude 会加新的窗口
/// （Current week (Fable) 就是后来多出来的），写死标题的话新窗口会被静默丢掉。
///
/// **Claude 报的是「已用」**，和 codex 的 `/status` 屏幕上显示「还剩」是反的。
/// 这里一律存成 used_percent，换算留给界面，免得两边各转一次、总有一处转反。
fn parse_claude_usage(text: &str) -> Vec<UsageBucket> {
    let mut buckets = vec![];
    for line in text.lines() {
        let line = line.trim();
        let Some((label, rest)) = line.split_once(':') else { continue };
        let Some((percent, tail)) = rest.trim().split_once("% used") else { continue };
        let Ok(used) = percent.trim().parse::<f64>() else { continue };
        let label = label.trim();
        if label.is_empty() {
            continue;
        }
        // 「resets …」后面那段原样留着：它可能是「Sep 23 at 8pm (Asia/Shanghai)」
        // 这种人话，硬解成时间戳解错了比不解更糟。
        let reset = tail
            .split_once("resets")
            .map(|(_, at)| at.trim().to_string())
            .filter(|value| !value.is_empty());
        buckets.push(UsageBucket {
            window: claude_window_of(label),
            bucket: label.to_string(),
            used_percent: Some(used),
            reset,
            ..Default::default()
        });
    }
    buckets
}

/// Claude 的窗口名是人话，翻成和 codex 那边一致的记法，界面才排得到一起。
/// 认不出来的不猜 —— 桶名照样原样显示。
fn claude_window_of(label: &str) -> Option<String> {
    let lower = label.to_ascii_lowercase();
    if lower.contains("session") {
        return Some("5h".into());
    }
    if lower.contains("week") {
        return Some("7d".into());
    }
    None
}

/// 问 Codex 自己。走它的 app-server 协议（stdio 上的 JSON-RPC），
/// 方法是 `account/rateLimits/read` —— 返回的是**结构化 JSON**，不用解文本。
///
/// 窗口是自描述的：`windowDurationMins` 300 就是 5 小时、10080 就是一周。
/// 所以这里不用猜 primary / secondary 分别代表什么，照它说的翻。
pub async fn probe_codex(command: &str) -> Option<UsageSnapshot> {
    let payload = codex_rate_limits(command).await?;
    let limits = payload.get("rateLimits")?;
    let mut buckets = vec![];
    for (key, name) in [("primary", "primary"), ("secondary", "secondary")] {
        let Some(window) = limits.get(key).filter(|value| !value.is_null()) else { continue };
        let Some(used) = window.get("usedPercent").and_then(Value::as_f64) else { continue };
        let minutes = window.get("windowDurationMins").and_then(Value::as_i64);
        buckets.push(UsageBucket {
            bucket: name.to_string(),
            window: minutes.map(window_label),
            used_percent: Some(used),
            reset: window.get("resetsAt").and_then(Value::as_i64).and_then(iso_from_unix),
            ..Default::default()
        });
    }
    if buckets.is_empty() {
        log_debug!("usage_probe_codex_empty", "hint": "app-server 回了，但没有任何窗口 —— 多半是这个账号没有订阅额度");
        return None;
    }
    let plan = limits.get("planType").and_then(Value::as_str).unwrap_or_default();
    Some(UsageSnapshot {
        buckets,
        raw: [("codex.planType".to_string(), plan.to_string())].into_iter().collect(),
        observed_at: now_rfc3339(),
        source: PROBE_SOURCE.into(),
    })
}

/// 把窗口长度翻成记法：300 → 5h、10080 → 7d。除不尽的按小时写。
fn window_label(minutes: i64) -> String {
    match minutes {
        m if m > 0 && m % 1440 == 0 => format!("{}d", m / 1440),
        m if m > 0 && m % 60 == 0 => format!("{}h", m / 60),
        m => format!("{m}m"),
    }
}

/// 和 codex app-server 握一次手，问一次用量，然后收工。
///
/// 每次探测起一个新进程再杀掉，不常驻：常驻要管重连、管它自己崩了之后的重启，
/// 而这件事五分钟才做一次 —— 省下的那点启动开销不值得多一条要维护的生命周期。
async fn codex_rate_limits(command: &str) -> Option<Value> {
    let mut child = Command::new(command)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            log_debug!("usage_probe_codex_spawn_failed", "command": command, "error": error.to_string());
        })
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let mut lines = BufReader::new(stdout).lines();

    let handshake = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "clientInfo": { "name": "ai-bridge", "version": env!("CARGO_PKG_VERSION"), "title": "ai-bridge" } }
    });
    stdin.write_all(format!("{handshake}\n").as_bytes()).await.ok()?;

    let read = async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            match message.get("id").and_then(Value::as_i64) {
                Some(1) => {
                    // 握手回来了才发第二条：app-server 在 initialize 之前不接别的请求。
                    let ready = json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} });
                    let ask = json!({ "jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {} });
                    stdin.write_all(format!("{ready}\n{ask}\n").as_bytes()).await.ok()?;
                }
                Some(2) => return message.get("result").cloned(),
                _ => {}
            }
        }
        None
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, read).await.ok().flatten();
    let _ = child.kill().await;
    result
}

/// 跑一个命令，把 stdout 收回来。非零退出、起不来、超时都返回 None。
async fn run(command: &str, args: &[&str]) -> Option<Vec<u8>> {
    let child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(error) => {
            // 没装就是没装，不是故障：这台机器可能只共享另一个上游。
            log_debug!("usage_probe_spawn_failed", "command": command, "error": error.to_string());
            return None;
        }
    };
    let output = tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await;
    match output {
        Ok(Ok(output)) if output.status.success() => Some(output.stdout),
        Ok(Ok(output)) => {
            log_debug!("usage_probe_failed", "command": command, "code": output.status.code().unwrap_or(-1));
            None
        }
        Ok(Err(error)) => {
            log_debug!("usage_probe_failed", "command": command, "error": error.to_string());
            None
        }
        Err(_) => {
            log_warn!("usage_probe_timeout", "command": command, "seconds": PROBE_TIMEOUT.as_secs());
            None
        }
    }
}

fn iso_from_unix(seconds: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 解的是真实输出 —— 这段是 `claude -p "/usage"` 实际吐出来的。
    #[test]
    fn parses_real_claude_usage_output() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\n\
            Current session: 17% used · resets Sep 21 at 2:50pm (Asia/Shanghai)\n\
            Current week (all models): 58% used · resets Sep 23 at 8pm (Asia/Shanghai)\n\
            Current week (Fable): 0% used · resets Sep 23 at 7:59pm (Asia/Shanghai)\n\n\
            What's contributing to your limits usage?\n\
            Last 24h · 2948 requests · 25 sessions\n";
        let buckets = parse_claude_usage(text);
        assert_eq!(buckets.len(), 3, "三个窗口都要认出来: {buckets:?}");

        assert_eq!(buckets[0].bucket, "Current session");
        assert_eq!(buckets[0].window.as_deref(), Some("5h"));
        assert_eq!(buckets[0].used_percent, Some(17.0));
        assert_eq!(buckets[0].reset.as_deref(), Some("Sep 21 at 2:50pm (Asia/Shanghai)"));

        assert_eq!(buckets[1].window.as_deref(), Some("7d"));
        assert_eq!(buckets[1].used_percent, Some(58.0));
        // 后来新增的窗口也要被认出来，不能因为标题没见过就丢掉。
        assert_eq!(buckets[2].bucket, "Current week (Fable)");
        assert_eq!(buckets[2].used_percent, Some(0.0));
    }

    /// 正文里那些带冒号的散文不能被当成窗口。
    #[test]
    fn ignores_prose_lines() {
        let text = "What's contributing to your limits usage?\n\
            Top skills: /loop 8%, /add-permission-resources 3%\n\
            Last 7d · 7768 requests · 71 sessions\n";
        assert!(parse_claude_usage(text).is_empty(), "只有 `…: N% used` 那种行才算");
    }

    /// 窗口长度按它自己说的翻，不猜。
    #[test]
    fn labels_windows_by_duration() {
        assert_eq!(window_label(300), "5h");
        assert_eq!(window_label(10080), "7d");
        assert_eq!(window_label(43200), "30d");
        assert_eq!(window_label(90), "90m");
    }

    /// codex 的结构化回包：primary 是 5 小时、secondary 是一周，都存成「已用」。
    #[test]
    fn maps_codex_rate_limits() {
        let payload: Value = serde_json::from_str(
            r#"{"rateLimits":{"planType":"plus",
                "primary":{"usedPercent":37,"windowDurationMins":300,"resetsAt":1758424000},
                "secondary":{"usedPercent":10,"windowDurationMins":10080,"resetsAt":1758770000}}}"#,
        )
        .unwrap();
        let limits = payload.get("rateLimits").unwrap();
        let mut buckets = vec![];
        for (key, name) in [("primary", "primary"), ("secondary", "secondary")] {
            let window = limits.get(key).unwrap();
            buckets.push(UsageBucket {
                bucket: name.to_string(),
                window: window.get("windowDurationMins").and_then(Value::as_i64).map(window_label),
                used_percent: window.get("usedPercent").and_then(Value::as_f64),
                reset: window.get("resetsAt").and_then(Value::as_i64).and_then(iso_from_unix),
                ..Default::default()
            });
        }
        assert_eq!(buckets[0].window.as_deref(), Some("5h"));
        assert_eq!(buckets[0].used_percent, Some(37.0));
        assert!(buckets[0].reset.as_deref().unwrap().starts_with("2025-"));
        assert_eq!(buckets[1].window.as_deref(), Some("7d"));
    }

    /// 一个不存在的命令不该 panic，也不该等满超时。
    #[tokio::test]
    async fn missing_cli_is_not_an_error() {
        assert!(probe_claude("definitely-not-a-real-binary-xyz").await.is_none());
        assert!(probe_codex("definitely-not-a-real-binary-xyz").await.is_none());
    }
}

/// 拿**本机真的 CLI** 跑一遍探针，把采到的东西打出来。
///
/// 默认不跑（`#[ignore]`）：它依赖这台机器上装着并登录着 claude / codex，
/// 在别人的机器和 CI 上都不成立，挂在常规用例里只会变成一条随机失败。
///
/// 排查「界面上为什么没有数」时手动跑它：
///     cargo test --lib probe_the_real_local_clis -- --ignored --nocapture
#[cfg(test)]
#[tokio::test]
#[ignore]
async fn probe_the_real_local_clis() {
    for (name, snapshot) in [
        ("claude", probe_claude("claude").await),
        ("codex", probe_codex("codex").await),
    ] {
        match snapshot {
            Some(snapshot) => {
                println!("\n=== {name}（来源 {}，观测于 {}）===", snapshot.source, snapshot.observed_at);
                for bucket in &snapshot.buckets {
                    let window = bucket.window.clone().unwrap_or_else(|| "?".into());
                    let used = bucket.used_percent.map(|v| format!("已用 {v:.0}%")).unwrap_or_else(|| "未报".into());
                    let left = bucket.used_percent.map(|v| format!("剩 {:.0}%", 100.0 - v)).unwrap_or_default();
                    let reset = bucket.reset.clone().unwrap_or_else(|| "-".into());
                    println!("  [{window:>4}] {:<28} {used:<10} {left:<8} 归零 {reset}", bucket.bucket);
                }
            }
            None => println!("\n=== {name}：没采到（没装、没登录、超时，或者输出格式变了）==="),
        }
    }
}
