use crate::config::schema::PoolConfig;
use crate::core::paths::{expand_home, runtime_dir, Env};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

// 节点令牌的落盘。
//
// 与 auth/tokens.json 只存哈希不同，这把令牌必须能在重启后原样出示给 Hub，
// 所以它是明文存的 —— 存哈希就等于每次重启都要重新配对，与「长期 node token」矛盾。
// 防护手段是文件权限 0600 + 目录 0700，与 ~/.codex/auth.json、~/.claude/.credentials.json
// 这些本机凭据一致；日志里只出现指纹，永远不出现明文。

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeIdentity {
    pub version: u32,
    #[serde(rename = "nodeId")]
    pub node_id: String,
    pub token: String,
    #[serde(rename = "hubURL")]
    pub hub_url: String,
    #[serde(rename = "pairedAt")]
    pub paired_at: String,
}

pub fn resolve_node_token_file(pool: Option<&PoolConfig>, env: &Env) -> PathBuf {
    match pool.and_then(|p| p.token_file.as_deref()) {
        Some(path) => expand_home(path),
        None => runtime_dir(env).join("node-token.json"),
    }
}

pub async fn read_node_identity(path: &Path) -> Result<Option<NodeIdentity>, String> {
    let raw = match tokio::fs::read_to_string(path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不到节点令牌文件 {}：{e}", path.display())),
    };
    let parsed: NodeIdentity = serde_json::from_str(&raw)
        .map_err(|_| format!("节点令牌文件格式不对：{}", path.display()))?;
    if parsed.version != 1 || parsed.token.is_empty() || parsed.node_id.is_empty() {
        return Err(format!("节点令牌文件格式不对：{}", path.display()));
    }
    Ok(Some(parsed))
}

pub async fn write_node_identity(path: &Path, value: &NodeIdentity) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await;
        }
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())? + "\n";
    tokio::fs::write(&tmp, text.as_bytes()).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await;
    }
    tokio::fs::rename(&tmp, path).await.map_err(|e| e.to_string())
}

/// 日志里代表这把令牌的东西：足以在排障时区分两台机器，又不足以拿去冒充。
pub fn fingerprint(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))[..12].to_string()
}
