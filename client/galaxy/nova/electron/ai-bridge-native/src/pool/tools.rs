use crate::log_warn;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 本机这几个工具的版本与可升级状态，给控制台显示。
///
/// 为什么版本要问 CLI 自己而不是读 npm：claude 的 bin 指向的是原生构建，
/// 实测 `claude --version` 与 npm 包版本会差一两个补丁号 —— 读 npm 会显示一个
/// 用户根本没在跑的版本。
///
/// 「最新版」要走网络，所以缓存 30 分钟：这个面板每次进页面都会拉。
const LATEST_TTL: Duration = Duration::from_secs(30 * 60);
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    pub name: String,
    /// 本机正在跑的版本。取不到就是没装。
    pub current: String,
    /// 上游最新版。取不到（网络不通等）就是空串，此时不判定可升级。
    pub latest: String,
    /// 只有两边都拿得到、且不相等，才算可升级 —— 拿不到就别催人升级。
    pub upgradable: bool,
    /// 没装的工具不显示升级按钮，显示「未安装」。
    pub installed: bool,
}

fn latest_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 只给测试用。
pub fn clear_tool_cache() {
    latest_cache().lock().unwrap().clear();
}

async fn run(file: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        EXEC_TIMEOUT,
        tokio::process::Command::new(file).args(args).stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| format!("{file} 超时"))?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("{file} 退出码 {}", output.status.code().unwrap_or(-1)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 从 `codex-cli 0.153.4` / `2.1.263 (Claude Code)` 这类输出里抠出版本号。
pub fn parse_version(raw: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?").unwrap());
    re.find(raw).map(|m| m.as_str().to_string()).unwrap_or_default()
}

async fn npm_latest(pkg: &str) -> String {
    if let Some((at, value)) = latest_cache().lock().unwrap().get(pkg) {
        if at.elapsed() < LATEST_TTL {
            return value.clone();
        }
    }
    match run("npm", &["view", pkg, "version"]).await {
        Ok(raw) => {
            let value = parse_version(&raw);
            latest_cache().lock().unwrap().insert(pkg.into(), (Instant::now(), value.clone()));
            value
        }
        Err(message) => {
            log_warn!("tool_latest_unavailable", "pkg": pkg, "message": message);
            String::new()
        }
    }
}

async fn cli_version(command: &str) -> String {
    run(command, &["--version"]).await.map(|raw| parse_version(&raw)).unwrap_or_default()
}

/// 桌面模式下 ai-bridge 随 Nova 一起分发，版本由调用方（Node 侧读自己的
/// package.json）传进来，没有独立的升级通道。
pub async fn tool_statuses(bridge_version: &str) -> Vec<ToolStatus> {
    let (claude, claude_latest, codex, codex_latest) = tokio::join!(
        cli_version("claude"),
        npm_latest("@anthropic-ai/claude-code"),
        cli_version("codex"),
        npm_latest("@openai/codex"),
    );
    vec![
        ToolStatus {
            name: "ai-bridge".into(),
            current: bridge_version.to_string(),
            latest: bridge_version.to_string(),
            upgradable: false,
            installed: true,
        },
        status("claude", claude, claude_latest),
        status("codex", codex, codex_latest),
    ]
}

fn status(name: &str, current: String, latest: String) -> ToolStatus {
    ToolStatus {
        // 两边都拿得到才判定 —— 网络不通时不该显示一个「可升级」的假信号。
        upgradable: !current.is_empty() && !latest.is_empty() && current != latest,
        installed: !current.is_empty(),
        name: name.into(),
        current,
        latest,
    }
}

/// 升级命令。**只认这张表**，请求体里只能传工具名 —— 和 LOGIN_COMMANDS 同一个道理。
fn upgrade_command(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "claude" => Some(&["npm", "install", "-g", "@anthropic-ai/claude-code@latest"]),
        "codex" => Some(&["npm", "install", "-g", "@openai/codex@latest"]),
        _ => None,
    }
}

/// 拉起一次升级。**立刻返回**，不等它跑完 ——
/// npm 全局安装动辄几十秒，干等只会超时；跑完与否由下次查版本体现。
pub fn upgrade_tool(name: &str) -> Result<String, String> {
    if name == "ai-bridge" {
        return Err("ai-bridge 随 Nova 更新，请更新 Nova 应用".into());
    }
    let argv = upgrade_command(name).ok_or_else(|| format!("不认识的工具：{name}"))?;
    spawn_detached(argv[0], &argv[1..])?;
    let command = argv.join(" ");
    crate::log_info!("tool_upgrade_launched", "tool": name, "command": command);
    Ok(command)
}

/// 脱离当前进程跑：升级过程比这次调用长得多，挂在自己身上会被一起带走。
pub fn spawn_detached(program: &str, args: &[&str]) -> Result<(), String> {
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn().map(|_| ()).map_err(|e| format!("{program} 起不来：{e}"))
}
