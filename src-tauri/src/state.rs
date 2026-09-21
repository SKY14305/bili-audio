//! 全局应用状态：cookie jar、WBI 密钥缓存、播放地址缓存、分P缓存、数据目录。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use tauri::AppHandle;

/// WBI 密钥缓存（24 小时有效）
#[derive(Clone, Default)]
pub struct WbiCache {
    pub img_key: String,
    pub sub_key: String,
    pub ts: u64,
}

/// 播放地址缓存条目
#[derive(Clone)]
pub struct PlayUrlEntry {
    pub ts: u64,
    pub audio: Vec<serde_json::Value>,
    pub source: String,
    pub resp: serde_json::Value,
}

/// 分P信息缓存条目
#[derive(Clone)]
pub struct PageCacheEntry {
    pub ts: u64,
    pub value: serde_json::Value,
}

#[derive(Clone)]
pub struct AppState {
    pub http: reqwest::Client,
    pub data_dir: PathBuf,
    pub cookies: Arc<Mutex<HashMap<String, String>>>,
    pub wbi: Arc<Mutex<WbiCache>>,
    pub playurl_cache: Arc<Mutex<HashMap<String, PlayUrlEntry>>>,
    pub page_cache: Arc<Mutex<HashMap<String, PageCacheEntry>>>,
    pub app: AppHandle,
}

impl AppState {
    pub fn new(data_dir: PathBuf, app: AppHandle) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(crate::bili::UA)
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("failed to build reqwest client");

        let state = Self {
            http,
            data_dir,
            cookies: Arc::new(Mutex::new(HashMap::new())),
            wbi: Arc::new(Mutex::new(WbiCache::default())),
            playurl_cache: Arc::new(Mutex::new(HashMap::new())),
            page_cache: Arc::new(Mutex::new(HashMap::new())),
            app,
        };

        state.load_cookies();
        state
    }

    /// 加载持久化的登录态
    pub fn load_cookies(&self) {
        let file = self.data_dir.join("cookies.json");
        if let Ok(raw) = std::fs::read_to_string(&file) {
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, String>>(&raw) {
                let mut jar = self.cookies.lock().unwrap();
                *jar = parsed;
            }
        }
    }

    /// 持久化登录态
    pub fn save_cookies(&self) {
        let jar = self.cookies.lock().unwrap();
        if let Ok(body) = serde_json::to_string_pretty(&*jar) {
            let _ = std::fs::write(self.data_dir.join("cookies.json"), body);
        }
    }

    /// 生成 cookie 请求头字符串
    pub fn cookie_header(&self) -> String {
        let jar = self.cookies.lock().unwrap();
        let mut parts = Vec::new();
        for (k, v) in jar.iter() {
            if !k.is_empty() && v != "null" && v != "undefined" {
                parts.push(format!("{}={}", k, v));
            }
        }
        parts.join("; ")
    }

    /// 合并 Set-Cookie 头到 jar 并持久化
    pub fn merge_cookies(&self, set_cookie_headers: impl Iterator<Item = String>) {
        let mut jar = self.cookies.lock().unwrap();
        let mut changed = false;
        for sc in set_cookie_headers {
            let first = sc.split(';').next().unwrap_or("").trim().to_string();
            if let Some(eq) = first.find('=') {
                if eq <= 0 {
                    continue;
                }
                let name = first[..eq].trim().to_string();
                let mut value = first[eq + 1..].trim().to_string();
                if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
                    value = value[1..value.len() - 1].to_string();
                }
                if !name.is_empty() {
                    jar.insert(name, value);
                    changed = true;
                }
            }
        }
        drop(jar);
        if changed {
            self.save_cookies();
        }
    }

    /// 确保有游客匿名标识 buvid3
    pub async fn ensure_buvid(&self) {
        {
            let jar = self.cookies.lock().unwrap();
            if jar.contains_key("buvid3") {
                return;
            }
        }
        let r = crate::bili::bili_request(
            self,
            "https://api.bilibili.com/x/frontend/finger/spi",
            None,
            None,
        )
        .await;
        if let Ok(resp) = r {
            if let Some(d) = resp.json.as_ref().and_then(|j| j.get("data")) {
                if let Some(b3) = d.get("b_3").and_then(|v| v.as_str()) {
                    let mut jar = self.cookies.lock().unwrap();
                    jar.insert("buvid3".to_string(), b3.to_string());
                    if let Some(b4) = d.get("b_4").and_then(|v| v.as_str()) {
                        jar.insert("buvid4".to_string(), b4.to_string());
                    }
                    drop(jar);
                    self.save_cookies();
                }
            }
        }
    }
}
