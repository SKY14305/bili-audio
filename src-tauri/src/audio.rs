//! 播放地址解析与音频流式转发（支持 Range 拖动 + 分片 + failover）。

use crate::{bili, state::AppState};

const PLAYURL_CACHE_TTL: u64 = 20 * 60;
const PLAYURL_CACHE_MAX: usize = 80;
const AUDIO_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const UPSTREAM_MAX_ATTEMPTS: usize = 5;

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

fn pick_urls(cands: Vec<Option<&str>>) -> Vec<String> {
    let mut out = Vec::new();
    for c in cands {
        if let Some(c) = c {
            if !c.is_empty() {
                out.push(c.to_string());
            }
        }
    }
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
            if !audio.is_empty() {
                let mut out = Vec::new();
                for (i, a) in audio.iter().enumerate() {
                    let base = ["baseUrl", "base_url", "baseurl"]
                        .iter()
                        .find_map(|k| a.get(*k).and_then(|v| v.as_str()));
                    let backup = ["backupUrl", "backup_url"]
                        .iter()
                        .find_map(|k| a.get(*k).and_then(|v| v.as_str()));
                    let urls = pick_urls(vec![base, backup]);
                    if urls.is_empty() {
                        continue;
                    }
                    out.push(serde_json::json!({
                        "id": a.get("id").and_then(|v| v.as_i64()).unwrap_or(i as i64),
                        "baseUrl": base.unwrap_or(""),
                        "urls": urls,
                        "bandwidth": a.get("bandwidth").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    }));
                }
                if !out.is_empty() {
                    return out;
                }
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
            let url = best.get("url").and_then(|v| v.as_str());
            let backup = best.get("backup_url").and_then(|v| v.as_str());
            let urls = pick_urls(vec![url, backup]);
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

/// 带缓存解析音频
pub async fn resolve_audio_cached(state: &AppState, bvid: &str, cid: &str) -> ResolvedAudio {
    let key = format!("{}:{}", bvid, cid);
    {
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
    if resolved.ok {
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
            },        );
    }
    resolved
}

/// 解析客户端 Range 头
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
    if parts.len() != 2 {
        return (0, None);
    }
    let start = parts[0].parse::<u64>().unwrap_or(0);
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

/// 分段流式转发音频：向客户端返回 axum Response（206 + Content-Range）
/// 返回 None 表示所有地址都失败（尚未写出任何字节）。
pub async fn stream_audio(
    state: &AppState,
    urls: &[String],
    client_range: Option<&str>,
) -> Option<axum::response::Response> {
    let list: Vec<&String> = urls.iter().filter(|u| !u.is_empty()).collect();
    if list.is_empty() {
        return None;
    }

    let (start, client_end) = parse_client_range(client_range);
    let req_end = match client_end {
        None => start + AUDIO_CHUNK_BYTES - 1,
        Some(e) => e.min(start + AUDIO_CHUNK_BYTES - 1),
    };

    let mut last_err = String::new();

    for attempt in 0..UPSTREAM_MAX_ATTEMPTS {
        let url = list[attempt % list.len()];

        // 发起上游 Range 请求
        let req = state
            .http
            .get(url)
            .header("Referer", bili::REFERER)
            .header("Accept", "*/*")
            .header("Range", format!("bytes={}-{}", start, req_end));
        let req = if bili::is_bili_host(url::Url::parse(url).map(|u| u.host_str().unwrap_or("").to_string()).unwrap_or_default().as_str())
        {
            let cookie = state.cookie_header();
            if !cookie.is_empty() {
                req.header("Cookie", cookie)
            } else {
                req
            }
        } else {
            req
        };

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status != 200 && status != 206 {
            last_err = format!("上游返回状态 {}", status);
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

        // 解析上游 Content-Range
        let (range_start, range_end, total) = parse_content_range(content_range.as_deref(), start, &resp);
        let body_len = range_end.saturating_sub(range_start).saturating_add(1);

        // 构造响应头
        let ct = audio_content_type(upstream_ct.as_deref(), url);
        let mut resp_builder = axum::response::Response::builder()
            .status(axum::http::StatusCode::OK)
            .header("Content-Type", ct)
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-store")
            .header("Content-Length", body_len.to_string());

        if status == 206 || range_start > 0 {
            let total_str = total.map(|t| t.to_string()).unwrap_or("*".to_string());
            resp_builder = resp_builder
                .status(axum::http::StatusCode::PARTIAL_CONTENT)
                .header("Content-Range", format!("bytes {}-{}/{}", range_start, range_end, total_str));
        }

        // 流式 body：包装静默超时
        use futures_util::StreamExt;
        let stream = resp.bytes_stream().map(|chunk| {
            chunk.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        });
        let body = axum::body::Body::from_stream(stream);

        let response = match resp_builder.body(body) {
            Ok(r) => r,
            Err(_) => continue,
        };
        return Some(response);
    }

    let _ = last_err;
    None
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
