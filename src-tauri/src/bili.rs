//! B 站请求封装：通用 GET 请求、WBI 签名、md5、HTML 清洗、日志。

use md5::{Digest, Md5};

use tauri::Manager;

use crate::state::AppState;

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
pub const REFERER: &str = "https://www.bilibili.com";

/// WBI 混钥置换表
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// 风控指纹参数
pub fn dm_fingerprint() -> Vec<(&'static str, &'static str)> {
    vec![
        ("dm_img_list", "[]"),
        ("dm_img_str", "V2ViR0wgMS4w"),
        ("dm_cover_img_str", "V2ViR0wgMS4w"),
        ("dm_img_inter", r#"{"ds":[],"wh":[0,0,0],"of":[0,0,0]}"#),
    ]
}

/// 通用请求返回结构
#[derive(Clone)]
pub struct BiliResp {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub buffer: Vec<u8>,
    pub text: String,
    pub json: Option<serde_json::Value>,
}

pub fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

pub fn get_mixin_key(orig: &str) -> String {
    let bytes: Vec<char> = orig.chars().collect();
    MIXIN_KEY_ENC_TAB
        .iter()
        .filter_map(|&i| bytes.get(i))
        .take(32)
        .collect()
}

pub fn extract_wbi_key(url: &str) -> String {
    // 形如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
    let base = url.rsplit('/').next().unwrap_or("");
    base.strip_suffix(".png").unwrap_or("").to_string()
}

/// 日志（写入 data/app.log + 控制台）
pub fn log(app: &tauri::AppHandle, msg: String) {
    let line = format!("[{}] {}", chrono_like_now(), msg);
    println!("{}", line);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("app.log"))
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(line.as_bytes())
                    .and_then(|_| f.write_all(b"\n"))
            });
    }
}

fn chrono_like_now() -> String {
    // 简化的本地时间戳，避免引入 chrono 依赖
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = now / 86400;
    let secs = now % 86400;
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    // 粗略换算到 UTC+8（本地时间戳仅用于日志，无需精确到日）
    let (h2, _) = ((h + 8) % 24, 0);
    format!(
        "day{} {:02}:{:02}:{:02}",
        days, h2, m, s
    )
}

/// 判断是否为 B 站相关域名（仅对这些域名携带 cookie）
pub fn is_bili_host(hostname: &str) -> bool {
    hostname.ends_with("bilibili.com")
        || hostname.ends_with("bilibili.cn")
        || hostname.ends_with("bilivideo.com")
        || hostname.ends_with("bilivideo.cn")
}

/// 清洗 HTML 标签与常见实体
pub fn strip_html(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

/// 通用 B 站 GET 请求（自动带 UA/Referer/Cookie、跟随重定向、收集 Set-Cookie）
pub async fn bili_request(
    state: &AppState,
    url: &str,
    referer: Option<&str>,
    method: Option<&str>,
) -> Result<BiliResp, String> {
    let method = method.unwrap_or("GET");
    let referer = referer.unwrap_or(REFERER);

    let parsed = url::Url::parse(url).map_err(|e| format!("非法 URL: {} ({})", url, e))?;
    let host = parsed.host_str().unwrap_or("").to_string();

    let mut req = state
        .http
        .request(reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?, url)
        .header("Referer", referer)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");

    if is_bili_host(&host) {
        let cookie = state.cookie_header();
        if !cookie.is_empty() {
            req = req.header("Cookie", cookie);
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();

    // 收集 Set-Cookie
    let set_cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    if !set_cookies.is_empty() {
        state.merge_cookies(set_cookies.into_iter());
    }

    // 跟随重定向（最多 5 次）
    if (300..400).contains(&status) {
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
            if let Ok(loc_str) = loc.to_str() {
                let next = parsed.join(loc_str).map_err(|e| e.to_string())?;
                return Box::pin(bili_request(state, next.as_str(), Some(referer), Some(method)))
                    .await;
            }
        }
    }

    let headers = resp.headers().clone();
    let buffer = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?
        .to_vec();
    let text = String::from_utf8_lossy(&buffer).to_string();
    let json = serde_json::from_str(&text).ok();

    Ok(BiliResp {
        status,
        headers,
        buffer,
        text,
        json,
    })
}

/// 获取 WBI 密钥（24 小时缓存）
pub async fn get_wbi_keys(state: &AppState) -> (String, String) {
    let now = now_secs();
    {
        let cache = state.wbi.lock().unwrap();
        if !cache.img_key.is_empty() && !cache.sub_key.is_empty() && now - cache.ts < 24 * 3600 {
            return (cache.img_key.clone(), cache.sub_key.clone());
        }
    }

    let r = bili_request(state, "https://api.bilibili.com/x/web-interface/nav", None, None).await;
    if let Ok(resp) = r {
        if let Some(data) = resp.json.as_ref().and_then(|j| j.get("data")) {
            let wbi_img = data.get("wbi_img").cloned().unwrap_or(serde_json::json!({}));
            let img_key = extract_wbi_key(wbi_img.get("img_url").and_then(|v| v.as_str()).unwrap_or(""));
            let sub_key = extract_wbi_key(wbi_img.get("sub_url").and_then(|v| v.as_str()).unwrap_or(""));
            if !img_key.is_empty() && !sub_key.is_empty() {
                let mut cache = state.wbi.lock().unwrap();
                cache.img_key = img_key.clone();
                cache.sub_key = sub_key.clone();
                cache.ts = now;
                return (img_key, sub_key);
            }
        }
    }
    let cache = state.wbi.lock().unwrap();
    (cache.img_key.clone(), cache.sub_key.clone())
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 对参数做 WBI 签名，返回完整 query string（含 w_rid）。
/// params 按 key 排序后编码，值中过滤 !'()* 字符。
pub async fn wbi_sign(state: &AppState, params: &[(&str, String)]) -> String {
    let (img_key, sub_key) = get_wbi_keys(state).await;

    let mut raw: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    raw.push(("wts".to_string(), now_secs().to_string()));
    raw.sort_by(|a, b| a.0.cmp(&b.0));

    let mut query = String::new();
    for (i, (k, v)) in raw.iter().enumerate() {
        if i > 0 {
            query.push('&');
        }
        let filtered = v.replace(['!', '\'', '(', ')', '*'], "");
        query.push_str(&format!("{}={}", k, urlencoding::encode(&filtered)));
    }

    let mixin_key = get_mixin_key(&(img_key + &sub_key));
    let w_rid = md5_hex(&(query.clone() + &mixin_key));
    format!("{}&w_rid={}", query, w_rid)
}

/// 带风控 voucher 重试的 WBI 请求
pub async fn bili_wbi_request(
    state: &AppState,
    path_name: &str,
    params: &[(&str, String)],
) -> Result<BiliResp, String> {
    let mut merged: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    let mut last: Option<BiliResp> = None;

    for i in 0..=3 {
        let qs = wbi_sign(state, &merged.iter().map(|(k, v)| (k.as_str(), v.clone())).collect::<Vec<_>>()).await;
        let url = format!("https://api.bilibili.com{}?{}", path_name, qs);
        let r = bili_request(state, &url, None, None).await?;
        let code = r
            .json
            .as_ref()
            .and_then(|j| j.get("code"))
            .and_then(|c| c.as_i64());
        let vv = r
            .json
            .as_ref()
            .and_then(|j| j.get("data"))
            .and_then(|d| d.get("v_voucher"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        last = Some(r.clone());

        if let Some(vv) = vv {
            merged.retain(|(k, _)| k != "v_voucher");
            merged.push(("v_voucher".to_string(), vv));
            continue;
        }
        if (code == Some(-412) || code == Some(-352)) && i < 3 {
            tokio::time::sleep(std::time::Duration::from_millis(600 * (i as u64 + 1))).await;
            continue;
        }
        return Ok(r);
    }
    Ok(last.unwrap())
}
