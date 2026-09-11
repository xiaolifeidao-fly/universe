use sha2::{Digest, Sha256};
use std::path::Path;

// 设备指纹：主人是工作室时，Hub 按它记这台机器的信誉，解绑重配、换账号再配都不清零；
// 散户的信誉跟着账号走，用不上它，但照样上报（Hub 侧见 service/galaxy/reputation.go）。
//
// 上报的是 sha256(命名空间 + 系统给的机器 id)，原始 id 不出本机 —— Hub 要知道的只是
// 「是不是同一台」，不需要主板序列号。
//
// 取 id 按「普通用户读得到、重装软件不变」排：
//   Linux          /etc/machine-id → /var/lib/dbus/machine-id → DMI product_uuid
//                  product_uuid 多数发行版只有 root 可读，排在最后：排在前面的话，
//                  同一台服务器 root 跑和普通用户跑会算出两个指纹，信誉分成两份。
//   macOS/Windows  主板 UUID（IOPlatformUUID / SMBIOS），普通用户可读
// 都拿不到（容器、精简系统）才退回运行目录里一串随机 id：同一份安装重新配对照样认得出，
// 删掉运行目录或重装就认不出了 —— 这是没有系统 id 时能做到的最好。

const NAMESPACE: &str = "galaxy-machine/v1";

/// 一些主板厂商不填 SMBIOS UUID，出厂就是这个占位值，成千上万台机器共用一个。
const PLACEHOLDER_UUID: &str = "03000200040005000006000700080009";

/// 这台机器的指纹，64 位小写十六进制。`fallback_dir` 放兜底用的随机 id，
/// 传节点令牌所在的目录。系统 id 拿不到、兜底文件也写不进去时返回 None，hello 就不带指纹。
pub fn machine_fingerprint(fallback_dir: &Path) -> Option<String> {
    fingerprint_from(system_machine_id(), fallback_dir)
}

/// 拆出来是为了能测兜底那条路：真机上系统 id 总是拿得到，那条路平时走不到。
pub fn fingerprint_from(system_id: Option<String>, fallback_dir: &Path) -> Option<String> {
    let raw = system_id.or_else(|| persisted_machine_id(fallback_dir))?;
    Some(fingerprint_of(&raw))
}

pub fn fingerprint_of(raw_id: &str) -> String {
    hex::encode(Sha256::digest(format!("{NAMESPACE}\n{raw_id}").as_bytes()))
}

fn system_machine_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
            if let Some(id) = std::fs::read_to_string(path).ok().and_then(|raw| usable_machine_id(&raw)) {
                return Some(id);
            }
        }
    }
    sysinfo::Product::uuid().and_then(|raw| usable_machine_id(&raw))
}

fn persisted_machine_id(dir: &Path) -> Option<String> {
    let path = dir.join("machine-id");
    if let Some(id) = std::fs::read_to_string(&path).ok().and_then(|raw| usable_machine_id(&raw)) {
        return Some(id);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

/// 规整成小写、去掉连字符；空的、全是同一个字符的（全 0、全 F）、厂商占位值一律不认 ——
/// 这些值很多台机器共用，拿来当指纹会把不相干的机器的信誉搅在一起。
pub fn usable_machine_id(raw: &str) -> Option<String> {
    let id: String = raw.trim().to_ascii_lowercase().chars().filter(|c| *c != '-').collect();
    let mut chars = id.chars();
    let first = chars.next()?;
    if id.len() < 16 || chars.all(|c| c == first) || id == PLACEHOLDER_UUID {
        return None;
    }
    Some(id)
}
