use crate::{log_info, log_warn};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Notify};
use std::sync::Arc;

// 远端机器上的交互式登录（claude / codex）。
//
// 和 tools.rs 那条「装 / 升」是**两种形状**，这是这个文件存在的全部理由：
// 装一个 npm 包是「发出去、跑完、报终态」，中间没人需要插话；而登录中间必须
// 有主人参与 —— 机器这边起一个进程，把「去哪儿授权」交出去，然后等。
//
//   · codex 走设备码（`codex login --device-auth`）：机器拿到一个短码和一个地址，
//     主人在任意一台有浏览器的设备上输码，机器自己轮询换 token。**单向**，
//     和装东西一样发出去就不用管了。
//   · claude 没有设备码流程。`claude auth login` 打印一条授权地址，浏览器授权完
//     由 platform.claude.com 那个托管回调页把授权码显示给主人，然后进程**卡在
//     stdin 上等这串码**。所以这条路必须有回程：控制台收下主人粘回来的码，
//     经 Hub 送回这台机器，喂给那个还活着的进程。
//
// 回程为什么搭心跳：poll 接入的机器 Hub 根本连不上它（只有 export 节点有入站面，
// 见 runner 里 next_loop 的启动条件），机房里的机器多半是 poll。所以下行只有心跳
// 这一条路。代价是码最多晚一跳才到，补偿办法和装东西时一样 —— 会话活着期间
// 心跳提速到 5 秒（见 runner::heartbeat_loop）。
//
// 终态一律看**退出码**，不看输出里有没有「成功」字样：那两行字是别人家的文案，
// 改一次我们就会把一次成功的登录报成失败。输出只用来认三件事 —— 去哪儿授权、
// 短码是什么、是不是在等码。

/// 起着，但还没拿到可以交给主人的东西。
pub const STATE_RUNNING: &str = "running";
/// 地址（和短码）已经就绪，在等主人。界面这时才有东西可显示。
pub const STATE_WAITING: &str = "waiting";
pub const STATE_SUCCEEDED: &str = "succeeded";
pub const STATE_FAILED: &str = "failed";

pub const PHASE_STARTING: &str = "starting";
/// 等主人去浏览器授权。
pub const PHASE_AUTHORIZE: &str = "authorize";
/// 码已经喂进去了，CLI 正在拿它换 token。
pub const PHASE_VERIFYING: &str = "verifying";
pub const PHASE_DONE: &str = "done";
pub const PHASE_FAILED: &str = "failed";

/// 一次登录最多挂这么久，到点连进程一起杀掉。
///
/// 按两边的码寿命取的：codex 的设备码自己写着 15 分钟过期，claude 那串授权码更短。
/// 超过这个数还没完成，留着的只是一个永远等不到 stdin 的进程 —— 而它占着这个工具的
/// 会话槽，主人重新点「登录」会被它挡住。
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 成功的记录挂这么久就自己收掉：够界面看见「已登录」，又不至于下次进页面时
/// 还挂着一条早就结束的消息。失败的不收，留到主人下次再点 —— 和 tools.rs 一个规矩。
const DONE_KEEP: Duration = Duration::from_secs(90);

const DETAIL_MAX: usize = 200;

/// 输出缓冲的上限。**满了就不再追加**，不做滚动丢弃：要认的三样东西
/// （地址、短码、等码提示）都在最前面几行，而后面可能是一串轮询日志 ——
/// 滚动的话反而会把已经认出来的那几行挤掉。
const BUFFER_MAX: usize = 16 * 1024;

/// 一次登录从起到落。界面上那一格「去这个地址输码 RWEQ-34W3X」就是它。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub tool: String,
    /// running / waiting / succeeded / failed。
    pub state: &'static str,
    /// starting / authorize / verifying / done / failed。
    pub phase: &'static str,
    /// 让主人在浏览器里打开的地址。没拿到之前是空串。
    pub verification_uri: String,
    /// 设备码流程里要主人手输的那串短码。claude 没有，是空串。
    pub user_code: String,
    /// 这条流程要不要主人把码粘回来。claude 要，codex 不要 ——
    /// 界面据此决定画不画那个输入框。
    pub needs_code: bool,
    /// 最后一句有信息量的话；失败时是 CLI 说的原因（「Invalid code」那种）。
    pub detail: String,
    pub elapsed_ms: u64,
    /// 真正跑的那条命令。失败时界面把它摆出来，好让人自己 ssh 上去跑一遍看个究竟。
    pub command: String,
    /// Hub 下发的那条指令 id。心跳原样报回去，Hub 才分得清
    /// 「机器已经领走了我发的那条」和「机器上本来就有人在登录」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

/// 会话代号，单调递增。
///
/// 一个工具同时只有一条会话记录，但**旧会话的后台任务可能还活着**：取消或重来之后，
/// 上一次的读输出任务和守着子进程的那个任务要过一小会儿才收摊。它们手里只有工具名，
/// 照着工具名写回去就会把新开的这一次覆盖掉 —— 主人看到的是刚点出来的新地址
/// 突然变成「上一次被取消了」。所以每次落笔都先对一下代号。
fn next_session() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

struct LoginRecord {
    session: u64,
    status: LoginStatus,
    started: Instant,
    finished: Option<Instant>,
    /// CLI 到这一刻为止说过的话，喂给 parse_login_output。
    buffer: String,
    /// 往子进程 stdin 写码的口子。进程退出后写进去只会石沉大海，
    /// 所以终态时主动置空 —— submit_code 据此说得出「这次登录已经结束了」。
    codes: Option<mpsc::UnboundedSender<String>>,
    /// 叫停这一次。说一声，守着子进程的那个任务就把它杀掉。
    cancel: Arc<Notify>,
}

fn sessions() -> &'static Mutex<HashMap<String, LoginRecord>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, LoginRecord>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 只给测试用。
pub fn clear_login_sessions() {
    sessions().lock().unwrap().clear();
}

/// 拉起登录的命令。**只认这张表**，指令里只能传工具名 —— 和 tools::upgrade_command
/// 同一个道理：让 Hub 送一条命令过来执行，等于把「在我的机器上跑什么」交出去（原则 8）。
///
/// codex 必须带 `--device-auth`：不带的话它会起一个本地回调服务器（localhost:1455）
/// 并试图开浏览器，在一台没有图形界面的机器上那条路是死的。
pub fn login_command(tool: &str) -> Option<&'static [&'static str]> {
    match tool {
        "claude" => Some(&["claude", "auth", "login"]),
        "codex" => Some(&["codex", "login", "--device-auth"]),
        _ => None,
    }
}

/// 这条流程要不要主人把码粘回来。见文件头对两条路的说明。
pub fn needs_code(tool: &str) -> bool {
    tool == "claude"
}

/// 从 CLI 的输出里认出要交给主人的东西。
///
/// 纯函数，好让 tests 拿两个 CLI 的真实输出各过一遍 —— 这是整条链上唯一一处
/// 依赖别人家输出格式的地方，它坏掉的样子是「界面上一直空着」，不容易一眼看出来。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoginHints {
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    /// 出现了「等你粘码」的提示。
    pub waiting_code: bool,
    /// CLI 明说的错（码不对那种）。进程还活着，主人可以再来一次。
    pub error: Option<String>,
}

pub fn parse_login_output(raw: &str) -> LoginHints {
    let text = strip_ansi(raw);
    let mut hints = LoginHints::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if hints.verification_uri.is_none() {
            if let Some(url) = find_url(line) {
                hints.verification_uri = Some(url);
            }
        }
        // 短码单独占一行，形如 RWEQ-34W3X。放宽到 3-8 位是怕哪天位数变了，
        // 但必须整行都是它 —— 否则授权地址里的任意一段都可能被当成码。
        if hints.user_code.is_none() && is_user_code(line) {
            hints.user_code = Some(line.to_string());
        }
        let lowered = line.to_lowercase();
        if lowered.contains("paste code") {
            hints.waiting_code = true;
        }
        if lowered.contains("invalid code") {
            hints.error = Some(line.to_string());
        }
    }
    hints
}

/// 剥掉 ANSI 转义。codex 即使不在终端里也照样上色（实测管道输出里仍有色码），
/// 不剥的话短码那一行整行匹配永远不成立。
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        // CSI：ESC [ … 字母。其它转义（ESC ] 之类）一并吃到字母或 BEL 为止。
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() || next == '\u{7}' {
                    break;
                }
            }
        }
    }
    out
}

fn find_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',', ')', '"', '\'']);
    if url.len() > "https://".len() {
        Some(url.to_string())
    } else {
        None
    }
}

fn is_user_code(line: &str) -> bool {
    let Some((head, tail)) = line.split_once('-') else { return false };
    let ok = |part: &str| {
        (3..=8).contains(&part.len())
            && part.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    };
    ok(head) && ok(tail)
}

fn clip(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= DETAIL_MAX {
        return trimmed.to_string();
    }
    trimmed.chars().take(DETAIL_MAX).collect::<String>() + "…"
}

/// 这个工具这会儿的登录进度。没有就是没人动过（或者上一次成功的那条已经收掉了）。
pub fn login_status(tool: &str) -> Option<LoginStatus> {
    let mut guard = sessions().lock().unwrap();
    let record = guard.get_mut(tool)?;
    match record.finished {
        Some(at) if record.status.state == STATE_SUCCEEDED && at.elapsed() > DONE_KEEP => {
            guard.remove(tool);
            None
        }
        Some(_) => Some(record.status.clone()),
        None => {
            record.status.elapsed_ms = record.started.elapsed().as_millis() as u64;
            Some(record.status.clone())
        }
    }
}

/// 心跳里那一份登录进度。
pub fn login_report() -> Vec<LoginStatus> {
    let tools: Vec<String> = sessions().lock().unwrap().keys().cloned().collect();
    tools.iter().filter_map(|tool| login_status(tool)).collect()
}

/// 有没有登录会话还开着。开着就把心跳提速 —— 回程的码等的就是这一跳。
pub fn any_login_active() -> bool {
    sessions().lock().unwrap().values().any(|record| record.finished.is_none())
}

fn active(tool: &str) -> bool {
    sessions().lock().unwrap().get(tool).is_some_and(|record| record.finished.is_none())
}

fn update(tool: &str, mutate: impl FnOnce(&mut LoginRecord)) {
    if let Some(record) = sessions().lock().unwrap().get_mut(tool) {
        mutate(record);
    }
}

/// 只在这条记录还是当初那一次时才落笔。后台任务一律走这个口子，见 next_session。
fn update_session(tool: &str, session: u64, mutate: impl FnOnce(&mut LoginRecord)) {
    if let Some(record) = sessions().lock().unwrap().get_mut(tool) {
        if record.session == session {
            mutate(record);
        }
    }
}

/// 把主人粘回来的码喂给还活着的那个进程。
///
/// 要对得上 command_id：一条迟到的码不能落进下一次登录 —— 那一次的挑战码不一样，
/// 喂进去只会换来一句「Invalid code」，而主人看到的是自己刚粘的那串码被拒了。
pub fn submit_code(tool: &str, command_id: &str, code: &str) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("授权码是空的".into());
    }
    let mut guard = sessions().lock().unwrap();
    let record = guard.get_mut(tool).ok_or("这台机器上没有正在进行的登录")?;
    if record.status.command_id.as_deref() != Some(command_id) {
        return Err("这串码对应的那次登录已经结束了，重新点一次登录".into());
    }
    let sender = record.codes.as_ref().ok_or("这次登录已经结束了，重新点一次登录")?;
    sender.send(code.to_string()).map_err(|_| "登录进程已经退出了".to_string())?;
    record.status.phase = PHASE_VERIFYING;
    record.status.detail = String::new();
    Ok(())
}

/// 叫停一次还在进行的登录，顺带把那个子进程杀掉。
///
/// 为什么需要它：`claude auth login` 会一直卡在 stdin 上等码，主人改了主意、或者
/// 想换个账号重来时，不给取消就只能等那 15 分钟的超时 —— 而这期间这个工具的
/// 会话槽一直被占着，「登录」按钮点不动。
///
/// 返回 false 是这会儿没有在跑的登录（已经结束了，或者压根没起过）。
pub fn cancel_login(tool: &str) -> bool {
    let guard = sessions().lock().unwrap();
    let Some(record) = guard.get(tool) else { return false };
    if record.finished.is_some() {
        return false;
    }
    record.cancel.notify_waiters();
    true
}

/// 拉起一次登录。**立刻返回**那条进度记录：授权地址要等 CLI 自己打印出来，
/// 干等只会超时；拿到之后由心跳一路报上去。
///
/// command_id 是 Hub 下发的指令 id，本机自己点的传 None。
pub async fn start_login(tool: &str, command_id: Option<&str>) -> Result<LoginStatus, String> {
    match spawn_login(tool, command_id).await {
        Ok(status) => Ok(status),
        Err(message) => {
            // 和 tools::run_tool_job 一个道理：远端下发的那一条，连命令都没起来时也要
            // 留一条失败记录 —— 心跳把它报回去，控制台才说得出原因。不留的话主人看到的
            // 是一个「等机器领取」挂满十分钟然后消失。
            if let Some(id) = command_id {
                record_failed(tool, id, &message);
            }
            Err(message)
        }
    }
}

fn record_failed(tool: &str, command_id: &str, message: &str) {
    let now = Instant::now();
    let status = LoginStatus {
        tool: tool.to_string(),
        state: STATE_FAILED,
        phase: PHASE_FAILED,
        verification_uri: String::new(),
        user_code: String::new(),
        needs_code: needs_code(tool),
        detail: clip(message),
        elapsed_ms: 0,
        command: String::new(),
        command_id: Some(command_id.to_string()),
    };
    sessions().lock().unwrap().insert(
        tool.to_string(),
        LoginRecord {
            session: next_session(),
            status,
            started: now,
            finished: Some(now),
            buffer: String::new(),
            codes: None,
            cancel: Arc::new(Notify::new()),
        },
    );
}

async fn spawn_login(tool: &str, command_id: Option<&str>) -> Result<LoginStatus, String> {
    let argv = login_command(tool).ok_or_else(|| format!("不认识的工具：{tool}"))?;
    // 已经在登录了，分两种情况：
    //   · 同一条指令（Hub 在机器开工前会重发）—— 把那一份原样还回去。按钮点两下不该
    //     起两个进程：第二个会把第一个顶掉，而主人手里那串码是第一个的。
    //   · 换了一条指令 —— 那是主人要重来一次（上一次卡在等他，而他改了主意或者
    //     那串码已经过期）。先把上一次连进程一起收拾掉，再从头起。不收拾的话，
    //     机器上会留一个还在轮询的进程，而它随时可能把一次成功报到新会话头上。
    if active(tool) {
        let same = login_status(tool)
            .filter(|status| status.command_id.as_deref() == command_id)
            .filter(|_| command_id.is_some());
        if let Some(status) = same {
            return Ok(status);
        }
        cancel_login(tool);
    }
    let program = super::tools::resolve_program(argv[0]).ok_or_else(|| {
        format!("{} 不在 PATH 上：这台机器上没有，或者跑 ai-bridge 的那个用户看不到它", argv[0])
    })?;
    let command_line = argv.join(" ");

    let mut command = tokio::process::Command::new(&program);
    command
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 别让它去开浏览器：这台机器上多半没有，而 claude 会为此干等一会儿。
        .env("BROWSER", "/bin/false");
    // 放进一个自己的进程组，好让超时和取消能连子孙一起收掉。见 kill_tree。
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| format!("{} 起不来：{e}", argv[0]))?;

    let stdin = child.stdin.take().ok_or("拿不到登录进程的输入口")?;
    let stdout = child.stdout.take().ok_or("拿不到登录进程的输出口")?;
    let stderr = child.stderr.take().ok_or("拿不到登录进程的错误输出口")?;

    let (sender, mut receiver) = mpsc::unbounded_channel::<String>();
    let cancel = Arc::new(Notify::new());
    let status = LoginStatus {
        tool: tool.to_string(),
        state: STATE_RUNNING,
        phase: PHASE_STARTING,
        verification_uri: String::new(),
        user_code: String::new(),
        needs_code: needs_code(tool),
        detail: String::new(),
        elapsed_ms: 0,
        command: command_line.clone(),
        command_id: command_id.map(str::to_string),
    };
    let session = next_session();
    sessions().lock().unwrap().insert(
        tool.to_string(),
        LoginRecord {
            session,
            status: status.clone(),
            started: Instant::now(),
            finished: None,
            buffer: String::new(),
            codes: Some(sender),
            cancel: Arc::clone(&cancel),
        },
    );
    log_info!("pool_login_started", "tool": tool, "command": command_line,
        "commandId": command_id.unwrap_or(""));

    // 写码的那一头单独一个任务拿着 stdin：会话记录挂在同步锁里，不能在锁上 await。
    let mut stdin = stdin;
    tokio::spawn(async move {
        while let Some(code) = receiver.recv().await {
            if stdin.write_all(format!("{code}\n").as_bytes()).await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    for (pipe, name) in [
        (Box::new(stdout) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, "stdout"),
        (Box::new(stderr) as Box<dyn tokio::io::AsyncRead + Unpin + Send>, "stderr"),
    ] {
        let tool = tool.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            // 按行读，于是**读不到最后那半行**：claude 的「Paste code here if prompted > 」
            // 不带换行，一直卡在那儿等输入，lines() 在进程退出前永远不会把它交出来。
            //
            // 这不影响结果，因为界面要不要画输入框是按工具定的（needs_code），不是等
            // 这句提示；而授权地址在它上面一行，那一行是带换行的。真正会漏的只有
            // hints.waiting_code —— 它只是个补充信号，所以留着不管。
            while let Ok(Some(line)) = lines.next_line().await {
                absorb(&tool, session, &line);
            }
            let _ = name;
        });
    }

    let tool_owned = tool.to_string();
    tokio::spawn(async move {
        let outcome = tokio::select! {
            result = child.wait() => match result {
                Ok(code) if code.success() => Outcome::Succeeded,
                Ok(code) => Outcome::Exited(format!("登录进程退出：{code}")),
                Err(e) => Outcome::Exited(format!("等登录进程结束时出错：{e}")),
            },
            _ = cancel.notified() => {
                kill_tree(&mut child).await;
                Outcome::Stopped("这次登录被取消了".to_string())
            }
            _ = tokio::time::sleep(LOGIN_TIMEOUT) => {
                kill_tree(&mut child).await;
                Outcome::Stopped("登录超时了（15 分钟）：授权码有有效期，重新点一次登录".to_string())
            }
        };
        finish(&tool_owned, session, outcome);
    });

    Ok(status)
}

/// 把这次登录连它拉起的子孙进程一起杀掉。
///
/// **不能只 `child.kill()`**，这是实测踩到的：PATH 上的 `codex` 是一个 node 启动器，
/// 真正干活的是它再拉起来的那个原生可执行文件。杀掉启动器，原生那个会活下来继续轮询 ——
/// 于是主人的服务器上留下一个谁也看不见、还在替一次早就作废的登录敲上游的进程，
/// 而界面上这次登录明明已经显示结束了。
///
/// 所以起进程时就把它放进一个自己的进程组（process_group(0)），要收就收整组。
/// Windows 上没有对应的东西（得用 Job 对象），退回只杀直接子进程 —— 那边 `codex`
/// 是一个 .cmd 批处理，同样的问题还在，但那不是这条功能的目标平台（无头服务器）。
async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY：killpg 除了一个 pid 没有别的前提。进程组已经没了会返回 ESRCH，
        // 那正是我们想要的结果，忽略即可。
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
}

/// 吃进 CLI 的一行输出，把认出来的东西写进会话。
fn absorb(tool: &str, session: u64, line: &str) {
    update_session(tool, session, |record| {
        if record.finished.is_some() {
            return;
        }
        if record.buffer.len() < BUFFER_MAX {
            record.buffer.push_str(line);
            record.buffer.push('\n');
        }
        let hints = parse_login_output(&record.buffer);
        if let Some(url) = hints.verification_uri {
            record.status.verification_uri = url;
        }
        if let Some(code) = hints.user_code {
            record.status.user_code = code;
        }
        if let Some(error) = hints.error {
            // 码不对：进程还活着，主人可以再粘一次，所以回到等码而不是失败。
            record.status.detail = clip(&error);
            record.status.phase = PHASE_AUTHORIZE;
        }
        // 有地址可给了（或者明说在等码）才翻成 waiting：在那之前界面上没东西可显示。
        if record.status.state == STATE_RUNNING
            && (!record.status.verification_uri.is_empty() || hints.waiting_code)
        {
            record.status.state = STATE_WAITING;
            record.status.phase = PHASE_AUTHORIZE;
        }
    });
}

/// 这次登录是怎么结束的。
///
/// Exited 和 Stopped 必须分开，不然主人会看到一句驴唇不对马嘴的话：失败原因该显示
/// 谁说的，取决于**是谁叫停的**。
///   · Exited —— 进程自己退的，那 CLI 自己说过的原因比退出码有用（「Invalid code」那种）；
///   · Stopped —— 是我们杀的（取消、超时），CLI 最后那句话和这件事没有关系。实测过一次：
///     取消一个 codex 登录，界面上显示的是它输出里最后那句设备码安全提示，
///     而主人想知道的只是「这次被取消了」。
enum Outcome {
    Succeeded,
    Exited(String),
    Stopped(String),
}

fn finish(tool: &str, session: u64, outcome: Outcome) {
    update_session(tool, session, |record| {
        record.finished = Some(Instant::now());
        record.status.elapsed_ms = record.started.elapsed().as_millis() as u64;
        // 写码的口子关掉：进程都没了，再往里送只会石沉大海。
        record.codes = None;
        match &outcome {
            Outcome::Succeeded => {
                record.status.state = STATE_SUCCEEDED;
                record.status.phase = PHASE_DONE;
                record.status.detail = String::new();
            }
            Outcome::Exited(message) => {
                record.status.state = STATE_FAILED;
                record.status.phase = PHASE_FAILED;
                let said = last_meaningful(&record.buffer);
                record.status.detail = clip(if said.is_empty() { message } else { &said });
            }
            Outcome::Stopped(message) => {
                record.status.state = STATE_FAILED;
                record.status.phase = PHASE_FAILED;
                record.status.detail = clip(message);
            }
        }
    });
    match &outcome {
        Outcome::Succeeded => log_info!("pool_login_succeeded", "tool": tool),
        Outcome::Exited(message) | Outcome::Stopped(message) => {
            log_warn!("pool_login_failed", "tool": tool, "message": message)
        }
    }
}

/// 输出里最后一句有信息量的话。给失败时的 detail 用。
fn last_meaningful(buffer: &str) -> String {
    strip_ansi(buffer)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or_default()
        .to_string()
}
