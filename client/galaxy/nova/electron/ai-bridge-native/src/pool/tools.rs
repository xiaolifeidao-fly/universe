use crate::log_warn;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
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

/// 本机版本也缓存，两个原因：
///   · 有东西在装时界面是一秒一轮，而 `claude --version` 要起一次 node（几百毫秒），
///     一秒问两遍纯属白烧；
///   · npm 换文件的那几秒问它会失败 —— 不缓存的话界面会闪一下「未安装」。
/// 装完由 watch() 把这一项清掉，所以新版本号不用等这 30 秒才露面。
const CURRENT_TTL: Duration = Duration::from_secs(30);

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
    /// 正在装 / 刚装完的那一次的进度。没有就是这会儿没人动它 ——
    /// 这时这个字段整个不出现，TS 侧是 undefined，渲染层少一种要判的形态。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<ToolJob>,
}

fn latest_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn current_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 只给测试用。
pub fn clear_tool_cache() {
    latest_cache().lock().unwrap().clear();
    current_cache().lock().unwrap().clear();
}

#[cfg(windows)]
const PATH_SEPARATOR: char = ';';
#[cfg(not(windows))]
const PATH_SEPARATOR: char = ':';

/// Windows 上可执行文件带后缀，而 npm / claude / codex 装出来的都是 `.cmd`。
#[cfg(windows)]
const EXECUTABLE_SUFFIXES: &[&str] = &["", ".exe", ".cmd", ".bat"];
#[cfg(not(windows))]
const EXECUTABLE_SUFFIXES: &[&str] = &[""];

/// 在一份 PATH 里找可执行文件。分隔符和后缀由调用方给，好让测试把两个平台都过一遍。
///
/// 名字里已经带了路径分隔符（`/usr/bin/osascript` 这种）就当它是路径，直接看在不在。
pub fn resolve_in(
    path: &str,
    name: &str,
    separator: char,
    suffixes: &[&str],
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        let direct = PathBuf::from(name);
        return exists(&direct).then_some(direct);
    }
    for dir in path.split(separator).filter(|part| !part.is_empty()) {
        for suffix in suffixes {
            let candidate = Path::new(dir).join(format!("{name}{suffix}"));
            if exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// unix 上还要看执行位：PATH 上躺着一个同名的普通文件不算数。
#[cfg(unix)]
fn is_executable(candidate: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(candidate)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(candidate: &Path) -> bool {
    std::fs::metadata(candidate).map(|meta| meta.is_file()).unwrap_or(false)
}

/// 按本进程的 PATH 找一个工具。
///
/// 为什么不直接 `Command::new("npm")`：Windows 上 npm 是 `npm.cmd`，而
/// `Command::new` 只会补 `.exe`，不认 PATHEXT —— 不自己找一遍，Windows 上连本机
/// 装的 npm 都调不起来。顺带也能把「没这个东西」和「跑起来失败了」分开说。
///
/// PATH 是 Nova 补好之后塞进来的（见 electron/src/modules/toolchain）：本机装的排在
/// 前面，Nova 自带的 node / npm shim 在最后兜底。这里只负责照着它找。
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    resolve_in(&path, name, PATH_SEPARATOR, EXECUTABLE_SUFFIXES, is_executable)
}

async fn run(file: &str, args: &[&str]) -> Result<String, String> {
    let program = resolve_program(file).ok_or_else(|| format!("{file} 不在 PATH 上"))?;
    let output = tokio::time::timeout(
        EXEC_TIMEOUT,
        tokio::process::Command::new(&program).args(args).stdin(Stdio::null()).output(),
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

/// 本机版本，带缓存。正在装的时候一律给上一次的值：那几秒问 CLI 只会失败或者给出
/// 换了一半的版本，而界面正好在一秒一轮地看这里。
async fn current_version(command: &str) -> String {
    let cached = current_cache().lock().unwrap().get(command).cloned();
    if job_running(command) {
        return cached.map(|(_, value)| value).unwrap_or_default();
    }
    if let Some((at, value)) = cached {
        if at.elapsed() < CURRENT_TTL {
            return value;
        }
    }
    let value = cli_version(command).await;
    current_cache().lock().unwrap().insert(command.into(), (Instant::now(), value.clone()));
    value
}

/// 桌面模式下 ai-bridge 随 Nova 一起分发，版本由调用方（Node 侧读自己的
/// package.json）传进来，没有独立的升级通道。
pub async fn tool_statuses(bridge_version: &str) -> Vec<ToolStatus> {
    let mut all = vec![ToolStatus {
        name: "ai-bridge".into(),
        current: bridge_version.to_string(),
        latest: bridge_version.to_string(),
        upgradable: false,
        installed: true,
        job: None,
    }];
    all.extend(external_tool_statuses().await);
    all
}

/// 要主人自己升的那两个外部工具。心跳报给 Hub 的就是这一份 ——
/// ai-bridge 不在里面：它的版本早就在 bridgeVersion 里，而且远程升级走的是另一条路。
///
/// **会走网络**（问 npm 要最新版，30 分钟缓存一次），所以别直接摆进心跳循环里，
/// 那一路卡住多久，心跳就迟到多久。心跳读的是后台探针存下的快照。
pub async fn external_tool_statuses() -> Vec<ToolStatus> {
    let (claude, claude_latest, codex, codex_latest) = tokio::join!(
        current_version("claude"),
        npm_latest("@anthropic-ai/claude-code"),
        current_version("codex"),
        npm_latest("@openai/codex"),
    );
    vec![status("claude", claude, claude_latest), status("codex", codex, codex_latest)]
}

/// 有没有哪个工具正在装。心跳据此把节奏提快 —— 远端那台的进度条也该看着动。
pub fn any_job_running() -> bool {
    jobs().lock().unwrap().values().any(|record| record.finished.is_none())
}

fn status(name: &str, current: String, latest: String) -> ToolStatus {
    ToolStatus {
        // 两边都拿得到才判定 —— 网络不通时不该显示一个「可升级」的假信号。
        upgradable: !current.is_empty() && !latest.is_empty() && current != latest,
        installed: !current.is_empty(),
        job: tool_job(name),
        name: name.into(),
        current,
        latest,
    }
}

// ---------- 装 / 升的进度 ----------

pub const ACTION_INSTALL: &str = "install";
pub const ACTION_UPGRADE: &str = "upgrade";
pub const STATE_RUNNING: &str = "running";
pub const STATE_SUCCEEDED: &str = "succeeded";
pub const STATE_FAILED: &str = "failed";
pub const PHASE_STARTING: &str = "starting";
pub const PHASE_RESOLVING: &str = "resolving";
pub const PHASE_DOWNLOADING: &str = "downloading";
pub const PHASE_INSTALLING: &str = "installing";
pub const PHASE_DONE: &str = "done";
pub const PHASE_FAILED: &str = "failed";

/// 一次安装 / 升级从起到落。界面上那一行「升级中 · 下载 46% · 12.0s」就是它。
///
/// 为什么要有这个东西：npm 全局装一次动辄几十秒，而这个调用是拉起就返回的。
/// 在它之前，点完按钮界面上什么都不会变，只能提示「装完自己刷新一下」—— 于是
/// 主人要么一直点刷新，要么以为没点上又点一次（两个 npm 同时写全局 node_modules）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolJob {
    pub name: String,
    /// install / upgrade。本来没装和装了旧版，在界面上是两句话。
    pub action: &'static str,
    /// running / succeeded / failed。
    pub state: &'static str,
    /// starting / resolving / downloading / installing / done / failed。
    pub phase: &'static str,
    /// 0-100。npm 不报百分比，这是按真实事件推的估算，见 Progress。
    pub percent: u8,
    /// 最后一行有信息量的输出；失败时是 npm 说的原因。
    pub detail: String,
    pub elapsed_ms: u64,
    /// 真正跑的那条命令。失败时界面把它摆出来，好让人自己去终端跑一遍看个究竟。
    pub command: String,
    /// 这一次是 Hub 让装的话，是那条指令的 id；本机自己点的没有。
    ///
    /// 心跳把它原样报回去，Hub 才分得清「机器已经领走了我发的那条」和
    /// 「机器上本来就有人在装」—— 分不清就会一直重发同一条指令。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

struct JobRecord {
    job: ToolJob,
    started: Instant,
    finished: Option<Instant>,
}

fn jobs() -> &'static Mutex<HashMap<String, JobRecord>> {
    static JOBS: OnceLock<Mutex<HashMap<String, JobRecord>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 装完的记录挂这么久就自己收掉：够界面（一秒一轮）看见「完成」，
/// 又不至于下次进页面时还挂着一条早就结束的消息。
/// 失败的不收，留到下次再点 —— 和远程升级那边一个规矩。
const DONE_KEEP: Duration = Duration::from_secs(90);

/// 这个工具这会儿的进度。没有就是没人动过它（或者上一次成功的那条已经过期收掉了）。
pub fn tool_job(name: &str) -> Option<ToolJob> {
    let mut guard = jobs().lock().unwrap();
    let record = guard.get_mut(name)?;
    match record.finished {
        Some(at) if record.job.state == STATE_SUCCEEDED && at.elapsed() > DONE_KEEP => {
            guard.remove(name);
            None
        }
        Some(_) => Some(record.job.clone()),
        None => {
            // 跑着的时候秒数现算：watch() 半秒一次，界面一秒一次，差的那半秒不该看出来。
            record.job.elapsed_ms = record.started.elapsed().as_millis() as u64;
            Some(record.job.clone())
        }
    }
}

fn job_running(name: &str) -> bool {
    jobs().lock().unwrap().get(name).is_some_and(|record| record.finished.is_none())
}

/// 升级命令。**只认这张表**，请求体里只能传工具名 —— 和 LOGIN_COMMANDS 同一个道理。
///
/// 后面那几个开关是为了能看见进度：
///   · `--loglevel=http` —— 非 TTY 下 npm 默认几乎不出声（连进度条都不画），
///     取包的那几行是这里唯一拿得到的进度信号；
///   · `--foreground-scripts` —— claude 的 postinstall 还要另外下一份原生构建，
///     不放出来的话最花时间的那一段是黑的；
///   · `--no-audit --no-fund` —— 纯噪音，还各自多一次网络往返。
/// npm 不认识的开关只会 warn 一行，老版本 npm 上顶多是没有进度，不会装不上。
fn upgrade_command(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "claude" => Some(&[
            "npm", "install", "-g", "@anthropic-ai/claude-code@latest",
            "--loglevel=http", "--foreground-scripts", "--no-audit", "--no-fund",
        ]),
        "codex" => Some(&[
            "npm", "install", "-g", "@openai/codex@latest",
            "--loglevel=http", "--foreground-scripts", "--no-audit", "--no-fund",
        ]),
        _ => None,
    }
}

/// 一次装 / 升最多跑这么久。这两个包通常几十秒，跑到这个数只可能是卡死了
/// （registry 不通、或者卡在等输入）。到点就杀：留着一个卡住的 npm 会一直占着
/// 全局 node_modules 的锁，下一次点「重试」连动都动不了。
const JOB_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 看日志的节奏。界面一秒一轮，比它快没意义。
const JOB_POLL: Duration = Duration::from_millis(500);

/// 本机自己点的那一次。远端下发的走 run_tool_job。
pub async fn upgrade_tool(name: &str) -> Result<ToolJob, String> {
    run_tool_job(name, None).await
}

/// 拉起一次安装或升级。**立刻返回**那条进度记录 —— npm 全局安装动辄几十秒，
/// 干等只会超时；真正跑到哪了由 getTools（本机）或心跳里的 tools（远端）一路报上去。
///
/// command_id 是 Hub 下发的指令 id，本机自己点的传 None。
pub async fn run_tool_job(name: &str, command_id: Option<&str>) -> Result<ToolJob, String> {
    match start_tool_job(name, command_id).await {
        Ok(job) => Ok(job),
        Err(message) => {
            // 远端下发的那一条：连命令都没起来（npm 不在 PATH 上、工具名不认识）时也要
            // 留一条失败记录 —— 它是这台机器唯一的发声渠道，心跳把它报回去，控制台才
            // 说得出原因。不留的话，主人看到的是一个「等机器领取」挂满十分钟然后消失。
            //
            // 本机自己点的不用留：那条调用当场就把错误返给界面了。
            if let Some(id) = command_id {
                record_failed_job(name, id, &message);
            }
            Err(message)
        }
    }
}

fn record_failed_job(name: &str, command_id: &str, message: &str) {
    let job = ToolJob {
        name: name.to_string(),
        action: ACTION_INSTALL,
        state: STATE_FAILED,
        phase: PHASE_FAILED,
        percent: 0,
        detail: clip(message),
        elapsed_ms: 0,
        command: String::new(),
        command_id: Some(command_id.to_string()),
    };
    let now = Instant::now();
    jobs()
        .lock()
        .unwrap()
        .insert(name.to_string(), JobRecord { job, started: now, finished: Some(now) });
}

async fn start_tool_job(name: &str, command_id: Option<&str>) -> Result<ToolJob, String> {
    if name == "ai-bridge" {
        return Err("ai-bridge 随 Nova 更新，请更新 Nova 应用".into());
    }
    let argv = upgrade_command(name).ok_or_else(|| format!("不认识的工具：{name}"))?;
    // 已经在装了就把那一份原样还回去。按钮点两下不该起两个 npm：
    // 两个进程同时写全局 node_modules，装出来是什么样没人说得准。
    if let Some(job) = tool_job(name).filter(|job| job.state == STATE_RUNNING) {
        return Ok(job);
    }
    // 装还是升，按「本机现在有没有这个命令」定。不问 `--version`：那要起一次 node，
    // 而这里是点下按钮之后的第一件事，要快。
    let action = if resolve_program(name).is_some() { ACTION_UPGRADE } else { ACTION_INSTALL };
    let log = log_path(name);
    let child = spawn_logged(argv[0], &argv[1..], &log)?;
    let command = argv.join(" ");
    let job = ToolJob {
        name: name.to_string(),
        action,
        state: STATE_RUNNING,
        phase: PHASE_STARTING,
        percent: START_PERCENT,
        detail: String::new(),
        elapsed_ms: 0,
        command: command.clone(),
        command_id: command_id.map(str::to_string),
    };
    let started = Instant::now();
    jobs()
        .lock()
        .unwrap()
        .insert(name.to_string(), JobRecord { job: job.clone(), started, finished: None });
    crate::log_info!("tool_upgrade_launched", "tool": name, "action": action, "command": command);
    tokio::spawn(watch(name.to_string(), child, log, started));
    Ok(job)
}

/// 日志落在临时目录：没人要长期留着它，而且 npm 跑失败时那一整段原文在这里，
/// 排查时比界面上那一句原因管用。同一个工具重来一次就覆盖上一次的。
fn log_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("nova-tool-{name}.log"))
}

/// 起一次装 / 升。输出**重定向到文件**，不走管道：
/// 管道另一头在 Nova 里，Nova 一关就是断管，npm 再写一行就被 SIGPIPE 打死 ——
/// 装到一半的全局包比没装上麻烦得多。写文件的话 Nova 关掉它照样装完，
/// 只是没人盯着进度了（下次打开看版本号就知道结果）。
fn spawn_logged(program: &str, args: &[&str], log: &Path) -> Result<std::process::Child, String> {
    // 这句话服务器上的人也要看得懂：systemd 起的服务拿到的 PATH 很窄，nvm 装的 node
    // 根本不在里面 —— 那是这条路上最常见的失败，而它和「这台机器没装 Node」要分得开。
    let resolved = resolve_program(program)
        .ok_or_else(|| format!("{program} 不在 PATH 上：这台机器上没有，或者跑 ai-bridge 的那个用户看不到它"))?;
    let file = std::fs::File::create(log).map_err(|e| format!("{} 写不了：{e}", log.display()))?;
    let errors = file.try_clone().map_err(|e| format!("{} 写不了：{e}", log.display()))?;
    let mut command = std::process::Command::new(&resolved);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::from(file)).stderr(Stdio::from(errors));
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn().map_err(|e| format!("{program} 起不来：{e}"))
}

/// 盯着一次装 / 升：半秒读一段新日志，认出走到哪一步了，写回那条记录。
///
/// setsid 只换会话不换爹，所以这里照样 try_wait 得到 —— 顺带把它收了，
/// 不然每装一次就在进程表里留一个僵尸，直到 Nova 退出。
async fn watch(name: String, mut child: std::process::Child, log: PathBuf, started: Instant) {
    let mut tail = LogTail::new(log);
    let mut progress = Progress::starting();
    loop {
        tokio::time::sleep(JOB_POLL).await;
        tail.feed(&mut progress);
        let done = match child.try_wait() {
            Ok(Some(status)) => Some(status.success()),
            Ok(None) if started.elapsed() > JOB_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                progress.stalled();
                Some(false)
            }
            Ok(None) => None,
            // 连它的死活都问不出来（进程被别人收了等等）：再问下去也是这个结果。
            Err(error) => {
                progress.fail(error.to_string());
                Some(false)
            }
        };
        let Some(ok) = done else {
            update(&name, |job| {
                job.phase = progress.phase;
                job.percent = progress.percent;
                job.detail.clone_from(&progress.detail);
            });
            continue;
        };
        // 收尾前再读一次：最后那几行（`added 1 package`、报错原文）多半是在
        // 上一次读之后、进程退出之前写下的。
        tail.feed(&mut progress);
        let reason = progress.reason();
        // 落终态和标「结束了」在同一把锁里做完：分两次的话中间那一瞬间，
        // 读到的会是一条「已成功但还在计时」的记录。
        if let Some(record) = jobs().lock().unwrap().get_mut(&name) {
            record.job.state = if ok { STATE_SUCCEEDED } else { STATE_FAILED };
            record.job.phase = if ok { PHASE_DONE } else { PHASE_FAILED };
            record.job.percent = if ok { 100 } else { progress.percent };
            record.job.detail = if ok { progress.detail.clone() } else { reason.clone() };
            record.job.elapsed_ms = started.elapsed().as_millis() as u64;
            record.finished = Some(Instant::now());
        }
        // 装完把版本缓存清掉：界面下一轮就该看见新版本号，
        // 而那个缓存本来就是为了「装的时候别去问」才加的。
        current_cache().lock().unwrap().remove(&name);
        if ok {
            crate::log_info!("tool_upgrade_done", "tool": name, "elapsedMs": started.elapsed().as_millis() as u64);
        } else {
            log_warn!("tool_upgrade_failed", "tool": name, "message": reason);
        }
        return;
    }
}

fn update(name: &str, change: impl FnOnce(&mut ToolJob)) {
    if let Some(record) = jobs().lock().unwrap().get_mut(name) {
        change(&mut record.job);
    }
}

/// 刚起步时给的那一点。不给 0：进度条一格不动的时候，人分不出「在跑」和「没点上」。
const START_PERCENT: u8 = 3;

/// 从 npm 的输出里读得出来的进度。
///
/// npm 不报百分比 —— 非 TTY 下它连进度条都不画，能拿到的只有 `--loglevel=http`
/// 那几行取包记录。所以这里**按真实事件往前推**：每取下来一个包挪一点，跑到包自己的
/// 安装脚本再挪一段，进程退出才到 100。百分比是估的，阶段不是；界面上大字写阶段，
/// 进度条只是让人看出它还在动，旁边还有一个真的秒数兜底。
#[derive(Debug, Clone)]
pub struct Progress {
    pub phase: &'static str,
    pub percent: u8,
    pub detail: String,
    /// 取下来几个包了。只拿来推进度。
    fetched: u32,
    /// npm 报错的头几行，失败时拿它当原因。
    errors: Vec<String>,
}

/// npm 收尾那一句：`added 1 package in 3s` / `changed 1 package` / `up to date`。
const FINISH_WORDS: &[&str] = &["added ", "changed ", "removed ", "up to date"];
/// 界面上就一行的地方，放不下更多。
const DETAIL_MAX: usize = 200;

impl Default for Progress {
    fn default() -> Self {
        Self::starting()
    }
}

impl Progress {
    pub fn starting() -> Self {
        Self {
            phase: PHASE_STARTING,
            percent: START_PERCENT,
            detail: String::new(),
            fetched: 0,
            errors: Vec::new(),
        }
    }

    /// 喂一行 npm 的输出。
    pub fn feed(&mut self, raw: &str) {
        let line = raw.trim();
        if line.is_empty() {
            return;
        }
        if let Some(body) = error_body(line) {
            // 报错行不当 detail：真正要说的那句在收尾时由 reason() 挑。
            // 只留头三行 —— npm 失败时能刷十几行，后面全是日志路径和堆栈。
            if self.errors.len() < 3 && !body.is_empty() && !body.starts_with("A complete log") {
                self.errors.push(clip(body));
            }
            return;
        }
        if line.starts_with("npm http fetch") {
            // 取 tarball 才算下载；前面那几条是问 registry 要元数据。
            if line.contains(".tgz") {
                // 头一个 tarball 就是主包，最花时间的那个，所以它一步跨到 40；
                // 后面是依赖，一个一步小的。封顶 70，剩下的留给安装脚本。
                self.fetched += 1;
                let percent = (36 + self.fetched * 4).min(70) as u8;
                self.reach(PHASE_DOWNLOADING, percent);
            } else {
                self.reach(PHASE_RESOLVING, 12);
            }
            return;
        }
        if line.starts_with("npm warn") || line.starts_with("npm WARN") || line.starts_with("npm notice") {
            return;
        }
        if FINISH_WORDS.iter().any(|word| line.starts_with(word)) {
            self.reach(PHASE_INSTALLING, 96);
            self.detail = clip(line);
            return;
        }
        // 剩下的是包自己的安装脚本打的（--foreground-scripts）：`> pkg@1.2.3 postinstall`
        // 之后的那一段。claude 就是在这里下它的原生构建，最花时间。
        self.reach(PHASE_INSTALLING, 80);
        if !line.starts_with('>') {
            self.detail = clip(line);
        }
    }

    /// 只进不退：两条流合在一个文件里，先后顺序本来就不保证。
    fn reach(&mut self, phase: &'static str, percent: u8) {
        if percent >= self.percent {
            self.percent = percent;
            self.phase = phase;
        }
    }

    /// 跑太久被掐掉。
    fn stalled(&mut self) {
        self.fail(format!("超过 {} 分钟还没装完，已经掐掉", JOB_TIMEOUT.as_secs() / 60));
    }

    fn fail(&mut self, reason: String) {
        self.errors.insert(0, clip(&reason));
    }

    /// 失败时给人看的那一句。npm 把原因摊成好几行（`npm error code EACCES`、
    /// `npm error syscall mkdir`……），单挑一行都说不全，拼起来才是一句人话。
    pub fn reason(&self) -> String {
        if self.errors.is_empty() {
            // 一个字都没说就挂了：多半是命令根本没跑起来（npm 不在、PATH 不对）。
            return if self.detail.is_empty() { "npm 没说原因，去终端跑一次看看".into() } else { self.detail.clone() };
        }
        clip(&self.errors.join(" · "))
    }
}

/// `npm error xxx` / `npm ERR! xxx` 里的 xxx。不是报错行就是 None。
fn error_body(line: &str) -> Option<&str> {
    for prefix in ["npm error", "npm ERR!"] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(rest.trim());
        }
    }
    None
}

fn clip(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= DETAIL_MAX {
        return trimmed.to_string();
    }
    trimmed.chars().take(DETAIL_MAX).collect::<String>() + "…"
}

/// 跟着日志文件往下读。只读新增的那一段，半行留着等下一次 ——
/// npm 是一行一行刷的，把读了一半的行喂给解析器会把阶段认错。
struct LogTail {
    path: PathBuf,
    offset: u64,
    partial: String,
}

/// 一行迟迟不结束（安装脚本在原地刷进度条，只回车不换行）时的上限。
const PARTIAL_MAX: usize = 4096;

impl LogTail {
    fn new(path: PathBuf) -> Self {
        Self { path, offset: 0, partial: String::new() }
    }

    /// 把新写进来的几行喂给 progress。几 KB 的同步读，不值得为它开一趟 spawn_blocking。
    fn feed(&mut self, progress: &mut Progress) {
        for line in self.take() {
            progress.feed(&line);
        }
    }

    fn take(&mut self) -> Vec<String> {
        let Ok(mut file) = std::fs::File::open(&self.path) else { return Vec::new() };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.offset += buf.len() as u64;
        // 回车当换行：安装脚本的进度条是靠 \r 原地刷的，不拆开就是一行几千字。
        self.partial.push_str(&String::from_utf8_lossy(&buf).replace('\r', "\n"));
        let mut lines = Vec::new();
        while let Some(at) = self.partial.find('\n') {
            lines.push(self.partial[..at].to_string());
            self.partial.drain(..=at);
        }
        if self.partial.len() > PARTIAL_MAX {
            lines.push(std::mem::take(&mut self.partial));
        }
        lines
    }
}

/// 脱离当前进程跑：升级过程比这次调用长得多，挂在自己身上会被一起带走。
pub fn spawn_detached(program: &str, args: &[&str]) -> Result<(), String> {
    let resolved = resolve_program(program)
        .ok_or_else(|| format!("{program} 不在 PATH 上：本机没装，Nova 自带的也没铺好"))?;
    let mut command = std::process::Command::new(&resolved);
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
