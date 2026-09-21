//! 内置 HTTP 服务：静态文件 + 全部 B 站代理 API（完整移植 server.js）。

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::{
    bili::{self, dm_fingerprint, strip_html},
    state::AppState,
    store,
};

// ---------------------------------------------------------------------------
// 内嵌前端静态资源
// ---------------------------------------------------------------------------
#[derive(rust_embed::Embed)]
#[folder = "../frontend/"]
struct FrontendAssets;

const SEARCH_PAGE_SIZE: usize = 20;

// ---------------------------------------------------------------------------
// 响应辅助
// ---------------------------------------------------------------------------
fn json_response(status: StatusCode, body: &Value) -> Response {
    let s = body.to_string();
    (
        status,
        [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Cache-Control", "no-store"),
        ],
        s,
    )
        .into_response()
}

fn ok_json(body: &Value) -> Response {
    json_response(StatusCode::OK, body)
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
pub fn router(state: AppState) -> Router {
    let shared = Arc::new(state);

    Router::new()
        // 音频流（流式，单独处理）
        .route("/api/audio", get(api_audio))
        // 图片/二维码二进制
        .route("/api/img", get(api_img))
        .route("/api/login/qr.png", get(api_qr_png))
        // 其余 API
        .route("/api/search", get(api_search))
        .route("/api/view", get(api_view))
        .route("/api/pages", get(api_pages))
        .route("/api/comments", get(api_comments))
        .route("/api/playurl", get(api_playurl))
        .route("/api/space", get(api_space))
        .route("/api/space/videos", get(api_space_videos))
        .route("/api/space/collections", get(api_space_collections))
        .route("/api/collection", get(api_collection))
        .route("/api/series", get(api_series))
        .route("/api/nav", get(api_nav))
        .route("/api/fav/folders", get(api_fav_folders))
        .route("/api/fav/list", get(api_fav_list))
        .route("/api/followings", get(api_followings))
        .route("/api/login/qr", get(api_login_qr))
        .route("/api/login/qr/poll", get(api_login_qr_poll))
        .route("/api/login/logout", get(api_login_logout))
        .route("/api/history", get(api_history_get).post(api_history_post).delete(api_history_delete))
        .route("/api/collections", get(api_collections_get).post(api_collections_post).patch(api_collections_patch).delete(api_collections_delete))
        .route("/api/collections/items", post(api_collections_items_post).delete(api_collections_items_delete))
        .route("/api/collections/import", post(api_collections_import))
        .route("/api/state", get(api_state_get).post(api_state_post))
        // 桌面文件对话框（导入/导出收藏列表）
        .route("/api/desktop/save-json", post(api_desktop_save_json))
        .route("/api/desktop/open-json", post(api_desktop_open_json))
        // 无边框窗口：最小化 / 最大化 / 关闭
        .route("/api/desktop/win/min", post(api_win_min))
        .route("/api/desktop/win/max", post(api_win_max))
        .route("/api/desktop/win/close", post(api_win_close))
        .route("/api/desktop/win/drag", post(api_win_drag))
        .route("/api/desktop/quit", post(api_desktop_quit))
        // 静态文件兜底
        .fallback(static_handler)
        .with_state(shared)
}

// ---------------------------------------------------------------------------
// 自定义协议派发：把 biliaudio://localhost/* 的请求直接交给 axum Router
// ---------------------------------------------------------------------------

/// 把 Tauri 自定义协议收到的请求转成 axum 请求并命中路由，返回完整响应。
///
/// 封装版本不监听任何 TCP 端口：请求在进程内直接派发，外部浏览器无法通过
/// 端口访问界面，也不存在跨进程 CORS / 扫描面。
pub async fn handle_protocol_request(
    router: Router,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use axum::body::{to_bytes, Body};
    use tower::ServiceExt;

    let (parts, body) = request.into_parts();
    let mut builder = axum::http::Request::builder()
        .method(parts.method.clone())
        .uri(parts.uri.clone())
        .version(parts.version);
    if let Some(headers) = builder.headers_mut() {
        for (name, value) in parts.headers.iter() {
            headers.append(name.clone(), value.clone());
        }
    }

    let axum_request = match builder.body(Body::from(body)) {
        Ok(r) => r,
        Err(e) => return protocol_text_response(500, &format!("请求构造失败: {}", e)),
    };

    match router.oneshot(axum_request).await {
        Ok(response) => {
            let (parts, body) = response.into_parts();
            let bytes = to_bytes(body, usize::MAX).await.unwrap_or_default();
            let mut out = tauri::http::Response::builder().status(parts.status);
            if let Some(headers) = out.headers_mut() {
                for (name, value) in parts.headers.iter() {
                    // 响应体已被完整读取，不能再声明分块传输
                    if name == axum::http::header::TRANSFER_ENCODING {
                        continue;
                    }
                    headers.append(name.clone(), value.clone());
                }
            }
            out.body(bytes.to_vec())
                .unwrap_or_else(|_| protocol_text_response(500, "响应构造失败"))
        }
        Err(e) => protocol_text_response(500, &format!("路由派发失败: {}", e)),
    }
}

fn protocol_text_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

// ---------------------------------------------------------------------------
// 静态文件服务
// ---------------------------------------------------------------------------
async fn static_handler(uri: axum::http::Uri) -> Response {
    let path = uri.path();
    let rel = if path == "/" {
        "index.html".to_string()
    } else {
        path.trim_start_matches('/').to_string()
    };

    let content: Option<Vec<u8>> = dev_frontend_file(&rel)
        .or_else(|| FrontendAssets::get(&rel).map(|c| c.data.into_owned()));

    match content {
        Some(data) => {
            let mime = mime_guess::from_path(&rel).first_or_octet_stream();
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", mime.as_ref());
            if rel.ends_with(".html") {
                builder = builder.header("Content-Type", "text/html; charset=utf-8");
            } else if rel.ends_with(".js") {
                builder = builder.header("Content-Type", "application/javascript; charset=utf-8");
            } else if rel.ends_with(".css") {
                builder = builder.header("Content-Type", "text/css; charset=utf-8");
            }
            builder
                .body(axum::body::Body::from(data))
                .unwrap()
        }
        None => (
            StatusCode::NOT_FOUND,
            [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Not Found",
        )
            .into_response(),
    }
}

/// dev-server 模式下直接从磁盘读取 frontend/，改前端无需重新编译 Rust。
#[cfg(feature = "dev-server")]
fn dev_frontend_file(rel: &str) -> Option<Vec<u8>> {
    const FRONTEND_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../frontend");
    if rel.is_empty() || rel.contains("..") {
        return None;
    }
    std::fs::read(std::path::Path::new(FRONTEND_DIR).join(rel)).ok()
}

/// 封装版本只认编译时内嵌的资源。
#[cfg(not(feature = "dev-server"))]
fn dev_frontend_file(_rel: &str) -> Option<Vec<u8>> {
    None
}

// ---------------------------------------------------------------------------
// 工具：提取查询参数
// ---------------------------------------------------------------------------
fn qs(q: &axum::extract::Query<Vec<(String, String)>>, key: &str, default: &str) -> String {
    q.0.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| default.to_string())
}

// ---------------------------------------------------------------------------
// a. 搜索
// ---------------------------------------------------------------------------
async fn api_search(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let kw = qs(&Query(q.clone()), "kw", "");
    let page = qs(&Query(q.clone()), "page", "1");

    let r = bili::bili_wbi_request(
        &state,
        "/x/web-interface/wbi/search/type",
        &[
            ("search_type", "video".to_string()),
            ("keyword", kw.clone()),
            ("page", page.clone()),
            ("page_size", SEARCH_PAGE_SIZE.to_string()),
        ],
    )
    .await;

    let r = match r {
        Ok(r) => r,
        Err(e) => return ok_json(&json!({"code": -1, "message": e})),
    };

    let json_val = match r.json {
        Some(j) => j,
        None => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                &json!({"code": -1, "message": "B 站响应解析失败（可能触发风控，请稍后重试）"}),
            )
        }
    };

    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("搜索失败")),
        }));
    }

    let data = json_val.get("data").cloned().unwrap_or(json!({}));
    let raw = data
        .get("result")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let filtered: Vec<Value> = raw.iter().filter(|it| it.get("bvid").is_some()).cloned().collect();

    ok_json(&json!({
        "code": 0,
        "data": {
            "hasMore": raw.len() >= SEARCH_PAGE_SIZE,
            "result": filtered.iter().map(|it| json!({
                "bvid": it.get("bvid").cloned().unwrap_or(json!("")),
                "title": strip_html(it.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                "author": it.get("author").cloned().unwrap_or(json!("")),
                "mid": it.get("mid").cloned().unwrap_or(json!(null)),
                "duration": it.get("duration").cloned().unwrap_or(json!(null)),
                "play": it.get("play").cloned().unwrap_or(json!(null)),
            })).collect::<Vec<_>>(),
        }
    }))
}

// ---------------------------------------------------------------------------
// b. 视频详情
// ---------------------------------------------------------------------------
async fn api_view(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let bvid = qs(&Query(q), "bvid", "");
    let r = bili::bili_request(
        &state,
        &format!("https://api.bilibili.com/x/web-interface/view?bvid={}", urlencoding::encode(&bvid)),
        None,
        None,
    )
    .await;

    let json_val = match r.ok().and_then(|r| r.json) {
        Some(j) => j,
        None => return json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "B 站响应解析失败"})),
    };

    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("获取视频详情失败")),
        }));
    }

    let d = json_val.get("data").cloned().unwrap_or(json!({}));
    ok_json(&json!({
        "code": 0,
        "data": {
            "aid": d.get("aid").cloned().unwrap_or(json!(null)),
            "cid": d.get("cid").cloned().unwrap_or(json!(null)),
            "title": d.get("title").cloned().unwrap_or(json!("")),
            "mid": d.get("owner").and_then(|o| o.get("mid")).cloned().unwrap_or(json!(null)),
            "name": d.get("owner").and_then(|o| o.get("name")).cloned().unwrap_or(json!("")),
            "duration": d.get("duration").cloned().unwrap_or(json!(0)),
            "charged": detect_charged(&d),
            "preview": detect_preview_seconds(&d),
            "pages": d.get("pages").and_then(|p| p.as_array()).map(|pages| pages.iter().map(|p| json!({
                "cid": p.get("cid").cloned().unwrap_or(json!(null)),
                "part": p.get("part").cloned().unwrap_or(json!("")),
                "page": p.get("page").cloned().unwrap_or(json!(0)),
                "duration": p.get("duration").cloned().unwrap_or(json!(0)),
            })).collect::<Vec<_>>()).unwrap_or_default(),
        }
    }))
}

fn detect_charged(d: &Value) -> bool {
    let rights = d.get("rights").cloned().unwrap_or(json!({}));
    d.get("is_upower_exclusive").map(|v| v == &json!(true) || v == &json!(1)).unwrap_or(false)
        || rights.get("ugc_pay").map(|v| v == &json!(1) || v == &json!(true)).unwrap_or(false)
        || rights.get("pay").map(|v| v == &json!(1) || v == &json!(true)).unwrap_or(false)
        || d.get("upower").and_then(|u| u.get("is_upower_exclusive")).map(|v| v == &json!(true)).unwrap_or(false)
        || d.get("payment").and_then(|p| p.get("reason")).map(|v| v == &json!("upower")).unwrap_or(false)
}

fn detect_preview_seconds(d: &Value) -> i64 {
    let rights = d.get("rights").cloned().unwrap_or(json!({}));
    let cands = [
        d.get("preview_duration"),
        d.get("upower_preview_duration"),
        rights.get("preview_duration"),
        rights.get("ugc_pay_preview_duration"),
    ];
    for c in cands.iter().flatten() {
        if let Some(n) = c.as_f64() {
            if n > 0.0 && n < 86400.0 {
                return n.round() as i64;
            }
        }
    }
    0
}

// ---------------------------------------------------------------------------
// b-2. 批量分 P 信息
// ---------------------------------------------------------------------------
async fn api_pages(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let raw = qs(&Query(q), "bvids", "");
    let bvids: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| {
            s.starts_with("BV") && s.len() >= 8 && s.chars().skip(2).all(|c| c.is_ascii_alphanumeric())
        })
        .take(30)
        .collect();

    let mut out = serde_json::Map::new();
    let mut need: Vec<String> = Vec::new();

    for b in &bvids {
        let hit = {
            let cache = state.page_cache.lock().unwrap();
            cache.get(b).cloned()
        };
        match hit {
            Some(h) if bili::now_secs() - h.ts < 6 * 3600 => {
                out.insert(b.clone(), h.value);
            }
            _ => need.push(b.clone()),
        }
    }

    // 并发 3 拉取
    let state_ref = state.clone();
    let results = futures_util::future::join_all(need.iter().map(|bvid| {
        let st = state_ref.clone();
        let bvid = bvid.clone();
        async move {
            let r = bili::bili_request(
                &st,
                &format!(
                    "https://api.bilibili.com/x/web-interface/view?bvid={}",
                    urlencoding::encode(&bvid)
                ),
                None,
                None,
            )
            .await;
            let d = r
                .ok()
                .and_then(|r| r.json)
                .filter(|j| j.get("code").and_then(|c| c.as_i64()) == Some(0))
                .and_then(|j| j.get("data").cloned());
            let value = match d {
                Some(d) => json!({
                    "aid": d.get("aid").cloned().unwrap_or(json!(null)),
                    "title": d.get("title").cloned().unwrap_or(json!("")),
                    "mid": d.get("owner").and_then(|o| o.get("mid")).cloned().unwrap_or(json!(null)),
                    "name": d.get("owner").and_then(|o| o.get("name")).cloned().unwrap_or(json!("")),
                    "duration": d.get("duration").cloned().unwrap_or(json!(0)),
                    "charged": detect_charged(&d),
                    "preview": detect_preview_seconds(&d),
                    "pages": d.get("pages").and_then(|p| p.as_array()).map(|pages| pages.iter().map(|p| json!({
                        "cid": p.get("cid").cloned().unwrap_or(json!(null)),
                        "part": p.get("part").cloned().unwrap_or(json!("")),
                        "page": p.get("page").cloned().unwrap_or(json!(0)),
                        "duration": p.get("duration").cloned().unwrap_or(json!(0)),
                    })).collect::<Vec<_>>()).unwrap_or_default(),
                }),
                None => json!({"pages": [], "charged": false, "preview": 0, "failed": true}),
            };
            let mut cache = st.page_cache.lock().unwrap();
            if cache.len() >= 400 {
                let keys: Vec<String> = cache.keys().cloned().collect();
                for k in keys.iter().take(keys.len() / 2) {
                    cache.remove(k);
                }
            }
            cache.insert(
                bvid.clone(),
                crate::state::PageCacheEntry {
                    ts: bili::now_secs(),
                    value: value.clone(),
                },
            );
            (bvid, value)
        }
    }))
    .await;

    for (bvid, value) in results {
        out.insert(bvid, value);
    }

    ok_json(&json!({"code": 0, "data": out}))
}

// ---------------------------------------------------------------------------
// b-3. 评论
// ---------------------------------------------------------------------------
async fn api_comments(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let aid = qs(&Query(q.clone()), "aid", "");
    let pn = qs(&Query(q.clone()), "pn", "1");
    let ps = qs(&Query(q.clone()), "ps", "20");
    if aid.is_empty() {
        return ok_json(&json!({"code": -1, "message": "缺少 aid"}));
    }

    let base: Vec<(&str, String)> = vec![
        ("type", "1".to_string()),
        ("oid", aid.clone()),
        ("sort", "2".to_string()),
        ("pn", pn.clone()),
        ("ps", ps.clone()),
        ("nohot", "0".to_string()),
    ];
    let plain_qs = base
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let r = bili::bili_request(
        &state,
        &format!("https://api.bilibili.com/x/v2/reply?{}", plain_qs),
        None,
        None,
    )
    .await;
    let mut json_val = r.ok().and_then(|r| r.json);

    if json_val.as_ref().map(|j| j.get("code").and_then(|c| c.as_i64()) != Some(0)).unwrap_or(true) {
        if let Ok(r2) = bili::bili_wbi_request(&state, "/x/v2/reply/wbi/main", &base).await {
            if r2.json.as_ref().map(|j| j.get("code").and_then(|c| c.as_i64()) == Some(0)).unwrap_or(false) {
                json_val = r2.json;
            }
        }
    }

    let json_val = match json_val {
        Some(j) => j,
        None => return ok_json(&json!({"code": -1, "message": "评论加载失败（可能触发风控）"})),
    };
    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("评论加载失败")),
        }));
    }

    let data = json_val.get("data").cloned().unwrap_or(json!({}));
    let replies = data.get("replies").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    ok_json(&json!({
        "code": 0,
        "data": {
            "count": data.get("page").and_then(|p| p.get("count")).and_then(|c| c.as_i64()).unwrap_or(replies.len() as i64),
            "replies": replies.iter().map(|c| json!({
                "rpid": c.get("rpid").cloned().unwrap_or(json!(null)),
                "mid": c.get("mid").cloned().unwrap_or(json!(null)),
                "uname": c.get("member").and_then(|m| m.get("uname")).cloned().unwrap_or(json!("未知用户")),
                "message": c.get("content").and_then(|cc| cc.get("message")).cloned().unwrap_or(json!("")),
                "like": c.get("like").cloned().unwrap_or(json!(0)),
                "time": c.get("ctime").cloned().unwrap_or(json!(0)),
                "replies": c.get("replies").and_then(|v| v.as_array()).map(|subs| subs.iter().take(3).map(|sub| json!({
                    "uname": sub.get("member").and_then(|m| m.get("uname")).cloned().unwrap_or(json!("未知用户")),
                    "message": sub.get("content").and_then(|cc| cc.get("message")).cloned().unwrap_or(json!("")),
                    "like": sub.get("like").cloned().unwrap_or(json!(0)),
                })).collect::<Vec<_>>()).unwrap_or_default(),
            })).collect::<Vec<_>>(),
        }
    }))
}

// ---------------------------------------------------------------------------
// c. 播放地址
// ---------------------------------------------------------------------------
async fn api_playurl(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let bvid = qs(&Query(q.clone()), "bvid", "");
    let cid = qs(&Query(q.clone()), "cid", "");
    let resolved = crate::audio::resolve_audio(&state, &bvid, &cid).await;
    if !resolved.ok {
        return ok_json(&json!({
            "code": if resolved.needs_login { -101 } else { -1 },
            "message": resolved.message,
        }));
    }
    let data = resolved.resp.and_then(|r| r.get("data").cloned()).unwrap_or(json!({}));
    ok_json(&json!({
        "code": 0,
        "data": {
            "title": data.get("title").cloned().unwrap_or(json!("")),
            "duration": data.get("duration").or_else(|| data.get("timelength")).cloned().unwrap_or(json!(0)),
            "audio": resolved.audio,
            "source": resolved.source,
        }
    }))
}

// ---------------------------------------------------------------------------
// d. 音频流（流式，支持 Range，带缓存）
// ---------------------------------------------------------------------------
async fn api_audio(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let bvid = qs(&Query(q.clone()), "bvid", "");
    let cid = qs(&Query(q.clone()), "cid", "");
    let resolved = crate::audio::resolve_audio_cached(&state, &bvid, &cid).await;
    if !resolved.ok {
        return json_response(
            StatusCode::BAD_GATEWAY,
            &json!({
                "code": if resolved.needs_login { -101 } else { -1 },
                "message": resolved.message,
            }),
        );
    }

    // 按带宽降序，逐个 failover
    let mut tracks = resolved.audio.clone();
    tracks.sort_by(|a, b| {
        let ba = a.get("bandwidth").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bb = b.get("bandwidth").and_then(|v| v.as_f64()).unwrap_or(0.0);
        bb.partial_cmp(&ba).unwrap_or(std::cmp::Ordering::Equal)
    });

    let range = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    for track in tracks {
        let urls: Vec<String> = track
            .get("urls")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|u| u.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_else(|| {
                track
                    .get("baseUrl")
                    .and_then(|v| v.as_str())
                    .map(|s| vec![s.to_string()])
                    .unwrap_or_default()
            });
        if let Some(resp) = crate::audio::stream_audio(&state, &urls, range.as_deref()).await {
            return resp;
        }
    }

    json_response(
        StatusCode::BAD_GATEWAY,
        &json!({"code": -1, "message": "所有音频节点均不可用"}),
    )
}

// ---------------------------------------------------------------------------
// e/f. UP 主信息 / 投稿
// ---------------------------------------------------------------------------
async fn api_space(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q), "mid", "");
    let mut params = vec![("mid", mid.clone())];
    params.extend(dm_fingerprint().iter().map(|(k, v)| (*k, v.to_string())));
    let r = bili::bili_wbi_request(&state, "/x/space/wbi/acc/info", &params).await;
    let json_val = match r.ok().and_then(|r| r.json) {
        Some(j) => j,
        None => return json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "B 站响应解析失败"})),
    };
    let d = json_val.get("data").cloned().unwrap_or(json!({}));
    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) || d.is_null() {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("获取 UP 主信息失败")),
        }));
    }
    ok_json(&json!({
        "code": 0,
        "data": {
            "name": d.get("name").cloned().unwrap_or(json!("")),
            "sign": d.get("sign").cloned().unwrap_or(json!("")),
            "face": d.get("face").cloned().unwrap_or(json!("")),
        }
    }))
}

async fn api_space_videos(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q.clone()), "mid", "");
    let pn = qs(&Query(q.clone()), "pn", "1");
    let ps = qs(&Query(q.clone()), "ps", "20");
    let mut params = vec![
        ("mid", mid.clone()),
        ("pn", pn.clone()),
        ("ps", ps.clone()),
        ("order", "pubdate".to_string()),
    ];
    params.extend(dm_fingerprint().iter().map(|(k, v)| (*k, v.to_string())));
    let r = bili::bili_wbi_request(&state, "/x/space/wbi/arc/search", &params).await;
    let json_val = match r.ok().and_then(|r| r.json) {
        Some(j) => j,
        None => return json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "B 站响应解析失败"})),
    };
    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("获取投稿失败")),
        }));
    }
    let d = json_val.get("data").cloned().unwrap_or(json!({}));
    let vlist = d.get("list").and_then(|l| l.get("vlist")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let page = d.get("page").cloned().unwrap_or(json!({}));
    ok_json(&json!({
        "code": 0,
        "data": {
            "list": {
                "vlist": vlist.iter().map(|it| json!({
                    "bvid": it.get("bvid").cloned().unwrap_or(json!("")),
                    "title": strip_html(it.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                    "length": it.get("length").cloned().unwrap_or(json!(null)),
                    "play": it.get("play").cloned().unwrap_or(json!(null)),
                    "comment": it.get("comment").cloned().unwrap_or(json!(null)),
                })).collect::<Vec<_>>(),
            },
            "page": {
                "count": page.get("count").cloned().unwrap_or(json!(0)),
                "pn": page.get("pn").cloned().unwrap_or(json!(0)),
                "ps": page.get("ps").cloned().unwrap_or(json!(0)),
            },
        }
    }))
}

// ---------------------------------------------------------------------------
// g. UP 主合集/列表目录
// ---------------------------------------------------------------------------
async fn api_space_collections(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q), "mid", "");
    let mut seasons: Vec<Value> = Vec::new();
    let mut series: Vec<Value> = Vec::new();
    let mut total: i64 = -1;

    for page_num in 1..=50 {
        let url = format!(
            "https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid={}&page_num={}&page_size=20",
            urlencoding::encode(&mid),
            page_num
        );
        let r = bili::bili_request(&state, &url, None, None).await;
        let json_val = match r.ok().and_then(|r| r.json) {
            Some(j) if j.get("code").and_then(|c| c.as_i64()) == Some(0) => j,
            _ => break,
        };
        let data = json_val.get("data").cloned().unwrap_or(json!({}));
        let items_lists = data.get("items_lists").cloned().unwrap_or(json!({}));
        let page = items_lists.get("page").cloned().unwrap_or(json!({}));
        if page_num == 1 {
            total = page.get("total").and_then(|t| t.as_i64()).unwrap_or(0);
        }
        let sl = items_lists.get("seasons_list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let srl = items_lists.get("series_list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        seasons.extend(sl.clone());
        series.extend(srl.clone());
        if total >= 0 && (seasons.len() + series.len()) as i64 >= total {
            break;
        }
        if sl.is_empty() && srl.is_empty() {
            break;
        }
    }

    ok_json(&json!({
        "code": 0,
        "data": {
            "seasons": seasons.iter().map(|s| json!({
                "season_id": s.get("meta").and_then(|m| m.get("season_id")).cloned().unwrap_or(json!(null)),
                "name": s.get("meta").and_then(|m| m.get("name")).cloned().unwrap_or(json!(null)),
                "total": s.get("meta").and_then(|m| m.get("total")).cloned().unwrap_or(json!(null)),
            })).collect::<Vec<_>>(),
            "series": series.iter().map(|s| json!({
                "series_id": s.get("meta").and_then(|m| m.get("series_id")).cloned().unwrap_or(json!(null)),
                "name": s.get("meta").and_then(|m| m.get("name")).cloned().unwrap_or(json!(null)),
                "total": s.get("meta").and_then(|m| m.get("total")).cloned().unwrap_or(json!(null)),
            })).collect::<Vec<_>>(),
        }
    }))
}

// ---------------------------------------------------------------------------
// h/i. 合集内容 / 列表内容
// ---------------------------------------------------------------------------
async fn api_collection(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q.clone()), "mid", "");
    let season_id = qs(&Query(q.clone()), "season_id", "");
    let page = qs(&Query(q.clone()), "page", "1");
    let url = format!(
        "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid={}&season_id={}&sort_reverse=false&page_num={}&page_size=30",
        urlencoding::encode(&mid),
        urlencoding::encode(&season_id),
        urlencoding::encode(&page)
    );
    let json_val = match bili::bili_request(&state, &url, None, None).await.ok().and_then(|r| r.json) {
        Some(j) => j,
        None => return json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "B站响应解析失败"})),
    };
    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("请求失败")),
        }));
    }
    let data = json_val.get("data").cloned().unwrap_or(json!({}));
    let archives = data.get("archives").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    ok_json(&json!({
        "code": 0,
        "data": {
            "archives": archives.iter().map(|a| json!({
                "bvid": a.get("bvid").cloned().unwrap_or(json!("")),
                "title": strip_html(a.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                "duration": a.get("duration").cloned().unwrap_or(json!(null)),
                "view": a.get("stat").and_then(|s| s.get("view")).cloned().unwrap_or(json!(null)),
            })).collect::<Vec<_>>(),
        }
    }))
}

async fn api_series(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q.clone()), "mid", "");
    let series_id = qs(&Query(q.clone()), "series_id", "");
    let page = qs(&Query(q.clone()), "page", "1");
    let url = format!(
        "https://api.bilibili.com/x/series/archives?mid={}&series_id={}&only_normal=true&sort=desc&pn={}&ps=30",
        urlencoding::encode(&mid),
        urlencoding::encode(&series_id),
        urlencoding::encode(&page)
    );
    let json_val = match bili::bili_request(&state, &url, None, None).await.ok().and_then(|r| r.json) {
        Some(j) => j,
        None => return json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "B站响应解析失败"})),
    };
    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("请求失败")),
        }));
    }
    let data = json_val.get("data").cloned().unwrap_or(json!({}));
    let archives = data.get("archives").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    ok_json(&json!({
        "code": 0,
        "data": {
            "archives": archives.iter().map(|a| json!({
                "bvid": a.get("bvid").cloned().unwrap_or(json!("")),
                "title": strip_html(a.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                "duration": a.get("duration").cloned().unwrap_or(json!(null)),
                "view": a.get("stat").and_then(|s| s.get("view")).cloned().unwrap_or(json!(null)),
            })).collect::<Vec<_>>(),
        }
    }))
}

// ---------------------------------------------------------------------------
// j. 登录状态
// ---------------------------------------------------------------------------
async fn api_nav(State(state): State<Arc<AppState>>) -> Response {
    let r = bili::bili_request(&state, "https://api.bilibili.com/x/web-interface/nav", None, None).await;
    let d = r.ok().and_then(|r| r.json).and_then(|j| j.get("data").cloned()).unwrap_or(json!({}));
    ok_json(&json!({
        "code": 0,
        "data": {
            "isLogin": d.get("isLogin").map(|v| v == &json!(true)).unwrap_or(false),
            "uname": d.get("uname").cloned().unwrap_or(json!("")),
            "mid": d.get("mid").cloned().unwrap_or(json!(null)),
            "face": d.get("face").cloned().unwrap_or(json!("")),
            "level": d.get("level_info").and_then(|l| l.get("current_level")).cloned().unwrap_or(json!(0)),
        }
    }))
}

// ---------------------------------------------------------------------------
// j-2. 图片代理
// ---------------------------------------------------------------------------
async fn api_img(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let url = qs(&Query(q), "url", "");
    let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(|s| s.to_string()));
    let host = host.unwrap_or_default();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少图片地址"}));
    }
    let allowed = host.ends_with("hdslb.com")
        || host.ends_with("bilibili.com")
        || host.ends_with("bilivideo.com")
        || host.contains(".hdslb.com")
        || host.contains(".bilibili.com")
        || host.contains(".bilivideo.com");
    if !allowed {
        return json_response(StatusCode::FORBIDDEN, &json!({"code": -1, "message": "不支持的图片域名"}));
    }

    match bili::bili_request(&state, &url, Some(&(bili::REFERER.to_string() + "/")), None).await {
        Ok(r) if r.status == 200 && !r.buffer.is_empty() => {
            let ct = r
                .headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            (
                StatusCode::OK,
                [
                    ("Content-Type", ct.as_str()),
                    ("Cache-Control", "public, max-age=86400"),
                ],
                r.buffer,
            )
                .into_response()
        }
        Ok(_) => json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "图片加载失败"})),
        Err(e) => json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": format!("图片加载失败: {}", e)})),
    }
}

// ---------------------------------------------------------------------------
// j-3/j-4. 收藏夹目录/内容
// ---------------------------------------------------------------------------
async fn api_fav_folders(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q), "mid", "");
    if mid.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 mid"}));
    }
    let mut params = vec![("up_mid", mid.clone()), ("type", "0".to_string())];
    params.extend(dm_fingerprint().iter().map(|(k, v)| (*k, v.to_string())));

    let r1 = bili::bili_wbi_request(&state, "/x/v3/fav/folder/created/list-all", &params).await;
    let r1_json = r1.as_ref().ok().and_then(|r| r.json.clone());
    let mut json_val = r1_json.clone().filter(|j| j.get("code").and_then(|c| c.as_i64()) == Some(0));

    if json_val.is_none() {
        let plain = format!("up_mid={}&type=0", urlencoding::encode(&mid));
        if let Ok(r2) = bili::bili_request(&state, &format!("https://api.bilibili.com/x/v3/fav/folder/created/list-all?{}", plain), None, None).await {
            if let Some(j) = r2.json.filter(|j| j.get("code").and_then(|c| c.as_i64()) == Some(0)) {
                json_val = Some(j);
            }
        }
    }

    let json_val = match json_val {
        Some(j) => j,
        None => {
            let code = r1_json.as_ref().and_then(|j| j.get("code").cloned()).unwrap_or(json!(-1));
            let msg = r1_json.as_ref().and_then(|j| j.get("message").cloned()).unwrap_or(json!("获取收藏夹失败"));
            return ok_json(&json!({"code": code, "message": msg}));
        }
    };

    let list = json_val.get("data").and_then(|d| d.get("list")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    ok_json(&json!({
        "code": 0,
        "data": {
            "folders": list.iter().map(|f| json!({
                "id": f.get("id").cloned().unwrap_or(json!(null)),
                "fid": f.get("fid").cloned().unwrap_or(json!(null)),
                "mid": f.get("mid").cloned().unwrap_or(json!(null)),
                "title": f.get("title").cloned().unwrap_or(json!("")),
                "count": f.get("media_count").cloned().or_else(|| f.get("cnt_info").and_then(|c| c.get("collect")).cloned()).unwrap_or(json!(0)),
            })).collect::<Vec<_>>(),
        }
    }))
}

async fn api_fav_list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let media_id = qs(&Query(q.clone()), "media_id", "");
    let pn = qs(&Query(q.clone()), "pn", "1");
    if media_id.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 media_id"}));
    }
    let params: Vec<(&str, String)> = vec![
        ("media_id", media_id.clone()),
        ("pn", pn.clone()),
        ("ps", "20".to_string()),
        ("order", "mtime".to_string()),
        ("type", "0".to_string()),
        ("tid", "0".to_string()),
        ("platform", "web".to_string()),
    ];

    let r1 = bili::bili_wbi_request(&state, "/x/v3/fav/resource/list", &params).await;
    let r1_json = r1.as_ref().ok().and_then(|r| r.json.clone());
    let mut json_val = r1_json.clone().filter(|j| j.get("code").and_then(|c| c.as_i64()) == Some(0));

    if json_val.is_none() {
        let plain = params.iter().map(|(k, v)| format!("{}={}", k, urlencoding::encode(v))).collect::<Vec<_>>().join("&");
        if let Ok(r2) = bili::bili_request(&state, &format!("https://api.bilibili.com/x/v3/fav/resource/list?{}", plain), None, None).await {
            if let Some(j) = r2.json.filter(|j| j.get("code").and_then(|c| c.as_i64()) == Some(0)) {
                json_val = Some(j);
            }
        }
    }

    let json_val = match json_val {
        Some(j) => j,
        None => {
            let code = r1_json.as_ref().and_then(|j| j.get("code").cloned()).unwrap_or(json!(-1));
            let msg = r1_json.as_ref().and_then(|j| j.get("message").cloned()).unwrap_or(json!("获取收藏夹内容失败"));
            return ok_json(&json!({"code": code, "message": msg}));
        }
    };

    let data = json_val.get("data").cloned().unwrap_or(json!({}));
    let medias = data.get("medias").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    ok_json(&json!({
        "code": 0,
        "data": {
            "title": data.get("info").and_then(|i| i.get("title")).cloned().unwrap_or(json!("")),
            "count": data.get("info").and_then(|i| i.get("media_count")).cloned().unwrap_or(json!(medias.len())),
            "hasMore": data.get("has_more").map(|v| v == &json!(true)).unwrap_or(false),
            "items": medias.iter().filter(|m| m.get("bvid").is_some()).map(|m| json!({
                "bvid": m.get("bvid").cloned().unwrap_or(json!("")),
                "title": strip_html(m.get("title").and_then(|v| v.as_str()).unwrap_or("")),
                "author": m.get("upper").and_then(|u| u.get("name")).cloned().unwrap_or(json!("")),
                "mid": m.get("upper").and_then(|u| u.get("mid")).cloned().unwrap_or(json!(null)),
                "duration": m.get("duration").cloned().unwrap_or(json!(null)),
                "cover": m.get("cover").cloned().unwrap_or(json!("")),
            })).collect::<Vec<_>>(),
        }
    }))
}

// ---------------------------------------------------------------------------
// j-5. 我的关注（关注列表）
// ---------------------------------------------------------------------------
async fn api_followings(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let mid = qs(&Query(q.clone()), "mid", "");
    let pn = qs(&Query(q.clone()), "pn", "1");
    let ps = qs(&Query(q.clone()), "ps", "50");
    if mid.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 mid"}));
    }
    let mut params: Vec<(&str, String)> = vec![
        ("vmid", mid.clone()),
        ("pn", pn.clone()),
        ("ps", ps.clone()),
        ("order", "desc".to_string()),
        ("order_type", "attention".to_string()),
    ];
    params.extend(dm_fingerprint().iter().map(|(k, v)| (*k, v.to_string())));

    let r = bili::bili_wbi_request(&state, "/x/relation/followings", &params).await;
    let json_val = match r.ok().and_then(|r| r.json) {
        Some(j) => j,
        None => return json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "B 站响应解析失败"})),
    };
    if json_val.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return ok_json(&json!({
            "code": json_val.get("code").cloned().unwrap_or(json!(-1)),
            "message": json_val.get("message").cloned().unwrap_or(json!("获取关注列表失败")),
        }));
    }
    let d = json_val.get("data").cloned().unwrap_or(json!({}));
    let list = d.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let total = d.get("total").and_then(|v| v.as_i64()).unwrap_or(list.len() as i64);
    ok_json(&json!({
        "code": 0,
        "data": {
            "total": total,
            "hasMore": list.len() as i64 >= ps.parse::<i64>().unwrap_or(50),
            "items": list.iter().map(|u| json!({
                "mid": u.get("mid").cloned().unwrap_or(json!(null)),
                "name": strip_html(u.get("uname").and_then(|v| v.as_str()).unwrap_or("")),
                "face": u.get("face").cloned().unwrap_or(json!("")),
                "sign": strip_html(u.get("sign").and_then(|v| v.as_str()).unwrap_or("")),
            })).collect::<Vec<_>>(),
        }
    }))
}

// ---------------------------------------------------------------------------
// k. 登录二维码
// ---------------------------------------------------------------------------
async fn api_login_qr(State(state): State<Arc<AppState>>) -> Response {
    let r = bili::bili_request(
        &state,
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        Some("https://passport.bilibili.com/login"),
        None,
    )
    .await;
    let d = r.ok().and_then(|r| r.json).and_then(|j| j.get("data").cloned()).unwrap_or(json!({}));
    ok_json(&json!({
        "code": 0,
        "data": {
            "qrcode_key": d.get("qrcode_key").cloned().unwrap_or(json!(null)),
            "url": d.get("url").cloned().unwrap_or(json!(null)),
        }
    }))
}

async fn api_login_qr_poll(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let key = qs(&Query(q), "qrcode_key", "");
    let r = bili::bili_request(
        &state,
        &format!(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={}",
            urlencoding::encode(&key)
        ),
        Some("https://passport.bilibili.com/login"),
        None,
    )
    .await;
    let d = r.ok().and_then(|r| r.json).and_then(|j| j.get("data").cloned()).unwrap_or(json!({}));

    // 登录成功后访问落地 url 完成登录态
    if d.get("code").and_then(|c| c.as_i64()) == Some(0) {
        if let Some(url) = d.get("url").and_then(|v| v.as_str()) {
            if !url.is_empty() {
                let _ = bili::bili_request(&state, url, Some("https://passport.bilibili.com/login"), None).await;
            }
        }
    }

    ok_json(&json!({
        "code": 0,
        "data": {
            "code": d.get("code").cloned().unwrap_or(json!(null)),
            "message": d.get("message").cloned().unwrap_or(json!(null)),
            "url": d.get("url").cloned().unwrap_or(json!(null)),
        }
    }))
}

// ---------------------------------------------------------------------------
// k3. 二维码图片（第三方降级）
// ---------------------------------------------------------------------------
async fn api_qr_png(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let data = qs(&Query(q), "data", "");
    if data.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少二维码内容"}));
    }
    let qr_url = format!(
        "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=4&data={}",
        urlencoding::encode(&data)
    );
    match bili::bili_request(&state, &qr_url, None, None).await {
        Ok(r) if r.status == 200 && !r.buffer.is_empty() => {
            let ct = r
                .headers
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            (
                StatusCode::OK,
                [("Content-Type", ct.as_str()), ("Cache-Control", "no-store")],
                r.buffer,
            )
                .into_response()
        }
        _ => json_response(StatusCode::BAD_GATEWAY, &json!({"code": -1, "message": "二维码生成失败"})),
    }
}

// ---------------------------------------------------------------------------
// l. 退出登录
// ---------------------------------------------------------------------------
async fn api_login_logout(State(state): State<Arc<AppState>>) -> Response {
    let keys = ["SESSDATA", "DedeUserID", "DedeUserID__ckMd5", "bili_jct", "bili_ticket", "bili_ticket_expires"];
    {
        let mut jar = state.cookies.lock().unwrap();
        for k in keys {
            jar.remove(k);
        }
    }
    state.save_cookies();
    ok_json(&json!({"code": 0}))
}

// ---------------------------------------------------------------------------
// m. 播放历史
// ---------------------------------------------------------------------------
async fn api_history_get(State(state): State<Arc<AppState>>) -> Response {
    let file = store::history_file(&state.data_dir);
    let list = store::read_json_file(&file, json!([]));
    ok_json(&json!({"code": 0, "data": list}))
}

async fn api_history_post(
    State(state): State<Arc<AppState>>,
    body: String,
) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let bvid = payload.get("bvid").and_then(|v| v.as_str()).unwrap_or("");
    if bvid.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 bvid"}));
    }
    let file = store::history_file(&state.data_dir);
    let mut list = store::read_json_file(&file, json!([]));
    if !list.is_array() {
        list = json!([]);
    }
    let arr = list.as_array_mut().unwrap();
    arr.retain(|it| it.get("bvid").and_then(|v| v.as_str()) != Some(bvid));
    arr.insert(0, json!({
        "bvid": bvid,
        "cid": payload.get("cid").and_then(|v| v.as_str()).map(|s| json!(s)).unwrap_or(json!(null)),
        "title": payload.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "author": payload.get("author").and_then(|v| v.as_str()).unwrap_or(""),
        "mid": payload.get("mid").and_then(|v| v.as_str()).map(|s| json!(s)).unwrap_or(json!(null)),
        "time": bili::now_secs() as f64 * 1000.0,
    }));
    if arr.len() > 200 {
        arr.truncate(200);
    }
    let _ = store::write_json_file(&file, &json!(arr));
    ok_json(&json!({"code": 0, "data": arr}))
}

async fn api_history_delete(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let bvid = qs(&Query(q), "bvid", "");
    let file = store::history_file(&state.data_dir);
    let mut list = store::read_json_file(&file, json!([]));
    if !list.is_array() {
        list = json!([]);
    }
    let arr = list.as_array_mut().unwrap();
    if bvid.is_empty() {
        arr.clear();
    } else {
        arr.retain(|it| it.get("bvid").and_then(|v| v.as_str()) != Some(bvid.as_str()));
    }
    let _ = store::write_json_file(&file, &json!(arr));
    ok_json(&json!({"code": 0, "data": arr}))
}

// ---------------------------------------------------------------------------
// m-2/m-3/m-4. 本地收藏列表
// ---------------------------------------------------------------------------
async fn api_collections_get(State(state): State<Arc<AppState>>) -> Response {
    let lists = store::read_collections(&state.data_dir);
    ok_json(&json!({"code": 0, "data": lists}))
}

async fn api_collections_post(State(state): State<Arc<AppState>>, body: String) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "请输入列表名称"}));
    }
    let mut lists = store::read_collections(&state.data_dir);
    let now = bili::now_secs() as f64 * 1000.0;
    lists.push(json!({
        "id": store_id(),
        "name": name.chars().take(60).collect::<String>(),
        "createdAt": now,
        "updatedAt": now,
        "items": [],
    }));
    let _ = store::write_collections(&state.data_dir, &lists);
    ok_json(&json!({"code": 0, "data": lists}))
}

async fn api_collections_patch(State(state): State<Arc<AppState>>, body: String) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if id.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 id"}));
    }
    if name.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "请输入列表名称"}));
    }
    let mut lists = store::read_collections(&state.data_dir);
    let target = lists.iter_mut().find(|l| l.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
    match target {
        Some(t) => {
            t["name"] = json!(name.chars().take(60).collect::<String>());
            t["updatedAt"] = json!(bili::now_secs() as f64 * 1000.0);
            let _ = store::write_collections(&state.data_dir, &lists);
            ok_json(&json!({"code": 0, "data": lists}))
        }
        None => json_response(StatusCode::NOT_FOUND, &json!({"code": -1, "message": "列表不存在"})),
    }
}

async fn api_collections_delete(
    State(state): State<Arc<AppState>>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let id = qs(&Query(q), "id", "");
    if id.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 id"}));
    }
    let lists = store::read_collections(&state.data_dir)
        .into_iter()
        .filter(|l| l.get("id").and_then(|v| v.as_str()) != Some(id.as_str()))
        .collect::<Vec<_>>();
    let _ = store::write_collections(&state.data_dir, &lists);
    ok_json(&json!({"code": 0, "data": lists}))
}

async fn api_collections_items_post(State(state): State<Arc<AppState>>, body: String) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let incoming: Vec<Value> = payload
        .get("items")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(store::normalize_collection_item).collect())
        .unwrap_or_default();
    if id.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 id"}));
    }
    if incoming.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "没有可添加的内容"}));
    }
    let mut lists = store::read_collections(&state.data_dir);
    let target = lists.iter_mut().find(|l| l.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
    let target = match target {
        Some(t) => t,
        None => return json_response(StatusCode::NOT_FOUND, &json!({"code": -1, "message": "列表不存在"})),
    };
    let items = target.get_mut("items").and_then(|v| v.as_array_mut()).unwrap();
    let mut have: std::collections::HashSet<String> = items.iter().map(store::item_key).collect();
    let mut added = 0;
    for it in incoming {
        let k = store::item_key(&it);
        if have.contains(&k) {
            continue;
        }
        have.insert(k);
        items.push(it);
        added += 1;
    }
    target["updatedAt"] = json!(bili::now_secs() as f64 * 1000.0);
    let _ = store::write_collections(&state.data_dir, &lists);
    ok_json(&json!({"code": 0, "data": lists, "added": added}))
}

async fn api_collections_items_delete(State(state): State<Arc<AppState>>, body: String) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let keys: std::collections::HashSet<String> = payload
        .get("keys")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|k| k.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if id.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "缺少 id"}));
    }
    let mut lists = store::read_collections(&state.data_dir);
    let target = lists.iter_mut().find(|l| l.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
    let target = match target {
        Some(t) => t,
        None => return json_response(StatusCode::NOT_FOUND, &json!({"code": -1, "message": "列表不存在"})),
    };
    let before = target.get("items").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    if let Some(items) = target.get_mut("items").and_then(|v| v.as_array_mut()) {
        items.retain(|it| !keys.contains(&store::item_key(it)));
    }
    let after = target.get("items").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    target["updatedAt"] = json!(bili::now_secs() as f64 * 1000.0);
    let _ = store::write_collections(&state.data_dir, &lists);
    ok_json(&json!({"code": 0, "data": lists, "removed": before - after}))
}

async fn api_collections_import(State(state): State<Arc<AppState>>, body: String) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let mode = if payload.get("mode").and_then(|v| v.as_str()) == Some("replace") { "replace" } else { "append" };
    let incoming: Option<Vec<Value>> = payload
        .get("lists")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| payload.get("data").and_then(|v| v.as_array()).cloned())
        .or_else(|| payload.as_array().cloned());
    let incoming = match incoming {
        Some(i) => i,
        None => return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "文件内容格式不正确"})),
    };

    // 规范化导入数据
    let parsed: Vec<Value> = incoming
        .iter()
        .map(|l| {
            let items = l.get("items").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(store::normalize_collection_item).collect::<Vec<_>>()).unwrap_or_default();
            json!({
                "name": l.get("name").and_then(|v| v.as_str()).unwrap_or("未命名列表"),
                "items": items,
            })
        })
        .filter(|l| !l.get("name").and_then(|v| v.as_str()).unwrap_or("").is_empty() || !l.get("items").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true))
        .collect();

    if parsed.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, &json!({"code": -1, "message": "文件中没有可用的收藏列表"}));
    }

    let mut lists = store::read_collections(&state.data_dir);
    let now = bili::now_secs() as f64 * 1000.0;

    if mode == "replace" {
        let new_lists: Vec<Value> = parsed.iter().map(|l| json!({
            "id": store_id(),
            "name": l.get("name").and_then(|v| v.as_str()).unwrap_or("").chars().take(60).collect::<String>(),
            "createdAt": now,
            "updatedAt": now,
            "items": l.get("items").cloned().unwrap_or(json!([])),
        })).collect();
        let added = new_lists.len();
        let _ = store::write_collections(&state.data_dir, &new_lists);
        return ok_json(&json!({"code": 0, "data": new_lists, "added": added, "renamed": 0, "addedItems": new_lists.len()}));
    }

    // 追加：同名自动重命名
    let mut taken: std::collections::HashSet<String> = lists.iter().filter_map(|l| l.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())).collect();
    let mut renamed = 0;
    let mut added_items = 0;
    let parsed_len = parsed.len();
    for l in &parsed {
        let base = l.get("name").and_then(|v| v.as_str()).unwrap_or("未命名列表");
        let final_name = store::unique_name(base, &taken);
        if final_name != base {
            renamed += 1;
        }
        taken.insert(final_name.clone());
        let items = l.get("items").cloned().unwrap_or(json!([]));
        added_items += items.as_array().map(|a| a.len()).unwrap_or(0);
        lists.push(json!({
            "id": store_id(),
            "name": final_name,
            "createdAt": now,
            "updatedAt": now,
            "items": items,
        }));
    }
    let added = parsed_len;
    let _ = store::write_collections(&state.data_dir, &lists);
    ok_json(&json!({"code": 0, "data": lists, "added": added, "renamed": renamed, "addedItems": added_items}))
}

fn store_id() -> String {
    // 复用 store 的 id 生成（时间戳 36 进制 + 随机后缀）
    let ts = bili::now_secs();
    let seed = ts ^ (std::process::id() as u64) << 32;
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut out = format!("{}", radix36(ts));
    for _ in 0..6 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push((b'0' + (x >> 59) as u8 % 36) as char);
    }
    out
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

// ---------------------------------------------------------------------------
// n. 播放状态持久化
// ---------------------------------------------------------------------------
async fn api_state_get(State(state): State<Arc<AppState>>) -> Response {
    let file = store::state_file(&state.data_dir);
    let s = store::read_json_file(&file, json!(null));
    ok_json(&json!({"code": 0, "data": s}))
}

async fn api_state_post(State(state): State<Arc<AppState>>, body: String) -> Response {
    if let Ok(payload) = serde_json::from_str::<Value>(&body) {
        if payload.is_object() {
            let file = store::state_file(&state.data_dir);
            let _ = store::write_json_file(&file, &payload);
        }
    }
    ok_json(&json!({"code": 0}))
}

// ---------------------------------------------------------------------------
// 桌面文件对话框（导入/导出收藏列表）
// ---------------------------------------------------------------------------
async fn api_desktop_save_json(
    State(state): State<Arc<AppState>>,
    body: String,
) -> Response {
    let payload: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let default_name = payload
        .get("defaultName")
        .and_then(|v| v.as_str())
        .unwrap_or("collections.json")
        .to_string();
    let content = payload.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let app = state.app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&default_name)
            .add_filter("JSON 文件", &["json"])
            .blocking_save_file()
    })
    .await;

    match path {
        Ok(Some(file_path)) => {
            let path = file_path.as_path().map(|p| p.to_path_buf());
            match path {
                Some(p) => {
                    if std::fs::write(&p, &content).is_ok() {
                        ok_json(&json!({"ok": true, "path": p.to_string_lossy()}))
                    } else {
                        ok_json(&json!({"ok": false, "error": "写入失败"}))
                    }
                }
                None => ok_json(&json!({"canceled": true})),
            }
        }
        Ok(None) => ok_json(&json!({"canceled": true})),
        Err(_) => ok_json(&json!({"ok": false, "error": "对话框异常"})),
    }
}

async fn api_desktop_open_json(State(state): State<Arc<AppState>>) -> Response {
    let app = state.app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("JSON 文件", &["json"])
            .blocking_pick_file()
    })
    .await;

    match path {
        Ok(Some(file_path)) => {
            let path = file_path.as_path().map(|p| p.to_path_buf());
            match path {
                Some(p) => match std::fs::read_to_string(&p) {
                    Ok(text) => ok_json(&json!({"ok": true, "path": p.to_string_lossy(), "text": text})),
                    Err(e) => ok_json(&json!({"ok": false, "error": e.to_string()})),
                },
                None => ok_json(&json!({"canceled": true})),
            }
        }
        Ok(None) => ok_json(&json!({"canceled": true})),
        Err(_) => ok_json(&json!({"ok": false, "error": "对话框异常"})),
    }
}

// ---------------------------------------------------------------------------
// 无边框窗口控制（最小化 / 最大化 / 关闭）
// ---------------------------------------------------------------------------
async fn api_win_min(State(state): State<Arc<AppState>>) -> Response {
    let app = state.app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || match app.get_webview_window("main") {
        Some(w) => w.minimize().is_ok(),
        None => false,
    })
    .await;
    ok_json(&json!({ "ok": ok.unwrap_or(false) }))
}

async fn api_win_max(State(state): State<Arc<AppState>>) -> Response {
    let app = state.app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || match app.get_webview_window("main") {
        Some(w) => {
            if w.is_maximized().unwrap_or(false) {
                w.unmaximize().is_ok()
            } else {
                w.maximize().is_ok()
            }
        }
        None => false,
    })
    .await;
    ok_json(&json!({ "ok": ok.unwrap_or(false) }))
}

/// 关闭按钮：与系统关闭行为一致 —— 隐藏到托盘，而非退出进程
async fn api_win_close(State(state): State<Arc<AppState>>) -> Response {
    let app = state.app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || match app.get_webview_window("main") {
        Some(w) => w.hide().is_ok(),
        None => false,
    })
    .await;
    ok_json(&json!({ "ok": ok.unwrap_or(false) }))
}

/// 退出软件：置退出标志后结束进程（区别于关闭按钮的「隐藏到托盘」）
async fn api_desktop_quit(State(state): State<Arc<AppState>>) -> Response {
    let app = state.app.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || {
        crate::IS_QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
        app.exit(0);
    })
    .await;
    // exit 会终止进程，通常到不了这里；兜底返回 ok
    ok_json(&json!({ "ok": ok.is_ok() }))
}

/// 标题栏拖拽：webview 加载的是远程 HTTP 页面，Tauri 的 drag-region
/// 初始化脚本不会注入，因此由前端 mousedown 转发到这里调用原生拖拽。
/// 关键：必须在 GUI 主线程执行 —— tao 的 drag_window 内部调用
/// ReleaseCapture() 只释放「调用线程」的鼠标捕获，在工作线程调用
/// 无法释放 WebView2（主线程持有）的捕获，导致 DefWindowProc 拖拽循环
/// 无法夺回控制。因此用 run_on_main_thread 把闭包派发到主线程。
async fn api_win_drag(State(state): State<Arc<AppState>>) -> Response {
    let app = state.app.clone();
    let app_for_closure = app.clone();
    let ok = app
        .run_on_main_thread(move || {
            if let Some(w) = app_for_closure.get_webview_window("main") {
                let _ = w.start_dragging();
            }
        })
        .is_ok();
    ok_json(&json!({ "ok": ok }))
}
