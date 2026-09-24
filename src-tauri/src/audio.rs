//! 播放地址解析与音频流式转发（支持 Range 拖动 + 分片 + failover）。
//!
//! 两条容易踩的坑（都曾造成「某个视频怎么都播不了，别的都正常」）：
//! 1. B 站的 `backupUrl` / `backup_url` 是**数组**，用 `as_str()` 取值恒为 `None` ——
//!    备用地址会被整体丢弃，`urls` 只剩 `baseUrl` 一条，首选节点不通就没有任何退路。
//! 2. 新视频的音轨 `baseUrl` 常被指向 **PCDN/P2P 节点**（`*.mcdn.bilivideo.cn:8082`），
//!    这类节点在不同网络下可达性差别极大。因此按「常规 CDN 优先、PCDN 兜底」重排。

use futures_util::StreamExt;

use crate::{bili, state::AppState};

const PLAYURL_CACHE_TTL: u64 = 20 * 60;
const PLAYURL_CACHE_MAX: usize = 80;
const AUDIO_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const UPSTREAM_MAX_ATTEMPTS: usize = 5;
/// 上游「连上但不给数据」的容忍时长。PCDN 节点常见这种半死状态：
/// 连接能建立，但首字节迟迟不来。不设这个上限，播放器会一直缓冲而不去换节点。
const UPSTREAM_FIRST_BYTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// 拉取 playurl（带风控退避重试），返回 json 或 None
pub async fn fetch_play_url(state: &AppState, bvid: &str, cid: &str, fnval: &str) -> Option<serde_json::Value> {
    let url = format!(
        "https://api.bilibili.com/x/player/playurl?bvid={}&cid={}&fnval={}&fnver=0&fourk=1",
        urlencoding::encode(bvid),
        urlencoding::encode(cid),
        urlencoding::encode(fnval)
    );

    let mut last: Option<serde_json::Value> = None;
    for i in 0..3 {
        let r = bili::bili_request(state, &url, None, None).await.ok();
        last = r.as_ref().and_then(|resp| resp.json.clone());
        let code = last
            .as_ref()
            .and_then(|j| j.get("code"))
            .and_then(|c| c.as_i64());
        if last.is_none() || code == Some(-412) || code == Some(-352) {
            if i < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(600 * (i as u64 + 1))).await;
                continue;
            }
            break;
        }
        break;
    }
    last
}

// ---------------------------------------------------------------------------
// 地址收集与排序
// ---------------------------------------------------------------------------

/// 取出字段里的地址：兼容**字符串**与**数组**两种形态。
/// ⚠ 这里必须能吃数组 —— `backupUrl` 就是数组，早期实现用 `as_str()` 取它，
/// 结果恒为 `None`，备用 CDN 全部丢失。
fn take_urls(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

/// 是否为 PCDN / P2P 节点（B 站新视频常把整条音轨都指向它）
pub fn is_pcdn(url: &str) -> bool {
    let h = host_of(url);
    if h.is_empty() {
        return false;
    }
    h.contains("mcdn")
        || h.contains("pcdn")
        || h.contains("szbdyd.com")
        || url.contains(":8082/")
}

/// 收集一个流的所有候选地址：主流地址先入列，备用地址全量展开；
/// 保序去重后按「常规 CDN 在前、PCDN 兜底」重排（稳定排序，同档内保持原顺序）。
///
/// ⚠ 字段名两套：DASH 的 audio 用 `baseUrl` / `backupUrl`，降级的 durl 用
/// `url` / `backup_url`。漏掉 `url` 会让 durl 降级路径整条失效。
fn candidate_urls(item: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |u: String| {
        if !out.contains(&u) {
            out.push(u);
        }
    };
    for key in ["baseUrl", "base_url", "baseurl", "url"] {
        for u in take_urls(item.get(key)) {
            push(u);
        }
    }
    for key in ["backupUrl", "backup_url", "backupurl"] {
        for u in take_urls(item.get(key)) {
            push(u);
        }
    }
    out.sort_by_key(|u| u8::from(is_pcdn(u)));
    out
}

/// 从 playurl 响应中提取音频列表
pub fn extract_audio_list(pdata: &serde_json::Value) -> Vec<serde_json::Value> {
    let data = match pdata.get("data") {
        Some(d) => d,
        None => return vec![],
    };

    // 1. DASH 独立音频流
    if let Some(dash) = data.get("dash") {
        if let Some(audio) = dash.get("audio").and_then(|v| v.as_array()) {
            let mut out = Vec::new();
            for (i, a) in audio.iter().enumerate() {
                let urls = candidate_urls(a);
                if urls.is_empty() {
                    continue;
                }
                out.push(serde_json::json!({
                    "id": a.get("id").and_then(|v| v.as_i64()).unwrap_or(i as i64),
                    "baseUrl": urls[0],
                    "urls": urls,
                    "bandwidth": a.get("bandwidth").and_then(|v| v.as_f64()).unwrap_or(0.0),
                }));
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    // 2. 降级 durl 合并流
    if let Some(durl) = data.get("durl").and_then(|v| v.as_array()) {
        if !durl.is_empty() {
            let mut best = durl[0].clone();
            for d in durl.iter().skip(1) {
                let bid = d.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                let aid = best.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                if bid != aid {
                    if bid > aid {
                        best = d.clone();
                    }
                } else {
                    let bs = d.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let asz = best.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if bs > asz {
                        best = d.clone();
                    }
                }
            }
            let urls = candidate_urls(&best);
            if !urls.is_empty() {
                return vec![serde_json::json!({
                    "id": best.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                    "baseUrl": urls[0],
                    "urls": urls,
                    "bandwidth": best.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0),
                })];
            }
        }
    }
    vec![]
}

fn play_url_needs_login(resp: &serde_json::Value) -> bool {
    let code = resp.get("code").and_then(|c| c.as_i64());
    if code == Some(-101) || code == Some(-404) || code == Some(-403) {
        return true;
    }
    let msg = resp.get("message").and_then(|m| m.as_str()).unwrap_or("");
    ["登录", "大会员", "权限", "风控", "账号", "异常"]
        .iter()
        .any(|k| msg.contains(k))
}

/// 解析可用音频（DASH 优先，降级 durl）
pub struct ResolvedAudio {
    pub ok: bool,
    pub audio: Vec<serde_json::Value>,
    pub source: String,
    pub resp: Option<serde_json::Value>,
    pub needs_login: bool,
    pub throttled: bool,
    pub message: String,
}

pub async fn resolve_audio(state: &AppState, bvid: &str, cid: &str) -> ResolvedAudio {
    let mut throttled = false;

    let dash = fetch_play_url(state, bvid, cid, "16").await;
    if let Some(d) = &dash {
        if d.get("code").and_then(|c| c.as_i64()).is_none()
            || d.get("code").and_then(|c| c.as_i64()) == Some(-412)
            || d.get("code").and_then(|c| c.as_i64()) == Some(-352)
        {
            throttled = true;
        }
        if d.get("code").and_then(|c| c.as_i64()) == Some(0) && d.get("data").is_some() {
            let audio = extract_audio_list(d);
            if !audio.is_empty() {
                return ResolvedAudio {
                    ok: true,
                    audio,
                    source: "dash".to_string(),
                    resp: Some(d.clone()),
                    needs_login: false,
                    throttled: false,
                    message: String::new(),
                };
            }
        }
    }

    let durl = fetch_play_url(state, bvid, cid, "1").await;
    if let Some(d) = &durl {
        if d.get("code").and_then(|c| c.as_i64()).is_none()
            || d.get("code").and_then(|c| c.as_i64()) == Some(-412)
            || d.get("code").and_then(|c| c.as_i64()) == Some(-352)
        {
            throttled = true;
        }
        if d.get("code").and_then(|c| c.as_i64()) == Some(0) && d.get("data").is_some() {
            let audio = extract_audio_list(d);
            if !audio.is_empty() {
                return ResolvedAudio {
                    ok: true,
                    audio,
                    source: "durl".to_string(),
                    resp: Some(d.clone()),
                    needs_login: false,
                    throttled: false,
                    message: String::new(),
                };
            }
        }
    }

    let needs_login = dash.as_ref().map(|d| play_url_needs_login(d)).unwrap_or(false)
        || durl.as_ref().map(|d| play_url_needs_login(d)).unwrap_or(false);
    if needs_login {
        return ResolvedAudio {
            ok: false,
            audio: vec![],
            source: String::new(),
            resp: None,
            needs_login: true,
            throttled: false,
            message: "需要登录或大会员权限".to_string(),
        };
    }
    if throttled {
        return ResolvedAudio {
            ok: false,
            audio: vec![],
            source: String::new(),
            resp: None,
            needs_login: false,
            throttled: true,
            message: "请求太频繁，请稍后重试".to_string(),
        };
    }
    ResolvedAudio {
        ok: false,
        audio: vec![],
        source: String::new(),
        resp: None,
        needs_login: false,
        throttled: false,
        message: "该视频暂无可用音轨".to_string(),
    }
}

/// 播放地址缓存 key
fn playurl_key(bvid: &str, cid: &str) -> String {
    format!("{}:{}", bvid, cid)
}

/// 丢掉某条内容的播放地址缓存。
/// 用于「这批地址已经全军覆没」时：不清掉的话，20 分钟内的重试都会拿到同一批坏地址，
/// 表现就是用户说的「重试好多次都不行」。
pub fn invalidate_playurl_cache(state: &AppState, bvid: &str, cid: &str) {
    let key = playurl_key(bvid, cid);
    if let Ok(mut cache) = state.playurl_cache.lock() {
        cache.remove(&key);
    }
}

/// 把一次成功的解析写入地址缓存。
/// 抽出来给 `/api/playurl` 复用：前端刚校验到「地址已更新」，紧接着的 `/api/audio`
/// 就应该用上这批新地址，而不是继续吃缓存里那份坏地址。
pub fn store_resolved(state: &AppState, bvid: &str, cid: &str, resolved: &ResolvedAudio) {
    if !resolved.ok {
        return;
    }
    let key = playurl_key(bvid, cid);
    let mut cache = state.playurl_cache.lock().unwrap();
    if cache.len() >= PLAYURL_CACHE_MAX {
        let keys: Vec<String> = cache.keys().cloned().collect();
        for k in keys.iter().take(keys.len() / 2) {
            cache.remove(k);
        }
    }
    cache.insert(
        key,
        crate::state::PlayUrlEntry {
            ts: bili::now_secs(),
            audio: resolved.audio.clone(),
            source: resolved.source.clone(),
            resp: resolved.resp.clone().unwrap_or(serde_json::json!({})),
        },
    );
}

/// 带缓存解析音频；`refresh = true` 时忽略缓存重新向 B 站要一批新地址
pub async fn resolve_audio_cached(state: &AppState, bvid: &str, cid: &str, refresh: bool) -> ResolvedAudio {
    let key = playurl_key(bvid, cid);
    if !refresh {
        let cache = state.playurl_cache.lock().unwrap();
        if let Some(hit) = cache.get(&key) {
            if bili::now_secs() - hit.ts < PLAYURL_CACHE_TTL {
                return ResolvedAudio {
                    ok: true,
                    audio: hit.audio.clone(),
                    source: hit.source.clone(),
                    resp: Some(hit.resp.clone()),
                    needs_login: false,
                    throttled: false,
                    message: String::new(),
                };
            }
        }
    }

    let resolved = resolve_audio(state, bvid, cid).await;
    store_resolved(state, bvid, cid, &resolved);
    resolved
}

/// 解析客户端 Range 头。
/// 只认 `bytes=start-` / `bytes=start-end`；
/// 后缀形式 `bytes=-N`（要最后 N 字节）需要先知道文件总长才能换算，
/// 这里不做映射，按「从头取」处理 —— 若把 N 当成起点会返回完全错误的数据。
fn parse_client_range(range: Option<&str>) -> (u64, Option<u64>) {
    let range = match range {
        Some(r) => r.trim(),
        None => return (0, None),
    };
    let body = match range.strip_prefix("bytes=") {
        Some(b) => b,
        None => return (0, None),
    };
    let parts: Vec<&str> = body.split('-').collect();
    if parts.len() != 2 || parts[0].is_empty() {
        return (0, None);
    }
    let start = match parts[0].parse::<u64>() {
        Ok(s) => s,
        Err(_) => return (0, None),
    };
    let end = if parts[1].is_empty() {
        None
    } else {
        parts[1].parse::<u64>().ok()
    };
    (start, end)
}

/// 判断音频 Content-Type
fn audio_content_type(upstream_ct: Option<&str>, audio_url: &str) -> String {
    let ct = upstream_ct.unwrap_or("").to_lowercase();
    if ct.starts_with("audio/") {
        return upstream_ct.unwrap_or("audio/mp4").to_string();
    }
    if ct == "application/octet-stream"
        || ct.is_empty()
        || audio_url.contains(".m4s?")
        || audio_url.contains(".mp4?")
        || audio_url.ends_with(".m4s")
        || audio_url.ends_with(".mp4")
    {
        return "audio/mp4".to_string();
    }
    upstream_ct.unwrap_or("audio/mp4").to_string()
}

/// 分段流式转发的结果
pub enum StreamOutcome {
    /// 可以返回给客户端了（尚未写出任何字节）
    Ready(axum::response::Response),
    /// 客户端请求的区间越界（上游 416）：这是合法语义，原样回 416 即可，
    /// 不要再拿别的节点重试。
    RangeNotSatisfiable(String),
    /// 所有候选地址都失败，附上逐地址的原因（用于日志与提示）
    Failed(Vec<String>),
}

/// 分段流式转发音频：向客户端返回 206/200（带 Content-Range）
pub async fn stream_audio(
    state: &AppState,
    urls: &[String],
    client_range: Option<&str>,
) -> StreamOutcome {
    let list: Vec<&String> = urls.iter().filter(|u| !u.is_empty()).collect();
    if list.is_empty() {
        return StreamOutcome::Failed(vec!["没有可用候选地址".to_string()]);
    }

    let has_client_range = client_range.map(|r| !r.trim().is_empty()).unwrap_or(false);
    let (start, client_end) = parse_client_range(client_range);
    let req_end = match client_end {
        None => start.saturating_add(AUDIO_CHUNK_BYTES - 1),
        Some(e) => e.min(start.saturating_add(AUDIO_CHUNK_BYTES - 1)),
    };

    let mut errs: Vec<String> = Vec::new();

    for attempt in 0..UPSTREAM_MAX_ATTEMPTS {
        let url = list[attempt % list.len()];
        let host = {
            let h = host_of(url);
            if h.is_empty() {
                "?".to_string()
            } else {
                h
            }
        };

        let req = state
            .http
            .get(url)
            .header("Referer", bili::REFERER)
            .header("Accept", "*/*")
            .header("Range", format!("bytes={}-{}", start, req_end));
        let req = if bili::is_bili_host(&host) {
            let cookie = state.cookie_header();
            if !cookie.is_empty() {
                req.header("Cookie", cookie)
            } else {
                req
            }
        } else {
            req
        };

        let resp = match tokio::time::timeout(UPSTREAM_FIRST_BYTE_TIMEOUT, req.send()).await {
            Err(_) => {
                errs.push(format!("{} 连接超时", host));
                continue;
            }
            Ok(Err(e)) => {
                errs.push(format!("{} 请求失败({})", host, e));
                continue;
            }
            Ok(Ok(r)) => r,
        };

        let status = resp.status().as_u16();

        // 416：客户端要的区间超出文件末尾
        if status == 416 {
            let cr = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("-")
                .to_string();
            return StreamOutcome::RangeNotSatisfiable(format!("{} 返回 416 {}", host, cr));
        }
        if status != 200 && status != 206 {
            errs.push(format!("{} 返回状态 {}", host, status));
            continue;
        }

        let upstream_ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let content_range = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let upstream_len = resp.content_length();

        // 起点非 0 却回 200，说明上游忽略了 Range，返回的是「从头开始」的整段数据。
        // 直接透传会让客户端把开头当成 seek 目标位置，数据错位 —— 换下一个候选。
        if status == 200 && start > 0 {
            errs.push(format!("{} 忽略 Range 返回 200（起点 {}）", host, start));
            continue;
        }

        let (mut range_start, mut range_end, mut total) =
            parse_content_range(content_range.as_deref(), start, &resp);
        if status == 200 {
            // 200 = 完整资源：长度以 Content-Length 为准
            let n = upstream_len
                .unwrap_or_else(|| range_end.saturating_sub(range_start).saturating_add(1));
            range_start = 0;
            range_end = n.saturating_sub(1);
            total = Some(n);
        }
        let body_len = range_end.saturating_sub(range_start).saturating_add(1);

        // 首字节也要设上限：连上但不给数据是 PCDN 的典型半死状态
        let mut stream = Box::pin(resp.bytes_stream());
        let first = match tokio::time::timeout(UPSTREAM_FIRST_BYTE_TIMEOUT, stream.next()).await {
            Err(_) => {
                errs.push(format!("{} 首字节超时", host));
                continue;
            }
            Ok(None) => {
                errs.push(format!("{} 响应体为空", host));
                continue;
            }
            Ok(Some(Err(e))) => {
                errs.push(format!("{} 读取失败({})", host, e));
                continue;
            }
            Ok(Some(Ok(chunk))) => chunk,
        };

        let ct = audio_content_type(upstream_ct.as_deref(), url);
        let mut builder = axum::response::Response::builder()
            .header("Content-Type", ct)
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-store")
            .header("Content-Length", body_len.to_string());

        // 客户端带了 Range 就必须回 206 + Content-Range。
        // 明明声明了 Accept-Ranges: bytes，却对 Range 请求回 200（上游 200 时旧逻辑就是这样），
        // 会让 media 引擎判定「服务端不支持区间」，进而放弃分段预读与 seek。
        if has_client_range || status == 206 || range_start > 0 {
            let total_str = total
                .map(|t| t.to_string())
                .unwrap_or_else(|| "*".to_string());
            builder = builder
                .status(axum::http::StatusCode::PARTIAL_CONTENT)
                .header(
                    "Content-Range",
                    format!("bytes {}-{}/{}", range_start, range_end, total_str),
                );
        } else {
            builder = builder.status(axum::http::StatusCode::OK);
        }

        let head_stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(first)]);
        let tail = stream.map(|c| c.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
        let body = axum::body::Body::from_stream(head_stream.chain(tail));

        match builder.body(body) {
            Ok(r) => return StreamOutcome::Ready(r),
            Err(e) => {
                errs.push(format!("{} 构造响应失败({})", host, e));
                continue;
            }
        }
    }

    StreamOutcome::Failed(errs)
}

/// 解析 Content-Range
fn parse_content_range(
    cr: Option<&str>,
    fallback_start: u64,
    resp: &reqwest::Response,
) -> (u64, u64, Option<u64>) {
    if let Some(cr) = cr {
        // "bytes 0-2097151/100000000"
        if let Some(body) = cr.strip_prefix("bytes ") {
            let seg = body.split('/').next().unwrap_or("");
            let mut parts = seg.split('-');
            if let (Some(s), Some(e)) = (parts.next(), parts.next()) {
                if let (Ok(s), Ok(e)) = (s.parse::<u64>(), e.parse::<u64>()) {
                    let total = body
                        .split('/')
                        .nth(1)
                        .and_then(|t| if t == "*" { None } else { t.parse::<u64>().ok() });
                    return (s, e, total);
                }
            }
        }
    }
    let len = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    (fallback_start, fallback_start + len.saturating_sub(1), None)
}

// ---------------------------------------------------------------------------
// 单元测试：地址解析是「某个视频播不了」那类问题的第一现场，必须锁住
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_urls_accepts_string_and_array() {
        assert_eq!(take_urls(Some(&serde_json::json!("a"))), vec!["a"]);
        assert_eq!(take_urls(Some(&serde_json::json!(""))), Vec::<String>::new());
        assert_eq!(
            take_urls(Some(&serde_json::json!(["a", "b", ""]))),
            vec!["a", "b"]
        );
        assert_eq!(take_urls(Some(&serde_json::json!(null))), Vec::<String>::new());
        assert_eq!(take_urls(None), Vec::<String>::new());
    }

    #[test]
    fn pcdn_detection() {
        assert!(is_pcdn("https://xy39x184x180x119xy.mcdn.bilivideo.cn:8082/v1/resource/x"));
        assert!(is_pcdn("https://foo.bar.bilivideo.com:8082/x"));
        assert!(!is_pcdn("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/x.m4s"));
        assert!(!is_pcdn("https://cn-sccd-ct-02-04.bilivideo.com/x"));
    }

    /// 回归：`backupUrl` 是数组，必须展开；且常规 CDN 要排在 PCDN 前面。
    #[test]
    fn candidates_expand_backup_array_and_prefer_normal_cdn() {
        let item = serde_json::json!({
            "baseUrl": "https://xy1.mcdn.bilivideo.cn:8082/v1/resource/a",
            "backupUrl": [
                "https://cn-sccd-ct-02-04.bilivideo.com/b",
                "https://upos-sz-mirrorcos.bilivideo.com/c"
            ]
        });
        let urls = candidate_urls(&item);
        assert_eq!(urls.len(), 3, "baseUrl + 两个 backupUrl 都要收进来");
        // 前两个必须是常规 CDN（保持原始顺序），PCDN 掉到最后
        assert!(urls[0].contains("cn-sccd-ct-02-04"));
        assert!(urls[1].contains("upos-sz-mirrorcos"));
        assert!(is_pcdn(&urls[2]));
    }

    #[test]
    fn candidates_keep_normal_order_when_all_cdn() {
        let item = serde_json::json!({
            "baseUrl": "https://upos-sz-mirrorcos.bilivideo.com/a",
            "backupUrl": ["https://upos-sz-estgoss.bilivideo.com/b"]
        });
        let urls = candidate_urls(&item);
        assert_eq!(urls.len(), 2);
        assert!(urls[0].contains("mirrorcos"));
        assert!(urls[1].contains("estgoss"));
    }

    #[test]
    fn candidates_dedup_and_accept_snake_case() {
        let item = serde_json::json!({
            "base_url": "https://upos-sz-mirrorcos.bilivideo.com/a",
            "backup_url": "https://upos-sz-mirrorcos.bilivideo.com/a"
        });
        assert_eq!(candidate_urls(&item).len(), 1);
    }

    /// 用真实 playurl 响应的形状跑一遍，确认每档音轨都拿到 3 个地址。
    #[test]
    fn extract_audio_list_keeps_all_fallbacks() {
        let resp = serde_json::json!({
            "code": 0,
            "data": {
                "dash": {
                    "duration": 38,
                    "audio": [
                        {
                            "id": 30216,
                            "bandwidth": 65890,
                            "baseUrl": "https://xy39x184x180x119xy.mcdn.bilivideo.cn:8082/v1/resource/a",
                            "backupUrl": [
                                "https://cn-sccd-ct-02-04.bilivideo.com/b",
                                "https://upos-sz-mirrorcos.bilivideo.com/c"
                            ]
                        },
                        {
                            "id": 30280,
                            "bandwidth": 109805,
                            "baseUrl": "https://upos-sz-estgoss.bilivideo.com/d",
                            "backupUrl": ["https://upos-sz-mirrorhwb.bilivideo.com/e"]
                        }
                    ]
                }
            }
        });
        let list = extract_audio_list(&resp);
        assert_eq!(list.len(), 2);
        // 30216：1 个 baseUrl + 2 个 backupUrl = 3 条候选，且常规 CDN 排在前
        let a = list[0]["urls"].as_array().unwrap();
        assert_eq!(a.len(), 3, "每个音轨都要带上全部备选地址");
        assert!(a[0].as_str().unwrap().contains("cn-sccd-ct-02-04"));
        assert!(a[1].as_str().unwrap().contains("upos-sz-mirrorcos"));
        assert!(is_pcdn(a[2].as_str().unwrap()));
        // 30280：1 + 1 = 2 条候选，顺序原样保留
        let b = list[1]["urls"].as_array().unwrap();
        assert_eq!(b.len(), 2);
        assert!(b[0].as_str().unwrap().contains("estgoss"));
    }

    /// 降级链：dash.audio 为空时走 durl，字段名是 `url` / `backup_url`（字符串），
    /// 且要在多段里挑 id 最大的那一档。
    #[test]
    fn extract_audio_list_falls_back_to_durl() {
        let resp = serde_json::json!({
            "code": 0,
            "data": {
                "dash": { "audio": [] },
                "durl": [
                    {
                        "id": 64, "size": 10,
                        "url": "https://upos-sz-mirrorcos.bilivideo.com/a",
                        "backup_url": "https://upos-sz-estgoss.bilivideo.com/b"
                    },
                    {
                        "id": 80, "size": 20,
                        "url": "https://upos-sz-mirrorbd.bilivideo.com/c",
                        "backup_url": "https://upos-sz-mirrorhwb.bilivideo.com/d"
                    }
                ]
            }
        });
        let list = extract_audio_list(&resp);
        assert_eq!(list.len(), 1);
        let urls = list[0]["urls"].as_array().unwrap();
        // 主流 + backup_url 都要收进来
        assert_eq!(urls.len(), 2);
        // 选中 id 更大的那一档（80）
        assert!(list[0]["baseUrl"].as_str().unwrap().contains("mirrorbd"));
        assert!(urls[1].as_str().unwrap().contains("mirrorhwb"));
    }

    #[test]
    fn client_range_parsing() {
        assert_eq!(parse_client_range(None), (0, None));
        assert_eq!(parse_client_range(Some("bytes=0-")), (0, None));
        assert_eq!(parse_client_range(Some("bytes=100-200")), (100, Some(200)));
        assert_eq!(parse_client_range(Some("bytes=-")), (0, None));
        assert_eq!(parse_client_range(Some("items=0-")), (0, None));
        // 后缀形式不能把 N 误当起点（否则返回的是开头的数据而不是末尾的）
        assert_eq!(parse_client_range(Some("bytes=-1")), (0, None));
        assert_eq!(parse_client_range(Some("bytes=-500")), (0, None));
        assert_eq!(parse_client_range(Some("bytes=abc-")), (0, None));
    }
}
