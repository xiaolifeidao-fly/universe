use super::client::describe_transport;
use crate::{log_error, log_warn};
use async_trait::async_trait;
use base64::Engine;
use futures_util::StreamExt;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

// 远程升级：节点自己把正在跑的可执行文件换成新版本（跨端契约第 1–3 节）。
//
// 信任只落在一处：编进二进制的发布公钥（release-keys.txt）。Hub 下发的下载地址、
// sha256、大小都只是线索 —— 签名覆盖 version + platform + sha256，下载完再拿自己算的
// sha256 去比。平台被人拿下时，对方能改的只是「让节点去下什么」，改不了「节点肯装什么」。
//
// 这个文件只管「换文件」。什么时候换（等不等在跑的单元）、换完怎么重启（exec 还是
// 起新进程再退出），分别是 runner 和进程主人（src/bin/ai-bridge.rs）的事。

/// 契约第 1 节的平台名，与 scripts/build-cli.cjs 的 TARGETS 一一对应。
pub const PLATFORMS: [&str; 6] =
    ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64", "windows-arm64"];

/// 安装包大小上限。正常的包 3 MB 上下，这个数只防一个错误的地址把磁盘写满。
pub const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;

/// 上报 message 与 upgradeBlocker 的长度上限（契约 3.3：≤ 255 字符）。
pub const MESSAGE_MAX_CHARS: usize = 255;

const RELEASE_KEYS: &str = include_str!("../../release-keys.txt");

/// 升级临时目录的名字前缀。建在可执行文件旁边，见 SelfUpdater::prepare。
const STAGING_PREFIX: &str = ".ai-bridge-upgrade-";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// 下载是按「多久没收到数据」算超时，不是按总时长：慢线路上 3 MB 走两分钟也是正常的，
/// 真正该放弃的是一个挂住不动的连接。
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const UNPACK_TIMEOUT: Duration = Duration::from_secs(120);
const TRIAL_TIMEOUT: Duration = Duration::from_secs(20);

const NO_RELEASE_KEYS: &str =
    "这份 ai-bridge 构建时没有内置发布公钥，校验不了安装包的来源，不能远程升级：换成正式发布的安装包重新装一次";

// ---------- 平台 ----------

/// Rust 的 target_os / target_arch → 平台名。认不出来就是 None ——
/// 猜一个相近的平台去下包，结果只会是在试跑那一步失败，还白下载一次。
pub fn platform_name(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("windows-x64"),
        ("windows", "aarch64") => Some("windows-arm64"),
        _ => None,
    }
}

/// 这份可执行文件是给哪个平台编的。
///
/// `std::env::consts` 就是编译期的 cfg(target_os / target_arch)，不是运行时探测：
/// 升级要换的正是「这份二进制」，该看它是给谁编的 —— Rosetta 下跑的 x64 包，
/// 升级也还得是 x64 包。
pub fn current_platform() -> Option<&'static str> {
    platform_name(std::env::consts::OS, std::env::consts::ARCH)
}

/// 发布包的文件名（契约第 1 节）。Windows 是 zip，其余 tar.gz —— 各自平台上不装任何东西就能解开。
pub fn package_file_name(version: &str, platform: &str) -> String {
    let extension = if platform.starts_with("windows-") { "zip" } else { "tar.gz" };
    format!("ai-bridge-{version}-{platform}.{extension}")
}

pub fn executable_name(platform: &str) -> &'static str {
    if platform.starts_with("windows-") { "ai-bridge.exe" } else { "ai-bridge" }
}

/// 换下来的旧版本放在哪：`<可执行文件>.old`。
pub fn backup_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(".old");
    exe.with_file_name(name)
}

fn unknown_platform() -> String {
    format!("认不出这台机器的平台（{}/{}），没有对应的安装包", std::env::consts::OS, std::env::consts::ARCH)
}

// ---------- 版本号 ----------

/// 版本号：`主.次.补丁`，可选 `-预发布`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

impl Version {
    /// 只认 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`。前缀 v、首尾空白、`+build` 一概不认：
    /// Hub 和管理后台按同一条正则校验，这边一宽松，两边对「是不是同一个版本」就会有分歧 ——
    /// 节点觉得「已经是了」报 succeeded，Hub 却永远等不到那个版本号的 hello。
    pub fn parse(raw: &str) -> Option<Self> {
        let (core, pre) = match raw.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (raw, None),
        };
        if let Some(pre) = pre {
            if pre.is_empty() || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
                return None;
            }
        }
        let parts: Vec<&str> = core.split('.').collect();
        let [major, minor, patch] = parts.as_slice() else { return None };
        let number = |part: &str| -> Option<u64> {
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        };
        Some(Self { major: number(major)?, minor: number(minor)?, patch: number(patch)?, pre: pre.map(str::to_string) })
    }
}

impl Ord for Version {
    /// 先比三段数字；数字相同时没有预发布后缀的更大（1.0.0 > 1.0.0-beta）；
    /// 两个都有后缀按字符串比。规则是跨端契约第 1 节定的，Hub 判断「有没有新版本」用的也是它，
    /// 这边自己改了，控制台说有新版、节点却说不升（或者反过来）。
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 任何一边不合法就是 None —— 比不出来的时候不该假装知道谁新。
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    Some(Version::parse(a)?.cmp(&Version::parse(b)?))
}

// ---------- 发布签名 ----------

/// 解析发布公钥文件：一行一把 base64 公钥，`#` 之后是注释，空行忽略。
///
/// 坏一行就整份报错，而不是跳过：跳过意味着主人以为加进去了的那把钥匙其实没生效，
/// 等到发版那天才发现所有机器都验不过新包。
pub fn parse_release_keys(text: &str) -> Result<Vec<[u8; 32]>, String> {
    let mut keys: Vec<[u8; 32]> = vec![];
    for (index, line) in text.lines().enumerate() {
        let content = line.split('#').next().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|_| format!("release-keys.txt 第 {} 行不是合法的 base64", index + 1))?;
        let key: [u8; 32] = decoded.try_into().map_err(|bytes: Vec<u8>| {
            format!("release-keys.txt 第 {} 行解出来是 {} 字节，Ed25519 公钥应当是 32 字节", index + 1, bytes.len())
        })?;
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    Ok(keys)
}

/// 编进这份二进制的发布公钥。
pub fn release_keys() -> Result<Vec<[u8; 32]>, String> {
    parse_release_keys(RELEASE_KEYS)
}

/// 被签名的字节（契约第 2 节）。
///
/// 逐字节一致、末尾有换行：签名工具（scripts/release-sign.cjs）和管理后台（Go）
/// 拼的是同一串，差一个换行就全部验不过。
pub fn signed_message(version: &str, platform: &str, sha256: &str) -> String {
    format!("ai-bridge-release:v1\n{version}\n{platform}\n{sha256}\n")
}

/// 用内置公钥校验一个发布包的签名。任何一把公钥验得过就算数（换钥匙期间新旧两把并存）。
///
/// 输入先查形状再验签：签名本身挡得住伪造，但「sha256 写成了大写」这类问题
/// 验签只会说「不通过」，主人拿着这句话查不到是哪一侧拼错了。
pub fn verify_release(
    keys: &[[u8; 32]],
    version: &str,
    platform: &str,
    sha256: &str,
    signature: &str,
) -> Result<(), String> {
    if keys.is_empty() {
        return Err(NO_RELEASE_KEYS.into());
    }
    if Version::parse(version).is_none() {
        return Err(format!("版本号不合法：{version}"));
    }
    if !PLATFORMS.contains(&platform) {
        return Err(format!("不认识的平台名：{platform}"));
    }
    if !is_sha256_hex(sha256) {
        return Err("sha256 应当是 64 位小写十六进制".into());
    }
    let signature = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .ok()
        .filter(|bytes| bytes.len() == 64)
        .ok_or("发布签名格式不对：应当是 88 个字符的 base64（64 字节 Ed25519 签名）")?;
    let message = signed_message(version, platform, sha256);
    let trusted = keys
        .iter()
        .any(|key| UnparsedPublicKey::new(&ED25519, key).verify(message.as_bytes(), &signature).is_ok());
    if !trusted {
        return Err(format!(
            "发布签名校验不通过：{version} / {platform} 这个包不是用内置公钥对应的私钥签发的，拒绝安装"
        ));
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 契约 3.3：message ≤ 255 字符。按字符数算不按字节 —— 中文一个字就是一个字符。
pub fn truncate_message(message: &str) -> String {
    if message.chars().count() <= MESSAGE_MAX_CHARS {
        return message.to_string();
    }
    let mut out: String = message.chars().take(MESSAGE_MAX_CHARS - 1).collect();
    out.push('…');
    out
}

// ---------- 契约里的两个形状 ----------

/// Hub 在心跳响应里下发的升级指令（契约 3.2）。
///
/// 字段全部带默认值：缺了哪个由 runner 判定并报 failed，而不是让整份心跳响应解析失败 ——
/// 那样连带着取消清单和生效配置一起丢掉。
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpgradeCommand {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub platform: String,
    /// 下载地址。OSS 签名地址，查询串里带着访问凭据：日志和错误信息里一律不出现。
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub sha256: String,
    /// 字节数；0 表示不知道，不校验。
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub signature: String,
}

impl std::fmt::Debug for UpgradeCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 调试输出里地址只留到路径为止：查询串是 OSS 的访问凭据。
        let url = reqwest::Url::parse(&self.url)
            .map(|mut url| {
                url.set_query(None);
                url.to_string()
            })
            .unwrap_or_default();
        f.debug_struct("UpgradeCommand")
            .field("id", &self.id)
            .field("version", &self.version)
            .field("platform", &self.platform)
            .field("url", &url)
            .field("sha256", &self.sha256)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

/// `POST /agent/v1/upgrade/report` 的 state（契约 3.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradeState {
    Downloading,
    Installing,
    Restarting,
    Failed,
    /// 只在「本机已经是目标版本」时由节点报。正常升级的成功由 Hub 在重启后的 hello 里判定。
    Succeeded,
}

impl UpgradeState {
    pub fn label(self) -> &'static str {
        match self {
            UpgradeState::Downloading => "downloading",
            UpgradeState::Installing => "installing",
            UpgradeState::Restarting => "restarting",
            UpgradeState::Failed => "failed",
            UpgradeState::Succeeded => "succeeded",
        }
    }
}

// ---------- 换文件 ----------

/// 下载、校验、解包、试跑都通过了的新版本，还没碰正在用的可执行文件。
///
/// 掉落时连同临时目录一起删掉：安装完、安装失败、升级被中止，走的都是这一条。
pub struct PreparedUpgrade {
    pub version: String,
    /// 解出来并试跑过的新可执行文件。
    pub executable: PathBuf,
    /// 只为了它的 Drop 而持有：临时目录的寿命跟着这个值走。
    _staging: Option<StagingDir>,
}

impl PreparedUpgrade {
    /// 给别的 Updater 实现（以及测试里的假实现）用：没有要清理的临时目录。
    pub fn new(version: impl Into<String>, executable: impl Into<PathBuf>) -> Self {
        Self { version: version.into(), executable: executable.into(), _staging: None }
    }
}

/// runner 眼里的「升级器」。抽成 trait 是为了把「什么时候升、怎么上报、升完怎么排空」
/// 和「怎么换文件」拆开测：前者用假实现在 tests/pool_upgrade.rs 里跑，后者在本文件的测试里
/// 对着真的压缩包和真的 tar 跑。
///
/// 这里刻意**没有**重启：exec / 退出是进程主人的事（它还得先把 runner 停干净），
/// runner 只负责说一声「装好了，可以重启了」。
#[async_trait]
pub trait Updater: Send + Sync {
    /// 此刻为什么不能远程升级（人话，控制台原样显示）；None = 可以。每次 hello 都问一遍 ——
    /// 主人把目录权限改对之后，重新 hello 一次按钮就该亮。
    fn blocker(&self) -> Option<String>;

    /// 验发布签名。不碰网络：签名不对的包，连下载都不该开始。
    fn verify(&self, command: &UpgradeCommand) -> Result<(), String>;

    /// 下载 → 比 sha256 → 解包 → 试跑。任何一步失败都不碰正在用的可执行文件。
    async fn prepare(&self, command: &UpgradeCommand) -> Result<PreparedUpgrade, String>;

    /// 原子替换正在用的可执行文件，返回装到了哪里。旧文件留 `.old`。
    async fn install(&self, prepared: PreparedUpgrade) -> Result<PathBuf, String>;
}

/// 真正的升级器：绑在一个明确的可执行文件路径上。
pub struct SelfUpdater {
    /// 要换掉的那个文件。拿不到路径时存原因，由 blocker 报出去，而不是让进程起不来 ——
    /// 升级是锦上添花，不该拖累本职工作。
    exe: Result<PathBuf, String>,
    http: reqwest::Client,
    current_version: String,
    keys: Vec<[u8; 32]>,
}

impl SelfUpdater {
    pub fn new(exe: PathBuf, http: reqwest::Client, current_version: impl Into<String>, keys: Vec<[u8; 32]>) -> Self {
        Self { exe: Ok(exe), http, current_version: current_version.into(), keys }
    }

    /// 绑定到正在运行的这个可执行文件，用编进二进制的发布公钥。**必须在启动时就调用**。
    ///
    /// 路径要趁早定下来：Linux 上 current_exe 读的是 /proc/self/exe，文件一旦被换过
    /// （改名成 .old、或者被删），它读出来的就是 .old 或者带「(deleted)」的路径 ——
    /// 到那时再问，exec 起来的会是旧版本。
    pub fn for_current_exe(http: reqwest::Client, current_version: impl Into<String>) -> Self {
        let exe = std::env::current_exe()
            .map_err(|e| format!("找不到正在运行的可执行文件：{e}"))
            .and_then(resolve_executable);
        let keys = release_keys().unwrap_or_else(|message| {
            log_error!("upgrade_release_keys_invalid", "message": message,
                "hint": "内置的发布公钥解析不了，这份构建不能远程升级");
            vec![]
        });
        Self { exe, http, current_version: current_version.into(), keys }
    }

    pub fn executable(&self) -> Result<&Path, String> {
        self.exe.as_deref().map_err(Clone::clone)
    }

    pub fn current_version(&self) -> &str {
        &self.current_version
    }

    /// 用装好的新版本原地重启。成功时不返回。
    ///
    /// Unix 上是 exec：PID 不变，systemd / launchd 看到的还是同一个进程，不会当成崩溃重拉，
    /// 也不会因为「主进程退出了」把服务判成失败。参数原样带上 —— `run -c <配置>` 这类写法
    /// 换了版本也得是同一份配置。
    ///
    /// Windows 没有 exec：先起新进程再退出。计划任务把正常退出当成任务结束、不会重拉，
    /// 所以新进程必须在退出之前就已经起来。
    ///
    /// 调用之前必须已经 stop() 过 runner：exec 不跑任何析构，在跑的单元不会被报给 Hub 改派，
    /// 消费者只能干等超时。
    pub fn restart(&self) -> Result<Infallible, String> {
        let exe = self.executable()?;
        // 日志是逐行 JSON，exec 之后缓冲区就没了：最后几行别丢在里面。
        let _ = std::io::Write::flush(&mut std::io::stdout());
        let _ = std::io::Write::flush(&mut std::io::stderr());
        let mut command = std::process::Command::new(exe);
        command.args(std::env::args_os().skip(1));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let error = command.exec();
            Err(format!("exec {} 失败：{error}", exe.display()))
        }
        #[cfg(not(unix))]
        {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // 新进程组：这个控制台上的 Ctrl+C 不会连着把新进程一起带走。
                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                command.creation_flags(CREATE_NEW_PROCESS_GROUP);
            }
            match command.spawn() {
                Ok(_) => std::process::exit(0),
                Err(error) => Err(format!("起不来新版本 {}：{error}", exe.display())),
            }
        }
    }
}

#[cfg(unix)]
fn resolve_executable(exe: PathBuf) -> Result<PathBuf, String> {
    // 软链要解开：安装脚本把 /usr/local/bin/ai-bridge 链到 /opt/ai-bridge/ai-bridge。
    // 该换的是链接指向的那个文件、在它所在的（对服务用户可写的）目录里换；
    // 去换链接本身等于往 /usr/local/bin 里写东西，服务用户没这个权限。
    std::fs::canonicalize(&exe).map_err(|e| format!("解析可执行文件路径 {} 失败：{e}", exe.display()))
}

#[cfg(not(unix))]
fn resolve_executable(exe: PathBuf) -> Result<PathBuf, String> {
    // Windows 上 canonicalize 会得到 `\\?\C:\…` 这种写法，拿去起进程反而容易出事；
    // current_exe 本来就是绝对路径，那边也很少有人拿软链装程序。
    Ok(exe)
}

#[async_trait]
impl Updater for SelfUpdater {
    fn blocker(&self) -> Option<String> {
        if self.keys.is_empty() {
            return Some(NO_RELEASE_KEYS.into());
        }
        if current_platform().is_none() {
            return Some(unknown_platform());
        }
        let exe = match self.executable() {
            Ok(exe) => exe,
            Err(message) => return Some(message),
        };
        let dir = exe.parent().unwrap_or_else(|| Path::new("/"));
        if !dir_writable(dir) {
            let fix = if cfg!(windows) {
                "装到当前用户可写的目录（安装脚本默认的 %LOCALAPPDATA%\\ai-bridge）"
            } else {
                "把安装目录交给这个用户（安装脚本加 --user，装到 /opt/ai-bridge）"
            };
            return Some(format!(
                "可执行文件所在目录 {} 对运行 ai-bridge 的用户{}不可写，升级换不了文件：{fix}，见部署说明「远程升级」",
                dir.display(),
                current_user(),
            ));
        }
        None
    }

    fn verify(&self, command: &UpgradeCommand) -> Result<(), String> {
        verify_release(&self.keys, &command.version, &command.platform, &command.sha256, &command.signature)
    }

    async fn prepare(&self, command: &UpgradeCommand) -> Result<PreparedUpgrade, String> {
        let exe = self.executable()?;
        let local = current_platform().ok_or_else(unknown_platform)?;
        if command.platform != local {
            return Err(format!("安装包是 {} 的，这台机器是 {local}", command.platform));
        }
        // 先验签名再下载：签名不对的包，一个字节都不该落到这台机器的磁盘上。
        self.verify(command)?;
        if command.size > MAX_PACKAGE_BYTES {
            return Err(format!("安装包声明有 {} 字节，超过 256 MB 的上限", command.size));
        }
        let dir = exe.parent().ok_or_else(|| format!("{} 没有上级目录", exe.display()))?;
        // 临时目录建在可执行文件旁边，不在系统临时目录：同一个文件系统上 rename 才是原子的，
        // 而 /tmp 常常是另一块 tmpfs，跨文件系统的 rename 直接失败。
        let staging = StagingDir::create(dir)?;
        let archive = staging.path().join(package_file_name(&command.version, local));
        download(&self.http, &command.url, &archive, command.size, &command.sha256).await?;
        unpack(&archive, staging.path(), local).await?;

        let folder = format!("ai-bridge-{}-{local}", command.version);
        let executable = staging.path().join(&folder).join(executable_name(local));
        // symlink_metadata：包里放一个同名软链，换进去的就不是一个真文件了。
        if !std::fs::symlink_metadata(&executable).map(|meta| meta.is_file()).unwrap_or(false) {
            return Err(format!("安装包里没有 {folder}/{}", executable_name(local)));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("给新版本加执行权限失败：{e}"))?;
        }
        // 在本机真跑一次再换：包对不上这台机器（架构、glibc、被系统拦截）就停在这一步，
        // 旧文件一点没动，进程照常干活。
        trial_run(&executable, &command.version).await?;
        Ok(PreparedUpgrade { version: command.version.clone(), executable, _staging: Some(staging) })
    }

    async fn install(&self, prepared: PreparedUpgrade) -> Result<PathBuf, String> {
        let exe = self.executable()?.to_path_buf();
        // 放进阻塞线程不只是为了不卡 runtime：这一步开始了就必须做完。升级任务在停机时
        // 会被中止，改名改到一半停下来会留下一个没有可执行文件的安装目录 ——
        // spawn_blocking 里的闭包不会被 abort 打断。
        tokio::task::spawn_blocking(move || {
            let swapped = swap_executable(&exe, &prepared.executable);
            // 换完（成不成都一样）临时目录就没用了：压缩包、deploy/、README 一起删。
            drop(prepared);
            swapped.map(|()| exe)
        })
        .await
        .map_err(|e| format!("替换可执行文件的任务异常退出：{e}"))?
    }
}

/// 把 staged 换成 exe，旧的留在 `<exe>.old`；新文件放不进去时把旧的还原回来。
///
/// 顺序是「先把旧的挪开，再把新的放进来」，三个平台同一套：Windows 不许覆盖或删除
/// 正在运行的 exe，但允许给它改名；Unix 上正在跑的进程持有的是 inode，改名不影响它。
/// 两次 rename 之间 exe 有一瞬间不存在 —— 只有恰好在那几微秒里手动敲 `ai-bridge`
/// 才会撞上，换来的是三个平台一条路径、一种失败语义。
pub fn swap_executable(exe: &Path, staged: &Path) -> Result<(), String> {
    let backup = backup_path(exe);
    // 先落盘再换：换完立刻断电，ext4 之类的延迟分配可能留下一个 0 字节的可执行文件，
    // 那台机器就再也起不来了。
    if let Ok(file) = std::fs::File::open(staged) {
        let _ = file.sync_all();
    }
    match std::fs::remove_file(&backup) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删不掉上一次升级留下的备份 {}：{e}", backup.display())),
    }
    std::fs::rename(exe, &backup).map_err(|e| format!("挪不开正在用的可执行文件 {}：{e}", exe.display()))?;
    if let Err(error) = std::fs::rename(staged, exe) {
        return match std::fs::rename(&backup, exe) {
            Ok(()) => Err(format!("新版本放不进 {}：{error}（旧版本已还原）", exe.display())),
            Err(restore) => Err(format!(
                "新版本放不进 {}：{error}；还原旧版本也失败了（{restore}），请手动把 {} 改名回 {}",
                exe.display(),
                backup.display(),
                exe.display(),
            )),
        };
    }
    // 目录项也落盘：rename 本身是写目录，不 fsync 目录的话断电后可能回到换之前。
    #[cfg(unix)]
    if let Some(dir) = exe.parent() {
        if let Ok(handle) = std::fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }
    Ok(())
}

/// 升级用的临时目录。掉落时整个删掉 —— 失败返回、升级任务被中止（future 被丢弃）
/// 都走 Drop，于是不用在每条错误分支上各清理一次。
struct StagingDir(PathBuf);

impl StagingDir {
    fn create(parent: &Path) -> Result<Self, String> {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let path = parent.join(format!("{STAGING_PREFIX}{}", &suffix[..12]));
        std::fs::create_dir(&path).map_err(|e| format!("在 {} 里建临时目录失败：{e}", parent.display()))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.0) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log_warn!("upgrade_staging_cleanup_failed",
                    "path": self.0.to_string_lossy(), "message": e.to_string());
            }
        }
    }
}

/// 流式下载到 dest，边收边算 sha256。
///
/// 错误信息里一律不带地址：OSS 的签名地址查询串里是访问凭据，而这些信息会原样显示在控制台上。
async fn download(http: &reqwest::Client, url: &str, dest: &Path, size: u64, sha256: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址不是合法的 URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("下载地址必须是 http(s)".into());
    }
    let response = tokio::time::timeout(CONNECT_TIMEOUT, http.get(parsed).send())
        .await
        .map_err(|_| "下载超时：安装包地址 30 秒没有响应".to_string())?
        .map_err(|e| format!("下载失败：{}", describe_transport(&e.without_url())))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("下载失败：安装包地址返回 HTTP {status}"));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_PACKAGE_BYTES {
            return Err(format!("安装包有 {length} 字节，超过 256 MB 的上限"));
        }
        if size > 0 && length != size {
            return Err(format!("安装包大小对不上：声明 {size} 字节，服务器给的是 {length} 字节"));
        }
    }

    let mut file = tokio::fs::File::create(dest).await.map_err(|e| format!("建临时文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut body = response.bytes_stream();
    loop {
        let chunk = match tokio::time::timeout(IDLE_TIMEOUT, body.next()).await {
            Err(_) => return Err("下载卡住了：60 秒没有收到任何数据".into()),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(format!("下载中断：{}", describe_transport(&e.without_url()))),
            Ok(Some(Ok(chunk))) => chunk,
        };
        received += chunk.len() as u64;
        if received > MAX_PACKAGE_BYTES {
            return Err("安装包超过 256 MB 的上限，停止下载".into());
        }
        if size > 0 && received > size {
            return Err(format!("安装包大小对不上：声明 {size} 字节，实际收到的更多"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| format!("写安装包失败：{e}"))?;
    }
    file.flush().await.map_err(|e| format!("写安装包失败：{e}"))?;
    drop(file);
    if size > 0 && received != size {
        return Err(format!("安装包大小对不上：声明 {size} 字节，实际收到 {received} 字节"));
    }
    let actual = hex::encode(hasher.finalize());
    if actual != sha256 {
        return Err(format!(
            "sha256 对不上（收到的是 {}…，签名里的是 {}…）：包在路上被换过或者损坏了",
            &actual[..12],
            &sha256[..sha256.len().min(12)],
        ));
    }
    Ok(())
}

/// 用系统的 tar 解包。
///
/// 不引压缩库：tar 三个平台都有（Windows 10 起系统自带 bsdtar，也解得开 zip，
/// 与 build-cli.cjs 打包用的是同一个工具），这个可执行文件要放在别人的服务器上长期跑，
/// 依赖树越短越好。
async fn unpack(archive: &Path, into: &Path, platform: &str) -> Result<(), String> {
    let name = archive.file_name().ok_or("压缩包路径不对")?;
    let flag = if platform.starts_with("windows-") { "-xf" } else { "-xzf" };
    let mut command = tokio::process::Command::new(tar_program());
    // 用相对文件名、在目标目录里跑：GNU tar 会把 `C:\…` 里的冒号当成远程主机名。
    command
        .arg(flag)
        .arg(name)
        .current_dir(into)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(UNPACK_TIMEOUT, command.output()).await {
        Err(_) => return Err("解包超时".into()),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("系统里找不到 tar 命令，解不开安装包".into());
        }
        Ok(Err(e)) => return Err(format!("tar 起不来：{e}")),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        return Err(format!("解包失败：{}", first_line(&String::from_utf8_lossy(&output.stderr))));
    }
    Ok(())
}

fn tar_program() -> PathBuf {
    // Windows 上优先系统自带的 bsdtar：PATH 里排在前面的往往是 Git 带的 GNU tar，它不认 zip。
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let system = PathBuf::from(root).join("System32").join("tar.exe");
            if system.is_file() {
                return system;
            }
        }
    }
    PathBuf::from("tar")
}

/// `<新文件> version`，输出里必须有目标版本号。
async fn trial_run(executable: &Path, version: &str) -> Result<(), String> {
    let mut command = tokio::process::Command::new(executable);
    command.arg("version").stdin(Stdio::null()).kill_on_drop(true);
    let output = match tokio::time::timeout(TRIAL_TIMEOUT, command.output()).await {
        Err(_) => return Err("新版本试跑超时：`ai-bridge version` 20 秒没有返回".into()),
        Ok(Err(e)) => return Err(format!("新版本在这台机器上跑不起来：{e}")),
        Ok(Ok(output)) => output,
    };
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        return Err(format!("新版本在这台机器上跑不起来（{}）：{}", output.status, first_line(&text)));
    }
    // 按整词比：0.2.0 不能被 0.2.0-beta 或 10.2.0 冒充。
    if !text.split_whitespace().any(|word| word == version) {
        return Err(format!("新版本自报的版本号对不上：要装的是 {version}，它说「{}」", first_line(&text)));
    }
    Ok(())
}

fn first_line(text: &str) -> String {
    text.trim().lines().next().unwrap_or("").chars().take(120).collect()
}

#[cfg(unix)]
fn dir_writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    // W_OK | X_OK 正是「能在这个目录里建文件、改名」要的权限。access 按真实 uid 判断，
    // 服务进程的真实 uid 就是 systemd User= 的那个用户，要问的正是他。只读挂载也会在这里报出来。
    unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
}

#[cfg(not(unix))]
fn dir_writable(dir: &Path) -> bool {
    // Windows 的 ACL 没有一个 access() 能问清楚，真建一个文件最可靠。
    let probe = dir.join(format!(".ai-bridge-write-test-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => std::fs::remove_file(&probe).is_ok(),
        Err(_) => false,
    }
}

fn current_user() -> String {
    ["USER", "USERNAME"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()))
        .map(|user| format!("（{user}）"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn keypair() -> (Ed25519KeyPair, [u8; 32]) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public: [u8; 32] = pair.public_key().as_ref().try_into().unwrap();
        (pair, public)
    }

    fn sign(pair: &Ed25519KeyPair, version: &str, platform: &str, sha256: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(pair.sign(signed_message(version, platform, sha256).as_bytes()))
    }

    const SHA: &str = "29497afb2668d3c372667f69ff807863db4201b937de100d7cb4826c05ee527e";

    // ---------- 平台与版本 ----------

    #[test]
    fn platform_names_follow_the_release_package_names() {
        let cases = [
            ("linux", "x86_64", "linux-x64"),
            ("linux", "aarch64", "linux-arm64"),
            ("macos", "aarch64", "darwin-arm64"),
            ("macos", "x86_64", "darwin-x64"),
            ("windows", "x86_64", "windows-x64"),
            ("windows", "aarch64", "windows-arm64"),
        ];
        for (os, arch, name) in cases {
            assert_eq!(platform_name(os, arch), Some(name), "{os}/{arch}");
            assert!(PLATFORMS.contains(&name));
        }
        // 认不出来就说认不出来，不猜一个相近的。
        for (os, arch) in [("linux", "riscv64"), ("freebsd", "x86_64"), ("linux", "x86"), ("macos", "arm")] {
            assert_eq!(platform_name(os, arch), None, "{os}/{arch}");
        }
        assert_eq!(package_file_name("0.2.0", "linux-x64"), "ai-bridge-0.2.0-linux-x64.tar.gz");
        assert_eq!(package_file_name("0.2.0", "windows-arm64"), "ai-bridge-0.2.0-windows-arm64.zip");
        assert_eq!(executable_name("windows-x64"), "ai-bridge.exe");
        assert_eq!(backup_path(Path::new("/opt/ai-bridge/ai-bridge")), PathBuf::from("/opt/ai-bridge/ai-bridge.old"));
    }

    #[test]
    fn versions_compare_by_numbers_then_a_release_beats_its_pre_releases() {
        let less = |a: &str, b: &str| {
            assert_eq!(compare_versions(a, b), Some(Ordering::Less), "{a} < {b}");
            assert_eq!(compare_versions(b, a), Some(Ordering::Greater), "{b} > {a}");
        };
        less("0.1.0", "0.2.0");
        less("0.9.0", "0.10.0"); // 按数字比，不按字符串
        less("1.9.9", "2.0.0");
        less("1.0.0-beta", "1.0.0"); // 正式版比它的预发布新
        less("1.0.0-alpha", "1.0.0-beta"); // 两个都有后缀按字符串比
        less("1.0.0-beta.1", "1.0.0-beta.2");
        less("0.9.9", "1.0.0-rc.1");
        assert_eq!(compare_versions("0.2.0", "0.2.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.0.0-rc-1", "1.0.0-rc-1"), Some(Ordering::Equal));

        for junk in ["", "1.0", "1.0.0.0", "v1.0.0", " 1.0.0", "1.0.0 ", "1.0.0-", "1.0.0+build", "1.0.x", "１.0.0", "test"] {
            assert!(Version::parse(junk).is_none(), "不该认 {junk:?}");
            assert_eq!(compare_versions(junk, "1.0.0"), None, "{junk:?}");
        }
        assert_eq!(
            Version::parse("1.2.3-rc.1-x"),
            Some(Version { major: 1, minor: 2, patch: 3, pre: Some("rc.1-x".into()) })
        );
    }

    // ---------- 公钥文件 ----------

    #[test]
    fn release_key_files_skip_comments_and_refuse_a_bad_line_instead_of_skipping_it() {
        let (_, public) = keypair();
        let encoded = base64::engine::general_purpose::STANDARD.encode(public);
        let text = format!("# 发布公钥\n\n  {encoded}  # 2026-09 换上\n{encoded}\n");
        assert_eq!(parse_release_keys(&text).unwrap(), vec![public], "注释、空行、重复都不算钥匙");
        assert!(parse_release_keys("# 只有注释\n\n").unwrap().is_empty());

        let bad = format!("{encoded}\nnot-base64!\n");
        assert!(parse_release_keys(&bad).unwrap_err().contains("第 2 行"));
        let short = base64::engine::general_purpose::STANDARD.encode([7u8; 31]);
        assert!(parse_release_keys(&short).unwrap_err().contains("31 字节"));
    }

    /// 仓库里那份文件本身必须解析得了：坏了的话每台机器都只会报「没有内置公钥」。
    #[test]
    fn the_shipped_release_key_file_parses() {
        release_keys().expect("release-keys.txt 必须是合法的公钥文件");
    }

    // ---------- 签名 ----------

    #[test]
    fn a_signature_covers_version_platform_and_sha256() {
        let (pair, public) = keypair();
        let signature = sign(&pair, "0.2.0", "linux-x64", SHA);
        assert_eq!(signature.len(), 88, "契约：88 个字符的 base64");
        verify_release(&[public], "0.2.0", "linux-x64", SHA, &signature).expect("自己签的要验得过");
        verify_release(&[public], "0.2.0", "linux-x64", SHA, &format!("{signature}\n")).expect(".sig 文件末尾的换行不算");

        // 签名覆盖的三样换掉任何一样，都不能被同一个签名放行。
        let other_sha = SHA.replace('2', "3");
        for (version, platform, sha) in [("0.2.1", "linux-x64", SHA), ("0.2.0", "linux-arm64", SHA), ("0.2.0", "linux-x64", other_sha.as_str())] {
            let message = verify_release(&[public], version, platform, sha, &signature).unwrap_err();
            assert!(message.contains("校验不通过"), "{version} {platform} → {message}");
        }

        // 别人的钥匙签的、没有钥匙、签名形状不对。
        let (stranger, _) = keypair();
        let forged = sign(&stranger, "0.2.0", "linux-x64", SHA);
        assert!(verify_release(&[public], "0.2.0", "linux-x64", SHA, &forged).unwrap_err().contains("校验不通过"));
        let (_, second) = keypair();
        verify_release(&[second, public], "0.2.0", "linux-x64", SHA, &signature).expect("任何一把内置公钥验得过就算数");
        assert!(verify_release(&[], "0.2.0", "linux-x64", SHA, &signature).unwrap_err().contains("公钥"));
        assert!(verify_release(&[public], "0.2.0", "linux-x64", SHA, "abc").unwrap_err().contains("格式不对"));
        assert!(verify_release(&[public], "0.2.0", "linux-x64", &SHA.to_uppercase(), &signature).unwrap_err().contains("小写"));
        assert!(verify_release(&[public], "0.2.0", "plan9-x64", SHA, &signature).unwrap_err().contains("平台"));
    }

    /// scripts/release-sign.cjs 签出来的东西，节点必须验得过 —— 两边拼消息的方式差一个字节，
    /// 发版那天所有机器都会拒装。这组向量是用那个脚本（keygen + sign）和一把用完即弃的钥匙
    /// 对 ai-bridge-0.1.0-linux-x64.tar.gz 生成的；这把公钥**不在** release-keys.txt 里。
    #[test]
    fn a_signature_made_by_the_node_signing_script_verifies() {
        const PUBLIC: &str = "+XdUKJVKJM5EuRq8pL4dB1Wl179yB4J/tvlOZvfoiCY=";
        const VERSION: &str = "0.1.0";
        const PLATFORM: &str = "linux-x64";
        const SHA256: &str = "29497afb2668d3c372667f69ff807863db4201b937de100d7cb4826c05ee527e";
        const SIGNATURE: &str =
            "LdBrE8P8lqfbozfkhl4hx4cIaZ7ZAYtUdHeSZALB5+BNgKqRF8fOieo1hzId2mUxvOHIdNJYUT8v2Al8M/+2Bg==";
        let keys = parse_release_keys(PUBLIC).unwrap();
        verify_release(&keys, VERSION, PLATFORM, SHA256, SIGNATURE).expect("Node 脚本签的包要验得过");
        assert!(verify_release(&keys, "9.9.9", PLATFORM, SHA256, SIGNATURE).is_err());
    }

    #[test]
    fn report_messages_are_capped_by_characters_not_bytes() {
        let long = "升".repeat(300);
        let capped = truncate_message(&long);
        assert_eq!(capped.chars().count(), MESSAGE_MAX_CHARS);
        assert!(capped.ends_with('…'));
        assert_eq!(truncate_message("已经是 0.2.0"), "已经是 0.2.0");
    }

    #[test]
    fn debug_output_never_carries_the_download_credentials() {
        let command = UpgradeCommand {
            url: "https://bucket.oss-cn-hangzhou.aliyuncs.com/a.tar.gz?OSSAccessKeyId=AK&Signature=SECRET".into(),
            ..Default::default()
        };
        let printed = format!("{command:?}");
        assert!(printed.contains("a.tar.gz") && !printed.contains("SECRET") && !printed.contains("OSSAccessKeyId"), "{printed}");
    }

    // ---------- 换文件 ----------

    #[test]
    fn swapping_keeps_a_backup_and_restores_the_old_file_when_the_new_one_cannot_be_placed() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("ai-bridge");
        let backup = backup_path(&exe);
        std::fs::write(&exe, "v1").unwrap();

        let staged = dir.path().join("staged");
        std::fs::write(&staged, "v2").unwrap();
        swap_executable(&exe, &staged).unwrap();
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "v1");
        assert!(!staged.exists());

        // 再升一次：上一次的备份让位给这一次的旧版本。
        std::fs::write(&staged, "v3").unwrap();
        swap_executable(&exe, &staged).unwrap();
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "v3");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "v2");

        // 新文件放不进去：旧版本必须原样回到原处，这台机器下次还起得来。
        let message = swap_executable(&exe, &dir.path().join("missing")).unwrap_err();
        assert!(message.contains("已还原"), "{message}");
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "v3");
    }

    #[test]
    fn the_blocker_says_what_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("ai-bridge");
        std::fs::write(&exe, "old").unwrap();
        let http = reqwest::Client::new();
        let (_, public) = keypair();

        let keyless = SelfUpdater::new(exe.clone(), http.clone(), "0.2.0", vec![]);
        assert!(keyless.blocker().unwrap().contains("公钥"), "没有公钥就不能升级");

        let ready = SelfUpdater::new(exe.clone(), http.clone(), "0.2.0", vec![public]);
        if current_platform().is_some() {
            assert_eq!(ready.blocker(), None);
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // root 不受目录权限约束，这一段在 root 下验不出东西。
            if unsafe { libc::geteuid() } != 0 {
                std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
                let blocker = ready.blocker();
                std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
                let blocker = blocker.expect("目录不可写要报出来");
                assert!(blocker.contains(&dir.path().display().to_string()), "要写清是哪个目录：{blocker}");
            }
        }
    }

    #[cfg(unix)]
    mod package {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::Arc;

        /// 按发布包的布局用系统 tar 打一个包，里面的「ai-bridge」是个会报版本号的 shell 脚本。
        fn build_package(dir: &Path, version: &str, platform: &str, prints: &str) -> Vec<u8> {
            let name = format!("ai-bridge-{version}-{platform}");
            let stage = dir.join(&name);
            std::fs::create_dir_all(stage.join("deploy")).unwrap();
            let script = stage.join("ai-bridge");
            std::fs::write(&script, format!("#!/bin/sh\necho \"{prints}\"\n")).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::write(stage.join("README.md"), "readme").unwrap();
            let archive = dir.join(format!("{name}.tar.gz"));
            let status = std::process::Command::new("tar")
                .arg("-czf")
                .arg(&archive)
                .arg(&name)
                .current_dir(dir)
                .env("COPYFILE_DISABLE", "1")
                .status()
                .unwrap();
            assert!(status.success());
            std::fs::read(&archive).unwrap()
        }

        /// 本地的「OSS」：/download 302 到 /pkg，和 Hub 的稳定下载地址一个形态。
        async fn serve(body: Vec<u8>, hits: Arc<AtomicUsize>) -> String {
            let app = axum::Router::new()
                .route("/download", axum::routing::get(|| async { axum::response::Redirect::temporary("/pkg") }))
                .route("/pkg", axum::routing::get(move || {
                    let body = body.clone();
                    let hits = Arc::clone(&hits);
                    async move {
                        hits.fetch_add(1, AtomicOrdering::SeqCst);
                        body
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            format!("http://127.0.0.1:{port}/download?Signature=SECRET")
        }

        struct Setup {
            _work: tempfile::TempDir,
            install: tempfile::TempDir,
            exe: PathBuf,
            updater: SelfUpdater,
            command: UpgradeCommand,
            pair: Ed25519KeyPair,
            hits: Arc<AtomicUsize>,
        }

        async fn setup(served_prints: &str, tamper: bool) -> Setup {
            let platform = current_platform().expect("测试机的平台要认得出来");
            let work = tempfile::tempdir().unwrap();
            let bytes = build_package(work.path(), "0.3.0", platform, served_prints);
            let sha256 = hex::encode(Sha256::digest(&bytes));
            let mut served = bytes.clone();
            if tamper {
                let last = served.len() - 1;
                served[last] ^= 0xff;
            }
            let hits = Arc::new(AtomicUsize::new(0));
            let url = serve(served, Arc::clone(&hits)).await;

            let install = tempfile::tempdir().unwrap();
            let exe = install.path().join("ai-bridge");
            std::fs::write(&exe, "old").unwrap();
            let (pair, public) = keypair();
            let http = reqwest::Client::builder().no_proxy().build().unwrap();
            let updater = SelfUpdater::new(exe.clone(), http, "0.2.0", vec![public]);
            let command = UpgradeCommand {
                id: "ug_1".into(),
                version: "0.3.0".into(),
                platform: platform.into(),
                url,
                signature: sign(&pair, "0.3.0", platform, &sha256),
                sha256,
                size: bytes.len() as u64,
            };
            Setup { _work: work, install, exe, updater, command, pair, hits }
        }

        /// 除了可执行文件本身，安装目录里不该留下任何东西。
        fn leftovers(dir: &Path) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name != "ai-bridge" && name != "ai-bridge.old")
                .collect();
            names.sort();
            names
        }

        #[tokio::test]
        async fn a_signed_package_is_downloaded_checked_unpacked_trial_run_and_swapped_in() {
            let s = setup("ai-bridge 0.3.0", false).await;
            let prepared = s.updater.prepare(&s.command).await.expect("准备好新版本");
            assert!(prepared.executable.starts_with(s.install.path()),
                "临时目录必须和可执行文件在同一个目录：同一个文件系统上 rename 才是原子的");
            assert_eq!(std::fs::read_to_string(&s.exe).unwrap(), "old", "准备阶段不碰正在用的文件");

            let installed = s.updater.install(prepared).await.expect("换上新版本");
            assert_eq!(installed, s.exe);
            assert!(std::fs::read_to_string(&s.exe).unwrap().contains("ai-bridge 0.3.0"));
            assert_eq!(std::fs::read_to_string(backup_path(&s.exe)).unwrap(), "old");
            assert!(leftovers(s.install.path()).is_empty(), "临时文件要清干净：{:?}", leftovers(s.install.path()));
        }

        #[tokio::test]
        async fn a_tampered_package_is_refused_after_download_and_nothing_is_left_behind() {
            let s = setup("ai-bridge 0.3.0", true).await;
            let message = s.updater.prepare(&s.command).await.err().expect("被改过的包不能装");
            assert!(message.contains("sha256"), "{message}");
            assert!(!message.contains("SECRET"), "错误信息里不能带下载地址的凭据：{message}");
            assert_eq!(std::fs::read_to_string(&s.exe).unwrap(), "old");
            assert!(leftovers(s.install.path()).is_empty(), "{:?}", leftovers(s.install.path()));
        }

        #[tokio::test]
        async fn a_bad_signature_is_refused_before_a_single_byte_is_downloaded() {
            let mut s = setup("ai-bridge 0.3.0", false).await;
            s.command.signature = sign(&s.pair, "0.3.1", &s.command.platform, &s.command.sha256);
            let message = s.updater.prepare(&s.command).await.err().expect("签名不对不能装");
            assert!(message.contains("校验不通过"), "{message}");
            assert_eq!(s.hits.load(AtomicOrdering::SeqCst), 0, "先验签名再下载");
            assert!(leftovers(s.install.path()).is_empty());
        }

        #[tokio::test]
        async fn a_size_that_does_not_match_the_command_is_refused() {
            let mut s = setup("ai-bridge 0.3.0", false).await;
            s.command.size += 1;
            let message = s.updater.prepare(&s.command).await.err().expect("大小对不上不能装");
            assert!(message.contains("大小对不上"), "{message}");
            assert!(leftovers(s.install.path()).is_empty());
        }

        /// 包本身是好的、签名也对，但在这台机器上报不出目标版本：停在试跑，旧文件原封不动。
        #[tokio::test]
        async fn a_package_that_does_not_report_the_target_version_stops_at_the_trial_run() {
            let s = setup("ai-bridge 0.3.0-beta", false).await;
            let message = s.updater.prepare(&s.command).await.err().expect("试跑对不上版本不能装");
            assert!(message.contains("版本号对不上"), "{message}");
            assert_eq!(std::fs::read_to_string(&s.exe).unwrap(), "old");
            assert!(leftovers(s.install.path()).is_empty(), "{:?}", leftovers(s.install.path()));
        }

        #[tokio::test]
        async fn a_package_for_another_platform_is_refused_up_front() {
            let mut s = setup("ai-bridge 0.3.0", false).await;
            let other = PLATFORMS.iter().find(|p| **p != s.command.platform).unwrap();
            s.command.platform = other.to_string();
            s.command.signature = sign(&s.pair, "0.3.0", other, &s.command.sha256);
            let message = s.updater.prepare(&s.command).await.err().expect("别的平台的包不能装");
            assert!(message.contains(other), "{message}");
            assert_eq!(s.hits.load(AtomicOrdering::SeqCst), 0);
        }
    }
}
