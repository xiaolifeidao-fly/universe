use serde_json::{json, Value};
use std::sync::atomic::{AtomicU8, Ordering};

/// 结构化日志，零依赖。level 由 LOG_LEVEL 或 config.log.level 决定。
/// 约定：任何日志 meta 里都不放 token / 凭据原文，最多放 alias 或前缀。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level { Debug = 10, Info = 20, Warn = 30, Error = 40 }

impl Level {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "debug" => Some(Level::Debug),
            "info" => Some(Level::Info),
            "warn" => Some(Level::Warn),
            "error" => Some(Level::Error),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

static MIN_LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);
static SILENT: AtomicU8 = AtomicU8::new(0);

pub fn set_log_level(level: Level) {
    MIN_LEVEL.store(level as u8, Ordering::Relaxed);
}

/// 测试里把日志静音。等价 TS 的 setLogSink(() => {})。
pub fn set_silent(silent: bool) {
    SILENT.store(u8::from(silent), Ordering::Relaxed);
}

pub fn init_from_env(env: &crate::core::paths::Env) {
    if let Some(level) = env.get("LOG_LEVEL").and_then(Level::parse) {
        set_log_level(level);
    }
}

pub fn emit(level: Level, msg: &str, meta: Value) {
    if (level as u8) < MIN_LEVEL.load(Ordering::Relaxed) || SILENT.load(Ordering::Relaxed) == 1 {
        return;
    }
    let mut line = json!({ "time": now_iso(), "level": level.label(), "msg": msg });
    if let (Some(target), Some(extra)) = (line.as_object_mut(), meta.as_object()) {
        for (k, v) in extra {
            target.insert(k.clone(), v.clone());
        }
    }
    let text = line.to_string();
    match level {
        Level::Warn | Level::Error => eprintln!("{text}"),
        _ => println!("{text}"),
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[macro_export]
macro_rules! log_line {
    ($level:expr, $msg:expr) => { $crate::core::logger::emit($level, $msg, ::serde_json::Value::Null) };
    ($level:expr, $msg:expr, $($json:tt)+) => {
        $crate::core::logger::emit($level, $msg, ::serde_json::json!({ $($json)+ }))
    };
}
#[macro_export]
macro_rules! log_debug { ($($args:tt)*) => { $crate::log_line!($crate::core::logger::Level::Debug, $($args)*) } }
#[macro_export]
macro_rules! log_info { ($($args:tt)*) => { $crate::log_line!($crate::core::logger::Level::Info, $($args)*) } }
#[macro_export]
macro_rules! log_warn { ($($args:tt)*) => { $crate::log_line!($crate::core::logger::Level::Warn, $($args)*) } }
#[macro_export]
macro_rules! log_error { ($($args:tt)*) => { $crate::log_line!($crate::core::logger::Level::Error, $($args)*) } }
