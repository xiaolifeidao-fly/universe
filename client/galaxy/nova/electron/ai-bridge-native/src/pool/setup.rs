use serde_json::{json, Value};
use std::path::Path;

/// authMode → 拉起登录的命令。
///
/// **只认这张表。** 调用方只能传上游的名字，命令由本机配置里那个上游自己的
/// authMode 决定 —— 否则这就是个「让任意调用方在你机器上跑任意命令」的接口。
/// api_key 不在表里：那种上游的凭据是写在配置里的，没有可拉起的登录流程。
pub fn login_command(auth_mode: &str) -> Option<&'static [&'static str]> {
    match auth_mode {
        "claude_oauth" => Some(&["claude", "auth", "login"]),
        "codex_chatgpt" => Some(&["codex", "login"]),
        _ => None,
    }
}

/// 把 argv 拼成一条能直接敲的命令。
///
/// argv[0] 换成 PATH 上找到的绝对路径：本机没装 Node 的人，claude 是 Nova 用自带
/// npm 装进 userData 下的 prefix 的（见 electron/src/modules/toolchain），那个目录
/// 不在用户自己终端的 PATH 上 —— 写成 `claude auth login` 递给 Terminal 只会是
/// command not found。找不到就原样留着名字，让控制台照常显示。
///
/// 路径可能带空格（`~/Library/Application Support/...`），所以要按 shell 的规矩引起来。
pub fn login_command_line(argv: &[&str]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(argv.len());
    for (index, item) in argv.iter().enumerate() {
        let resolved = if index == 0 {
            super::tools::resolve_program(item)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| (*item).to_string())
        } else {
            (*item).to_string()
        };
        parts.push(shell_quote(&resolved));
    }
    parts.join(" ")
}

/// POSIX 的单引号引法：里面的单引号要断开再拼回去。
pub fn shell_quote(value: &str) -> String {
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./:=@".contains(&b)) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 在一个真终端窗口里跑命令，给交互式登录用。
///
/// 只做 macOS：Linux 的终端模拟器五花八门，挨个试一遍还经常猜错，不如老实返回
/// false，让控制台把命令显示出来让人自己敲 —— 那条路在所有平台上都是通的。
///
/// 命令由 login_command 那张固定表加上本机解析出来的路径拼成，不含调用方输入；
/// 传进来之前已经按 shell 的规矩引好（login_command_line），这里再整条 JSON 引一次
/// 给 AppleScript。哪天要接受外部参数，这两层引用都要重新审一遍。
pub fn open_terminal(command: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let quoted = serde_json::to_string(command).unwrap_or_else(|_| "\"\"".into());
    super::tools::spawn_detached(
        "/usr/bin/osascript",
        &[
            "-e", &format!("tell application \"Terminal\" to do script {quoted}"),
            "-e", "tell application \"Terminal\" to activate",
        ],
    )
    .is_ok()
}

/// 只取协议+主机+端口。Hub 地址可能带路径（自建部署挂在子路径下），
/// 比对必须按源来，否则同一个 Hub 写法差一个尾斜杠就配不上。
pub fn origin_of(value: &str) -> String {
    reqwest::Url::parse(value.trim())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default()
}

/// 校准平台地址时要不要真的改写配置。
///
/// 两条规则，都是踩出来的：
///   · **origin 一致就不动**。node-token 里存的 hubURL 和配置是逐字符比对的
///     （napi_api 的 identity()），为了一个末尾斜杠重写配置，会把一台正连着的
///     机器直接判成未配对。
///   · **没绑过平台的也不动**。write_pool_connection 会顺手把 mode 切成 pool，
///     而一台没配对过的机器切进 pool 模式只会起不来；那种机器的地址由配对流程写。
pub fn hub_needs_rebind(current: &str, target: &str) -> bool {
    !current.trim().is_empty() && origin_of(current) != origin_of(target)
}

/// 把顶层的 `<key>:` 整块换成 replacement；原来没有就追加到末尾。
///
/// 一个顶层块从 `^<key>:` 开始，到下一个**行首非空白**的行为止 —— 中间的缩进行
/// 和空行都属于它。紧贴在块前面的注释属于这个块，一并替换掉，
/// 否则会留下一段描述已经不存在的字段的说明。
pub fn replace_top_level(text: &str, key: &str, replacement: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let prefix = format!("{key}:");
    let Some(start) = lines.iter().position(|line| line.starts_with(&prefix)) else {
        let separator = if text.ends_with('\n') { "" } else { "\n" };
        return format!("{text}{separator}\n{replacement}");
    };
    let mut end = start + 1;
    while end < lines.len() && (lines[end].is_empty() || lines[end].starts_with([' ', '\t'])) {
        end += 1;
    }
    // 块尾往回收：末尾的空行留给下一段，不然每写一次就多吞一个空行。
    while end > start + 1 && lines[end - 1].is_empty() {
        end -= 1;
    }
    // 块头往前收：紧贴着的注释是这一段的说明。
    let mut head = start;
    while head > 0 && lines[head - 1].trim_start().starts_with('#') {
        head -= 1;
    }

    let body = replacement.strip_suffix('\n').unwrap_or(replacement);
    let mut out: Vec<&str> = lines[..head].to_vec();
    out.extend(body.split('\n'));
    out.extend_from_slice(&lines[end..]);
    out.join("\n")
}

/// 只改 mode 和 pool 两个顶层块，其余原样保留。
///
/// 不用「读成对象再整份 dump」：那样注释会在一次 round-trip 里全没了，
/// 用户第一次配置就把说明书弄丢，不是可接受的代价。
pub async fn write_pool_connection(config_path: &Path, hub_url: &str) -> Result<String, String> {
    write_pool_access(config_path, &PoolAccessPatch { hub_url, ..Default::default() }).await
}

/// 要写回配置的接入信息。None 表示「这一项不动」。
///
/// 这条规矩是给命令行定的：`ai-bridge register` 没带 --public-url，
/// 不该把配置文件里早就写好的公网地址抹成空 —— 那台机器会在下一次重启时
/// 悄悄退回长轮询，而主人什么都没改。
#[derive(Debug, Default)]
pub struct PoolAccessPatch<'a> {
    pub hub_url: &'a str,
    pub access_mode: Option<&'a str>,
    pub access_key: Option<&'a str>,
    /// 把配置里的接入密钥删掉。`--no-save-key` 用它：「不保存」要说到做到，
    /// 留着上一次存的那把会让人以为密钥不在这台机器上。
    pub clear_access_key: bool,
    pub public_url: Option<&'a str>,
    pub host: Option<&'a str>,
    pub port: Option<u16>,
}

/// 把接入信息写回配置：只改 mode 与 pool 两个顶层块，其余原样保留。
pub async fn write_pool_access(config_path: &Path, patch: &PoolAccessPatch<'_>) -> Result<String, String> {
    let original = tokio::fs::read_to_string(config_path)
        .await
        .map_err(|e| format!("读不到配置文件 {}：{e}", config_path.display()))?;
    let previous: Value = serde_yaml::from_str(&original).unwrap_or(Value::Null);
    // 保留 pool 段里的其它字段（heartbeatSec、tokenFile、contract 这些）。
    let mut pool = previous
        .get("pool")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    pool["hubURL"] = json!(patch.hub_url);
    if let Some(mode) = patch.access_mode {
        pool["accessMode"] = json!(mode);
    }
    if patch.clear_access_key {
        if let Some(map) = pool.as_object_mut() {
            map.remove("accessKey");
        }
    } else if let Some(key) = patch.access_key {
        pool["accessKey"] = json!(key);
    }
    if patch.public_url.is_some() || patch.host.is_some() || patch.port.is_some() {
        let mut export = pool
            .get("export")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(url) = patch.public_url {
            export["publicURL"] = json!(url);
        }
        if let Some(host) = patch.host {
            export["host"] = json!(host);
        }
        if let Some(port) = patch.port {
            export["port"] = json!(port);
        }
        pool["export"] = export;
    }

    let dumped = serde_yaml::to_string(&json!({ "pool": pool }))
        .map_err(|e| format!("生成 pool 配置失败：{e}"))?;
    let text = replace_top_level(&original, "mode", "mode: pool\n");
    let text = replace_top_level(&text, "pool", &dumped);

    let backup = format!("{}.bak", config_path.display());
    write_private(Path::new(&backup), original.as_bytes()).await?;
    let tmp = config_path.with_extension(format!("{}.tmp", std::process::id()));
    write_private(&tmp, text.as_bytes()).await?;
    tokio::fs::rename(&tmp, config_path).await.map_err(|e| e.to_string())?;
    Ok(backup)
}

async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    tokio::fs::write(path, bytes).await.map_err(|e| format!("写 {} 失败：{e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}
