use serde_json::{Map, Value};
use std::sync::OnceLock;

/// 轻量 TOML。
///
/// 只为读 config.toml 里几个标量键，不做完整 TOML 校验：支持表头（含带引号的点分段）、
/// 数组表头、点分键、基本/字面字符串、布尔、数字、单行数组与内联表。
/// 认不出的值原样存成字符串 —— 读不懂的键这里本来就不用。
///
/// 刻意不换成严格解析器：主人的 config.toml 里有一行我们不认识的写法时，
/// 严格解析会整份放弃、把上游悄悄退回官方地址；宽松解析只丢那一行。
pub fn parse_toml_lite(text: &str) -> Map<String, Value> {
    let mut root = Map::new();
    let mut current: Vec<String> = vec![];

    for raw_line in text.split('\n') {
        let line = strip_comment(raw_line.trim_end_matches('\r')).trim().to_string();
        if line.is_empty() {
            continue;
        }

        if line.starts_with('[') {
            let is_array = line.starts_with("[[");
            let close = line.rfind(if is_array { "]]" } else { "]" });
            let Some(close) = close else { continue };
            let start = if is_array { 2 } else { 1 };
            if close < start {
                continue;
            }
            let keys = split_key_path(line[start..close].trim());
            if keys.is_empty() {
                continue;
            }
            if is_array {
                let (parents, last) = keys.split_at(keys.len() - 1);
                let parent = table_at(&mut root, parents);
                if !matches!(parent.get(&last[0]), Some(Value::Array(_))) {
                    parent.insert(last[0].clone(), Value::Array(vec![]));
                }
                if let Some(Value::Array(items)) = parent.get_mut(&last[0]) {
                    items.push(Value::Object(Map::new()));
                }
            } else {
                table_at(&mut root, &keys);
            }
            current = keys;
            continue;
        }

        let Some(eq) = index_of_unquoted(&line, '=') else { continue };
        let keys = split_key_path(line[..eq].trim());
        if keys.is_empty() {
            continue;
        }
        let value = parse_value(line[eq + 1..].trim());
        let (parents, last) = keys.split_at(keys.len() - 1);
        let node = table_at(&mut root, &current);
        let node = table_at(node, parents);
        node.insert(last[0].clone(), value);
    }
    root
}

fn table_at<'a>(root: &'a mut Map<String, Value>, path: &[String]) -> &'a mut Map<String, Value> {
    let mut node = root;
    for key in path {
        node = descend(node, key);
    }
    node
}

fn descend<'a>(node: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let reuse = match node.get(key) {
        Some(Value::Array(items)) => matches!(items.last(), Some(Value::Object(_))),
        Some(Value::Object(_)) => true,
        _ => false,
    };
    if !reuse {
        node.insert(key.to_string(), Value::Object(Map::new()));
    }
    match node.get_mut(key) {
        Some(Value::Array(items)) => match items.last_mut() {
            Some(Value::Object(map)) => map,
            _ => unreachable!("descend 只在最后一项是表时复用数组"),
        },
        Some(Value::Object(map)) => map,
        _ => unreachable!("descend 刚写入过一个表"),
    }
}

fn strip_comment(line: &str) -> &str {
    match index_of_unquoted(line, '#') {
        Some(index) => &line[..index],
        None => line,
    }
}

/// 找引号外第一个 needle。TOML 的注释与等号都不能出现在字符串里被误认。
fn index_of_unquoted(text: &str, needle: char) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut chars = text.char_indices();
    while let Some((i, ch)) = chars.next() {
        if let Some(q) = quote {
            if ch == '\\' && q == '"' {
                chars.next();
            } else if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            _ if ch == needle => return Some(i),
            _ => {}
        }
    }
    None
}

fn split_key_path(raw: &str) -> Vec<String> {
    let mut keys = vec![];
    let mut buffer = String::new();
    let mut quote: Option<char> = None;
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == '\\' && q == '"' {
                if let Some(next) = chars.next() {
                    buffer.push(next);
                }
            } else if ch == q {
                quote = None;
            } else {
                buffer.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            '.' => {
                keys.push(buffer.trim().to_string());
                buffer.clear();
            }
            _ => buffer.push(ch),
        }
    }
    keys.push(buffer.trim().to_string());
    keys.retain(|k| !k.is_empty());
    keys
}

fn number_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$").unwrap())
}

fn parse_value(raw: &str) -> Value {
    if raw.starts_with("\"\"\"") || raw.starts_with("'''") {
        return Value::String(raw.to_string());
    }
    if let Some(rest) = raw.strip_prefix('"') {
        let inner = if raw.len() > 1 && raw.ends_with('"') { &rest[..rest.len() - 1] } else { rest };
        return Value::String(unescape_basic(inner));
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        let inner = if raw.len() > 1 && raw.ends_with('\'') { &rest[..rest.len() - 1] } else { rest };
        return Value::String(inner.to_string());
    }
    if raw == "true" {
        return Value::Bool(true);
    }
    if raw == "false" {
        return Value::Bool(false);
    }
    if number_re().is_match(raw) {
        let digits = raw.replace('_', "");
        // JS 只有一种数字类型，TOML 有整数和浮点。整数保持整数，
        // 否则 `bar = 1` 会变成 1.0，跟 TS 侧读出来的值对不上。
        if !digits.contains(['.', 'e', 'E']) {
            if let Ok(number) = digits.parse::<i64>() {
                return Value::Number(number.into());
            }
        }
        if let Ok(number) = digits.parse::<f64>() {
            if let Some(n) = serde_json::Number::from_f64(number) {
                return Value::Number(n);
            }
        }
    }
    if raw.starts_with('[') && raw.ends_with(']') && raw.len() >= 2 {
        return Value::Array(split_top_level(&raw[1..raw.len() - 1]).iter().map(|p| parse_value(p)).collect());
    }
    if raw.starts_with('{') && raw.ends_with('}') && raw.len() >= 2 {
        let mut table = Map::new();
        for pair in split_top_level(&raw[1..raw.len() - 1]) {
            let Some(eq) = index_of_unquoted(&pair, '=') else { continue };
            let keys = split_key_path(pair[..eq].trim());
            if keys.is_empty() {
                continue;
            }
            let value = parse_value(pair[eq + 1..].trim());
            let (parents, last) = keys.split_at(keys.len() - 1);
            let node = table_at(&mut table, parents);
            node.insert(last[0].clone(), value);
        }
        return Value::Object(table);
    }
    Value::String(raw.to_string())
}

/// 按引号与括号之外的逗号切分。
fn split_top_level(raw: &str) -> Vec<String> {
    let mut parts = vec![];
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut buffer = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            buffer.push(ch);
            if ch == '\\' && q == '"' {
                if let Some(next) = chars.next() {
                    buffer.push(next);
                }
            } else if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                buffer.push(ch);
            }
            '[' | '{' => {
                depth += 1;
                buffer.push(ch);
            }
            ']' | '}' => {
                depth -= 1;
                buffer.push(ch);
            }
            ',' if depth == 0 => {
                parts.push(buffer.trim().to_string());
                buffer.clear();
            }
            _ => buffer.push(ch),
        }
    }
    if !buffer.trim().is_empty() {
        parts.push(buffer.trim().to_string());
    }
    parts.retain(|p| !p.is_empty());
    parts
}

fn unescape_basic(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let Some(code) = chars.next() else { break };
        match code {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'r' => out.push('\r'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            'u' | 'U' => {
                let width = if code == 'u' { 4 } else { 8 };
                let digits: String = chars.clone().take(width).collect();
                let valid = digits.len() == width && digits.bytes().all(|c| c.is_ascii_hexdigit());
                match valid.then(|| u32::from_str_radix(&digits, 16).ok()).flatten().and_then(char::from_u32) {
                    Some(decoded) => {
                        for _ in 0..width { chars.next(); }
                        out.push(decoded);
                    }
                    None => out.push(code),
                }
            }
            other => out.push(other),
        }
    }
    out
}
