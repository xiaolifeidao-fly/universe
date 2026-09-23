use ai_bridge_native::pool::login::{
    cancel_login, clear_login_sessions, login_status, start_login, STATE_FAILED, STATE_RUNNING,
    STATE_WAITING,
};
use std::time::Duration;

// 拿**真的 CLI** 跑一遍整条链：起进程 → 读它的输出 → 认出地址和短码 → 落到会话状态上。
//
// 单独一个文件而且默认跳过，因为它要求本机装了这两个命令行，而 CI 上没有：
//
//     cargo test --test pool_login -- --ignored --test-threads=1
//
// 上面 tests/pool.rs 里那几条解析用例钉的是「给定这段输出该认出什么」，这一条钉的是
// 「那段输出真的会出现」—— 两者缺一不可：CLI 改版时前者仍然全绿，只有这一条会红。
//
// 不会动主人真正的登录态：两个 CLI 的凭据目录都改到临时目录去了。也不会留下孤儿进程 ——
// 每条用例结束前都 cancel_login 把子进程杀掉（设备码那条不杀的话会自己轮询 15 分钟）。

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ai-bridge-login-test-{name}"));
    std::fs::create_dir_all(&dir).expect("建不了临时目录");
    dir
}

/// 等到这个工具的会话满足条件为止。给得宽一点：起一次 node 进程加一趟网络往返，
/// 慢的机器上两三秒是正常的。
async fn wait_until(
    tool: &str,
    mut done: impl FnMut(&ai_bridge_native::pool::login::LoginStatus) -> bool,
) -> ai_bridge_native::pool::login::LoginStatus {
    for _ in 0..60 {
        if let Some(status) = login_status(tool) {
            if done(&status) {
                return status;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("{tool}：等了 30 秒也没等到想要的状态，最后一次是 {:?}", login_status(tool));
}

#[tokio::test]
#[ignore = "要本机装了 codex：cargo test --test pool_login -- --ignored"]
async fn codex_really_hands_back_a_device_code() {
    clear_login_sessions();
    std::env::set_var("CODEX_HOME", scratch("codex"));

    let started = start_login("codex", Some("lg_test_codex")).await.expect("codex 登录起不来");
    assert_eq!(started.state, STATE_RUNNING, "刚起来时还没有东西可给主人看");
    // 设备码这条路不需要主人把任何东西粘回来。
    assert!(!started.needs_code);

    let status = wait_until("codex", |status| status.state == STATE_WAITING).await;
    assert!(
        status.verification_uri.starts_with("https://"),
        "该给出一个能打开的地址，得到 {:?}",
        status.verification_uri
    );
    assert!(
        status.user_code.contains('-') && status.user_code.len() >= 7,
        "该给出一串短码，得到 {:?}",
        status.user_code
    );
    assert!(cancel_login("codex"), "还在跑的会话该取消得掉");
    // 等它真的收摊：取消只是说一声，杀进程是守着子进程那个任务干的。
    // 不等的话测试进程先退了，那个任务根本没机会跑 —— 而它要杀的是**整个进程组**，
    // 只杀直接子进程的话，codex 那个 node 启动器底下的原生进程会活下来继续轮询。
    let done = wait_until("codex", |status| status.state == STATE_FAILED).await;
    assert!(done.detail.contains("取消"), "终态该说清楚是被取消的，得到 {:?}", done.detail);
}

#[tokio::test]
#[ignore = "要本机装了 claude：cargo test --test pool_login -- --ignored"]
async fn claude_really_hands_back_an_authorize_url_and_waits_for_a_code() {
    clear_login_sessions();
    std::env::set_var("CLAUDE_CONFIG_DIR", scratch("claude"));

    start_login("claude", Some("lg_test_claude")).await.expect("claude 登录起不来");
    let status = wait_until("claude", |status| status.state == STATE_WAITING).await;

    assert!(
        status.verification_uri.starts_with("https://"),
        "该给出授权地址，得到 {:?}",
        status.verification_uri
    );
    // 这条路的全部特殊之处：没有短码，取而代之的是「码要粘回来」。
    assert!(status.user_code.is_empty(), "claude 不该有短码，得到 {:?}", status.user_code);
    assert!(status.needs_code, "claude 必须等主人把码粘回来");
    // 进程还活着 —— 它正卡在 stdin 上。这正是回程存在的理由。
    assert!(cancel_login("claude"), "还在等码的会话该取消得掉");
    wait_until("claude", |status| status.state == STATE_FAILED).await;
}
