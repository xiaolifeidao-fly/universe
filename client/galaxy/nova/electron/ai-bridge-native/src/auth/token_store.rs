use crate::config::schema::{AuthConfig, AuthToken, Scope};
use crate::config::validate_auth_token;
use crate::core::paths::{expand_home, runtime_dir, Env};
use crate::log_warn;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;

use super::principal::{Principal, PrincipalSource};

/// token 的存储与比对。
/// - 比对一律用 sha256 哈希 + 常量时间比较：明文 token 在加载时就被哈希掉，进程内不留明文表。
/// - 两个来源：config.auth.tokens（内联）与 tokenFile（CLI 维护的 JSON，只存哈希）。
///   两边 alias 冲突时 tokenFile 优先，方便运维用 CLI 覆盖配置里的旧 token。
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn resolve_token_file(cfg: &AuthConfig, env: &Env) -> PathBuf {
    match &cfg.token_file {
        Some(path) => expand_home(path),
        None => runtime_dir(env).join("tokens.json"),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenFile {
    pub version: u32,
    pub tokens: Vec<AuthToken>,
}

impl Default for TokenFile {
    fn default() -> Self { Self { version: 1, tokens: vec![] } }
}

pub fn read_token_file(path: &Path) -> Result<TokenFile, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TokenFile::default()),
        Err(e) => return Err(format!("读不到 token 文件 {}：{e}", path.display())),
    };
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| format!("token 文件格式不对：{}", path.display()))?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || !value.get("tokens").is_some_and(serde_json::Value::is_array)
    {
        return Err(format!("token 文件格式不对：{}", path.display()));
    }
    // 文件里只允许 tokenHash：明文落盘会让「进程内不留明文」这条约束形同虚设。
    for entry in value["tokens"].as_array().unwrap() {
        if entry.get("token").is_some() {
            let alias = entry.get("alias").and_then(serde_json::Value::as_str).unwrap_or("");
            return Err(format!("token 文件里不允许出现明文 token（alias={alias}）"));
        }
    }
    let file: TokenFile = serde_json::from_value(value)
        .map_err(|e| format!("token 文件格式不对：{}（{e}）", path.display()))?;
    for token in &file.tokens {
        validate_auth_token(token)?;
    }
    Ok(file)
}

pub fn write_token_file(path: &Path, data: &TokenFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_dir_private(parent)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())? + "\n";
    write_private(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写 token 文件失败：{e}"))
}

fn create_dir_private(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败 {}：{e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("写文件失败 {}：{e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

struct Entry {
    hash: [u8; 32],
    principal: Principal,
}

fn to_principal(t: &AuthToken, source: PrincipalSource) -> Principal {
    Principal {
        alias: t.alias.clone(),
        scopes: t.scopes.iter().copied().collect::<HashSet<Scope>>(),
        concurrency: t.concurrency,
        source,
    }
}

#[derive(Serialize)]
pub struct TokenSummary {
    pub alias: String,
    pub scopes: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    pub source: PrincipalSource,
}

pub struct TokenStore {
    cfg: AuthConfig,
    token_file: PathBuf,
    entries: Vec<Entry>,
    by_alias: HashMap<String, usize>,
}

impl TokenStore {
    pub fn new(cfg: AuthConfig, token_file: PathBuf) -> Self {
        Self { cfg, token_file, entries: vec![], by_alias: HashMap::new() }
    }

    pub fn token_file(&self) -> &Path { &self.token_file }

    /// 从 config + tokenFile 重建表。可以在运行时重复调用（admin reload）。
    pub fn load(&mut self) -> Result<(), String> {
        let file = read_token_file(&self.token_file)?;
        let mut entries: Vec<Entry> = vec![];
        let mut by_alias: HashMap<String, usize> = HashMap::new();

        let sources = self.cfg.tokens.iter().map(|t| (t, PrincipalSource::Config))
            .chain(file.tokens.iter().map(|t| (t, PrincipalSource::File)));
        for (token, source) in sources {
            if token.disabled {
                continue;
            }
            let hex_hash = match (&token.token_hash, &token.token) {
                (Some(hash), _) => hash.clone(),
                (None, Some(plain)) => hash_token(plain),
                (None, None) => continue,
            };
            let mut hash = [0u8; 32];
            if hex::decode_to_slice(&hex_hash, &mut hash).is_err() {
                return Err(format!("tokenHash 不是合法 sha256 hex（alias={}）", token.alias));
            }
            let entry = Entry { hash, principal: to_principal(token, source) };
            // tokenFile 覆盖 config
            match by_alias.get(&token.alias) {
                Some(&index) => entries[index] = entry,
                None => {
                    by_alias.insert(token.alias.clone(), entries.len());
                    entries.push(entry);
                }
            }
        }

        self.entries = entries;
        self.by_alias = by_alias;
        if self.cfg.enabled && self.entries.is_empty() {
            log_warn!("auth_no_tokens", "message": "auth.enabled=true 但没有任何可用 token，所有业务请求都会被拒绝。用 `ai-bridge token add --alias <name>` 生成一个。");
        }
        Ok(())
    }

    pub fn size(&self) -> usize { self.entries.len() }

    /// 常量时间：对每个条目都做一次比较，不因命中提前返回而泄露信息
    pub fn verify(&self, token: &str) -> Option<Principal> {
        let probe = Sha256::digest(token.as_bytes());
        let mut hit: Option<&Principal> = None;
        for entry in &self.entries {
            if entry.hash.ct_eq(probe.as_slice()).into() {
                hit = Some(&entry.principal);
            }
        }
        hit.cloned()
    }

    pub fn list(&self) -> Vec<TokenSummary> {
        self.entries.iter().map(|e| {
            let mut scopes: Vec<&'static str> = e.principal.scopes.iter().map(|s| s.label()).collect();
            scopes.sort_unstable();
            TokenSummary {
                alias: e.principal.alias.clone(),
                scopes,
                concurrency: e.principal.concurrency,
                source: e.principal.source,
            }
        }).collect()
    }

    pub fn has_alias(&self, alias: &str) -> bool { self.by_alias.contains_key(alias) }
}

// ---------- CLI / admin 用的文件操作 ----------

pub fn add_file_token(
    path: &Path,
    alias: &str,
    scopes: &[Scope],
    concurrency: Option<u32>,
) -> Result<String, String> {
    let mut file = read_token_file(path)?;
    if file.tokens.iter().any(|t| t.alias == alias) {
        return Err(format!("alias \"{alias}\" 已存在；先 revoke 再重新生成"));
    }
    let token = generate_token();
    let entry = AuthToken {
        token: None,
        token_hash: Some(hash_token(&token)),
        alias: alias.to_string(),
        scopes: scopes.to_vec(),
        concurrency,
        disabled: false,
        created_at: Some(
            time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        ),
    };
    validate_auth_token(&entry)?;
    file.tokens.push(entry);
    write_token_file(path, &file)?;
    Ok(token)
}

pub fn revoke_file_token(path: &Path, alias: &str) -> Result<bool, String> {
    let mut file = read_token_file(path)?;
    let before = file.tokens.len();
    file.tokens.retain(|t| t.alias != alias);
    if file.tokens.len() == before {
        return Ok(false);
    }
    write_token_file(path, &file)?;
    Ok(true)
}

pub fn scope_list_json(scopes: &[Scope]) -> serde_json::Value {
    json!(scopes.iter().map(|s| s.label()).collect::<Vec<_>>())
}
