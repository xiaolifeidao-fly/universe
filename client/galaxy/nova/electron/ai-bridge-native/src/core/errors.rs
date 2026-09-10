use serde_json::{json, Value};

/// 桥接服务内部统一的 HTTP 错误：status + code + message。
/// 各协议的错误体形态（OpenAI / Anthropic）由路由层决定，这里只表达语义。
#[derive(Debug, Clone)]
pub struct BridgeError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl BridgeError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for BridgeError {}

pub fn http_error(status: u16, code: &str, message: impl Into<String>) -> BridgeError {
    BridgeError::new(status, code, message)
}

/// 统一错误体：OpenAI SDK 读 error.message/type/code，Anthropic SDK 读 type:"error" + error.type/message，
/// 一个形态同时满足两边。模块内部若有更精确的协议形态可自行覆盖。
pub fn error_body(status: u16, code: &str, message: &str) -> Value {
    json!({ "type": "error", "error": { "type": code, "code": code, "message": message, "status": status } })
}

/// Anthropic 协议的错误体形态。
pub fn anthropic_error(status: u16, code: &str, message: &str) -> Value {
    json!({ "type": "error", "error": { "type": code, "message": message, "status": status } })
}

/// OpenAI 协议的错误体形态。
pub fn openai_error(status: u16, code: &str, message: &str) -> Value {
    json!({ "error": { "message": message, "type": code, "code": code, "param": null, "status": status } })
}
