# bili Audio

B 站音频收听器（Tauri 2.0 / Windows）：只取音频流播放，不加载视频画面，界面纯文字。
数据与 EXE 同目录，随目录迁移。

## 下载

到 **[Releases](../../releases)** 页面下载：

| 文件 | 说明 | 大小 |
|---|---|---|
| `bili-audio.exe` | 便携版，双击即用，免安装 | ~11.2 MB |
| `bili Audio_1.0.0_x64-setup.exe` | NSIS 安装包（当前用户安装，生成开始菜单 / 桌面快捷方式） | ~2.6 MB |

- 依赖系统自带 WebView2 运行时（Win10/11 已内置，Win7 需手动安装）。
- 登录态 / 历史 / 播放列表 / 收藏列表都存在 **exe 同级的 `data/`**，换机拷目录即可。

## 功能

- **搜索**：关键词搜视频，纯文字列表（标题 / UP 主 / 时长 / 播放量）。
- **播放**：DASH 音频流；播放暂停、进度拖动、上一首 / 下一首、自动连播、倍速、音量。
- **历史 / 评论 / UP 主页 / 合集**：播放历史、视频评论、UP 投稿与合集列表。
- **收藏**：本地收藏列表（歌单）管理、导入 / 导出；账号收藏夹与「我的关注」需登录。
- **游客优先**：不登录也能用，遇到需登录的接口弹二维码扫码。

## 构建

```bash
npm install                    # 装 @tauri-apps/cli
source /e/tauri-env/env.sh     # 注入 MSVC + cargo 环境（Windows，路径按本机调整）
npx tauri build                # 出 EXE + NSIS 安装包（增量约 2 分钟）
```

产物在 `src-tauri/target/release/`（`bili-audio.exe` 与 `bundle/nsis/*-setup.exe`），

开发调试：双击 `启动开发模式.bat` —— 构建 dev-server 版并打开 <http://127.0.0.1:37210>。
**release 构建恒不监听任何端口**，界面与全部 API 都走自定义协议 `biliaudio://`。

## 自查

```bash
NODE=node; SK=~/.workbuddy/skills/ui-assert-verify/scripts/verify-ui.js
$NODE "$SK" tools/ui-spec.json            # 版式 17 条
$NODE "$SK" tools/ui-spec-behavior.json   # 行为 21 条（队列语义 / 弹层互斥）
python tools/verify-artifacts.py          # 产物本体：内嵌前端 / 图标 / 产品名
```

两份 spec 分开跑（各自的 setup 会互相踩状态）；`viewport` 必须等于真实窗口尺寸（420×780）。

## 目录

```
bili-audio/
├── 启动开发模式.bat     # 一键构建 dev-server 版并打开浏览器调试界面
├── src-tauri/           # Rust 端：自定义协议 / 托盘 / 29 个 /api 端点
│   ├── icons/           # 应用图标（brand-logo.svg 为矢量母版）
│   └── src/             # main / lib / state / bili / audio / store / server
├── frontend/            # 纯 HTML/CSS/JS 界面，由 rust-embed 内嵌进 EXE
└── tools/               # 断言清单 + 产物校验脚本
```
