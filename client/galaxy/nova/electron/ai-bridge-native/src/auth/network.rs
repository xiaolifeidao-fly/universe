use ipnet::IpNet;
use std::net::IpAddr;

/// 来源 IP 策略。空名单 = 全部放行；配了就只放行命中的地址/网段。
pub struct IpAllowlist {
    nets: Vec<IpNet>,
}

impl IpAllowlist {
    pub fn new(entries: &[String]) -> Result<Self, String> {
        let mut nets = Vec::with_capacity(entries.len());
        for raw in entries {
            let entry = raw.trim();
            let net = if entry.contains('/') {
                entry.parse::<IpNet>()
                    .map_err(|_| format!("auth.ipAllowlist 里 CIDR 前缀不合法：{raw}"))?
            } else {
                let addr: IpAddr = entry.parse()
                    .map_err(|_| format!("auth.ipAllowlist 里不是合法 IP/CIDR：{raw}"))?;
                IpNet::from(addr)
            };
            nets.push(net);
        }
        Ok(Self { nets })
    }

    pub fn allows(&self, ip: Option<IpAddr>) -> bool {
        if self.nets.is_empty() {
            return true;
        }
        let Some(ip) = ip.map(normalize) else { return false };
        self.nets.iter().any(|net| net.contains(&ip))
    }
}

/// IPv6 栈上收到的是 ::ffff:127.0.0.1 这种映射地址，统一还原成 v4 再判断。
pub fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

pub fn is_loopback(ip: Option<IpAddr>) -> bool {
    ip.map(normalize).is_some_and(|ip| ip.is_loopback())
}
