// bili Audio —— 桌面能力桥接（Tauri 版）
//
// Electron 版由 preload.js 注入 window.desktopApi；
// Tauri 版无 preload，这里通过内置 HTTP 后端的 /api/desktop/* 端点
// 桥接原生文件对话框（导入/导出收藏列表），保证前端逻辑零改动。
//
// 仅当 window.desktopApi 尚不存在时才注入，避免覆盖 Electron 的实现。
(function () {
  if (window.desktopApi) return;

  async function post(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
  }

  window.desktopApi = {
    saveJson: (defaultName, content) =>
      post('/api/desktop/save-json', { defaultName, content }),
    openJson: () => post('/api/desktop/open-json'),
  };
})();
