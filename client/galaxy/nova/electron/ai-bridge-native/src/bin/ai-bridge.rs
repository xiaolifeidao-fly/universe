//! `ai-bridge` 命令行：把共享池节点独立部署在服务器上。
//!
//! Nova 客户端里的 bridge 和这里是**同一份** Rust 实现，差别只在入口：
//!
//! |          | Nova 客户端        | 命令行（这里）                        |
//! |----------|--------------------|---------------------------------------|
//! | 身份     | 一次性配对码       | 长期接入密钥（gpk-…）                 |
//! | 接入方式 | 只有 poll          | poll 或 export                        |
//! | 生命周期 | Electron 私有通道  | 前台进程 / systemd / launchd / 服务   |
//!
//! 所以这个文件里不实现任何共享池逻辑 —— 它只管参数、配置文件和进程信号。
//! 共享池的一切（hello、心跳、领活、回连、计量）都在 `ai_bridge_native::pool` 里，
//! 与 Nova 共用，两边不会各长出一套行为。

use ai_bridge_native::config::load_config;
use ai_bridge_native::config::schema::{AccessMode, AppConfig, Mode};
use ai_bridge_native::core::logger::{init_from_env, set_log_level, Level};
use ai_bridge_native::core::paths::{default_config_path, expand_home, Env};
use ai_bridge_native::credentials::CredentialRegistry;
use ai_bridge_native::pool::client::{AccessDeclaration, HubClient, RegisteredNode};
use ai_bridge_native::pool::export::normalize_public_url;
use ai_bridge_native::pool::probe::probe;
use ai_bridge_native::pool::runner::{create_pool_runner, resolve_access};
use ai_bridge_native::pool::setup::{origin_of, write_pool_access, PoolAccessPatch};
use ai_bridge_native::pool::token::{read_node_identity, resolve_node_token_file, write_node_identity, NodeIdentity};
use ai_bridge_native::{log_info, log_warn};
use serde_json::json;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
ai-bridge — 把这台机器的 Claude / Codex 订阅算力接入 Galaxy 共享池

用法：
  ai-bridge <命令> [参数]

命令：
  init        生成配置文件（已存在时不覆盖，加 --force 覆盖）
  register    用接入密钥把这台机器注册到平台
  run         启动并加入共享池（配置里有接入密钥时，每次启动先自动重新注册）
  status      查看配置、节点身份与本机探测到的能力
  version     打印版本
  help        打印这段说明

通用参数：
  -c, --config <路径>     配置文件（默认 $AI_BRIDGE_CONFIG，或 ~/.config/ai-bridge/config.yaml）

register 参数：
  --hub <地址>            平台地址（控制台「账户 → 接入密钥」里给出）
  --key <gpk-…>           接入密钥；也可以用环境变量 AI_BRIDGE_ACCESS_KEY
  --mode poll|export      接入方式，默认 poll
                            poll    主动向平台领活，不需要公网 IP
                            export  平台主动回连，需要公网地址和开放端口
  --public-url <地址>     export：平台回连这台机器用的地址，如 https://203.0.113.7:8788
  --host <地址>           export：监听地址，默认 0.0.0.0
  --port <端口>           export：监听端口，默认 8788
  --name <名字>           机器在控制台上的名字，默认主机名
  --no-save-key           不把接入密钥写进配置（run 时就不会自动重新注册）
  --fresh                 当作一台新机器注册，不沿用本机上一次的节点身份
                          （这台机器在控制台被解绑过、又确实要重新接入时用）

status 参数：
  --json                  以 JSON 输出

示例：
  ai-bridge register --hub https://hub.example.com --key gpk-XXXX
  ai-bridge register --hub https://hub.example.com --key gpk-XXXX \\
      --mode export --public-url https://203.0.113.7:8788
  ai-bridge run
";

/// `init` 铺下的配置模板。
///
/// 和 Nova 用的 config.example.yaml 刻意不是同一份：那份默认是本机 relay 模式、
/// 带着一整套给本机客户端用的鉴权说明；独立部署只加入共享池，那些段落在这里
/// 只会让人以为还有什么没配。
const TEMPLATE: &str = r#"# ai-bridge 独立部署配置。由 `ai-bridge init` / `ai-bridge register` 生成，可以手改。
# 支持 ${ENV_VAR} 占位符。改完重启 `ai-bridge run` 生效。

log:
  level: info                    # debug | info | warn | error

# 上游：这台机器上 Claude Code / Codex 的订阅登录态。
#
# 不写 baseURL 就跟随本机 CLI 正在用的上游 —— 本机接了中转站就打中转站，
# 没接就是订阅官方。机器上先 `claude auth login` / `codex login`。
# 没登录的那一项会在控制台上显示为「不可用」，不影响另一项。
providers:
  relay_claude:
    type: relay
    authMode: claude_oauth
    concurrency: 2
    queueMaxSize: 16
  relay_codex:
    type: relay
    authMode: codex_chatgpt
    concurrency: 6
    queueMaxSize: 64

# 独立部署只把算力贡献给共享池，不在本机开 relay 服务。
relay:
  enabled: false

admin:
  enabled: false

# 共享池接入（mode / pool 两段由 `ai-bridge register` 写入）：
#
# mode: pool
# pool:
#   hubURL: https://hub.example.com
#   accessKey: gpk-...             # 接入密钥：run 时用它自动重新注册
#   accessMode: poll               # poll：主动领活，不需要公网 IP
#                                  # export：平台主动回连，需要公网地址与开放端口
#   export:
#     host: 0.0.0.0
#     port: 8788
#     publicURL: https://box.example.com:8788
#     # secret 不填会自动生成，存在 ~/.local/state/ai-bridge/export-secret
"#;

#[derive(Debug, Default, PartialEq)]
struct Args {
    command: String,
    config: Option<PathBuf>,
    hub: Option<String>,
    key: Option<String>,
    mode: Option<String>,
    public_url: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    name: Option<String>,
    no_save_key: bool,
    force: bool,
    fresh: bool,
    json: bool,
    help: bool,
}

/// 不引参数解析库：命令一共五个，手写三十行比多一个依赖好审计 ——
/// 这个可执行文件要放在别人的服务器上长期跑，依赖树越短越好。
fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut args = Args::default();
    let mut iter = argv.iter();
    while let Some(raw) = iter.next() {
        // --flag=value 与 --flag value 两种写法都认。
        let (flag, inline) = match raw.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (raw.as_str(), None),
        };
        match flag {
            "-c" | "--config" => args.config = Some(expand_home(&take_value(flag, inline, &mut iter)?)),
            "--hub" => args.hub = Some(take_value(flag, inline, &mut iter)?),
            "--key" => args.key = Some(take_value(flag, inline, &mut iter)?),
            "--mode" => {
                let mode = take_value(flag, inline, &mut iter)?;
                if mode != "poll" && mode != "export" {
                    return Err(format!("--mode 只能是 poll 或 export，收到 {mode}"));
                }
                args.mode = Some(mode);
            }
            "--public-url" => args.public_url = Some(take_value(flag, inline, &mut iter)?),
            "--host" => args.host = Some(take_value(flag, inline, &mut iter)?),
            "--port" => {
                let raw = take_value(flag, inline, &mut iter)?;
                let port = raw.parse::<u16>().ok().filter(|port| *port > 0);
                args.port = Some(port.ok_or_else(|| format!("--port 不是合法端口：{raw}"))?);
            }
            "--name" => args.name = Some(take_value(flag, inline, &mut iter)?),
            "--no-save-key" => args.no_save_key = true,
            "--force" => args.force = true,
            "--fresh" => args.fresh = true,
            "--json" => args.json = true,
            "-h" | "--help" => args.help = true,
            "-V" | "--version" => args.command = "version".into(),
            other if other.starts_with('-') => {
                return Err(format!("不认识的参数：{other}（ai-bridge help 查看用法）"));
            }
            other => {
                if !args.command.is_empty() {
                    return Err(format!("多余的参数：{other}"));
                }
                args.command = other.to_string();
            }
        }
    }
    if args.help {
        args.command = "help".into();
    }
    Ok(args)
}

fn take_value(flag: &str, inline: Option<String>, iter: &mut std::slice::Iter<'_, String>) -> Result<String, String> {
    match inline {
        Some(value) => Ok(value),
        None => iter.next().cloned().ok_or_else(|| format!("{flag} 后面要跟一个值")),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("ai-bridge: {message}");
            return ExitCode::from(2);
        }
    };
    let env = Env::from_process();
    init_from_env(&env);
    let result = match args.command.as_str() {
        "" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        "version" => {
            println!("ai-bridge {VERSION}");
            Ok(())
        }
        "init" => init(&args, &env).await,
        "register" => register(&args, &env).await,
        "run" => run(&args, &env).await,
        "status" => status(&args, &env).await,
        other => Err(format!("不认识的命令：{other}（ai-bridge help 查看用法）")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("ai-bridge: {message}");
            ExitCode::FAILURE
        }
    }
}

fn config_path(args: &Args, env: &Env) -> PathBuf {
    args.config.clone().unwrap_or_else(|| default_config_path(env))
}

// ---------- init ----------

async fn init(args: &Args, env: &Env) -> Result<(), String> {
    let path = config_path(args, env);
    if path.exists() && !args.force {
        println!("配置文件已存在：{}（要覆盖加 --force）", path.display());
        return Ok(());
    }
    write_template(&path).await?;
    println!("已生成配置：{}", path.display());
    println!("下一步：ai-bridge register --hub <平台地址> --key <接入密钥>");
    Ok(())
}

async fn write_template(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("建目录 {} 失败：{e}", parent.display()))?;
    }
    tokio::fs::write(path, TEMPLATE)
        .await
        .map_err(|e| format!("写 {} 失败：{e}", path.display()))?;
    // 配置里会存接入密钥，和 ~/.codex/auth.json 这类本机凭据同一个权限。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

// ---------- register ----------

async fn register(args: &Args, env: &Env) -> Result<(), String> {
    let path = config_path(args, env);
    if !path.exists() {
        write_template(&path).await?;
        println!("已生成配置：{}", path.display());
    }
    let existing = load_config(Some(&path), env).ok();
    let existing_pool = existing.as_ref().and_then(|cfg| cfg.pool.clone());

    // 平台地址：参数 > 配置里已有的 > 交互输入。
    let hub = match args.hub.clone().or_else(|| existing_pool.as_ref().map(|p| p.hub_url.clone())) {
        Some(hub) => hub,
        None => prompt("平台地址（控制台「账户 → 接入密钥」里给出）")?,
    };
    let hub = validate_hub_url(&hub)?;
    let key = match args
        .key
        .clone()
        .or_else(|| env.trimmed("AI_BRIDGE_ACCESS_KEY").map(str::to_string))
        .or_else(|| existing_pool.as_ref().and_then(|p| p.access_key.clone()))
    {
        Some(key) => key.trim().to_string(),
        None => prompt("接入密钥（gpk- 开头）")?,
    };
    check_access_key(&key)?;

    // export 的公网地址在本机先校验一遍：Hub 那边也会校验，但在这里拦住，
    // 主人还站在机器前面就能看到错，而不是去控制台对着一台永远没活的机器发愣。
    let public_url = args.public_url.as_deref().map(normalize_public_url).transpose()?;
    let wants_export = args.mode.as_deref() == Some("export")
        || (args.mode.is_none() && existing_pool.as_ref().is_some_and(|p| p.access_mode == AccessMode::Export));
    let has_public_url = public_url.is_some()
        || existing_pool.as_ref().and_then(|p| p.export.as_ref()).and_then(|e| e.public_url.as_ref()).is_some();
    if wants_export && !has_public_url {
        return Err("export 接入需要 --public-url：平台要靠这个地址回连这台机器".into());
    }

    write_pool_access(&path, &PoolAccessPatch {
        hub_url: &hub,
        access_mode: args.mode.as_deref(),
        access_key: Some(&key),
        clear_access_key: args.no_save_key,
        public_url: public_url.as_deref(),
        host: args.host.as_deref(),
        port: args.port,
    })
    .await?;

    let cfg = load_config(Some(&path), env)?;
    let http = http_client()?;
    let registration = match register_node(&cfg, env, &key, &display_name(args), &http, args.fresh).await {
        Ok(registration) => registration,
        Err(message) => {
            let retry = if args.no_save_key {
                "修好之后重新执行 register"
            } else {
                "修好之后重新执行 register，或直接 ai-bridge run（启动时会自动重试注册）"
            };
            return Err(format!("注册失败：{message}\n配置已写入 {}，{retry}", path.display()));
        }
    };
    print_registration(&cfg, &registration);
    Ok(())
}

/// 一次注册的全部结果。
struct Registration {
    node: RegisteredNode,
    declared: AccessDeclaration,
    token_file: PathBuf,
}

/// 用接入密钥注册（或重新注册）这台机器，并把节点身份落盘。
///
/// 带上**上一次**注册拿到的 nodeId：Hub 会沿用同一条节点记录、只换一把令牌。
/// 一台一天重启几次的服务器，不能每次都在控制台上多出一台永远离线的机器。
/// 旧身份属于别的平台时不带 —— 那个 nodeId 在这个平台上没有意义。
async fn register_node(
    cfg: &AppConfig,
    env: &Env,
    key: &str,
    display_name: &str,
    http: &reqwest::Client,
    fresh: bool,
) -> Result<Registration, String> {
    let pool = cfg.pool.as_ref().ok_or("配置里缺少 pool 段")?;
    let declared = resolve_access(pool, pool.export.as_ref(), env).await;
    let token_file = resolve_node_token_file(Some(pool), env);
    let previous = read_node_identity(&token_file)
        .await
        .ok()
        .flatten()
        .filter(|identity| !fresh && origin_of(&identity.hub_url) == origin_of(&pool.hub_url));
    let client = HubClient::new(pool.hub_url.clone(), pool.contract, None, None, http.clone());
    let node = client
        .register(key, display_name, VERSION, &declared, previous.as_ref().map(|identity| identity.node_id.as_str()))
        .await
        .map_err(|e| e.message)?;
    write_node_identity(&token_file, &NodeIdentity {
        version: 1,
        node_id: node.node_id.clone(),
        token: node.token.clone(),
        // 和配置里的 hubURL 逐字一致：Nova 那边判断「这份身份属不属于当前平台」
        // 是逐字符比对的，两边写法差一个尾斜杠就会被判成未配对。
        hub_url: pool.hub_url.clone(),
        paired_at: now_iso(),
    })
    .await?;
    Ok(Registration { node, declared, token_file })
}

fn print_registration(cfg: &AppConfig, registration: &Registration) {
    let node = &registration.node;
    let hub = cfg.pool.as_ref().map(|p| p.hub_url.as_str()).unwrap_or("");
    println!("已注册：{}", node.node_id);
    println!("  平台地址  {hub}");
    let accepted = if node.access_mode.is_empty() { registration.declared.mode.as_str() } else { node.access_mode.as_str() };
    match (accepted, registration.declared.endpoint.as_ref()) {
        ("export", Some(endpoint)) => println!("  接入方式  export · 平台回连 {}", endpoint.url),
        _ => println!("  接入方式  poll · 主动向平台领活"),
    }
    if accepted != registration.declared.mode {
        println!("  注意      本机声明的是 {}，平台按 {accepted} 接入了这台机器", registration.declared.mode);
    }
    if !node.notice.is_empty() {
        println!("  注意      {}", node.notice);
    }
    println!("  节点身份  {}", registration.token_file.display());
    println!("下一步：ai-bridge run（长期运行请配成系统服务，见 README）");
    println!("然后到控制台「共享设置」里打开要共享的能力并给上额度 —— 默认什么都不共享。");
}

// ---------- run ----------

async fn run(args: &Args, env: &Env) -> Result<(), String> {
    let path = config_path(args, env);
    let cfg = load_config(Some(&path), env)?;
    let Some(pool) = cfg.pool.clone().filter(|_| cfg.mode == Mode::Pool) else {
        return Err(format!("{} 还没有加入共享池：先运行 ai-bridge register", path.display()));
    };
    if let Some(level) = Level::parse(&cfg.log.level) {
        set_log_level(level);
    }
    let http = http_client()?;

    // 有接入密钥就每次启动先注册一次。
    //
    // 这就是「无人值守」的全部含义：令牌被撤、平台库重建过、公网地址换了，
    // 机器重启一次就自己回来了，不需要任何人去控制台上点什么。注册失败不致命 ——
    // 平台暂时连不上时，本机已有的身份照样能用，runner 自己会重试 hello。
    let key = env
        .trimmed("AI_BRIDGE_ACCESS_KEY")
        .map(str::to_string)
        .or_else(|| pool.access_key.clone())
        .filter(|key| !key.trim().is_empty());
    let token_file = resolve_node_token_file(Some(&pool), env);
    if let Some(key) = key {
        // 自动注册永远不带 --fresh：主人在控制台解绑过的机器，不该被一次重启悄悄接回来。
        match register_node(&cfg, env, key.trim(), &display_name(args), &http, false).await {
            Ok(registration) => {
                log_info!("cli_registered", "nodeId": registration.node.node_id,
                    "accessMode": registration.node.access_mode, "notice": registration.node.notice);
            }
            Err(message) => {
                if read_node_identity(&token_file).await.ok().flatten().is_none() {
                    return Err(format!("注册失败，而且本机没有可用的节点身份：{message}"));
                }
                log_warn!("cli_register_failed", "message": message,
                    "hint": "沿用本机已有的节点身份继续启动");
            }
        }
    } else if read_node_identity(&token_file).await.ok().flatten().is_none() {
        return Err("本机还没有注册：运行 ai-bridge register --hub <平台地址> --key <接入密钥>".into());
    }

    let runner = Arc::new(create_pool_runner(cfg, env.clone(), VERSION.into(), http).await?);
    let mut starting = {
        let runner = Arc::clone(&runner);
        tokio::spawn(async move { runner.start().await })
    };
    let mut started = false;
    loop {
        tokio::select! {
            () = shutdown_signal() => break,
            joined = &mut starting, if !started => {
                started = true;
                let failure = match joined {
                    Ok(Ok(())) => None,
                    Ok(Err(message)) => Some(message),
                    Err(e) => Some(format!("启动任务异常退出：{e}")),
                };
                if let Some(message) = failure {
                    runner.stop().await;
                    return Err(message);
                }
            }
        }
    }
    // 停机要走完整的 stop：它会把在跑的单元报给平台，平台立刻改派，
    // 消费者那边无感。直接退出进程的话，他们要干等一个超时。
    runner.stop().await;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

// ---------- status ----------

async fn status(args: &Args, env: &Env) -> Result<(), String> {
    let path = config_path(args, env);
    let cfg = load_config(Some(&path), env)?;
    let pool = cfg.pool.as_ref().filter(|_| cfg.mode == Mode::Pool);
    let token_file = resolve_node_token_file(pool, env);
    let identity = read_node_identity(&token_file)
        .await
        .ok()
        .flatten()
        .filter(|identity| pool.is_some_and(|p| origin_of(&p.hub_url) == origin_of(&identity.hub_url)));
    let credentials = CredentialRegistry::new(http_client()?);
    let probed = probe(&cfg, &credentials, env).await;
    let export = pool.and_then(|p| p.export.clone()).unwrap_or_default();
    // 接入密钥只报「存没存」，永远不打印内容 —— status 的输出经常被贴进工单里。
    let key_saved = pool.and_then(|p| p.access_key.as_ref()).is_some();

    if args.json {
        let out = json!({
            "configPath": path.to_string_lossy(),
            "version": VERSION,
            "joined": pool.is_some(),
            "hubURL": pool.map(|p| p.hub_url.clone()),
            "accessMode": pool.map(|p| p.access_mode.label()),
            "export": pool.filter(|p| p.access_mode == AccessMode::Export).map(|_| json!({
                "publicURL": export.public_url, "host": export.host, "port": export.port,
            })),
            "registered": identity.is_some(),
            "nodeId": identity.as_ref().map(|i| i.node_id.clone()),
            "accessKeySaved": key_saved,
            "capabilities": probed.capabilities,
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return Ok(());
    }

    println!("配置文件    {}", path.display());
    println!("版本        {VERSION}");
    let Some(pool) = pool else {
        println!("共享池      未加入（运行 ai-bridge register）");
        return Ok(());
    };
    println!("平台地址    {}", pool.hub_url);
    if pool.access_mode == AccessMode::Export {
        println!("接入方式    export · 平台回连 {} · 本机监听 {}:{}",
            export.public_url.as_deref().unwrap_or("（未填 publicURL，启动时会回落成 poll）"),
            export.host, export.port);
    } else {
        println!("接入方式    poll · 主动向平台领活");
    }
    match &identity {
        Some(identity) => println!("节点        {}（已注册）", identity.node_id),
        None => println!("节点        未注册"),
    }
    println!("接入密钥    {}", if key_saved { "已保存（run 时自动重新注册）" } else { "未保存" });
    println!("本机能力");
    if probed.capabilities.is_empty() {
        println!("  （没有探测到任何能力：配置的 providers 里一项都没有）");
    }
    for capability in &probed.capabilities {
        let name = capability.upstream.clone().unwrap_or_default();
        let state = if capability.available { "可用  " } else { "不可用" };
        println!("  {name:<14} {:<14} {state}  {}", capability.provider, capability.detail);
    }
    Ok(())
}

// ---------- 小工具 ----------

/// 在发请求之前认出「拿错了的东西」，并说清楚那到底是什么。
///
/// 只说「应当以 gpk- 开头」不够：控制台列表里显示的 ID 是 `gpk_` 开头，和密钥本身
/// 只差一个字符，照着界面复制最容易拿到的就是它 —— 这件事真的发生过。算力密钥、
/// 配对码、节点令牌也都长得像一串密钥，拿错了各自该怎么办不一样。
fn check_access_key(key: &str) -> Result<(), String> {
    let rest = key.strip_prefix("gpk-").unwrap_or("");
    if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\'') {
        return Ok(());
    }
    let reason = if key.starts_with("gpk_") {
        "这是接入密钥的 ID（控制台列表里 gpk_ 开头的那串），只用来辨认是哪一把，不是密钥本身。\
         密钥以 gpk- 开头，只在签发时显示一次；没存下来就重新签发一把"
    } else if key.starts_with("sk-galaxy-") {
        "这是使用算力的消费者密钥（sk-galaxy-），不是接入密钥"
    } else if key.starts_with("gnt_") {
        "这是节点令牌（gnt_），它是注册之后平台发给机器的，不能拿来注册"
    } else if is_pairing_code(key) {
        "这是 Nova 客户端用的一次性配对码，命令行注册要用接入密钥"
    } else if key.starts_with(['"', '\'']) || key.ends_with(['"', '\'']) {
        "密钥两边带了引号，去掉引号再试"
    } else if !key.is_ascii() || key.contains(char::is_whitespace) {
        "密钥里混进了看不见的字符（多半是从网页复制时带上的），重新复制一次"
    } else {
        "接入密钥应当以 gpk- 开头"
    };
    Err(format!("{reason}。接入密钥在控制台「账户 → 接入密钥」签发，签发弹窗里的注册命令已经填好了密钥"))
}

/// 配对码形如 8F3K-2Q9M（见 service/galaxy 的 pairingCode）。
fn is_pairing_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 9 && bytes[4] == b'-' && bytes.iter().enumerate().all(|(i, b)| i == 4 || b.is_ascii_alphanumeric())
}

fn validate_hub_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| format!("平台地址不是合法 URL：{trimmed}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("平台地址必须是 http(s) 地址，且不能带用户名密码".into());
    }
    Ok(trimmed.to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().build().map_err(|e| format!("建 HTTP 客户端失败：{e}"))
}

fn display_name(args: &Args) -> String {
    args.name
        .clone()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(sysinfo::System::host_name)
        .unwrap_or_else(|| "ai-bridge".into())
}

/// 交互式地问一个值。非交互环境（systemd、CI）里直接报错而不是挂住 ——
/// 一个在后台等 stdin 的服务进程，看起来和「启动卡死」一模一样。
fn prompt(label: &str) -> Result<String, String> {
    if !std::io::stdin().is_terminal() {
        return Err(format!("缺少{label}：非交互环境请用参数或环境变量传入"));
    }
    print!("{label}：");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).map_err(|e| e.to_string())?;
    let value = line.trim().to_string();
    if value.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    Ok(value)
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn flags_take_values_both_as_separate_words_and_after_an_equals_sign() {
        let args = parse_args(&argv(&[
            "register", "--hub", "https://hub.example.com", "--key=gpk-ABC", "--mode", "export", "--port=9000",
        ]))
        .unwrap();
        assert_eq!(args.command, "register");
        assert_eq!(args.hub.as_deref(), Some("https://hub.example.com"));
        assert_eq!(args.key.as_deref(), Some("gpk-ABC"));
        assert_eq!(args.mode.as_deref(), Some("export"));
        assert_eq!(args.port, Some(9000));
    }

    /// 服务器上的命令行参数常常是从文档里复制来的，拼错一个字母不能被悄悄忽略 ——
    /// 那样主人会以为 export 开了，而机器其实在长轮询。
    #[test]
    fn unknown_flags_bad_modes_and_missing_values_are_reported_instead_of_ignored() {
        assert!(parse_args(&argv(&["run", "--verbose"])).unwrap_err().contains("--verbose"));
        assert!(parse_args(&argv(&["register", "--mode", "push"])).unwrap_err().contains("poll 或 export"));
        assert!(parse_args(&argv(&["register", "--hub"])).unwrap_err().contains("--hub"));
        assert!(parse_args(&argv(&["register", "--port", "http"])).unwrap_err().contains("--port"));
        assert!(parse_args(&argv(&["register", "--port", "0"])).unwrap_err().contains("--port"));
    }

    #[test]
    fn help_wins_over_any_command() {
        assert_eq!(parse_args(&argv(&["run", "--help"])).unwrap().command, "help");
    }

    /// 拿错东西时要说清楚拿的是什么 —— 尤其是控制台列表里那个和密钥只差一个字符的 ID。
    #[test]
    fn wrong_kinds_of_keys_are_named_instead_of_just_rejected() {
        assert!(check_access_key("gpk-7Q2K9M4XH3B8N6RTWZ5CJ1VD").is_ok());
        let cases = [
            ("gpk_06G8WEQ9CF8YEGCGV97EE67T50", "ID"),
            ("sk-galaxy-abcdef", "消费者密钥"),
            ("gnt_ABCDEF", "节点令牌"),
            ("8F3K-2Q9M", "配对码"),
            ("\"gpk-ABC\"", "引号"),
            ("gpk-AB\u{200b}C", "看不见的字符"),
            ("gpk-", "gpk- 开头"),
            ("hello", "gpk- 开头"),
        ];
        for (key, hint) in cases {
            let message = check_access_key(key).unwrap_err();
            assert!(message.contains(hint), "{key} → {message}");
        }
    }

    /// 模板本身合法，register 写回之后仍然合法，而且没给的参数不会抹掉已有配置。
    #[tokio::test]
    async fn the_template_round_trips_through_registration_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let env = Env::default();
        write_template(&path).await.unwrap();
        load_config(Some(&path), &env).expect("模板本身必须是合法配置");

        write_pool_access(&path, &PoolAccessPatch {
            hub_url: "https://hub.example.com",
            access_mode: Some("export"),
            access_key: Some("gpk-TEST"),
            public_url: Some("https://box.example.com:8788"),
            port: Some(9000),
            ..Default::default()
        })
        .await
        .unwrap();
        let cfg = load_config(Some(&path), &env).expect("写回之后仍然合法");
        assert_eq!(cfg.mode, Mode::Pool);
        let pool = cfg.pool.unwrap();
        assert_eq!(pool.access_mode, AccessMode::Export);
        assert_eq!(pool.access_key.as_deref(), Some("gpk-TEST"));
        let export = pool.export.unwrap();
        assert_eq!(export.public_url.as_deref(), Some("https://box.example.com:8788"));
        assert_eq!(export.port, 9000);
        assert_eq!(export.host, "0.0.0.0", "没给的字段走默认值");
        assert!(std::fs::read_to_string(&path).unwrap().contains("# 上游"), "注释不能在写回里丢掉");

        // 第二次注册没带 --public-url：不该把已有的公网地址抹掉。
        write_pool_access(&path, &PoolAccessPatch { hub_url: "https://hub.example.com", ..Default::default() })
            .await
            .unwrap();
        let pool = load_config(Some(&path), &env).unwrap().pool.unwrap();
        assert_eq!(pool.access_mode, AccessMode::Export);
        assert_eq!(pool.export.unwrap().public_url.as_deref(), Some("https://box.example.com:8788"));

        // --no-save-key 要说到做到：连上一次存的那把也删掉。
        write_pool_access(&path, &PoolAccessPatch {
            hub_url: "https://hub.example.com",
            clear_access_key: true,
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(load_config(Some(&path), &env).unwrap().pool.unwrap().access_key.is_none());
    }
}
