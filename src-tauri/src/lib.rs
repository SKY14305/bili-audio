pub mod state;
pub mod bili;
pub mod store;
pub mod audio;
pub mod server;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tokio::sync::OnceCell;

/// 全局退出标志：托盘「退出」时置 true，使窗口关闭事件放行（真正退出而非隐藏）
pub static IS_QUITTING: AtomicBool = AtomicBool::new(false);

/// 自定义协议名：窗口与全部 API 都走 biliaudio://localhost/*
/// （Windows 上 WebView2 会把它映射成 http://biliaudio.localhost/*）
pub const APP_PROTOCOL: &str = "biliaudio";

/// 是否额外启动 TCP HTTP 服务。
/// 仅 dev-server 特性或 debug 构建下开启，用于「浏览器直接打开端口界面」调试；
/// 封装（release）构建恒为 false —— 不监听任何端口。
pub const DEV_SERVER: bool = cfg!(any(feature = "dev-server", debug_assertions));
pub const DEV_SERVER_ADDR: &str = "127.0.0.1:37210";

type SharedRouter = Arc<OnceCell<axum::Router>>;

pub fn run() {
    // 路由依赖 AppHandle（setup 里才能构造），用 OnceCell 交给协议闭包延迟取用
    let router_cell: SharedRouter = Arc::new(OnceCell::new());
    let router_cell_for_protocol = router_cell.clone();

    tauri::Builder::default()
        // 封装版唯一的「服务端」：把 biliaudio:// 请求在进程内派发给 axum Router，
        // 不创建 TcpListener，浏览器无法从外部访问。
        .register_asynchronous_uri_scheme_protocol(
            APP_PROTOCOL,
            move |_ctx, request, responder| {
                let cell = router_cell_for_protocol.clone();
                tauri::async_runtime::spawn(async move {
                    if DEV_SERVER {
                        eprintln!(
                            "[protocol] -> {} {}",
                            request.method(),
                            request.uri()
                        );
                    }
                    let response = match cell.get() {
                        Some(router) => {
                            server::handle_protocol_request(router.clone(), request).await
                        }
                        None => tauri::http::Response::builder()
                            .status(503)
                            .header("Content-Type", "text/plain; charset=utf-8")
                            .body("路由尚未初始化".as_bytes().to_vec())
                            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
                    };
                    if DEV_SERVER {
                        eprintln!("[protocol] <- {} ({} bytes)",
                            response.status().as_u16(),
                            response.body().len());
                    }
                    responder.respond(response);
                });
            },
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 单实例锁：二次启动时聚焦已有窗口
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = store::data_dir();
            let _ = std::fs::create_dir_all(&data_dir);

            let state = state::AppState::new(data_dir, handle.clone());
            // 同一份路由：封装版走进程内协议派发，开发版额外挂到 TCP 端口
            let router = server::router(state.clone());

            // 交给自定义协议闭包使用
            let _ = router_cell.set(router.clone());

            // 仅开发模式额外监听 TCP 端口，供浏览器直接调试；封装版不监听
            if DEV_SERVER {
                let listener_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    match tokio::net::TcpListener::bind(DEV_SERVER_ADDR).await {
                        Ok(listener) => {
                            bili::log(
                                &listener_handle,
                                "dev-server 已启动: http://".to_string() + DEV_SERVER_ADDR,
                            );
                            let _ = axum::serve(listener, router).await;
                        }
                        Err(e) => {
                            bili::log(
                                &listener_handle,
                                format!("dev-server 启动失败: {}", e),
                            );
                        }
                    }
                });
            } else {
                bili::log(
                    &handle,
                    format!("封装模式：未监听任何 TCP 端口，界面由 {}:// 协议提供", APP_PROTOCOL),
                );
            }

            // 启动后先初始化 buvid（游客标识）
            let st = state.clone();
            tauri::async_runtime::spawn(async move {
                st.ensure_buvid().await;
            });

            // 托盘：左键单击切换显隐，右键菜单「显示主界面 / 退出」
            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("bili Audio")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        IS_QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app);

            // 构建带菜单的托盘（需要菜单句柄）
            let tray = match tray {
                Ok(t) => {
                    // 右键菜单：显示主界面 / 退出
                    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)
                        .unwrap();
                    let quit =
                        MenuItem::with_id(app, "quit", "退出", true, None::<&str>).unwrap();
                    let sep = PredefinedMenuItem::separator(app).unwrap();
                    let menu = Menu::with_items(app, &[&show, &sep, &quit]).unwrap();
                    let _ = t.set_menu(Some(menu));
                    Some(t)
                }
                Err(e) => {
                    bili::log(app.handle(), format!("托盘创建失败: {}", e));
                    None
                }
            };

            // 防止 tray 被提前释放
            std::mem::forget(tray);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 关闭按钮 → 隐藏到托盘而非退出（除非用户从托盘菜单主动退出）
                if !IS_QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
