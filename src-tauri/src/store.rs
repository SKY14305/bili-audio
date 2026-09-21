//! 本地数据持久化：history / state / collections 的读写，以及收藏列表业务逻辑。

use std::path::PathBuf;

use serde_json::Value;

/// 数据目录：默认 exe 同级 data/（便携模式，与 Electron 版打包态一致）。
/// 可用环境变量 BILI_DATA_DIR 覆盖（开发调试用）。
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BILI_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join("data");
        }
    }
    PathBuf::from("data")
}

pub fn read_json_file(file: &PathBuf, fallback: Value) -> Value {
    match std::fs::read_to_string(file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

pub fn write_json_file(file: &PathBuf, data: &Value) -> bool {
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(data) {
        Ok(body) => std::fs::write(file, body).is_ok(),
        Err(_) => false,
    }
}

pub fn history_file(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("history.json")
}
pub fn state_file(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("state.json")
}
pub fn collections_file(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("collections.json")
}

fn new_id() -> String {
    let ts = bili_now_ms();
    format!("{}{}", radix36(ts), rand_suffix())
}

fn bili_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn radix36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut s = Vec::new();
    while n > 0 {
        s.push(DIGITS[(n % 36) as usize] as char);
        n /= 36;
    }
    s.iter().rev().collect()
}

fn rand_suffix() -> String {
    // 无 rand 依赖：用时间+地址抖动生成 6 位伪随机
    let seed = bili_now_ms() ^ (std::process::id() as u64) << 32;
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut out = String::new();
    for _ in 0..6 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push((b'0' + (x >> 59) as u8 % 36) as char);
    }
    out
}

/// 条目去重键 "bvid:cid"
pub fn item_key(it: &Value) -> String {
    let bvid = it.get("bvid").and_then(|v| v.as_str()).unwrap_or("");
    let cid = it.get("cid").and_then(|v| v.as_str()).unwrap_or("");
    format!("{}:{}", bvid, cid)
}

/// 规范化收藏条目
pub fn normalize_collection_item(it: &Value) -> Option<Value> {
    let bvid = it.get("bvid")?.as_str()?;
    let cid = match it.get("cid").and_then(|v| v.as_str()) {
        Some(c) if !c.is_empty() => Value::String(c.to_string()),
        _ => Value::Null,
    };
    Some(serde_json::json!({
        "bvid": bvid,
        "cid": cid,
        "title": it.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "author": it.get("author").and_then(|v| v.as_str()).unwrap_or(""),
        "mid": it.get("mid").and_then(|v| v.as_str()).map(|s| Value::String(s.to_string())).unwrap_or(Value::Null),
        "duration": it.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "addedAt": it.get("addedAt").and_then(|v| v.as_f64()).unwrap_or(bili_now_ms() as f64),
    }))
}

/// 读取收藏列表（兼容 {version,lists} 或直接数组）
pub fn read_collections(data_dir: &PathBuf) -> Vec<Value> {
    let file = collections_file(data_dir);
    let raw = read_json_file(&file, Value::Null);
    let mut lists = if let Some(l) = raw.get("lists").and_then(|v| v.as_array()) {
        Some(l.clone())
    } else if let Some(a) = raw.as_array() {
        Some(a.clone())
    } else {
        None
    }
    .unwrap_or_default();

    let now = bili_now_ms() as f64;
    lists
        .iter_mut()
        .map(|l| {
            let items = l
                .get("items")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(normalize_collection_item).collect::<Vec<_>>())
                .unwrap_or_default();
            serde_json::json!({
                "id": l.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(new_id),
                "name": l.get("name").and_then(|v| v.as_str()).unwrap_or("未命名列表").chars().take(60).collect::<String>(),
                "createdAt": l.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(now),
                "updatedAt": l.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(now),
                "items": items,
            })
        })
        .collect()
}

pub fn write_collections(data_dir: &PathBuf, lists: &[Value]) -> bool {
    write_json_file(
        &collections_file(data_dir),
        &serde_json::json!({
            "version": 1,
            "updatedAt": bili_now_ms(),
            "lists": lists,
        }),
    )
}

/// 在已有名称集合里取不重复的名字
pub fn unique_name(base: &str, taken: &std::collections::HashSet<String>) -> String {
    let name: String = base.chars().take(60).collect();
    let name = if name.is_empty() { "未命名列表".to_string() } else { name };
    if !taken.contains(&name) {
        return name;
    }
    for i in 2..1000 {
        let suffix = format!(" ({})", i);
        let candidate = format!("{}{}", name.chars().take(60 - suffix.chars().count()).collect::<String>(), suffix);
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    format!("{} {}", name, new_id())
}
