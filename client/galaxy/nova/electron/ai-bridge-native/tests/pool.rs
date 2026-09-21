use ai_bridge_native::business::{inline_json, inline_text, model_match, Primitive, WorkUnit};
use ai_bridge_native::pool::client::{BridgeReleaseManifest, CapabilityReport, HeartbeatResult, HelloResult};
use ai_bridge_native::pool::hub_address::{HubAddressCheck, HubAddressEvent};
use ai_bridge_native::pool::lane::{Lane, LaneConfig};
use ai_bridge_native::pool::models::{parse_codex_cache, parse_models};
use ai_bridge_native::pool::runner::health_signature;
use ai_bridge_native::pool::setup::{hub_needs_rebind, shell_quote};
use ai_bridge_native::pool::tools::{parse_version, resolve_in};
use base64::Engine;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod common;
use common::fake_provider;

fn lane(seats: u32, seat_concurrency: u32) -> Lane {
    Lane::new(
        LaneConfig {
            id: "claude-main".into(), kind: "llm.chat".into(), kind_version: 1,
            provider: "claude_oauth".into(), seats, seat_concurrency,
            models_allow: vec![], models_deny: vec![],
        },
        fake_provider(),
    )
}

const NOW: i64 = 1_700_000_000_000;

// ---------- 通道闸门 ----------

#[test]
fn one_consumer_cannot_fill_the_whole_lane() {
    let target = lane(2, 2);
    assert_eq!(target.capacity(), 4);
    assert!(target.acquire("ck_a"));
    assert!(target.acquire("ck_a"));
    // 第三条属于同一个消费者，超过 seatConcurrency=2
    assert!(!target.acquire("ck_a"));
    // 换个消费者还有位置
    assert!(target.acquire("ck_b"));
    assert_eq!(target.inflight(), 3);

    target.release("ck_a");
    assert!(target.acquire("ck_a"));
}

#[test]
fn a_full_lane_turns_everyone_away() {
    let target = lane(1, 2);
    assert_eq!(target.capacity(), 2);
    assert!(target.acquire("ck_a"));
    assert!(target.acquire("ck_a"));
    assert!(!target.acquire("ck_b"));
}

#[test]
fn draining_paused_broken_or_throttled_lanes_report_no_free_seats() {
    use std::sync::atomic::Ordering;
    let target = lane(3, 2);
    assert_eq!(target.free(NOW), 6);

    target.draining.store(true, Ordering::Relaxed);
    assert_eq!(target.free(NOW), 0, "排空中不该再接新单");
    target.draining.store(false, Ordering::Relaxed);

    target.paused.store(true, Ordering::Relaxed);
    assert_eq!(target.free(NOW), 0, "主人按了紧急闸");
    target.paused.store(false, Ordering::Relaxed);

    target.upstream_ok.store(false, Ordering::Relaxed);
    assert_eq!(target.free(NOW), 0, "凭据失效的通道不该被派单");
    target.upstream_ok.store(true, Ordering::Relaxed);

    target.set_throttled_until_ms(Some(NOW + 60_000));
    assert_eq!(target.free(NOW), 0, "被上游限流时临时退出候选");
    target.set_throttled_until_ms(Some(NOW - 1));
    assert_eq!(target.free(NOW), 6, "限流窗口过了要自动恢复");
}

#[test]
fn lane_honors_retry_after_and_cannot_shorten_an_active_cooldown() {
    let target = lane(1, 1);
    target.throttle(Some("300"), NOW);
    assert_eq!(target.throttled_until_ms(), Some(NOW + 300_000));
    assert_eq!(target.free(NOW), 0);

    // 并发中的旧响应不能把已有冷却缩短。
    target.throttle(None, NOW);
    assert_eq!(target.throttled_until_ms(), Some(NOW + 300_000));

    // HTTP 日期形态也认。
    let later = NOW + 600_000;
    let later_secs = later / 1000 * 1000;
    let http_date = time::OffsetDateTime::from_unix_timestamp(later_secs / 1000)
        .unwrap()
        .format(&time::format_description::parse(
            "[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT",
        ).unwrap())
        .unwrap();
    target.throttle(Some(&http_date), NOW);
    assert_eq!(target.throttled_until_ms(), Some(later_secs));

    // 认不出来的值退回固定的两分钟。
    target.set_throttled_until_ms(None);
    target.throttle(Some("invalid"), NOW);
    assert_eq!(target.throttled_until_ms(), Some(NOW + 120_000));
}

// ---------- 白名单自校验 ----------

#[test]
fn model_allowlist_matches_the_server_semantics() {
    let allow = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(model_match("claude-sonnet-4-5", &allow(&["claude-sonnet-*"]), &[]));
    assert!(!model_match("claude-opus-4-1", &allow(&["claude-*"]), &allow(&["claude-opus-*"])));
    assert!(model_match("anything", &[], &[]));
    assert!(!model_match("gpt-4o", &allow(&["claude-*"]), &[]));
}

// ---------- 工作单元解码 ----------

#[test]
fn inline_payloads_are_decoded_from_base64() {
    let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);
    let unit: WorkUnit = serde_json::from_value(json!({
        "id": "u_1", "kind": "llm.chat", "kindVersion": 1, "primitive": "relay",
        "provider": "claude_oauth", "consumerKey": "ck_1", "state": "running",
        "inputs": [
            { "name": "path", "inline": encode("/v1/messages") },
            { "name": "headers", "inline": encode("{\"anthropic-version\":\"2023-06-01\"}") },
        ],
    })).unwrap();
    assert_eq!(unit.primitive, Primitive::Relay);
    assert_eq!(inline_text(&unit, "path").as_deref(), Some("/v1/messages"));
    assert_eq!(inline_json(&unit, "headers", json!({})), json!({ "anthropic-version": "2023-06-01" }));
    // 缺失的载荷返回兜底值，不抛
    assert_eq!(inline_json(&unit, "missing", json!({ "ok": true })), json!({ "ok": true }));
}

// ---------- 能力健康指纹 ----------

fn report(cid: &str, available: bool, reason: Option<&str>) -> CapabilityReport {
    CapabilityReport {
        cid: cid.into(), kind: "llm.chat".into(), kind_version: 1, provider: "p".into(),
        available, unavailable_reason: reason.map(str::to_string), available_models: None,
    }
}

#[test]
fn availability_flips_must_change_the_signature() {
    let before = health_signature(&[report("relay_claude", false, Some("登录态缺失")), report("relay_codex", true, None)]);
    let after = health_signature(&[report("relay_claude", true, None), report("relay_codex", true, None)]);
    assert_ne!(before, after, "登录回来了却判成没变，主人得重启节点才恢复");
}

#[test]
fn a_changed_reason_counts_as_a_change() {
    let a = health_signature(&[report("relay_claude", false, Some("登录态缺失"))]);
    let b = health_signature(&[report("relay_claude", false, Some("登录态已过期"))]);
    assert_ne!(a, b);
}

#[test]
fn probe_order_does_not_affect_the_signature() {
    let a = health_signature(&[report("x", true, None), report("y", false, Some("r"))]);
    let b = health_signature(&[report("y", false, Some("r")), report("x", true, None)]);
    assert_eq!(a, b);
}

// ---------- 上游模型清单解析 ----------

#[test]
fn model_lists_are_parsed_from_every_known_shape() {
    assert_eq!(parse_models(&json!({ "data": [{ "id": "claude-opus-4" }, { "id": "claude-sonnet-4" }] })),
        vec!["claude-opus-4", "claude-sonnet-4"]);
    assert_eq!(parse_models(&json!({ "models": ["gpt-a", "gpt-b"] })), vec!["gpt-a", "gpt-b"]);
    // 去重并排序：同一个模型在分页结果里出现两次不该变成两个候选。
    assert_eq!(parse_models(&json!({ "data": [{ "id": "b" }, { "id": "a" }, { "id": "b" }] })), vec!["a", "b"]);
    // Codex 返回的条目用 slug 不用 id。只认 id 的话请求明明成功了、解析出来还是空。
    assert_eq!(parse_models(&json!({ "models": [{ "slug": "gpt-5.5" }, { "slug": "gpt-5.4-mini" }] })),
        vec!["gpt-5.4-mini", "gpt-5.5"]);
    assert_eq!(parse_models(&json!({ "data": [{ "id": "a" }, { "slug": "b" }] })), vec!["a", "b"]);
    assert_eq!(parse_models(&json!({ "data": [{ "id": "" }, { "id": "  " }, { "id": 5 }, { "id": "ok" }] })), vec!["ok"]);
}

#[test]
fn unrecognized_model_payloads_yield_nothing_rather_than_a_guess() {
    // 猜错的模型名比没有更糟：主人会照着它配出一条永远匹配不上的规则。
    for junk in [json!(null), json!({}), json!({ "data": "nope" }), json!({ "data": [1, 2] }), json!("text"), json!([])] {
        assert!(parse_models(&junk).is_empty(), "不该从 {junk} 解析出模型");
    }
}

#[test]
fn codex_cache_keeps_only_selectable_models_in_selector_order() {
    // gpt-reserve / codex-auto-review 在真实缓存里就是 hide —— 放进去主人会照着
    // 配出一条指向内部模型的规则，而那本不该被共享出去。
    let raw = json!({ "models": [
        { "slug": "gpt-6-astra", "visibility": "list", "priority": 1 },
        { "slug": "gpt-reserve", "visibility": "hide", "priority": 3 },
        { "slug": "codex-auto-review", "visibility": "hide", "priority": 43 },
    ] }).to_string();
    assert_eq!(parse_codex_cache(&raw), vec!["gpt-6-astra"]);

    let ordered = json!({ "models": [
        { "slug": "gpt-5.4-mini", "visibility": "list", "priority": 23 },
        { "slug": "gpt-6-astra", "visibility": "list", "priority": 1 },
        { "slug": "gpt-5.6-terra", "visibility": "list", "priority": 7 },
    ] }).to_string();
    assert_eq!(parse_codex_cache(&ordered), vec!["gpt-6-astra", "gpt-5.6-terra", "gpt-5.4-mini"]);

    for junk in ["", "not json", "{}", r#"{"models":"nope"}"#, r#"{"models":[{"slug":123}]}"#,
                 r#"{"models":[{"slug":"x"}]}"#] {
        assert!(parse_codex_cache(junk).is_empty(), "不该从 {junk} 解析出模型");
    }
}

// ---------- 工具版本解析 ----------

#[test]
fn cli_version_output_is_parsed_for_every_tool() {
    assert_eq!(parse_version("codex-cli 0.153.4"), "0.153.4");
    assert_eq!(parse_version("2.1.263 (Claude Code)"), "2.1.263");
    assert_eq!(parse_version("1.2.3"), "1.2.3");
    assert_eq!(parse_version("v0.9.1\n"), "0.9.1");
    assert_eq!(parse_version("codex-cli 1.0.0-beta.2"), "1.0.0-beta.2");
    // 空串会让 upgradable 判成 false —— 拿不到版本时**不催人升级**。
    for junk in ["", "unknown", "命令未找到", "codex-cli"] {
        assert_eq!(parse_version(junk), "", "不该从 {junk:?} 解析出版本");
    }
}

// ---------- Hub 地址校验 ----------

#[test]
fn hub_address_is_normalized_deduplicated_and_recovers() {
    let mut check = HubAddressCheck::new("http://example.com/hub");
    let names: Vec<&'static str> = [
        Some(" HTTP://EXAMPLE.COM:80/hub/ "),
        Some("http://example.com/other"),
        Some("http://example.com/other/"),
        Some("https://example.com/hub"),
        Some("http://example.com:81/hub"),
        Some("http://example.com/hub"),
    ]
    .into_iter()
    .filter_map(|value| check.check(value))
    .map(|event| event.name())
    .collect();
    assert_eq!(names, vec![
        "pool_hub_address_matched", "pool_hub_address_mismatch",
        "pool_hub_address_mismatch", "pool_hub_address_mismatch", "pool_hub_address_matched",
    ]);
}

#[test]
fn hub_address_tolerates_a_missing_field_and_never_echoes_a_bad_one() {
    let mut check = HubAddressCheck::new("http://example.com");
    assert_eq!(check.check(None), None);
    assert_eq!(check.check(Some("")), None);

    let mut events = vec![];
    for value in ["bad", "ftp://example.com", "http://user:secret@example.com", "http://example.com?token=secret"] {
        if let Some(event) = check.check(Some(value)) {
            events.push(event);
        }
    }
    // 只说一次「地址无效」，而且不把输入原样带出去。
    assert_eq!(events, vec![HubAddressEvent::Invalid]);
    assert!(!format!("{events:?}").contains("secret"));

    assert_eq!(check.check(None), None);
    assert!(matches!(check.check(Some("http://example.com")), Some(HubAddressEvent::Matched { .. })));
}

#[test]
fn lane_config_can_be_swapped_without_losing_the_inflight_count() {
    // 重建通道会把 inflight 清零，正在跑的请求就成了没人认领的并发。
    let target = Arc::new(lane(1, 1));
    assert!(target.acquire("ck_a"));
    let mut config = target.config();
    config.seats = 4;
    target.set_config(config);
    assert_eq!(target.capacity(), 4);
    assert_eq!(target.inflight(), 1, "换配置不该丢掉在跑的计数");
}

/// Hub 的 hello 响应里 `rejected` 为 null 时，enabled 必须照常解出来。
///
/// Go 那边 `[]struct` 是 nil 切片，序列化出去就是 `"rejected": null`，
/// 而 `#[serde(default)]` 只在**字段缺失**时兜底、遇上显式 null 会直接报错 ——
/// 于是整个 HelloResult 解析失败，`unwrap_or_default()` 把它悄悄换成
/// enabled: None，节点当成「老版本 Hub，维持现状」，一条通道都不建，
/// 而且日志里一个字都没有。查了很久才找到的就是这一条。
#[test]
fn hello_result_tolerates_null_collections() {
    let payload = json!({
        "accepted": ["relay_codex"],
        "rejected": null,
        "quotaEffective": {},
        "enabled": [{
            "cid": "relay_codex",
            "kind": "llm.chat",
            "kindVersion": 1,
            "provider": "codex_chatgpt",
            "modelsAllow": null,
            "modelsDeny": null,
            "seats": 3,
            "seatConcurrency": 2,
            "quota": null,
            "schedule": null
        }]
    });
    let result: HelloResult = serde_json::from_value(payload).expect("hello 响应应当解得动");
    let enabled = result.enabled.expect("enabled 不该丢");
    assert_eq!(enabled.len(), 1);
    assert_eq!(enabled[0].cid, "relay_codex");
    assert!(enabled[0].models_allow.is_empty());
}

/// 心跳同理：cancel / drain 是 nil 切片时也不能把 enabled 一起带走。
/// 主人在控制台开关一条贡献，靠的就是心跳把新的 enabled 下发下来。
#[test]
fn heartbeat_result_tolerates_null_collections() {
    let payload = json!({
        "hubUrl": "http://127.0.0.1:10004",
        "cancel": null,
        "drain": null,
        "quotaUpdate": {},
        "enabled": [{
            "cid": "relay_codex", "kind": "llm.chat", "kindVersion": 1,
            "provider": "codex_chatgpt", "seats": 3, "seatConcurrency": 2
        }]
    });
    let result: HeartbeatResult = serde_json::from_value(payload).expect("心跳响应应当解得动");
    assert!(result.cancel.is_empty());
    assert_eq!(result.enabled.expect("enabled 不该丢").len(), 1);
}

/// 升级指令（契约 3.2）：形状对就解出来；形状不对只丢掉它自己，取消清单和生效配置照常 ——
/// 一条坏掉的升级指令不能让「消费者走了立刻停手」跟着失效。
#[test]
fn heartbeat_upgrade_commands_parse_and_a_malformed_one_does_not_take_the_rest_down() {
    let command = json!({
        "id": "ug_01J8", "version": "0.2.0", "platform": "linux-x64",
        "url": "https://bucket.oss-cn-hangzhou.aliyuncs.com/galaxy/ai-bridge/0.2.0/ai-bridge-0.2.0-linux-x64.tar.gz?Signature=x",
        "sha256": "29497afb2668d3c372667f69ff807863db4201b937de100d7cb4826c05ee527e",
        "size": 3072128, "signature": "c2ln",
    });
    let parsed: HeartbeatResult = serde_json::from_value(json!({ "cancel": ["u_1"], "upgrade": command })).unwrap();
    let upgrade = parsed.upgrade.expect("升级指令要解出来");
    assert_eq!((upgrade.id.as_str(), upgrade.version.as_str(), upgrade.size), ("ug_01J8", "0.2.0", 3072128));

    for absent in [json!({ "cancel": ["u_1"] }), json!({ "cancel": ["u_1"], "upgrade": null })] {
        let parsed: HeartbeatResult = serde_json::from_value(absent).unwrap();
        assert!(parsed.upgrade.is_none());
    }

    let malformed = json!({
        "cancel": ["u_1"],
        "enabled": [{ "cid": "c", "kind": "llm.chat", "kindVersion": 1, "provider": "p", "seats": 1, "seatConcurrency": 1 }],
        "upgrade": { "id": "ug_x", "size": "很大" },
    });
    let parsed: HeartbeatResult = serde_json::from_value(malformed).expect("坏掉的升级指令不能让整份心跳解析失败");
    assert!(parsed.upgrade.is_none());
    assert_eq!(parsed.cancel, vec!["u_1".to_string()]);
    assert_eq!(parsed.enabled.expect("enabled 不该丢").len(), 1);
}

/// 发布清单按契约第 4 节的样例解析；一个包都没发布时是空版本、空列表，而不是解析失败。
#[test]
fn release_manifests_parse_the_contract_example_and_the_empty_case() {
    let manifest: BridgeReleaseManifest = serde_json::from_value(json!({
        "version": "0.2.0", "notes": "……", "publishedAt": "2026-09-12T08:00:00Z",
        "hubUrl": "https://hub.example.com",
        "installScript": "https://hub.example.com/agent/v1/bridge/install.sh",
        "installPowerShell": "https://hub.example.com/agent/v1/bridge/install.ps1",
        "platforms": [{
            "platform": "linux-x64", "version": "0.2.0", "fileName": "ai-bridge-0.2.0-linux-x64.tar.gz",
            "size": 3072128, "sha256": "29497afb", "signature": "base64...",
            "downloadUrl": "https://hub.example.com/agent/v1/bridge/download/linux-x64",
            "notes": "……", "publishedAt": "2026-09-12T08:00:00Z",
        }],
    }))
    .unwrap();
    assert_eq!(manifest.version, "0.2.0");
    assert_eq!(manifest.install_power_shell, "https://hub.example.com/agent/v1/bridge/install.ps1");
    let package = &manifest.platforms[0];
    assert_eq!(package.file_name, "ai-bridge-0.2.0-linux-x64.tar.gz");
    assert_eq!(package.download_url, "https://hub.example.com/agent/v1/bridge/download/linux-x64");
    assert_eq!(package.size, 3072128);

    let empty: BridgeReleaseManifest = serde_json::from_value(json!({ "version": "", "platforms": null })).unwrap();
    assert!(empty.version.is_empty() && empty.platforms.is_empty());
}

/// 账户页每次打开都会拿平台地址来校准本机绑定，所以这条判定必须极其保守。
///
/// 两个方向都会出事：
///   · 该改的不改 —— 平台换了域名，本机还连着旧地址，界面显示得也是旧的；
///   · 不该改的改了 —— 一个末尾斜杠就重写配置，而 node-token 里的 hubURL
///     是逐字符比对的，一台正连着的机器会当场变成「未配对」。
#[test]
fn hub_rebind_compares_origin_not_string() {
    // 同一个 Hub 的各种写法：一个字都不该动
    for (current, target) in [
        ("http://127.0.0.1:10004", "http://127.0.0.1:10004"),
        ("http://127.0.0.1:10004", "http://127.0.0.1:10004/"),
        ("https://hub.example.com", "https://hub.example.com/galaxy"),
        ("https://HUB.example.com", "https://hub.example.com"),
    ] {
        assert!(!hub_needs_rebind(current, target), "{current} → {target} 不该改写");
    }

    // 真的换了平台：域名、端口、协议，任一不同都要改
    for (current, target) in [
        ("http://127.0.0.1:10004", "https://hub.example.com:10005"),
        ("http://127.0.0.1:10004", "http://127.0.0.1:10005"),
        ("http://hub.example.com", "https://hub.example.com"),
    ] {
        assert!(hub_needs_rebind(current, target), "{current} → {target} 该改写");
    }

    // 还没绑过平台的机器不碰：写配置会顺手把 mode 切成 pool，
    // 而没配对过的机器切进 pool 只会起不来。地址由配对流程写。
    assert!(!hub_needs_rebind("", "https://hub.example.com"));
    assert!(!hub_needs_rebind("   ", "https://hub.example.com"));
}

// ---------- 在 PATH 上找工具 ----------

const WINDOWS_SUFFIXES: &[&str] = &["", ".exe", ".cmd", ".bat"];
const UNIX_SUFFIXES: &[&str] = &[""];

#[test]
fn finds_the_first_match_along_path() {
    // 目录和名字用 Path::join 拼起来比，**不要写死带 "/" 的字面量**：resolve_in 里
    // 拼的也是 Path::join，分隔符跟着宿主平台走，Windows 上出来的是
    // `/opt/homebrew/bin\npm`。写死字面量的话这条在 Windows runner 上必挂，而它挂了
    // 之后 `build .node` 那一步就不会跑 —— win32-x64 那片原生模块因此一直出不来，
    // 表现是「CI 明明跑了，工件里就是没有 Windows 那片」。
    let present: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin"].iter().map(|dir| Path::new(dir).join("npm")).collect();
    let found = resolve_in("/usr/bin:/opt/homebrew/bin:/usr/local/bin", "npm", ':', UNIX_SUFFIXES, |candidate| {
        present.iter().any(|known| known == candidate)
    });
    assert_eq!(found.unwrap(), Path::new("/opt/homebrew/bin").join("npm"));
}

#[test]
fn windows_must_try_cmd_because_npm_is_not_an_exe() {
    // Command::new 只会补 .exe。不认 .cmd 的话，Windows 上连本机装的 npm 都调不起来。
    // 拼路径用的是 std::path，分隔符跟着宿主平台走 —— 所以这里只验这两件事：
    // 分号切分，以及后缀真的挨个试过。
    let found = resolve_in("C:/Windows;C:/nodejs", "npm", ';', WINDOWS_SUFFIXES, |candidate| {
        candidate.file_name().is_some_and(|name| name == "npm.cmd")
            && candidate.to_string_lossy().contains("nodejs")
    });
    assert_eq!(found.unwrap().file_name().unwrap(), "npm.cmd");
    // 顺序按 PATHEXT 的习惯来：两个都在时先用 .exe。claude 装出来的就是 .exe。
    let both = resolve_in("C:/nodejs", "claude", ';', WINDOWS_SUFFIXES, |candidate| {
        matches!(candidate.file_name().and_then(|name| name.to_str()), Some("claude.exe") | Some("claude.cmd"))
    });
    assert_eq!(both.unwrap().file_name().unwrap(), "claude.exe");
}

#[test]
fn an_absolute_name_is_used_as_is() {
    // setup.rs 拿 /usr/bin/osascript 调这里，不该再去 PATH 上找一遍。
    let found = resolve_in("", "/usr/bin/osascript", ':', UNIX_SUFFIXES, |candidate| {
        candidate.to_string_lossy() == "/usr/bin/osascript"
    });
    assert_eq!(found.unwrap().to_string_lossy(), "/usr/bin/osascript");
    assert!(resolve_in("", "/nope/osascript", ':', UNIX_SUFFIXES, |_| false).is_none());
}

#[test]
fn missing_tool_is_none_not_a_guess() {
    assert!(resolve_in("/usr/bin:/bin", "npm", ':', UNIX_SUFFIXES, |_| false).is_none());
}

// ---------- 登录命令的引号 ----------

#[test]
fn a_path_with_spaces_must_survive_the_terminal() {
    // 自带 npm 的 prefix 在 ~/Library/Application Support/Nova 下，名字里有空格。
    assert_eq!(
        shell_quote("/Users/x/Library/Application Support/Nova/toolchain/global/bin/claude"),
        "'/Users/x/Library/Application Support/Nova/toolchain/global/bin/claude'"
    );
    assert_eq!(shell_quote("claude"), "claude");
    assert_eq!(shell_quote("/opt/homebrew/bin/claude"), "/opt/homebrew/bin/claude");
    assert_eq!(shell_quote("auth"), "auth");
}

#[test]
fn a_single_quote_in_the_path_cannot_break_out() {
    assert_eq!(shell_quote("/tmp/it's here/claude"), "'/tmp/it'\\''s here/claude'");
}
