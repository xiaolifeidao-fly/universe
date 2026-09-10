use crate::{log_info, log_warn};

/// 保留路径差异；尾斜杠、主机大小写和默认端口不构成地址变化。
fn normalize(value: &str) -> Result<String, ()> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| ())?;
    let has_query = url.query().is_some_and(|q| !q.is_empty());
    let has_fragment = url.fragment().is_some_and(|f| !f.is_empty());
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || has_query
        || has_fragment
    {
        return Err(());
    }
    Ok(format!("{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/')))
}

/// 一次校验的结论。判定与落日志分开：这样测试不必去捕获全局日志，
/// 而「什么时候该说话」这条规则本身也就能被直接断言。
#[derive(Debug, Clone, PartialEq)]
pub enum HubAddressEvent {
    Matched { hub: String },
    Mismatch { configured: String, platform: String },
    Invalid,
}

impl HubAddressEvent {
    pub fn name(&self) -> &'static str {
        match self {
            HubAddressEvent::Matched { .. } => "pool_hub_address_matched",
            HubAddressEvent::Mismatch { .. } => "pool_hub_address_mismatch",
            HubAddressEvent::Invalid => "pool_hub_address_invalid",
        }
    }
}

/// 每次心跳校验，仅状态变化时输出日志，不向公布的新地址发送节点凭据。
pub struct HubAddressCheck {
    configured: String,
    previous: String,
}

impl HubAddressCheck {
    pub fn new(configured: impl Into<String>) -> Self {
        Self { configured: configured.into(), previous: String::new() }
    }

    /// 返回 None 表示这一轮没有新情况（状态没变，或者对面没公布地址）。
    pub fn check(&mut self, advertised: Option<&str>) -> Option<HubAddressEvent> {
        // 老版本 Hub 不返回这个字段，或者没配置：未知，不当成一致。
        let Some(advertised) = advertised.filter(|value| !value.is_empty()) else {
            self.previous.clear();
            return None;
        };
        let (Ok(actual), Ok(expected)) = (normalize(&self.configured), normalize(advertised)) else {
            if self.previous == "invalid" {
                return None;
            }
            self.previous = "invalid".into();
            return Some(HubAddressEvent::Invalid);
        };
        let state = if actual == expected { "matched".to_string() } else { format!("mismatch:{expected}") };
        if state == self.previous {
            return None;
        }
        self.previous = state;
        Some(if actual == expected {
            HubAddressEvent::Matched { hub: actual }
        } else {
            HubAddressEvent::Mismatch { configured: actual, platform: expected }
        })
    }

    pub fn check_and_log(&mut self, advertised: Option<&str>) {
        match self.check(advertised) {
            Some(HubAddressEvent::Matched { hub }) => log_info!("pool_hub_address_matched", "hub": hub),
            Some(HubAddressEvent::Mismatch { configured, platform }) => {
                log_warn!("pool_hub_address_mismatch",
                    "configuredHub": configured, "platformHub": platform,
                    "hint": "本机 Hub 地址与平台公布地址不一致，请核实后在控制台重新配对这台机器")
            }
            Some(HubAddressEvent::Invalid) => log_warn!("pool_hub_address_invalid",
                "hint": "平台地址格式无效，无法校验，请检查 Hub 地址配置"),
            None => {}
        }
    }
}
