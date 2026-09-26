'use strict';

/**
 * bili Audio —— 前端逻辑
 *
 * 零依赖，原生 JS。功能：
 *   1. 导航历史栈（后退/前进/回首页），UP 主页 / 投稿 / 合集 作为独立视图
 *   2. 搜索 / UP 投稿 / 合集 / 列表 复用列表渲染
 *   3. 列表卡片直接展示多 P 横滑卡片条，点分 P 直接播对应内容
 *   4. 播放队列（当前列表即队列，多 P 自动展开），播放列表查看/移除/清空/跳转
 *   5. 播放历史（记录、查看、点击播放、清空），UP 主名可点进主页
 *   6. 倍速 / 音量 / 评论
 *   7. 充电视频卡片角标 + 播放时提示只能播放部分内容
 *   8. 播放卡顿自动恢复（等价于用户手动拖一下进度条）
 *   9. 二维码登录；状态持久化（重启恢复队列/曲目/进度/倍速/音量）
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
let queue = []; // 播放队列 [{bvid, cid, title, author, mid, duration, aid, charged, preview}]
let currentIndex = -1;

let navStack = []; // 导航历史栈 [{kind, title, params, data}]
let navIndex = -1;

let qrKey = '';
let pollTimer = null;
let toastTimer = null;
let currentPanel = null; // 当前打开的面板：'playlist' | 'history' | 'favfolders' | 'favlist' | null

// 登录用户信息（含头像）
let userNav = { isLogin: false, uname: '', mid: null, face: '' };

// 软件自带收藏列表（本地歌单）
let collections = []; // [{id, name, createdAt, updatedAt, items:[]}]
let collectionsView = null; // {mode:'list'} | {mode:'detail', id}
let favPickItems = []; // 待收藏的条目（供「收藏到」弹层使用）
let favFolderId = null; // 当前打开的 B 站账号收藏夹 id
let favFolderPage = 1; // 账号收藏夹分页

// 卡片操作图标（stroke 线性风格，统一 16px）
const MORE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="5" cy="12" r="1.9"></circle>' +
  '<circle cx="12" cy="12" r="1.9"></circle>' +
  '<circle cx="19" cy="12" r="1.9"></circle></svg>';

const ICON = {
  play:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 5.2v13.6L19.2 12z"/></svg>',
  pause:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<rect x="6.4" y="5" width="3.8" height="14" rx="1.3"/>' +
    '<rect x="13.8" y="5" width="3.8" height="14" rx="1.3"/></svg>',
  comment:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 ' +
    '8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  queue:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 6h11"/><path d="M3 11h11"/><path d="M3 16h6"/>' +
    '<path d="M17 13v7"/><path d="M13.5 16.5h7"/></svg>',
  more: MORE_ICON,
  next:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 5.5l9 6.5-9 6.5z"/><path d="M18 5v14"/></svg>',
  star:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>',
  trash:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
  close:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  trashSm:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
  back:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M19 12H6"/><polyline points="12 6 6 12 12 18"/></svg>',
  pencil:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  playAll:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><path d="M10 8.6l6 3.4-6 3.4z" fill="currentColor" stroke="none"/></svg>',
  chevL:
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15 5l-7 7 7 7"/></svg>',
  chevR:
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 5l7 7-7 7"/></svg>',
  // 打开合集/列表（外链样式）
  open:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
    '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  search:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/></svg>',
  // 追加到播放列表（加号 + 列表）
  append:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h11"/><path d="M3 11h11"/><path d="M3 16h6"/>' +
    '<path d="M17 13v7"/><path d="M13.5 16.5h7"/></svg>',
};

/** 切换底部播放按钮的播放 / 暂停图标 */
function setPlayIcon(playing) {
  const btn = $('playBtn');
  if (!btn) return;
  btn.innerHTML = playing ? ICON.pause : ICON.play;
}

/**
 * 播放器标题区（两行，整体高度与右侧图标一致）：
 *   第一行：视频标题（多 P 时显示分 P 名称）
 *   第二行：UP 主名（小字，可点击进主页）+ 多 P 时补视频总名
 * 超长截断，hover 通过 title 显示全称。
 */
function setPlayerDisplay(entry) {
  const mainEl = $('ptMain');
  const subEl = $('ptSub');
  const upEl = $('ptUp');
  const extraEl = $('ptExtra');
  if (!mainEl || !subEl || !upEl || !extraEl) return;

  if (!entry) {
    mainEl.textContent = '未在播放';
    mainEl.title = '';
    subEl.classList.add('hidden');
    upEl.hidden = true;
    extraEl.hidden = true;
    upEl.textContent = '';
    extraEl.textContent = '';
    upEl.onclick = null;
    return;
  }

  let main = entry.title || '';
  let total = '';
  if (entry.part || entry.main) {
    main = entry.part || main;
    total = entry.main || '';
  } else {
    // 兼容旧数据标题格式「总名 · P1 分P名」
    const idx = main.indexOf(' · P');
    if (idx > 0) {
      total = main.slice(0, idx);
      main = main.slice(idx + 3);
    }
  }
  mainEl.textContent = main || '未在播放';
  mainEl.title = total ? total + ' · ' + main : main;

  const author = entry.author || '';
  if (author) {
    upEl.textContent = author;
    upEl.title = '查看 UP 主主页';
    upEl.hidden = false;
    upEl.onclick = (e) => {
      e.stopPropagation();
      openUpFromEntry(entryMid(entry.mid, entry.bvid), author);
    };
  } else {
    upEl.hidden = true;
    upEl.textContent = '';
    upEl.onclick = null;
  }

  if (total) {
    extraEl.textContent = total;
    extraEl.title = total;
    extraEl.hidden = false;
  } else {
    extraEl.hidden = true;
    extraEl.textContent = '';
  }

  if (author || total) subEl.classList.remove('hidden');
  else subEl.classList.add('hidden');
}

/** 底部「收藏」按钮：收藏当前正在播放的视频（整条视频，不细分 P） */
function favCurrent() {
  const entry = queue[currentIndex];
  if (!entry || !entry.bvid) {
    toast('当前没有正在播放的内容');
    return;
  }
  openFavPick([
    {
      bvid: entry.bvid,
      cid: null,
      title: entry.main || entry.title || '',
      author: entry.author || '',
      mid: entry.mid != null && entry.mid !== '' ? String(entry.mid) : null,
      duration: Number(entry.duration) || 0,
    },
  ]);
}

let resumeTime = 0; // 恢复播放的进度（秒）
let resumeKey = null; // 上面这个进度属于哪一条（bvid:cid）；换了条目就必须丢弃
let pendingSeek = 0; // 待 seek 的进度（秒）
let userPickedPlayback = false; // 用户是否已自己点播过（用于避免恢复旧状态时把它们盖掉）
let lastSaveTime = 0; // 状态保存节流时间戳
let retryCount = 0; // 音频 error 自动重试计数
let stallTimer = null; // 网络卡顿提示定时器
let stallNotified = false;

/** 分 P 信息缓存：bvid -> {pages, charged, preview, title, name, mid, duration, aid} */
const pageInfo = new Map();
const pagePending = new Set();

// 倍速 / 音量
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 0.5];
let speedIdx = 1;
let volumeValue = 1; // 0~1
let isMuted = false;

// 评论
let commentsAid = null;
let commentsPn = 1;
let commentsHasMore = false;

// 卡顿看护
let watchdogTimer = null;
let lastPos = -1;
let lastTick = 0;
let nudgeCount = 0;

const audio = new Audio();

// ---------------------------------------------------------------------------
// DOM 快捷引用
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    return { code: -1, message: '网络请求失败' };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = { code: -1, message: '响应解析失败' };
  }
  return data;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * 条目唯一键：`bvid:cid`（cid 缺失时退化为 `bvid:`）。
 * 用于**精确**比较（收藏列表去重、当前播放项取键）。
 * 判断「队列里是否已经有这份内容」不要用字符串比键，用 sameEntry()：
 * cid 缺失是常态（见下），字符串比键会把同一份内容判成两个条目。
 */
function entryKey(e) {
  return String((e && e.bvid) || '') + ':' + (e && e.cid ? String(e.cid) : '');
}

/**
 * 两个条目是否指同一份内容（播放列表判重、当前播放项判定的统一口径）。
 *
 * 规则：bvid 必须相同；**任一方 cid 缺失时按 bvid 判同一条**，两边都有 cid 才要求相等。
 *
 * 为什么必须容忍 cid 缺失：条目入队时常常只拿到 bvid 拿不到 cid ——
 * 「播放全部」把整个列表排进队列时只有被点的那一条会补 cid（其余靠播放时懒解析），
 * /api/view 被风控时也会退化成只有 bvid。之后从收藏列表再点同一条，此时能补上 cid，
 * 若按字符串比键就会「键不同 → 当成新条目再插一份」，表现为
 * 「第一次添加成功、再点才提示已在列表中」。
 */
function sameEntry(a, b) {
  if (!a || !b) return false;
  if (!a.bvid || !b.bvid || a.bvid !== b.bvid) return false;
  if (!a.cid || !b.cid) return true;
  return String(a.cid) === String(b.cid);
}

/** 构建一个 ✕ 图标移除按钮（供播放列表 / 历史复用） */
function makeRemoveBtn(onClick, title) {
  const btn = el('button', 'remove-btn');
  btn.title = title || '移除';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = ICON.close;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// ---------------------------------------------------------------------------
// 卡片 hover 操作组（播放 / 评论 / 加入播放列表 / 更多）与「更多」菜单
// ---------------------------------------------------------------------------
/**
 * 「更多」菜单固定三项，首项为「查看评论」（图标 + 文字）。
 * 卡片右侧只剩 播放 / 添加到播放列表 / 更多 三个图标，评论据此移入菜单。
 */
const MORE_MENU = [
  { act: 'comments', label: '查看评论', icon: 'comment' },
  { act: 'next', label: '下一首播放', icon: 'next' },
  { act: 'fav', label: '收藏', icon: 'star' },
];

/** 卡片右侧悬浮操作组里的单个图标按钮 */
function makeActionBtn(iconHtml, title, onClick) {
  const btn = el('button', 'item-act');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = iconHtml;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(btn, e);
  });
  return btn;
}

/**
 * 弹出卡片菜单。
 * 优先放在按钮下方，空间不够则翻到上方；左右尽量与按钮右缘对齐。
 */
function positionMenu(pop, btn, align) {
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.classList.remove('hidden');
  const w = pop.offsetWidth || 140;
  const h = pop.offsetHeight || 90;
  let left = align === 'right' ? r.right - w : r.left;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - 8 - w);
  }
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) {
    const above = r.top - h - 6;
    top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - h);
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.right = 'auto';
  pop.style.bottom = 'auto';
  pop.style.visibility = '';
}

function openItemMenu(anchor, it, extraMenu) {
  const menu = $('itemMenu');
  closeAllPopovers();
  menu.innerHTML = '';
  MORE_MENU.concat(Array.isArray(extraMenu) ? extraMenu : []).forEach((a) => {
    if (a.sep) {
      menu.appendChild(el('div', 'menu-sep'));
      return;
    }
    const b = el('button', 'menu-item' + (a.danger ? ' danger' : ''));
    const ic = el('span', 'mi-icon');
    ic.innerHTML = ICON[a.icon] || ICON.more;
    b.appendChild(ic);
    b.appendChild(el('span', null, a.label));
    b.addEventListener('click', () => {
      closeAllPopovers();
      runItemAction(a.act, it);
    });
    menu.appendChild(b);
  });
  positionMenu(menu, anchor, 'right');
}

function runItemAction(act, it) {
  switch (act) {
    case 'queue':
      addToQueue(it);
      break;
    case 'next':
      insertNext(it);
      break;
    case 'comments':
      openCommentsForItem(it);
      break;
    case 'fav':
      openFavPick([it]);
      break;
    case 'removeFromList':
      removeFromCollection(it);
      break;
    default:
      break;
  }
}

/**
 * 取视频详情并写入分 P 缓存。
 * 缓存里已有可用分 P 数据时直接复用；否则回源 /api/view 补一次
 * （批量 /api/pages 偶尔会因风控漏掉某些视频）。
 */
async function ensureView(bvid) {
  const cached = pageInfo.get(bvid);
  if (cached && cached.pages && cached.pages.length) return cached;
  const v = await api('/api/view?bvid=' + encodeURIComponent(bvid));
  if (v.code !== 0 || !v.data) return cached || null;
  const info = {
    aid: v.data.aid || null,
    title: v.data.title || '',
    mid: v.data.mid || null,
    name: v.data.name || '',
    duration: v.data.duration || 0,
    charged: !!v.data.charged,
    preview: v.data.preview || 0,
    pages: v.data.pages || [],
  };
  pageInfo.set(bvid, info);
  return info;
}

/**
 * 把一个列表条目展开成可入队的条目数组：
 *   带 cid → 单条；多 P 且未指定 cid → 展开所有分 P；其余 → 单条。
 */
async function entriesForItem(it) {
  const base = {
    bvid: it.bvid,
    cid: it.cid || null,
    title: it.title || '',
    author: it.author || '',
    mid: it.mid || null,
    duration: it.duration || null,
    aid: it.aid || null,
  };
  if (base.cid) return [base];

  const info = await ensureView(it.bvid);
  if (info && info.pages && info.pages.length > 1) return partEntries(it, info);
  if (info && info.pages && info.pages.length === 1) {
    base.cid = info.pages[0].cid;
    base.aid = info.aid || null;
  }
  return [base];
}

/**
 * 追加语义（同步纯函数，便于断言回归）：
 * 队列中已存在同一份内容（sameEntry）时跳过，不产生重复项。
 * @returns {{list:Array, added:number, skipped:number}}
 */
function mergeAppend(base, entries) {
  const list = Array.isArray(base) ? base.slice() : [];
  let added = 0;
  let skipped = 0;
  (entries || []).forEach((e) => {
    // 拿 list 现扫而不是预先建的键集合：同一批里重复传入的条目也会被后面的比较拦下
    if (list.some((q) => sameEntry(q, e))) {
      skipped += 1;
      return;
    }
    list.push(e);
    added += 1;
  });
  return { list: list, added: added, skipped: skipped };
}

/**
 * 「下一首播放」语义（同步纯函数，便于断言回归）：
 * - 队列中没有的条目 → 按给定顺序插到当前曲目之后；
 * - 队列中已有、且不是正在播放的那条 → **不重复添加**，把它移动到当前曲目之后；
 * - 正在播放的那条 → 不动（不能排到自己后面）。
 * @returns {{list:Array, index:number, moved:number, added:number, noop:boolean, playing:number}}
 */
function mergeInsertNext(base, index, entries) {
  const list = Array.isArray(base) ? base.slice() : [];
  const cur = index >= 0 && index < list.length ? index : -1;
  const playing = cur >= 0 ? list[cur] : null;
  const picked = []; // [{idx, entry}]：idx 为条目在队列中的位置，-1 表示队列里没有
  let playingHits = 0;
  (entries || []).forEach((e) => {
    if (picked.some((p) => sameEntry(p.entry, e))) return; // 同一批里重复传入的只算一次
    if (playing && sameEntry(playing, e)) {
      playingHits += 1; // 正在播放的那条不参与移动
      return;
    }
    const at = list.findIndex((q) => sameEntry(q, e));
    picked.push({ idx: at, entry: at >= 0 ? list[at] : e });
  });

  const result = { list: list, index: cur, moved: 0, added: 0, noop: true, playing: playingHits };
  if (!picked.length) return result; // 传入的就是正在播放的那条
  if (picked.length === 1 && picked[0].idx === cur + 1) return result; // 已经就在下一首

  // 先按索引从大到小摘除队列中已有的条目，避免前面的删除让后面的索引错位
  let anchor = cur < 0 ? -1 : cur;
  picked
    .filter((p) => p.idx >= 0)
    .map((p) => p.idx)
    .sort((a, b) => b - a)
    .forEach((i) => {
      list.splice(i, 1);
      if (i < anchor) anchor -= 1;
    });

  const insertAt = anchor < 0 ? 0 : anchor + 1;
  list.splice(insertAt, 0, ...picked.map((p) => p.entry));
  return {
    list: list,
    index: insertAt,
    moved: picked.filter((p) => p.idx >= 0).length,
    added: picked.filter((p) => p.idx < 0).length,
    noop: false,
    playing: playing,
  };
}

/**
 * 添加到播放列表：追加到当前队列尾部（不影响正在播放的曲目）。
 * 同一条目已在队列中时不重复添加。
 */
async function addToQueue(it) {
  const entries = await entriesForItem(it);
  if (!entries.length) return 0;
  const before = queue.length;
  const r = mergeAppend(queue, entries);
  if (!r.added) {
    toast('已在播放列表中');
    return 0;
  }
  queue = r.list;
  saveState();
  if (before === 0 && currentIndex < 0) {
    currentIndex = 0;
    playQueue();
  }
  toast(
    r.skipped
      ? '已添加到播放列表（' + r.added + ' 项，' + r.skipped + ' 项已存在）'
      : '已添加到播放列表（' + r.added + ' 项）'
  );
  if (panelVisible() && currentPanel === 'playlist') renderPanelBody();
  return r.added;
}

/**
 * 下一首播放：排到当前曲目之后；队列为空时直接开始播放。
 * 队列中已有同一条目时不再重复添加 —— 若它不在播放中，则移动到下一首的位置。
 */
async function insertNext(it) {
  const entries = await entriesForItem(it);
  if (!entries.length) return;

  if (!queue.length || currentIndex < 0) {
    queue = entries.slice();
    currentIndex = 0;
    saveState();
    playQueue();
    if (panelVisible() && currentPanel === 'playlist') renderPanelBody();
    return;
  }

  const r = mergeInsertNext(queue, currentIndex, entries);
  if (r.noop) {
    toast(r.playing && !r.moved ? '该内容正在播放' : '已在下一首播放');
    return;
  }
  queue = r.list;
  currentIndex = r.index;
  saveState();
  toast(r.moved ? '已调整到下一首播放' : '已添加到下一首播放');
  if (panelVisible() && currentPanel === 'playlist') renderPanelBody();
}

/**
 * 收起当前打开的弹层（播放列表 / 历史 / 收藏夹 / 评论）。
 * 用于「点 UP 主名进主页」——各弹层行为统一为：跳转主页并关闭弹层。
 */
function closeActiveSheets() {
  if (panelVisible()) closePanel();
  if (commentsVisible()) closeComments();
  if (collState) closeCollModal();
  // 收藏列表（collectionsModal）与上面几个同属「顶层弹层」，
  // 漏掉它就会出现「点了 UP 主名、主页已切过去、收藏列表还挡在上面」。
  if (sheetOpen($('collectionsModal'))) closeCollections();
}

/**
 * 列表 / 弹层里点击 UP 主名：关掉当前弹层后打开 UP 主页。
 * 缺少 mid（老数据、匿名或接口未返回）时给出提示，避免「点了没反应」。
 */
function openUpFromEntry(mid, name) {
  const m = Number(mid);
  if (!m) {
    toast('暂未获取到该 UP 主的 ID，无法打开主页');
    return;
  }
  closeActiveSheets();
  openUp(m, name);
}

/**
 * 条目缺 mid 时用「分P信息」里带的 UP 主 id 兜底。
 * /api/pages 会返回 owner.mid（权威值）；播放列表 / 收藏里的老条目常常只有
 * bvid + author，直接拿 it.mid 判空就会以为「没有 UP 主 ID」。
 */
function entryMid(mid, bvid) {
  if (mid !== null && mid !== undefined && mid !== '') return mid;
  const info = bvid ? pageInfo.get(bvid) : null;
  return (info && info.mid) || null;
}

/** 构建一个可点击跳转 UP 主页的作者名；没有 mid 时点击给出提示 */
function makeAuthor(name, mid, bvid) {
  if (!name) return null;
  const span = el('span', 'item-author', name);
  span.title = '查看 UP 主主页';
  span.addEventListener('click', (e) => {
    e.stopPropagation();
    openUpFromEntry(entryMid(mid, bvid), name);
  });
  return span;
}

function fmtPlay(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

function fmtDur(sec) {
  sec = Math.floor(Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
}

function fmtItemDur(d) {
  if (d === null || d === undefined || d === '') return '';
  if (typeof d === 'number') return fmtDur(d);
  return String(d);
}

function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return mm + '-' + dd + ' ' + hh + ':' + mi;
}

function needsLogin(code, message) {
  if (code === -101 || code === -404 || code === -403) return true;
  const m = String(message || '');
  return /登录|大会员|权限|风控|账号|异常/i.test(m);
}

/**
 * 把 B 站返回的英文风控提示换成人话。
 * 未登录时访问 UP 主空间/投稿接口，B 站有时直接放行、有时返回 -412
 * （"request was banned"）或 -352，这里统一引导用户登录。
 */
function friendlyMessage(code, message) {
  const m = String(message || '');
  if (code === -412 || /request was banned|banned/i.test(m)) {
    return '请登录后重试';
  }
  if (code === -352) return '请登录后重试';
  if (!m || /^requests?\s/i.test(m)) return '操作失败，请稍后重试';
  return m;
}

function isLoggedIn() {
  const btn = $('loginBtn');
  return !!(btn && btn.dataset.logged);
}

function handleError(resp) {
  const code = resp && resp.code;
  const message = resp && resp.message;
  const logged = isLoggedIn();

  if (needsLogin(code, message)) {
    if (logged) toast(friendlyMessage(code, message));
    else showLogin('请登录后重试');
    return;
  }
  // 风控类错误码（-412/-352）：未登录时引导登录，已登录则提示稍后重试
  if (code === -412 || code === -352) {
    if (logged) toast('操作太频繁，请稍后重试');
    else showLogin('请登录后重试');
    return;
  }
  toast(friendlyMessage(code, message));
}

function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------------------------------------------------------------------------
// 分 P 信息（批量拉取 + 缓存，用于卡片下的多 P 卡片条）
// ---------------------------------------------------------------------------
async function ensurePages(bvids) {
  const need = (bvids || []).filter(
    (b) => b && !pageInfo.has(b) && !pagePending.has(b)
  );
  if (!need.length) return false;
  need.forEach((b) => pagePending.add(b));
  let changed = false;
  try {
    const r = await api('/api/pages?bvids=' + encodeURIComponent(need.join(',')));
    if (r.code === 0 && r.data) {
      for (const [b, v] of Object.entries(r.data)) {
        if (v && !v.failed) {
          pageInfo.set(b, v);
          changed = true;
        } else {
          // 失败也记一个空结果，避免同一批反复重试
          pageInfo.set(b, { pages: [], charged: false, preview: 0 });
        }
      }
    }
  } catch (e) {
    // 忽略：卡片条只是增强信息
  }
  need.forEach((b) => pagePending.delete(b));
  return changed;
}

/**
 * 列表渲染后补齐缺失的 UP 主 mid。
 *
 * 播放列表 / 收藏里的老条目常常只有 bvid + author，`mid` 为 null ——
 * 此时作者名点了只提示「暂未获取到该 UP 主的 ID」。这里借 /api/pages
 * （内部就是 /x/web-interface/view，返回 owner.mid）批量补一次，
 * 补到之后重绘，作者名即可点击。
 * @param {Array} items 当前列表
 * @param {Function} repaint 补齐后重绘该列表
 */
async function ensureMidsThenRepaint(items, repaint) {
  const need = (items || [])
    .filter((it) => it && it.bvid && (it.mid === null || it.mid === undefined || it.mid === ''))
    .map((it) => it.bvid)
    .filter((b) => {
      const info = pageInfo.get(b);
      return !info || !info.mid;
    })
    .slice(0, 30);
  if (!need.length) return;
  const changed = await ensurePages(need);
  if (changed && typeof repaint === 'function') repaint();
}

/** 确保列表条目的分P信息已在缓存里（不画卡片条）。返回本次是否拉到了新数据。 */
async function ensureInfoForList(items) {
  const bvids = (items || [])
    .map((it) => it && it.bvid)
    .filter(Boolean)
    .slice(0, 24);
  if (!bvids.length) return false;
  const missing = bvids.filter((b) => !pageInfo.has(b));
  if (!missing.length) return false;
  return await ensurePages(missing);
}

/** 列表渲染后补齐分 P 卡片条（后台拉取，不阻塞渲染） */
async function loadPartsForList(container, items) {
  const changed = await ensureInfoForList(items);
  // 等网络的那条路径回来后容器可能已被替换掉，此时不值得再画
  if (changed && container && !container.isConnected) return;
  paintPartStrips(container);
}

/** 刷新容器内所有卡片的充电角标（不碰多 P 卡片条） */
function paintChargeBadges(container) {
  if (!container) return;
  container.querySelectorAll('.item[data-bvid]').forEach((li) => {
    if (li._item) paintChargedBadge(li, li._item);
  });
}

/**
 * 列表渲染后补一次分P信息并刷充电角标。
 * 供「不显示多 P 横滑卡片条」的列表用（播放列表 / 历史）：它们同样要显示充电标识，
 * 但不能因此凭空长出一条卡片条来。
 */
async function loadChargesForList(container, items) {
  await ensureInfoForList(items);
  paintChargeBadges(container);
}

/** 把所有卡片的卡片条刷新一遍 */
function paintPartStrips(container) {
  if (!container) return;
  const nodes = container.querySelectorAll('.item[data-bvid]');
  nodes.forEach((li) => {
    const it = li._item;
    if (!it) return;
    renderPartStrip(li, it);
    paintChargedBadge(li, it);
  });
  markPlaying();
}

/**
 * 同步底部滚动条：滑块宽度/位置 + 左右箭头可用状态。
 * 箭头到达尽头时置灰但仍显示（不再隐藏），滑块随滚动实时移动。
 * 拖动过程中由 dragPartThumb 直接写入滑块位置，这里不再重算，避免抖动。
 */
function syncPartBar(wrap, strip) {
  if (!wrap || !strip) return;
  if (wrap.classList.contains('dragging')) return;
  const track = wrap.querySelector('.part-track');
  const thumb = wrap.querySelector('.part-thumb');
  syncPartArrows(wrap, strip);
  if (!track || !thumb) return;
  const max = strip.scrollWidth - strip.clientWidth;
  const trackW = track.clientWidth;
  const ratio = trackW > 0 ? Math.min(1, strip.clientWidth / strip.scrollWidth) : 1;
  const thumbW = Math.max(24, Math.round(trackW * ratio));
  thumb.style.width = thumbW + 'px';
  const maxLeft = Math.max(0, trackW - thumbW);
  const scrollRatio = max > 0 ? strip.scrollLeft / max : 0;
  thumb.style.left = Math.round(scrollRatio * maxLeft) + 'px';
  // 无可滚动空间时整个滑块铺满，并弱化提示
  wrap.classList.toggle('no-scroll', max <= 0);
}

/** 只更新左右箭头的置灰状态（拖动时每帧调用，开销很小） */
function syncPartArrows(wrap, strip) {
  const prev = wrap.querySelector('.part-nav.prev');
  const next = wrap.querySelector('.part-nav.next');
  const max = strip.scrollWidth - strip.clientWidth;
  if (prev) prev.classList.toggle('disabled', strip.scrollLeft <= 1);
  if (next) next.classList.toggle('disabled', strip.scrollLeft >= max - 1);
}

/**
 * 拖动底部滑块横向滚动卡片条。
 * 关键点（之前「不跟手、P 越多越明显」的根因）：
 *   1. 卡片条 CSS 的 scroll-behavior 必须是 auto（见 style.css）——smooth 会把每次
 *      scrollLeft 写入变成几百毫秒的补间动画，拖动距离越大滞后越明显；
 *   2. 拖动期间给 wrap 加 .dragging 关掉 scroll-snap，否则浏览器会把滚动位置
 *      吸回就近卡片边界，与鼠标位置打架；
 *   3. 指针捕获 setPointerCapture：鼠标移出滑块/窗口也不丢事件；
 *   4. pointermove 只记录位移，实际写入放进 requestAnimationFrame，每帧最多一次。
 */
function dragPartThumb(wrap, strip, track, thumb, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const maxScroll = strip.scrollWidth - strip.clientWidth;
  if (maxScroll <= 0) return; // 卡片没铺满，没有可拖动的空间
  const trackRect = track.getBoundingClientRect();
  const maxLeft = Math.max(1, trackRect.width - thumb.offsetWidth);
  const startX = e.clientX;
  const startLeft = thumb.offsetLeft;

  let pendingDx = 0;
  let hasMove = false;
  let raf = 0;

  wrap.classList.add('dragging');
  try {
    thumb.setPointerCapture(e.pointerId);
  } catch (err) {
    /* 不支持指针捕获时退回下面的 document 监听兜底 */
  }

  const apply = () => {
    raf = 0;
    const ratio = Math.max(0, Math.min(1, (startLeft + pendingDx) / maxLeft));
    // 先写滚动位置，再按同一比例定位滑块 —— 两者严格同源，滑块与鼠标 1:1 跟随
    if (maxScroll > 0) strip.scrollLeft = ratio * maxScroll;
    thumb.style.left = Math.round(ratio * maxLeft) + 'px';
    syncPartArrows(wrap, strip);
  };

  const move = (ev) => {
    hasMove = true;
    pendingDx = ev.clientX - startX;
    if (!raf) raf = requestAnimationFrame(apply);
  };

  const finish = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      if (hasMove) apply();
    }
    thumb.removeEventListener('pointermove', move);
    thumb.removeEventListener('pointerup', finish);
    thumb.removeEventListener('pointercancel', finish);
    thumb.removeEventListener('lostpointercapture', finish);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    wrap.classList.remove('dragging');
    syncPartBar(wrap, strip);
  };

  thumb.addEventListener('pointermove', move);
  thumb.addEventListener('pointerup', finish);
  thumb.addEventListener('pointercancel', finish);
  thumb.addEventListener('lostpointercapture', finish);
  // 兜底：某些 WebView 版本下指针捕获失效时仍能正常结束拖动
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish);
}

/** 点击箭头时横向滚动一段（约一屏的 80%） */
function scrollPartStrip(strip, dir) {
  if (!strip) return;
  const step = Math.max(strip.clientWidth * 0.8, 120);
  strip.scrollBy({ left: dir * step, behavior: 'smooth' });
}

/**
 * 让卡片条支持横向滚动：
 *   1. 鼠标滚轮（竖向）在卡片条上转为横向滚动，滚到两端再交还给页面
 *   2. 触控板横滑 / Shift+滚轮 由浏览器原生处理，不干预
 *   3. 滚动时同步底部滑块 + 箭头状态
 *   4. 自定义滚动条：点击轨道跳转、拖动滑块
 */
function enableStripScroll(wrap, strip) {
  strip.addEventListener(
    'wheel',
    (e) => {
      // 已经是横向滚动就不接管
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (max <= 1) return;
      const atStart = strip.scrollLeft <= 1;
      const atEnd = strip.scrollLeft >= max - 1;
      // 到了两端就把滚动交还页面，避免列表"卡住"滚不动
      if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
      e.preventDefault();
      strip.scrollLeft = Math.max(0, Math.min(max, strip.scrollLeft + e.deltaY));
      syncPartBar(wrap, strip);
    },
    { passive: false }
  );
  strip.addEventListener('scroll', () => syncPartBar(wrap, strip));

  const track = wrap.querySelector('.part-track');
  const thumb = wrap.querySelector('.part-thumb');
  if (track) {
    // 点击轨道任意位置 → 跳转到对应进度
    track.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return; // 拖动由 thumb 处理
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const max = strip.scrollWidth - strip.clientWidth;
      strip.scrollTo({ left: ratio * max, behavior: 'smooth' });
    });
  }
  if (thumb && track) {
    thumb.addEventListener('pointerdown', (e) => dragPartThumb(wrap, strip, track, thumb, e));
  }
}

/** 渲染单张卡片下的多 P 横滑卡片条：卡片 + 底部 [‹ 滚动条 ›] 一行 */
function renderPartStrip(li, it) {
  const info = pageInfo.get(it.bvid);
  let wrap = li.querySelector('.part-wrap');
  const pages = (info && info.pages) || [];
  // 多 P 卡片不参与「统一高度」，高度随内容自适应
  li.classList.toggle('has-parts', pages.length > 1);
  if (pages.length <= 1) {
    if (wrap) wrap.remove();
    return;
  }
  let strip;
  if (!wrap) {
    wrap = el('div', 'part-wrap');
    // 阻止卡片条上的点击冒泡到卡片（否则会触发整条播放）
    wrap.addEventListener('click', (e) => e.stopPropagation());

    strip = el('div', 'part-strip');

    const bar = el('div', 'part-bar');

    const prevBtn = el('button', 'part-nav prev');
    prevBtn.title = '向左滚动';
    prevBtn.innerHTML = ICON.chevL;
    prevBtn.addEventListener('click', () => scrollPartStrip(strip, -1));

    const track = el('div', 'part-track');
    const thumb = el('div', 'part-thumb');
    track.appendChild(thumb);

    const nextBtn = el('button', 'part-nav next');
    nextBtn.title = '向右滚动';
    nextBtn.innerHTML = ICON.chevR;
    nextBtn.addEventListener('click', () => scrollPartStrip(strip, 1));

    bar.appendChild(prevBtn);
    bar.appendChild(track);
    bar.appendChild(nextBtn);

    wrap.appendChild(strip);
    wrap.appendChild(bar);
    li.appendChild(wrap);
    enableStripScroll(wrap, strip);
  } else {
    strip = wrap.querySelector('.part-strip');
  }

  strip.innerHTML = '';
  pages.forEach((p, i) => {
    const full = 'P' + p.page + (p.part ? ' ' + p.part : '');
    const card = el('div', 'part-card');
    card.dataset.key = it.bvid + ':' + p.cid;
    card.title = full + (p.duration ? '（' + fmtDur(p.duration) + '）' : '');
    card.appendChild(el('div', 'part-card-idx', 'P' + p.page));
    card.appendChild(el('div', 'part-card-title', p.part || 'P' + p.page));
    if (p.duration) card.appendChild(el('div', 'part-card-dur', fmtDur(p.duration)));
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      playListItemAt(li._listItems, li._listIndex, i);
    });
    strip.appendChild(card);
  });
  syncPartBar(wrap, strip);
}

/** 是否充电专属：条目自带 charged（队列/收藏里存了）优先，否则查已缓存的分P信息 */
function isChargedItem(it) {
  if (!it) return false;
  if (it.charged) return true;
  const info = it.bvid ? pageInfo.get(it.bvid) : null;
  return !!(info && info.charged);
}

/**
 * 充电视频：卡片右上角加「充电」角标。
 * hover 时**保留** —— 操作组在卡片右侧垂直居中，与右上角的角标并不重叠。
 */
function paintChargedBadge(li, it) {
  const charged = isChargedItem(it);
  const old = li.querySelector(':scope > .badge-charge');
  if (!charged) {
    if (old) old.remove();
    return;
  }
  if (old) return;
  const badge = el('span', 'badge-charge', '充电');
  badge.title = '充电专属视频，未充电通常只能播放试看部分';
  li.appendChild(badge);
}

// ---------------------------------------------------------------------------
// 导航栈
// ---------------------------------------------------------------------------
function currentView() {
  return navStack[navIndex] || null;
}

function isCurrent(view) {
  return navStack[navIndex] === view;
}

function homeView() {
  return { kind: 'home', title: '', params: {}, data: {} };
}

function go(view) {
  navStack = navStack.slice(0, navIndex + 1);
  navStack.push(view);
  navIndex = navStack.length - 1;
  renderNav();
}

function goBack() {
  if (navIndex <= 0) return;
  navIndex -= 1;
  renderNav();
}

function goHome() {
  navStack = [homeView()];
  navIndex = 0;
  renderNav();
}

function updateNavButtons() {
  const back = $('backBtn');
  if (back) back.disabled = navIndex <= 0;
}

function renderNav() {
  updateNavButtons();
  const container = $('listContainer');
  container.innerHTML = '';
  const view = currentView();
  if (!view || view.kind === 'home') {
    renderHome(container);
    return;
  }
  switch (view.kind) {
    case 'search':
      renderSearch(container, view);
      break;
    case 'up':
      renderUp(container, view);
      break;
    default:
      renderHome(container);
  }
  paintListNumbers(container);
  markPlaying();
}

// ---------------------------------------------------------------------------
// 列表渲染公共部分
// ---------------------------------------------------------------------------
function renderHome(container) {
  container.appendChild(
    el('div', 'empty', '输入关键词搜索视频，或点击 UP 主名浏览投稿与合集')
  );
}

/**
 * 构建单个列表项（标题点击播放、作者点击进 UP 主页、多 P 展示横滑卡片条、
 * meta 行右下角带「更多」按钮）
 * @param {object} it 列表数据
 * @param {Function} onPlay 点击标题的回调
 * @param {boolean} showTime 是否显示播放时间（历史用）
 * @param {Array} [listItems] 所属列表（供分 P 卡片定位）
 * @param {number} [listIndex] 在所属列表中的下标
 * @param {Array} [extraMenu] 追加到「更多」菜单末尾的自定义项
 * @param {object} [opts] opts.compact=true 时只保留「播放 / 更多」两个图标按钮
 *                        （历史等弹层专用，评论与添加到播放列表移入「更多」菜单）
 */
function buildItem(it, onPlay, showTime, listItems, listIndex, extraMenu, opts) {
  const compact = !!(opts && opts.compact);
  const li = el('li', 'item');
  li.dataset.bvid = it.bvid || '';
  if (it.cid) li.dataset.cid = String(it.cid);
  li._item = it;
  li._listItems = listItems || null;
  li._listIndex = typeof listIndex === 'number' ? listIndex : -1;

  const head = el('div', 'item-head');
  const main = el('div', 'item-main');

  const titleEl = el('div', 'item-title', it.title || '(无标题)');
  titleEl.title = it.title || '';
  titleEl.addEventListener('click', onPlay);

  const meta = el('div', 'item-meta');
  const author = makeAuthor(it.author, it.mid, it.bvid);
  if (author) meta.appendChild(author);
  if (it.duration) meta.appendChild(el('span', null, fmtItemDur(it.duration)));
  if (it.play != null) meta.appendChild(el('span', null, fmtPlay(it.play) + ' 播放'));
  if (showTime && it.time) meta.appendChild(el('span', null, fmtTime(it.time)));
  // 元信息全空时补一个占位，保证「更多」按钮仍靠右
  if (!meta.children.length) meta.appendChild(el('span', null, ' '));

  main.appendChild(titleEl);
  main.appendChild(meta);

  // hover 时在卡片右侧居中浮出：播放 / 添加到播放列表 / 更多
  // 「查看评论」在「更多」菜单首项（图标 + 文字）
  // compact（历史）：只有 播放 / 更多（外加移除），后两项挪进「更多」菜单
  const actions = el('div', 'item-actions');
  // 播放按钮：该条目正在播放时显示暂停图标，点击可暂停/续播
  const playAct = makeActionBtn(ICON.play, '播放', () => {
    if (isCurrentItem(it) && audio.src) {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
      return;
    }
    onPlay();
  });
  playAct.dataset.playbtn = '1';
  actions.appendChild(playAct);
  if (!compact) {
    actions.appendChild(makeActionBtn(ICON.queue, '添加到播放列表', () => addToQueue(it)));
  }
  actions.appendChild(
    makeActionBtn(ICON.more, '更多操作', (btn) => openItemMenu(btn, it, extraMenu))
  );

  head.appendChild(main);
  head.appendChild(actions);
  li.appendChild(head);
  li._actions = actions;
  return li;
}

/**
 * 给容器内所有列表卡片加左侧两位数序号（01、02…），格式与播放列表一致。
 * 覆盖：历史 / 收藏夹 / 收藏列表 / 搜索结果 / UP 投稿与合集内容。
 * 播放列表卡片自带序号，这里跳过。
 */
function paintListNumbers(container) {
  if (!container) return;
  container.querySelectorAll('ul.list').forEach((ul) => {
    let n = 0;
    ul.querySelectorAll(':scope > li.item').forEach((li) => {
      if (li.querySelector(':scope > .item-head > .pl-idx')) return; // 已有序号
      n += 1;
      const head = li.querySelector(':scope > .item-head');
      const idx = el('span', 'pl-idx', String(n).padStart(2, '0'));
      if (head) head.insertBefore(idx, head.firstChild);
    });
  });
}

/** 通用列表渲染：标题 + items + 加载更多（搜索视图的标题吸顶固定） */
function renderStandardList(container, view, items, hasMore, onPlay, onLoadMore) {
  if (view.title) {
    const t = el('div', 'list-title' + (view.kind === 'search' ? ' sticky-title' : ''), view.title);
    t.title = view.title;
    container.appendChild(t);
  }
  if (items == null) {
    container.appendChild(el('div', 'empty', '加载中…'));
    return null;
  }
  if (!items.length) {
    container.appendChild(el('div', 'empty', '没有找到内容'));
    return null;
  }
  const ul = el('ul', 'list');
  items.forEach((it, i) => {
    ul.appendChild(buildItem(it, () => onPlay(items, i), false, items, i));
  });
  container.appendChild(ul);
  if (hasMore) {
    const btn = el('button', 'loadmore', '加载更多');
    btn.onclick = onLoadMore;
    container.appendChild(btn);
  }
  loadPartsForList(container, items);
  return ul;
}

// ---------------------------------------------------------------------------
// 搜索视图
// ---------------------------------------------------------------------------
function doSearch(page, kw) {
  kw = kw || $('searchInput').value.trim();
  if (!kw) return;
  const view = {
    kind: 'search',
    title: kw,
    params: { kw, page: page || 1 },
    data: { kw, page: page || 1, items: null, hasMore: false },
  };
  go(view);
  loadSearch(view);
}

async function loadSearch(view) {
  const r = await api(
    '/api/search?kw=' + encodeURIComponent(view.data.kw) + '&page=' + view.data.page
  );
  if (r.code !== 0) {
    if (isCurrent(view)) handleError(r);
    return;
  }
  const result = (r.data && r.data.result) || [];
  view.data.items =
    view.data.page === 1 ? result : (view.data.items || []).concat(result);
  // 是否还有下一页由后端判定（后端按过滤前的原始条数判断，避免漏判）
  view.data.hasMore =
    r.data && typeof r.data.hasMore === 'boolean'
      ? r.data.hasMore
      : result.length >= 20;
  if (isCurrent(view)) renderNav();
}

function loadMoreSearch() {
  const view = currentView();
  if (!view || view.kind !== 'search') return;
  view.data.page += 1;
  loadSearch(view);
}

function renderSearch(container, view) {
  renderStandardList(
    container,
    view,
    view.data.items,
    view.data.hasMore,
    playItems,
    loadMoreSearch
  );
}

// ---------------------------------------------------------------------------
// UP 主页视图（资料卡 + 标签页：投稿 / 合集列表，均在同一视图内）
// ---------------------------------------------------------------------------
async function openUp(mid, name) {
  const view = {
    kind: 'up',
    title: 'UP主',
    params: { mid, name },
    data: {
      mid,
      name: name || '',
      sign: '',
      loaded: false,
      videos: null,
      videosTotal: 0,
      videosPage: 1,
      hasMore: false,
      tab: 'videos', // 当前标签：'videos' | 'seasons' | 'series'
      collections: { seasons: [], series: [] }, // 合集/列表目录
      collectionsLoaded: false,
      videoQuery: '', // 投稿内搜索关键词
      searchOpen: false, // 投稿搜索框是否展开
      videoAllLoading: false, // 是否正在后台补齐全部投稿
      videoAllLoaded: false, // 全部投稿是否已补齐
    },
  };
  go(view);
  await loadUp(view);
}

async function loadUp(view) {
  const mid = view.data.mid;
  const [sp, vr, cr] = await Promise.all([
    api('/api/space?mid=' + encodeURIComponent(mid)),
    api('/api/space/videos?mid=' + encodeURIComponent(mid) + '&pn=1&ps=20'),
    api('/api/space/collections?mid=' + encodeURIComponent(mid) + '&page=1'),
  ]);

  // 资料卡：名称 / 简介
  if (sp.code === 0 && sp.data) {
    view.data.name = sp.data.name || view.data.name || 'UP主';
    view.data.sign = sp.data.sign || '';
  }

  // 投稿列表
  if (vr.code !== 0) {
    if (isCurrent(view)) handleError(vr);
    view.data.videos = [];
    view.data.hasMore = false;
  } else {
    const vlist = (vr.data && vr.data.list && vr.data.list.vlist) || [];
    const total = (vr.data && vr.data.page && vr.data.page.count) || 0;
    view.data.videos = vlist.map((v) => ({
      bvid: v.bvid,
      title: v.title,
      author: view.data.name || '',
      mid: mid,
      duration: v.length,
      play: v.play,
    }));
    view.data.videosTotal = total;
    view.data.videosPage = 1;
    view.data.hasMore = view.data.videos.length < total;
  }
  view.data.loaded = true;

  // 合集/列表目录
  if (cr.code === 0 && cr.data) {
    view.data.collections.seasons = cr.data.seasons || [];
    view.data.collections.series = cr.data.series || [];
  }
  view.data.collectionsLoaded = true;

  if (isCurrent(view)) renderNav();
}

async function loadMoreUpVideos() {
  const view = currentView();
  if (!view || view.kind !== 'up') return;
  view.data.videosPage += 1;
  const page = view.data.videosPage;
  const mid = view.data.mid;
  const r = await api(
    '/api/space/videos?mid=' + encodeURIComponent(mid) + '&pn=' + page + '&ps=20'
  );
  if (r.code !== 0) return handleError(r);
  const vlist = (r.data && r.data.list && r.data.list.vlist) || [];
  const total = (r.data && r.data.page && r.data.page.count) || 0;
  view.data.videos = view.data.videos.concat(
    vlist.map((v) => ({
      bvid: v.bvid,
      title: v.title,
      author: view.data.name || '',
      mid: mid,
      duration: v.length,
      play: v.play,
    }))
  );
  view.data.videosTotal = total;
  view.data.hasMore = view.data.videos.length < total;
  if (isCurrent(view)) renderNav();
}

function renderUp(container, view) {
  const d = view.data;

  // 吸顶头部：sticky 固定，滚动时保持在顶部
  const header = el('div', 'up-header');

  // UP 主介绍 + 标签行（投稿 / 合集 / 列表）共用同一个圆框
  const card = el('div', 'up-card');
  card.appendChild(renderUpProfile(view));
  card.appendChild(renderUpTabBar(view));
  header.appendChild(card);
  container.appendChild(header);

  // 内容区单独成块：投稿内搜索时只重渲染这里，输入框不会失焦
  const content = el('div', 'up-content');
  container.appendChild(content);
  view._contentEl = content;
  renderUpContent(view);
}

/** UP 主资料：名称 + 简介 */
function renderUpProfile(view) {
  const d = view.data;
  const prof = el('div', 'up-profile');
  prof.appendChild(el('div', 'up-name', d.name || 'UP主'));
  if (d.sign) prof.appendChild(el('div', 'up-sign', d.sign));
  return prof;
}

/**
 * 标签行：投稿 / 合集 / 列表（左对齐，无边框无底色，统计数字标在文字右上角），
 * 行末是投稿搜索框（点击向左展开）。
 */
function renderUpTabBar(view) {
  const d = view.data;
  const bar = el('div', 'up-tabbar');
  const tabs = el('div', 'up-tabs');
  const seasons = (d.collections && d.collections.seasons) || [];
  const series = (d.collections && d.collections.series) || [];
  tabs.appendChild(makeUpTab(view, 'videos', '投稿', d.videosTotal));
  tabs.appendChild(makeUpTab(view, 'seasons', '合集', seasons.length));
  tabs.appendChild(makeUpTab(view, 'series', '列表', series.length));
  bar.appendChild(tabs);
  bar.appendChild(makeUpSearch(view));
  return bar;
}

/** 单个标签：文字 + 右上角统计数字；无边框无底色，hover 显示更深底色 */
function makeUpTab(view, tab, label, count) {
  const b = el('button', 'up-tab' + (view.data.tab === tab ? ' active' : ''));
  b.type = 'button';
  b.dataset.tab = tab;
  b.appendChild(el('span', 'up-tab-label', label));
  const c = el('span', 'up-tab-count', String(count == null ? 0 : count));
  c.title = '共 ' + String(count == null ? 0 : count) + ' 个';
  b.appendChild(c);
  b.addEventListener('click', () => {
    view.data.tab = tab;
    renderNav();
  });
  return b;
}

/** 投稿搜索框：默认收起为放大镜图标，点击向左展开成输入框 */
function makeUpSearch(view) {
  const d = view.data;
  const wrap = el('div', 'up-search' + (d.searchOpen ? ' open' : ''));

  // 输入框：展开时显示；X 清除按钮位于框内右侧（仅有关键词时显示）
  const field = el('div', 'up-search-field');
  const input = el('input', 'up-search-input');
  input.type = 'text';
  input.placeholder = '搜索投稿';
  input.value = d.videoQuery || '';
  input.hidden = !d.searchOpen;
  const clear = el('button', 'up-search-clear');
  clear.type = 'button';
  clear.title = '清除';
  clear.setAttribute('aria-label', '清除');
  clear.innerHTML = ICON.close;
  clear.hidden = !(d.searchOpen && d.videoQuery);

  // 清除按钮：阻止失焦（先 preventDefault 再清空），清空后保持焦点
  clear.addEventListener('mousedown', (e) => e.preventDefault());
  clear.addEventListener('click', () => {
    input.value = '';
    d.videoQuery = '';
    clear.hidden = true;
    renderUpContent(view);
    input.focus();
  });

  // 展开按钮：仅收起态显示；展开后不显示关闭按钮
  const btn = el('button', 'up-search-btn');
  btn.type = 'button';
  btn.title = '在投稿中搜索';
  btn.setAttribute('aria-label', '在投稿中搜索');
  btn.innerHTML = ICON.search;
  btn.hidden = d.searchOpen;
  btn.addEventListener('click', () => {
    d.searchOpen = true;
    renderNav();
    const inp = document.querySelector('.up-search-input');
    if (inp) inp.focus();
  });

  input.addEventListener('input', () => {
    d.videoQuery = input.value.trim();
    clear.hidden = !input.value;
    // 搜索只针对投稿：在其它标签下输入时自动切回投稿
    if (d.videoQuery && d.tab !== 'videos') d.tab = 'videos';
    renderUpContent(view);
    // 已加载的投稿不完整时，后台补齐后再筛一次，保证搜索覆盖全部投稿
    if (d.videoQuery && d.hasMore) loadAllUpVideos(view);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = '';
      d.videoQuery = '';
      clear.hidden = true;
      renderUpContent(view);
    }
    e.stopPropagation();
  });
  // 失焦且无内容时自动回收
  input.addEventListener('blur', () => {
    if (input.value.trim()) return;
    d.searchOpen = false;
    d.videoQuery = '';
    renderNav();
  });

  field.appendChild(input);
  field.appendChild(clear);
  wrap.appendChild(field);
  wrap.appendChild(btn);
  return wrap;
}

/** 只重渲染 UP 视图的内容区 + 同步标签高亮（不重建搜索框，输入焦点不丢） */
function renderUpContent(view) {
  const host = view._contentEl;
  // 视图已经切走（节点脱离文档）时直接跳过，避免写进游离节点
  if (!host || !host.isConnected) return;
  host.innerHTML = '';
  if (view.data.tab === 'videos') renderUpVideosContent(host, view);
  else if (view.data.tab === 'seasons') renderUpCollEntries(host, view, 'season');
  else renderUpCollEntries(host, view, 'series');
  document.querySelectorAll('.up-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === view.data.tab);
  });
}

/** 投稿列表（支持关键词过滤） */
function filteredUpVideos(view) {
  const q = (view.data.videoQuery || '').toLowerCase();
  const all = view.data.videos || [];
  if (!q) return all;
  return all.filter((v) => String(v.title || '').toLowerCase().indexOf(q) >= 0);
}

function renderUpVideosContent(container, view) {
  const d = view.data;
  if (!d.loaded) {
    container.appendChild(el('div', 'empty', '加载中…'));
    return;
  }
  const q = (d.videoQuery || '').trim();
  const items = filteredUpVideos(view);
  if (!items.length) {
    container.appendChild(
      el('div', 'empty', q ? '没有匹配的投稿' : '暂无投稿')
    );
    return;
  }
  if (q) {
    container.appendChild(
      el('div', 'up-result', '匹配 ' + items.length + ' / ' + (d.videosTotal || items.length) + ' 个投稿')
    );
  }
  const ul = el('ul', 'list');
  items.forEach((it, i) => {
    ul.appendChild(buildItem(it, () => playItems(items, i), false, items, i));
  });
  container.appendChild(ul);
  if (!q && d.hasMore) {
    const btn = el('button', 'loadmore', '加载更多');
    btn.onclick = loadMoreUpVideos;
    container.appendChild(btn);
  }
  loadPartsForList(container, items);
}

/** 后台补齐该 UP 的全部投稿（搜索时保证结果完整，最多补 40 页） */
async function loadAllUpVideos(view) {
  const d = view.data;
  if (d.videoAllLoading || d.videoAllLoaded) return;
  d.videoAllLoading = true;
  let guard = 0;
  while (d.hasMore && guard < 40 && isCurrent(view)) {
    guard += 1;
    d.videosPage += 1;
    const r = await api(
      '/api/space/videos?mid=' + encodeURIComponent(d.mid) +
      '&pn=' + d.videosPage + '&ps=30'
    );
    if (r.code !== 0) break;
    const vlist = (r.data && r.data.list && r.data.list.vlist) || [];
    if (!vlist.length) break;
    const total = (r.data && r.data.page && r.data.page.count) || 0;
    d.videos = (d.videos || []).concat(
      vlist.map((v) => ({
        bvid: v.bvid,
        title: v.title,
        author: d.name || '',
        mid: d.mid,
        duration: v.length,
        play: v.play,
      }))
    );
    d.videosTotal = total || d.videosTotal;
    d.hasMore = d.videos.length < d.videosTotal;
    renderUpContent(view);
  }
  d.videoAllLoading = false;
  d.videoAllLoaded = true;
  renderUpContent(view);
}

/**
 * 合集 / 列表条目：两排（名称 + 视频数量小字），
 * 右侧三个图标（打开 / 播放全部 / 收藏）hover 才浮出。
 */
function renderUpCollEntries(container, view, type) {
  const d = view.data;
  if (!d.collectionsLoaded) {
    container.appendChild(el('div', 'empty', '加载中…'));
    return;
  }
  const list = type === 'season'
    ? ((d.collections && d.collections.seasons) || [])
    : ((d.collections && d.collections.series) || []);
  const noun = type === 'season' ? '合集' : '列表';
  if (!list.length) {
    container.appendChild(el('div', 'empty', '该 UP 主暂无' + noun));
    return;
  }
  const wrap = el('div', 'coll-entry-list');
  list.forEach((it, i) => {
    const id = type === 'season' ? it.season_id : it.series_id;
    const row = el('div', 'coll-entry');
    row.appendChild(el('span', 'pl-idx', String(i + 1).padStart(2, '0')));

    const main = el('div', 'coll-entry-main');
    main.appendChild(el('div', 'coll-entry-name', it.name || ('未命名' + noun)));
    main.appendChild(el('div', 'coll-entry-count', (it.total || 0) + ' 个视频'));
    main.addEventListener('click', () => openCollModal(view, type, it));
    row.appendChild(main);

    const acts = el('div', 'coll-entry-acts');
    acts.appendChild(
      makeCollEntryBtn(ICON.open, '打开' + noun, () => openCollModal(view, type, it))
    );
    acts.appendChild(
      makeCollEntryBtn(ICON.playAll, '播放全部', () => playCollEntry(view, type, it))
    );
    acts.appendChild(
      makeCollEntryBtn(ICON.star, '收藏' + noun, () => favCollEntry(view, type, it))
    );
    row.appendChild(acts);
    wrap.appendChild(row);
  });
  container.appendChild(wrap);
}

function makeCollEntryBtn(iconHtml, title, onClick) {
  const b = el('button', 'coll-entry-btn');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = iconHtml;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 直接播放整个合集/列表（不打开弹窗） */
async function playCollEntry(view, type, it) {
  const items = await fetchCollItems(view, type, it, true);
  if (!items.length) return;
  playItems(items, 0);
}

/** 收藏整个合集/列表 */
async function favCollEntry(view, type, it) {
  const items = await fetchCollItems(view, type, it, true);
  if (!items.length) return;
  openFavPick(items);
}

/** 追加整个合集/列表到播放列表 */
async function appendCollEntry(view, type, it) {
  const items = await fetchCollItems(view, type, it, true);
  if (!items.length) return;
  await appendItemsToQueue(items);
}

/**
 * 拉取合集/列表内容。all=true 时逐页取完整份（用于播放全部 / 收藏 / 追加），
 * 否则只取第一页（用于弹窗首屏，弹窗内可继续加载更多）。
 */
async function fetchCollItems(view, type, it, all) {
  const d = view.data;
  const mid = d.mid;
  const id = type === 'season' ? it.season_id : it.series_id;
  if (id == null) {
    toast('无法打开该' + (type === 'season' ? '合集' : '列表'));
    return [];
  }
  const url = (page) =>
    type === 'season'
      ? '/api/collection?mid=' + encodeURIComponent(mid) +
        '&season_id=' + encodeURIComponent(id) + '&page=' + page
      : '/api/series?mid=' + encodeURIComponent(mid) +
        '&series_id=' + encodeURIComponent(id) + '&page=' + page;

  let out = [];
  let page = 1;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const r = await api(url(page));
    if (r.code !== 0) {
      handleError(r);
      break;
    }
    const archives = (r.data && r.data.archives) || [];
    out = out.concat(
      archives.map((a) => ({
        bvid: a.bvid,
        title: a.title,
        author: d.name || '',
        mid: mid != null ? String(mid) : null,
        duration: a.duration,
        play: a.view,
      }))
    );
    if (!all || archives.length < 30) break;
    page += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 合集 / 列表内容弹窗（播放全部 / 追加到播放列表 / 收藏 / 批量操作）
// ---------------------------------------------------------------------------
let collState = null; // {kind, id, name, mid, author, items, page, hasMore, loading, batch, selected:Set}

/** 打开合集/列表弹窗（只先加载第一页，滚动到底可加载更多） */
function openCollModal(view, type, it) {
  const d = view.data;
  const id = type === 'season' ? it.season_id : it.series_id;
  if (id == null) {
    toast('无法打开该' + (type === 'season' ? '合集' : '列表'));
    return;
  }
  collState = {
    kind: type,
    id: id,
    name: it.name || '',
    mid: d.mid,
    author: d.name || '',
    items: null,
    page: 1,
    hasMore: false,
    loading: false,
    batch: false,
    selected: new Set(),
  };
  $('collTitle').textContent = collState.name;
  $('collCount').hidden = true;
  // 清除可能残留的滑出态，确保滑入动画从头播放
  const box = $('collModal').querySelector('.coll-modal-box');
  if (box) box.classList.remove('coll-out');
  $('collModal').classList.remove('hidden');
  renderCollBody();
  loadCollPage(1);
}

function closeCollModal() {
  if (collState) {
    collState.batch = false;
    collState.selected.clear();
  }
  collState = null;
  // 复位头部批量激活态（此前关窗后图标仍停留在激活态）
  const btn = $('collBatchBtn');
  if (btn) {
    btn.hidden = true;
    btn.classList.remove('active');
  }
  const bar = $('collBatchBar');
  if (bar) bar.classList.add('hidden');
  closeAllPopovers();
  const m = $('collModal');
  if (!m || m.classList.contains('hidden')) return;
  // 从右侧滑出后再真正隐藏
  const box = m.querySelector('.coll-modal-box');
  if (box) box.classList.add('coll-out');
  setTimeout(() => {
    m.classList.add('hidden');
    if (box) box.classList.remove('coll-out');
  }, 200);
}

/** 进入 / 退出批量模式（清空选中并同步头部按钮与批量栏） */
function setCollBatch(on) {
  const st = collState;
  if (!st) return;
  st.batch = !!on;
  st.selected.clear();
  syncCollHead();
  renderCollBody();
}

/** 同步头部按钮：批量时只显示「批量开关 + 关闭」，其余工具按钮隐藏 */
function syncCollHead() {
  const st = collState;
  const batch = !!(st && st.batch);
  $('collPlayAllBtn').hidden = batch;
  $('collQueueBtn').hidden = batch;
  $('collMoreBtn').hidden = batch;
  const btn = $('collBatchBtn');
  if (btn) {
    btn.hidden = !batch;
    btn.classList.toggle('active', batch);
  }
  const bar = $('collBatchBar');
  if (bar) bar.classList.toggle('hidden', !batch);
  // 批量模式：隐藏卡片悬浮操作按钮（CSS 按 .coll-batching 控制）
  const m = $('collModal');
  if (m) m.classList.toggle('coll-batching', batch);
}

async function loadCollPage(page) {
  const st = collState;
  if (!st || st.loading) return;
  st.loading = true;
  const url =
    st.kind === 'season'
      ? '/api/collection?mid=' + encodeURIComponent(st.mid) +
        '&season_id=' + encodeURIComponent(st.id) + '&page=' + page
      : '/api/series?mid=' + encodeURIComponent(st.mid) +
        '&series_id=' + encodeURIComponent(st.id) + '&page=' + page;
  const r = await api(url);
  // 弹窗可能已被关掉
  if (!collState || collState !== st) return;
  st.loading = false;
  if (r.code !== 0) {
    st.items = st.items || [];
    renderCollBody();
    handleError(r);
    return;
  }
  const archives = (r.data && r.data.archives) || [];
  const items = archives.map((a) => ({
    bvid: a.bvid,
    title: a.title,
    author: st.author,
    mid: st.mid != null ? String(st.mid) : null,
    duration: a.duration,
    play: a.view,
  }));
  st.items = page === 1 ? items : (st.items || []).concat(items);
  st.page = page;
  st.hasMore = archives.length === 30;
  renderCollBody();
}

function setCollCount(n) {
  const c = $('collCount');
  if (!c) return;
  if (n == null) {
    c.hidden = true;
    return;
  }
  c.textContent = String(n);
  c.hidden = false;
}

function renderCollBody() {
  const st = collState;
  const body = $('collBody');
  if (!st || !body) return;
  body.innerHTML = '';
  syncCollHead();

  $('collTitle').textContent = st.name;
  setCollCount(st.items ? st.items.length : null);

  if (!st.items) {
    body.appendChild(el('div', 'empty', '加载中…'));
    return;
  }
  if (!st.items.length) {
    body.appendChild(el('div', 'empty', '暂无内容'));
    return;
  }

  const ul = el('ul', 'list');
  st.items.forEach((it, i) => {
    const key = String(i);
    // 批量模式下点标题不播放，只切换选中
    const li = buildItem(
      it,
      () => {
        if (collState && collState.batch) return;
        playItems(st.items, i);
      },
      false,
      st.items,
      i
    );
    li.dataset.collKey = key;
    if (st.batch) {
      const head = li.querySelector('.item-head');
      // 选框替换序号位置：用一个与 .pl-idx 同布局的单元格承载 checkbox
      const cell = el('span', 'coll-check-cell');
      const cb = el('input', 'coll-check');
      cb.type = 'checkbox';
      cb.checked = st.selected.has(key);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => toggleCollSel(key, cb.checked));
      cell.appendChild(cb);
      if (head) head.insertBefore(cell, head.firstChild);
      li.classList.toggle('selected', st.selected.has(key));
      li.addEventListener('click', (e) => {
        // 批量模式下点整行即切换选中（避开操作按钮与分 P 卡片）
        if (e.target.closest('.item-act, .part-card, .part-nav')) return;
        toggleCollSel(key, !st.selected.has(key));
      });
    }
    ul.appendChild(li);
  });
  body.appendChild(ul);

  if (st.hasMore) {
    const btn = el('button', 'loadmore', '加载更多');
    btn.onclick = () => loadCollPage(st.page + 1);
    body.appendChild(btn);
  }
  loadPartsForList(body, st.items);
  if (!st.batch) paintListNumbers(body); // 批量模式：选框已占据序号位，不绘序号
  syncCollBatchBar();
}

function toggleCollSel(key, on) {
  const st = collState;
  if (!st) return;
  if (on) st.selected.add(key);
  else st.selected.delete(key);
  const li = document.querySelector('#collBody .item[data-coll-key="' + key + '"]');
  if (li) {
    const cb = li.querySelector('.coll-check');
    if (cb) cb.checked = !!on;
    li.classList.toggle('selected', !!on);
  }
  syncCollBatchBar();
}

function syncCollBatchBar() {
  const st = collState;
  if (!st) return;
  const label = $('collSelCount');
  if (label) label.textContent = '已选 ' + st.selected.size + ' 项';
  const all = $('collSelectAll');
  if (all) {
    const allSel = (st.items || []).length > 0 && st.selected.size === st.items.length;
    all.title = allSel ? '取消全选' : '全选';
    all.setAttribute('aria-label', allSel ? '取消全选' : '全选');
    all.classList.toggle('active', allSel);
  }
}

/** 批量模式下取当前选中的条目 */
function collSelectedItems() {
  const st = collState;
  if (!st || !st.items) return [];
  return st.items.filter((_, i) => st.selected.has(String(i)));
}

/** 播放全部：取完整份内容后整体入队播放 */
async function collPlayAll() {
  const st = collState;
  if (!st) return;
  const items = await collFetchAll();
  if (!items.length) return;
  playItems(items, 0);
  closeCollModal();
}

async function collAppendAll() {
  const st = collState;
  if (!st) return;
  await appendItemsToQueue(await collFetchAll());
}

async function collFavAll() {
  const st = collState;
  if (!st) return;
  const items = await collFetchAll();
  if (!items.length) return;
  openFavPick(items);
}

/** 取弹窗对应合集/列表的完整内容（播放全部 / 收藏 / 追加需要全量） */
async function collFetchAll() {
  const st = collState;
  if (!st) return [];
  const url = (page) =>
    st.kind === 'season'
      ? '/api/collection?mid=' + encodeURIComponent(st.mid) +
        '&season_id=' + encodeURIComponent(st.id) + '&page=' + page
      : '/api/series?mid=' + encodeURIComponent(st.mid) +
        '&series_id=' + encodeURIComponent(st.id) + '&page=' + page;
  if (!st.hasMore && st.items) return st.items;
  let out = [];
  let page = 1;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const r = await api(url(page));
    if (r.code !== 0) {
      handleError(r);
      break;
    }
    const archives = (r.data && r.data.archives) || [];
    out = out.concat(
      archives.map((a) => ({
        bvid: a.bvid,
        title: a.title,
        author: st.author,
        mid: st.mid != null ? String(st.mid) : null,
        duration: a.duration,
        play: a.view,
      }))
    );
    if (archives.length < 30) break;
    page += 1;
  }
  if (collState === st) {
    st.items = out;
    st.hasMore = false;
    renderCollBody();
  }
  return out;
}

/** 批量追加：把若干条目（含多 P 展开）接到队列尾部；已在队列中的条目跳过 */
async function appendItemsToQueue(items) {
  const list = items || [];
  if (!list.length) {
    toast('没有可添加的内容');
    return;
  }
  const flat = [];
  for (const it of list) {
    const es = await entriesForItem(it);
    flat.push(...es);
  }
  if (!flat.length) return;
  const r = mergeAppend(queue, flat);
  if (!r.added) {
    toast('已在播放列表中');
    return;
  }
  queue = r.list;
  saveState();
  if (currentIndex < 0 && queue.length) {
    currentIndex = 0;
    playQueue();
  } else {
    toast(
      r.skipped
        ? '已追加 ' + r.added + ' 项到播放列表（' + r.skipped + ' 项已存在）'
        : '已追加 ' + r.added + ' 项到播放列表'
    );
  }
  if (panelVisible() && currentPanel === 'playlist') renderPanelBody();
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 面板弹层（播放列表 / 历史 / 评论）
// ---------------------------------------------------------------------------
function panelVisible() {
  return sheetOpen($('panelModal'));
}

/**
 * 弹层是否处于「可用状态」。
 * 收回动画期间（已触发关闭但 hidden 还没加上）必须算关闭，
 * 否则此刻同步底部按钮会把 .active 留在按钮上，动画结束后底色不还原。
 */
function sheetOpen(modal) {
  return !!(modal && !modal.classList.contains('hidden') && !modal._closing);
}

/** 同步底部三个弹层按钮的激活状态（打开时底色加深） */
function syncPanelButtons() {
  $('playlistBtn').classList.toggle('active', currentPanel === 'playlist');
  $('historyBtn').classList.toggle('active', currentPanel === 'history');
  $('commentsBtn').classList.toggle('active', commentsVisible());
}

/**
 * 顶层弹层互斥。
 *
 * 底部播放条（z-index 130）压在弹层遮罩（z-index 100）之上，弹层开着时
 * 底部三个按钮仍可点 —— 若不处理，就会叠加出「播放列表盖在收藏列表窗口上」这类双层弹窗。
 * 因此把 播放列表/历史/收藏夹（panelModal）、评论（commentsModal）、收藏列表
 * （collectionsModal）视为同一层：打开其中一个时，其余已打开的立即收起。
 *
 * 收起走 skipBgFade（背景色瞬间交接给接手的弹层），避免两层半透明背景交叠时闪一下白底。
 * @param {HTMLElement} keep 即将打开（或要保留）的弹层
 */
function closeOtherTopSheets(keep) {
  if (keep !== $('commentsModal') && commentsVisible()) closeComments(true);
  if (keep !== $('panelModal') && panelVisible()) closePanel(true);
  if (keep !== $('collectionsModal') && sheetOpen($('collectionsModal'))) closeCollections(true);
}

// ---------------------------------------------------------------------------
// 弹层出入场动画：从下向上弹出 / 向下收回，背景渐进变黑 / 变白
// （仅评论 / 播放列表 / 历史三个 sheet 弹层；每个弹层有独立的收回定时器）
// ---------------------------------------------------------------------------
/** 取消某个弹层正在进行的收回动画 */
function cancelSheetHide(modal) {
  modal._closing = false;
  if (modal._hideTimer) {
    clearTimeout(modal._hideTimer);
    modal._hideTimer = null;
  }
}

/** 瞬时设置背景透明度（不触发过渡，用于切换弹层时保持背景黑度不变） */
function setInstantBg(modal, opacity) {
  modal.style.transition = 'none';
  modal.style.opacity = opacity;
  void modal.offsetWidth;
  modal.style.transition = '';
}

/** 从下向上弹出；背景由透明渐进变黑（skipBgFade 时背景保持，用于互斥切换） */
function showSheetAnimated(modal, opts) {
  cancelSheetHide(modal);
  const box = modal.querySelector('.sheet-box');
  box.classList.add('sheet-out');
  const alreadyVisible = !modal.classList.contains('hidden');
  if (!alreadyVisible) {
    modal.classList.remove('hidden');
    if (opts && opts.skipBgFade) {
      setInstantBg(modal, '1');
    } else {
      modal.style.opacity = '0';
      void modal.offsetWidth;
      modal.style.opacity = '';
    }
  } else if (opts && opts.skipBgFade) {
    setInstantBg(modal, '1');
  } else {
    modal.style.opacity = '';
  }
  void box.offsetWidth; // 强制 reflow，保证过渡从初始位开始
  box.classList.remove('sheet-out');
}

/** 向下收回，背景渐进变透明，动画结束后真正隐藏 */
function hideSheetAnimated(modal, onDone, opts) {
  if (!modal) return;
  const box = modal.querySelector('.sheet-box');
  box.classList.add('sheet-out');
  if (opts && opts.skipBgFade) {
    setInstantBg(modal, '0');
  } else {
    modal.style.opacity = '0';
  }
  cancelSheetHide(modal);
  modal._closing = true; // 标记收回中：此刻起视为已关闭（按钮底色立即还原）
  modal._hideTimer = setTimeout(() => {
    modal._hideTimer = null;
    modal._closing = false;
    modal.classList.add('hidden');
    box.classList.remove('sheet-out');
    modal.style.opacity = '';
    if (onDone) onDone();
  }, 250);
}

function openPanel(kind) {
  // 三个顶层弹层互斥：先判断要不要保留背景黑度，再收起其它弹层
  const switching = commentsVisible() || sheetOpen($('collectionsModal'));
  closeOtherTopSheets($('panelModal'));
  currentPanel = kind;
  showSheetAnimated($('panelModal'), { skipBgFade: switching });
  renderPanelBody();
  syncPanelButtons();
}

/** 底部按钮切换：同面板已开 → 向下收回；否则打开/直接切换 */
function togglePanel(kind) {
  if (panelVisible() && currentPanel === kind) {
    currentPanel = null;
    syncPanelButtons();
    hideSheetAnimated($('panelModal'));
    return;
  }
  openPanel(kind);
}

/**
 * 收起播放列表 / 历史 / 收藏夹弹层。
 * @param {boolean} skipBgFade 仅互斥切换时由内部传 true（背景交给接手的弹层）；
 *        直接点关闭（含点背景）时传的是事件对象，必须走普通淡出，否则背景会先一步消失。
 */
function closePanel(skipBgFade) {
  currentPanel = null;
  syncPanelButtons();
  hideSheetAnimated($('panelModal'), null, skipBgFade === true ? { skipBgFade: true } : undefined);
}

/**
 * 弹层头部右上角按钮随面板类型变化：
 *   播放列表 → 保存为收藏列表 + 清空（垃圾桶图标）
 *   历史     → 清空（垃圾桶图标）
 *   账号收藏夹内容 → 返回上一层图标
 *   其余     → 隐藏
 */
function syncPanelHead() {
  const btn = $('clearPanelBtn');
  const save = $('savePlaylistBtn');
  if (save) {
    save.hidden = currentPanel !== 'playlist';
  }
  if (!btn) return;
  if (currentPanel === 'playlist' || currentPanel === 'history') {
    btn.hidden = false;
    btn.innerHTML = ICON.trashSm;
    btn.classList.add('danger');
    btn.title = '清空';
    btn.setAttribute('aria-label', '清空');
  } else if (currentPanel === 'favlist') {
    btn.hidden = false;
    btn.innerHTML = ICON.back;
    btn.classList.remove('danger');
    btn.title = '返回收藏夹目录';
    btn.setAttribute('aria-label', '返回收藏夹目录');
  } else {
    btn.hidden = true;
    btn.classList.remove('danger');
  }
}

/** 收藏夹（favfolders / favlist）：弹窗尺寸与收藏列表一致 */
function syncFavSheet() {
  const box = document.querySelector('#panelModal .sheet-box');
  if (box) {
    const fav = currentPanel === 'favfolders' || currentPanel === 'favlist';
    box.classList.toggle('fav-sheet', fav);
  }
  // 我的关注：325×540 且从左侧滑出
  const modal = $('panelModal');
  if (modal) modal.classList.toggle('follow-sheet', currentPanel === 'followings');
}

/** 弹层标题右侧的数字角标（浅黑小字，无括号） */
function setPanelCount(n) {
  const c = $('panelCount');
  if (!c) return;
  if (n === null || n === undefined) {
    c.hidden = true;
    return;
  }
  c.textContent = String(n);
  c.hidden = false;
}

/** 统一更新弹层标题（含数量）并渲染 body；每次刷新都会同步标题 */
function renderPanelBody() {
  const body = $('panelBody');
  body.innerHTML = '';
  syncPanelHead();
  syncFavSheet();
  const sub = $('panelSub');
  if (sub) {
    sub.hidden = !(currentPanel === 'favfolders' || currentPanel === 'favlist');
  }
  if (currentPanel === 'playlist') {
    $('panelTitle').textContent = '播放列表';
    setPanelCount(queue.length);
    renderPlaylist(body);
  } else if (currentPanel === 'history') {
    $('panelTitle').textContent = '播放历史';
    setPanelCount(null);
    loadHistoryIntoPanel(body);
  } else if (currentPanel === 'favfolders') {
    $('panelTitle').textContent = '收藏夹';
    setPanelCount(null);
    loadFavFolders(body);
  } else if (currentPanel === 'favlist') {
    $('panelTitle').textContent = favTitle || '收藏夹内容';
    setPanelCount(favItems.length);
    renderFavItems(body);
  } else if (currentPanel === 'followings') {
    $('panelTitle').textContent = '我的关注';
    setPanelCount(followTotal || followItems.length || null);
    renderFollowings(body);
  }
}

/** 面板打开时刷新面板内容，否则刷新导航视图 */
function refreshPanelOrNav() {
  if (panelVisible()) {
    renderPanelBody();
  } else {
    renderNav();
  }
}

// ---------------------------------------------------------------------------
// 播放列表
// ---------------------------------------------------------------------------
function openPlaylist() {
  openPanel('playlist');
}

/** 构建播放列表卡片：左侧两位数序号 + 文本区（多 P 三排：P 名 / 小字总名 / meta） */
function buildPlaylistItem(it, i) {
  const li = el('li', 'item');
  li.dataset.bvid = it.bvid || '';
  li.dataset.cid = it.cid || '';
  li._item = it;

  const head = el('div', 'item-head');
  const idx = el('span', 'pl-idx', String(i + 1).padStart(2, '0'));
  head.appendChild(idx);

  const main = el('div', 'item-main');

  const titleEl = el('div', 'item-title', it.part || it.title || '(无标题)');
  titleEl.title = it.part ? it.part + (it.main ? ' · ' + it.main : '') : it.title || '';
  titleEl.addEventListener('click', () => playQueueAt(i));

  const meta = el('div', 'item-meta');
  const author = makeAuthor(it.author, it.mid, it.bvid);
  if (author) meta.appendChild(author);
  if (it.duration) meta.appendChild(el('span', null, fmtItemDur(it.duration)));

  main.appendChild(titleEl);
  // 多 P：中间一行小字显示视频总名称
  if (it.part && it.main) {
    const sub = el('div', 'pl-sub', it.main);
    sub.title = it.main;
    main.appendChild(sub);
  }
  main.appendChild(meta);

  // hover 操作组：播放 / 移除 / 更多（评论在「更多」菜单首项）
  const actions = el('div', 'item-actions');
  const playAct = makeActionBtn(ICON.play, '播放', () => {
    if (isCurrentItem(it) && audio.src) {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
      return;
    }
    playQueueAt(i);
  });
  playAct.dataset.playbtn = '1';
  actions.appendChild(playAct);
  actions.appendChild(makeActionBtn(ICON.trash, '从播放列表移除', () => removeFromQueue(i)));
  actions.appendChild(
    makeActionBtn(ICON.more, '更多操作', (btn) => openItemMenu(btn, it))
  );

  head.appendChild(main);
  head.appendChild(actions);
  li.appendChild(head);
  li._actions = actions;
  return li;
}

function renderPlaylist(container) {
  if (!queue.length) {
    container.appendChild(el('div', 'empty', '播放列表为空'));
    return;
  }

  const ul = el('ul', 'list');
  queue.forEach((it, i) => {
    const li = buildPlaylistItem(it, i);
    if (i === currentIndex) li.classList.add('playing');
    ul.appendChild(li);
  });
  container.appendChild(ul);
  // 打开 / 刷新时定位到正在播放的那条
  const playing = ul.querySelector('.item.playing');
  if (playing) {
    try {
      playing.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) {}
  }
  markPlaying();
  // 充电专属标识：队列条目自带 charged，直接刷一遍即可
  loadChargesForList(container, queue);
  // 老条目缺 mid 时后台补一次，补到后重绘，作者名才点得动
  ensureMidsThenRepaint(queue, () => {
    if (panelVisible() && currentPanel === 'playlist') renderPanelBody();
  });
}

async function playQueueAt(i) {
  if (i < 0 || i >= queue.length) return;
  userPickedPlayback = true;
  currentIndex = i;
  await playQueue();
  saveState();
  if (panelVisible()) renderPanelBody();
  markPlaying();
}

function removeFromQueue(i) {
  if (i < 0 || i >= queue.length) return;
  queue.splice(i, 1);
  if (!queue.length) {
    currentIndex = -1;
    stopPlayback();
  } else if (i < currentIndex) {
    currentIndex -= 1;
  } else if (i === currentIndex) {
    if (currentIndex >= queue.length) currentIndex = queue.length - 1;
    playQueue();
  }
  saveState();
  refreshPanelOrNav();
  markPlaying();
}

/** 默认列表名：播放列表 MM-DD HH:mm */
function defaultPlaylistName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    '播放列表 ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

/**
 * 把当前播放列表转成一整份收藏列表条目。
 * mid 必须转成字符串：后端 normalize 只读字符串，传数字会被丢弃，
 * 导致存进收藏列表后 UP 主名点不动。
 */
function playlistItemsForSave() {
  return queue.map((it) => ({
    bvid: it.bvid || '',
    cid: it.cid != null && it.cid !== '' ? String(it.cid) : null,
    title: it.title || '',
    author: it.author || '',
    mid: it.mid != null && it.mid !== '' ? String(it.mid) : null,
    duration: Number(it.duration) || 0,
  }));
}

/** 播放列表弹窗右上角：把当前播放列表另存为一个收藏列表 */
async function savePlaylistAsCollection() {
  if (!queue.length) {
    toast('播放列表是空的');
    return;
  }
  const res = await showDialog({
    title: '保存为收藏列表',
    text: '把当前播放列表的 ' + queue.length + ' 项内容保存为一个新的收藏列表。',
    input: { value: defaultPlaylistName(), placeholder: '列表名称' },
  });
  if (res.act !== 'ok') return;
  const name = res.value;
  if (!name) {
    toast('请输入列表名称');
    return;
  }
  await createCollectionWithItems(name, playlistItemsForSave());
}

/** 新建一个收藏列表并立刻写入条目 */
async function createCollectionWithItems(name, items) {
  if (!items.length) {
    toast('没有可保存的内容');
    return;
  }
  const r = await api('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  const created = collections[collections.length - 1];
  if (!created) {
    toast('创建列表失败');
    return;
  }
  const r2 = await api('/api/collections/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: created.id, items: items }),
  });
  if (r2.code !== 0) return handleError(r2);
  collections = r2.data || [];
  renderCollectionsBody();
  toast(
    r2.added
      ? '已保存到收藏列表「' + name + '」（' + r2.added + ' 项）'
      : '收藏列表「' + name + '」已存在这些内容'
  );
}

function clearQueue() {
  queue = [];
  currentIndex = -1;
  stopPlayback();
  saveState();
  refreshPanelOrNav();
}

function stopPlayback() {
  try {
    audio.pause();
  } catch (e) {}
  try {
    audio.removeAttribute('src');
    audio.load();
  } catch (e) {}
  resumeTime = 0;
  pendingSeek = 0;
  resumeKey = null;
  retryCount = 0;
  resetWatchdog();
  setPlayIcon(false);
  setPlayerDisplay(null);
  renderSeek();
  markPlaying();
}

// ---------------------------------------------------------------------------
// 播放历史
// ---------------------------------------------------------------------------
function openHistory() {
  openPanel('history');
}

async function loadHistoryIntoPanel(container) {
  container.appendChild(el('div', 'empty', '加载中…'));
  const r = await api('/api/history');
  if (r.code !== 0) {
    container.innerHTML = '';
    container.appendChild(el('div', 'empty', r.message || '加载失败'));
    return;
  }
  const items = (r.data || []).map((it) => ({
    bvid: it.bvid,
    cid: it.cid || null,
    title: it.title,
    author: it.author,
    mid: it.mid || null,
    time: it.time,
  }));
  if (currentPanel === 'history') {
    setPanelCount(items.length);
  }
  renderHistory(container, items);

  // 老记录没有 mid（UP 主名点不动），这里补拉一次作者信息
  const missing = items.filter((it) => it.author && !it.mid).map((it) => it.bvid);
  if (missing.length) {
    const changed = await ensurePages(missing);
    if (changed && currentPanel === 'history') renderHistory(container, items);
  }
}

async function clearHistory() {
  const r = await api('/api/history', { method: 'DELETE' });
  if (r.code !== 0) return handleError(r);
  refreshPanelOrNav();
  toast('已清空历史');
}

async function removeHistoryItem(bvid) {
  if (!bvid) return;
  const r = await api('/api/history?bvid=' + encodeURIComponent(bvid), { method: 'DELETE' });
  if (r.code !== 0) return handleError(r);
  if (panelVisible()) renderPanelBody();
  toast('已移除');
}

function renderHistory(container, items) {
  container.innerHTML = '';
  const arr = items || [];
  if (!arr.length) {
    container.appendChild(el('div', 'empty', '暂无历史'));
    return;
  }
  const ul = el('ul', 'list');
  // 历史卡片：操作区只留「播放 / 更多 / 移除」三个图标
  // 「查看评论」「添加到播放列表」改由「更多」菜单以图标 + 文字呈现
  // 「查看评论」已固定在「更多」菜单首项，这里只补「添加到播放列表」
  const extraMenu = [{ act: 'queue', label: '添加到播放列表', icon: 'queue' }];
  arr.forEach((it, i) => {
    // 补齐 mid 后 UP 主名即可点击
    const info = pageInfo.get(it.bvid);
    if (!it.mid && info && info.mid) it.mid = info.mid;
    if (!it.author && info && info.name) it.author = info.name;
    const li = buildItem(it, () => playItems(arr, i), true, null, -1, extraMenu, {
      compact: true,
    });
    li.classList.add('item-compact'); // 只有三个图标，hover 让位更窄
    const acts = li.querySelector('.item-actions');
    if (acts) {
      acts.appendChild(makeRemoveBtn(() => removeHistoryItem(it.bvid), '移除'));
    }
    ul.appendChild(li);
  });
  container.appendChild(ul);
  paintListNumbers(container);
  // 历史记录本身不存 charged，靠分P信息补出来才能显示充电标识
  loadChargesForList(container, arr);
}

// ---------------------------------------------------------------------------
// 通用对话框（确认 / 输入）
// ---------------------------------------------------------------------------
/**
 * 弹出一个确认框（可带输入框）。
 * @returns {Promise<{act:string, value:string|null}>} act 为按钮的 act 值
 */
function showDialog(opts) {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const box = modal.querySelector('.confirm-box');
    const title = $('confirmTitle');
    const text = $('confirmText');
    const actions = $('confirmActions');
    let input = modal.querySelector('.confirm-input');

    title.textContent = opts.title || '确认';
    text.textContent = opts.text || '';
    text.hidden = !opts.text;

    if (opts.input) {
      if (!input) {
        input = el('input', 'confirm-input');
        input.type = 'text';
        input.maxLength = 60;
        box.insertBefore(input, actions);
      }
      input.hidden = false;
      input.value = opts.input.value || '';
      input.placeholder = opts.input.placeholder || '';
    } else if (input) {
      input.hidden = true;
    }

    const finish = (act) => {
      modal.classList.add('hidden');
      resolve({ act: act, value: input && !input.hidden ? input.value.trim() : null });
    };

    actions.innerHTML = '';
    const list =
      opts.actions && opts.actions.length
        ? opts.actions
        : [
            { label: '取消', act: 'cancel' },
            { label: '确定', act: 'ok', cls: 'primary' },
          ];
    list.forEach((a) => {
      const b = el('button', a.cls || '', a.label);
      b.addEventListener('click', () => finish(a.act || a.label));
      actions.appendChild(b);
    });

    modal.classList.remove('hidden');
    if (input && !input.hidden) {
      input.focus();
      input.select();
    }
  });
}

// ---------------------------------------------------------------------------
// 软件自带收藏列表（本地歌单，与 B 站账号收藏夹无关）
// ---------------------------------------------------------------------------
/** 收藏列表去重键：与播放列表去重同口径（bvid + 分 P cid） */
function itemKey(it) {
  return entryKey(it);
}

async function loadCollections() {
  const r = await api('/api/collections');
  if (r.code === 0 && Array.isArray(r.data)) collections = r.data;
  else collections = [];
  return collections;
}

function openCollections() {
  const modal = $('collectionsModal');
  // 与播放列表/历史/评论同层：打开收藏列表时收起它们，避免双层弹窗叠在一起
  const switching = panelVisible() || commentsVisible();
  closeOtherTopSheets(modal);
  if (!collectionsView) collectionsView = { mode: 'list' };
  showSheetAnimated(modal, { skipBgFade: switching });
  loadCollections().then(() => renderCollectionsBody());
}

/**
 * 关闭收藏列表窗口（出入场动画与播放列表/评论一致）。
 * @param {boolean} skipBgFade 互斥切换时传 true：背景瞬间变透明交给接手的弹层，
 *        避免两层背景交叠时闪一下。直接点关闭（含点背景）时传的是事件对象，按普通收起处理。
 */
function closeCollections(skipBgFade) {
  const modal = $('collectionsModal');
  if (!sheetOpen(modal)) return;
  hideSheetAnimated(modal, null, skipBgFade === true ? { skipBgFade: true } : undefined);
}

function renderCollectionsBody() {
  const modal = $('collectionsModal');
  if (!modal || modal.classList.contains('hidden')) return;
  const body = $('collectionsBody');
  body.innerHTML = '';
  const view = collectionsView || { mode: 'list' };
  const cnt = $('collectionsCount');
  const back = $('collectionsBackBtn');
  if (view.mode === 'detail') {
    const list = collections.find((l) => l.id === view.id);
    if (!list) {
      collectionsView = { mode: 'list' };
      return renderCollectionsBody();
    }
    $('collectionsTitle').textContent = list.name;
    if (cnt) {
      cnt.textContent = String(list.items.length);
      cnt.hidden = false;
    }
    $('collectionsAddBtn').hidden = true;
    $('collectionsImportBtn').hidden = true;
    $('collectionsExportBtn').hidden = true;
    if (back) back.hidden = false;
    renderCollectionsDetail(body, list);
    paintListNumbers(body);
    return;
  }
  $('collectionsTitle').textContent = '收藏列表';
  if (cnt) {
    cnt.textContent = String(collections.length);
    cnt.hidden = false;
  }
  $('collectionsAddBtn').hidden = false;
  $('collectionsImportBtn').hidden = false;
  $('collectionsExportBtn').hidden = false;
  if (back) back.hidden = true;
  renderCollectionsList(body);
}

/** 目录页：每行 [序号] 名称/数量 [播放全部] [重命名] [删除]（后三项图标化） */
function renderCollectionsList(container) {
  if (!collections.length) {
    container.appendChild(el('div', 'empty', '还没有收藏列表，点右上角 ＋ 新建一个'));
    return;
  }
  const wrap = el('div', 'coll-list');
  collections.forEach((l, i) => {
    const row = el('div', 'coll-row');

    // 左侧两位数序号（与其它列表一致）
    row.appendChild(el('span', 'pl-idx', String(i + 1).padStart(2, '0')));

    const main = el('div', 'coll-row-main');
    main.appendChild(el('div', 'coll-row-name', l.name));
    main.appendChild(el('div', 'coll-row-count', l.items.length + ' 项'));
    main.addEventListener('click', () => {
      collectionsView = { mode: 'detail', id: l.id };
      renderCollectionsBody();
    });

    const play = el('button', 'coll-icon-btn');
    play.title = '播放全部';
    play.setAttribute('aria-label', '播放全部');
    play.innerHTML = ICON.playAll;
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      playCollectionAll(l);
    });

    const rename = el('button', 'coll-icon-btn');
    rename.title = '重命名';
    rename.setAttribute('aria-label', '重命名');
    rename.innerHTML = ICON.pencil;
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      renameCollection(l);
    });

    const del = el('button', 'coll-icon-btn danger');
    del.title = '删除';
    del.setAttribute('aria-label', '删除');
    del.innerHTML = ICON.trash;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCollection(l);
    });

    row.appendChild(main);
    row.appendChild(play);
    row.appendChild(rename);
    row.appendChild(del);
    wrap.appendChild(row);
  });
  container.appendChild(wrap);
}

/** 播放某个收藏列表的全部内容（关闭弹窗，回到播放器） */
function playCollectionAll(list) {
  if (!list || !list.items.length) {
    toast('这个列表还是空的');
    return;
  }
  playItems(list.items, 0);
  closeCollections();
}

/** 内容页：卡片样式与搜索结果一致，菜单多一项「从本列表移除」；返回按钮在弹窗顶部右侧 */
function renderCollectionsDetail(container, list) {
  if (!list.items.length) {
    container.appendChild(el('div', 'empty', '这个列表还是空的'));
    return;
  }
  const ul = el('ul', 'list');
  const extra = [
    { sep: true },
    { act: 'removeFromList', label: '从本列表移除', danger: true, icon: 'trash' },
  ];
  list.items.forEach((it, i) => {
    // 带上列表 id，供「从本列表移除」定位
    const item = Object.assign({}, it, { _colId: list.id });
    ul.appendChild(
      buildItem(item, () => playItems(list.items, i), false, list.items, i, extra)
    );
  });
  container.appendChild(ul);
  loadPartsForList(container, list.items);
  ensureMidsThenRepaint(list.items, () => renderCollectionsBody());
}

async function createCollection() {
  const res = await showDialog({
    title: '新建收藏列表',
    input: { placeholder: '列表名称' },
  });
  if (res.act !== 'ok' || !res.value) return;
  const r = await api('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: res.value }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  renderCollectionsBody();
  toast('已创建');
}

async function renameCollection(list) {
  const res = await showDialog({
    title: '重命名列表',
    input: { value: list.name, placeholder: '列表名称' },
  });
  if (res.act !== 'ok' || !res.value) return;
  const r = await api('/api/collections', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: list.id, name: res.value }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  renderCollectionsBody();
  toast('已重命名');
}

async function deleteCollection(list) {
  const res = await showDialog({
    title: '删除列表',
    text: '确定删除「' + list.name + '」？该列表的 ' + list.items.length + ' 项内容会一并移除。',
    actions: [
      { label: '取消', act: 'cancel' },
      { label: '删除', act: 'ok', cls: 'danger' },
    ],
  });
  if (res.act !== 'ok') return;
  const r = await api('/api/collections?id=' + encodeURIComponent(list.id), {
    method: 'DELETE',
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  collectionsView = { mode: 'list' };
  renderCollectionsBody();
  toast('已删除');
}

/** 卡片菜单「从本列表移除」 */
async function removeFromCollection(it) {
  if (!it || !it._colId) return;
  const r = await api('/api/collections/items', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: it._colId, keys: [itemKey(it)] }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  toast('已移除');
  renderCollectionsBody();
}

// --- 导入 / 导出 -------------------------------------------------------------
function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes())
  );
}

function exportCollections() {
  if (!collections.length) {
    toast('还没有收藏列表');
    return;
  }
  const payload = {
    app: 'bili-audio',
    type: 'collections',
    version: 1,
    exportedAt: Date.now(),
    lists: collections.map((l) => ({ name: l.name, items: l.items })),
  };
  saveJsonFile(
    'bili-audio-收藏列表-' + dateStamp() + '.json',
    JSON.stringify(payload, null, 2)
  );
}

function saveJsonFile(filename, text) {
  // Electron 环境：走主进程保存对话框，可以自己选路径
  if (window.desktopApi && typeof window.desktopApi.saveJson === 'function') {
    window.desktopApi
      .saveJson(filename, text)
      .then((r) => {
        if (r && r.canceled) return;
        toast(r && r.ok ? '已导出' : '导出失败');
      })
      .catch(() => toast('导出失败'));
    return;
  }
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出到下载目录');
}

function importCollectionsFlow() {
  if (window.desktopApi && typeof window.desktopApi.openJson === 'function') {
    window.desktopApi
      .openJson()
      .then((r) => {
        if (!r || r.canceled) return;
        if (r.ok) applyImportText(r.text);
        else toast('读取失败：' + (r.error || '未知错误'));
      })
      .catch(() => toast('读取失败'));
    return;
  }
  const f = $('importFile');
  f.value = '';
  f.click();
}

async function applyImportText(text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    toast('不是有效的 JSON 文件');
    return;
  }
  let lists = Array.isArray(payload) ? payload : payload && payload.lists;
  if (!Array.isArray(lists)) {
    toast('文件中没有收藏列表');
    return;
  }
  const res = await showDialog({
    title: '导入收藏列表',
    text:
      '文件包含 ' + lists.length + ' 个列表。覆盖会替换现有全部列表；' +
      '追加时同名列表会自动重命名。',
    actions: [
      { label: '取消', act: 'cancel' },
      { label: '追加', act: 'append', cls: 'primary' },
      { label: '覆盖', act: 'replace', cls: 'danger' },
    ],
  });
  if (res.act === 'cancel') return;
  const r = await api('/api/collections/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: res.act, lists: lists }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  collectionsView = { mode: 'list' };
  renderCollectionsBody();
  toast(
    res.act === 'replace'
      ? '已覆盖导入 ' + (r.added || 0) + ' 个列表'
      : '已追加 ' + (r.added || 0) + ' 个列表' +
          (r.renamed ? '（' + r.renamed + ' 个已重命名）' : '')
  );
}

// ---------------------------------------------------------------------------
// 「收藏到」弹层：选择已有列表，或新建列表并收藏
// ---------------------------------------------------------------------------
function openFavPick(items) {
  favPickItems = items || [];
  $('favPickModal').classList.remove('hidden');
  loadCollections().then(renderFavPick);
}

function closeFavPick() {
  $('favPickModal').classList.add('hidden');
}

function renderFavPick() {
  const body = $('favPickBody');
  body.innerHTML = '';
  if (!collections.length) {
    body.appendChild(el('div', 'empty', '还没有列表，可在下方新建一个'));
    return;
  }
  collections.forEach((l) => {
    const b = el('button', 'pick-opt');
    b.appendChild(el('span', 'pick-opt-name', l.name));
    b.appendChild(el('span', 'pick-opt-count', l.items.length + ' 项'));
    b.addEventListener('click', () => addToCollection(l.id));
    body.appendChild(b);
  });
}

async function addToCollection(id) {
  if (!favPickItems.length) return;
  const r = await api('/api/collections/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, items: favPickItems }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  closeFavPick();
  toast(r.added ? '已收藏 ' + r.added + ' 项' : '该列表已包含这些内容');
  renderCollectionsBody();
}

/** 创建新列表并收藏当前待收藏条目（name 由命名弹窗传入） */
async function createCollectionByName(name) {
  if (!name) {
    toast('请输入列表名称');
    return;
  }
  const r = await api('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name }),
  });
  if (r.code !== 0) return handleError(r);
  collections = r.data || [];
  // 新建的列表追加在末尾
  const created = collections[collections.length - 1];
  if (created) await addToCollection(created.id);
  renderCollectionsBody();
}

/** 「创建新列表」：关闭收藏界面，弹出命名窗口，确定后创建并收藏 */
async function openFavNew() {
  closeFavPick();
  const r = await showDialog({
    title: '新建列表',
    text: '',
    input: { placeholder: '列表名称', value: '' },
    actions: [
      { label: '取消', act: 'cancel' },
      { label: '确定', act: 'ok', cls: 'primary' },
    ],
  });
  if (r.act !== 'ok' || !r.value) return;
  await createCollectionByName(r.value);
}

// ---------------------------------------------------------------------------
// B 站账号收藏夹（需要登录）
// ---------------------------------------------------------------------------
let favItems = [];
let favTitle = '';
let favHasMore = false;

function openFavFolders() {
  if (!userNav.isLogin || !userNav.mid) {
    showLogin('查看收藏夹需要登录');
    return;
  }
  openPanel('favfolders');
}

async function loadFavFolders(container) {
  container.appendChild(el('div', 'empty', '加载中…'));
  const r = await api('/api/fav/folders?mid=' + encodeURIComponent(userNav.mid));
  if (r.code !== 0) {
    container.innerHTML = '';
    container.appendChild(el('div', 'empty', r.message || '加载失败'));
    handleError(r);
    return;
  }
  const folders = (r.data && r.data.folders) || [];
  if (currentPanel !== 'favfolders') return;
  container.innerHTML = '';
  setPanelCount(folders.length);
  if (!folders.length) {
    container.appendChild(el('div', 'empty', '暂无收藏夹'));
    return;
  }
  folders.forEach((f) => {
    const row = el('div', 'fav-folder-row');
    const main = el('div', 'coll-row-main');
    main.appendChild(el('div', 'coll-row-name', f.title || '未命名收藏夹'));
    main.appendChild(el('div', 'coll-row-count', (f.count || 0) + ' 个内容'));
    main.addEventListener('click', () => openFavFolder(f));
    row.appendChild(main);
    container.appendChild(row);
  });
}

function openFavFolder(folder) {
  favFolderId = folder.id;
  favFolderPage = 1;
  favItems = [];
  favTitle = folder.title || '';
  favHasMore = false;
  currentPanel = 'favlist';
  renderPanelBody();
  loadFavFolder(favFolderId, 1);
}

async function loadFavFolder(mediaId, page) {
  const r = await api(
    '/api/fav/list?media_id=' + encodeURIComponent(mediaId) + '&pn=' + page
  );
  if (r.code !== 0) {
    handleError(r);
    return;
  }
  const d = r.data || {};
  favTitle = d.title || favTitle;
  const items = d.items || [];
  favItems = page === 1 ? items : favItems.concat(items);
  favHasMore = !!d.hasMore;
  if (currentPanel === 'favlist') renderPanelBody();
}

function renderFavItems(container) {
  if (!favItems.length) {
    container.appendChild(el('div', 'empty', '暂无内容'));
    return;
  }
  const ul = el('ul', 'list');
  favItems.forEach((it, i) => {
    ul.appendChild(buildItem(it, () => playItems(favItems, i), false, favItems, i));
  });
  container.appendChild(ul);
  if (favHasMore) {
    const btn = el('button', 'loadmore', '加载更多');
    btn.onclick = () => {
      favFolderPage += 1;
      loadFavFolder(favFolderId, favFolderPage);
    };
    container.appendChild(btn);
  }
  loadPartsForList(container, favItems);
  paintListNumbers(container);
  ensureMidsThenRepaint(favItems, () => {
    if (currentPanel === 'favlist') renderPanelBody();
  });
}

// ---------------------------------------------------------------------------
// 我的关注（账号关注列表，需要登录）
// ---------------------------------------------------------------------------
let followItems = [];
let followPage = 1;
let followHasMore = false;
let followTotal = 0;

function openFollowings() {
  if (!userNav.isLogin || !userNav.mid) {
    showLogin('查看我的关注需要登录');
    return;
  }
  followItems = [];
  followPage = 1;
  followHasMore = false;
  followTotal = 0;
  openPanel('followings');
  loadFollowings(1);
}

async function loadFollowings(page) {
  const r = await api(
    '/api/followings?mid=' + encodeURIComponent(userNav.mid) +
    '&pn=' + page + '&ps=50'
  );
  if (currentPanel !== 'followings') return;
  if (r.code !== 0) {
    handleError(r);
    renderPanelBody();
    return;
  }
  const items = (r.data && r.data.items) || [];
  followItems = page === 1 ? items : followItems.concat(items);
  followPage = page;
  followTotal = (r.data && r.data.total) || followItems.length;
  followHasMore = !!(r.data && r.data.hasMore);
  renderPanelBody();
}

function renderFollowings(container) {
  if (!followItems.length) {
    container.appendChild(el('div', 'empty', '还没有关注任何 UP 主'));
    return;
  }
  const wrap = el('div', 'follow-list');
  followItems.forEach((u, i) => {
    const row = el('div', 'follow-row');
    row.appendChild(el('span', 'pl-idx', String(i + 1).padStart(2, '0')));

    if (u.face) {
      const face = el('span', 'follow-face');
      const img = el('img', 'follow-face-img');
      img.src = '/api/img?url=' + encodeURIComponent(u.face);
      img.alt = '';
      img.loading = 'lazy';
      face.appendChild(img);
      row.appendChild(face);
    }

    const main = el('div', 'follow-main');
    main.appendChild(el('div', 'follow-name', u.name || '未知用户'));
    if (u.sign) main.appendChild(el('div', 'follow-sign', u.sign));
    main.addEventListener('click', () => openUpFromEntry(u.mid, u.name));
    row.appendChild(main);
    wrap.appendChild(row);
  });
  container.appendChild(wrap);
  if (followHasMore) {
    const btn = el('button', 'loadmore', '加载更多');
    btn.onclick = () => loadFollowings(followPage + 1);
    container.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------
/**
 * 音频流地址。
 * @param {object} entry 队列条目
 * @param {object} [opts] refresh=true 让后端丢掉播放地址缓存重新解析。
 *        播放中断 / 卡死重载时必须带 —— 否则 20 分钟缓存会让每次重试都撞在
 *        同一批坏节点上，表现就是「重试多少遍都一样」。
 *        bust=true 追加时间戳，顺带绕开 WebView 自身的 HTTP 缓存。
 */
function audioUrl(entry, opts) {
  const o = opts || {};
  let u =
    '/api/audio?bvid=' + encodeURIComponent(entry.bvid) +
    '&cid=' + encodeURIComponent(entry.cid);
  if (o.refresh) u += '&refresh=1';
  if (o.bust) u += '&_r=' + Date.now();
  return u;
}

/** 把一个视频的分 P 展开成若干队列项（part=分P名，main=视频总名，供列表/播放器分行显示） */
function partEntries(it, info) {
  const mainTitle = info.title || it.title || '';
  const author = it.author || info.name || '';
  const mid = it.mid || info.mid || null;
  return (info.pages || []).map((p) => ({
    bvid: it.bvid,
    cid: p.cid,
    title: mainTitle + ' · P' + p.page + (p.part ? ' ' + p.part : ''),
    part: 'P' + p.page + (p.part ? ' ' + p.part : ''),
    main: mainTitle,
    author: author,
    mid: mid,
    duration: p.duration || info.duration || it.duration,
    aid: info.aid || null,
    charged: !!info.charged,
    preview: info.preview || 0,
  }));
}

/**
 * 播放列表中的第 i 项；多 P 视频会把整段视频的所有分 P 展开进播放列表。
 * @param {Array} items 当前列表
 * @param {number} i 下标
 * @param {number} [startPart] 从第几个分 P 开始（点分 P 卡片时用）
 */
/**
 * 「恢复上次进度」只属于被恢复的那一条。
 *
 * 用户改点别的内容（或按上一首 / 下一首）时必须丢弃：否则新内容会被 seek 到上次的进度，
 * 一旦该进度超过新内容的时长，播放器会直接落到结尾并触发 ended 自动连播 ——
 * 表现就是「点了这一条却跳过它、直接播下一首」。这曾是一个只在重开软件后偶发的问题。
 */
function resumeSeekTarget(entry) {
  if (!(resumeTime > 0)) return 0;
  return resumeKey === entryKey(entry) ? resumeTime : 0;
}

/** seek 目标超出音频长度时不要照做（会落到结尾并立刻 ended），回退到从头播 */
function clampSeekTarget(target, duration) {
  if (!(target > 0)) return 0;
  if (duration > 0 && target >= duration - 1) return 0;
  return target;
}

function playItems(items, i, startPart) {
  userPickedPlayback = true;
  const it = items[i];
  if (!it) return;
  const info = pageInfo.get(it.bvid);
  const base = items.map((x) => ({
    bvid: x.bvid,
    cid: x.cid || null,
    title: x.title,
    author: x.author || '',
    mid: entryMid(x.mid, x.bvid),
    duration: x.duration,
  }));

  if (info && info.pages && info.pages.length > 1) {
    let from = startPart;
    // 未指定起始分 P 但该项已带 cid（如历史记录）→ 定位到对应的那一 P
    if (typeof from !== 'number' && it.cid) {
      const pi = info.pages.findIndex((p) => String(p.cid) === String(it.cid));
      if (pi >= 0) from = pi;
    }
    base.splice(i, 1, ...partEntries(it, info));
    currentIndex = i + (from || 0);
  } else {
    if (info && info.pages && info.pages.length === 1) {
      base[i].cid = info.pages[0].cid;
      base[i].aid = info.aid || null;
      base[i].charged = !!info.charged;
      base[i].preview = info.preview || 0;
    }
    currentIndex = i;
  }
  queue = base;
  playQueue();
  saveState();
}

/**
 * 点分 P 卡片：播放队列只取「该视频的全部分 P」，从点击的那一 P 开始播。
 * 与点大标题不同 —— 点大标题是把整个搜索/合集列表都排进队列（见 playItems）。
 */
function playListItemAt(items, i, partIndex) {
  userPickedPlayback = true;
  const it = items && items[i];
  if (!it) return;
  const info = pageInfo.get(it.bvid);
  // 分 P 卡片只在 pages.length > 1 时渲染；缓存缺失时退回整列表策略
  if (!info || !info.pages || info.pages.length <= 1) {
    playItems(items, i, partIndex || 0);
    return;
  }
  queue = partEntries(it, info);
  currentIndex = Math.max(0, Math.min(partIndex || 0, queue.length - 1));
  playQueue();
  saveState();
}

async function playQueue() {
  let entry = queue[currentIndex];
  if (!entry) return;
  setPlayerDisplay(entry);
  retryCount = 0;
  resetWatchdog();

  try {
    // 懒加载 cid；多 P 视频展开为独立队列项，支持上一首/下一首/自动连播
    if (!entry.cid) {
      const v = await api('/api/view?bvid=' + encodeURIComponent(entry.bvid));
      if (v.code !== 0) return handleError(v);
      const mainTitle = v.data.title || entry.title;
      const mainAuthor = v.data.name || entry.author;
      const mainDuration = v.data.duration || entry.duration;
      const aid = v.data.aid || null;
      const charged = !!v.data.charged;
      const preview = v.data.preview || 0;
      const pages = v.data.pages || [];
      if (pages.length > 1) {
        const parts = pages.map((p) => {
          let t = mainTitle + ' · P' + p.page;
          if (p.part) t += ' ' + p.part;
          return {
            bvid: entry.bvid,
            cid: p.cid,
            title: t,
            part: 'P' + p.page + (p.part ? ' ' + p.part : ''),
            main: mainTitle,
            author: mainAuthor,
            mid: entry.mid || v.data.mid || null,
            duration: p.duration || mainDuration,
            aid: aid,
            charged: charged,
            preview: preview,
          };
        });
        queue.splice(currentIndex, 1, ...parts);
        entry = queue[currentIndex];
      } else {
        entry.cid = pages.length === 1 ? pages[0].cid : v.data.cid;
        entry.title = entry.title || mainTitle;
        entry.author = entry.author || mainAuthor;
        entry.duration = entry.duration || mainDuration;
        entry.aid = aid;
        entry.charged = charged;
        entry.preview = preview;
        // 顺手把 UP 主 id 写回条目：播放控件上的作者名要靠它才能点开主页
        entry.mid = entry.mid || v.data.mid || null;
      }
      saveState();
    }

    const purl = await api(
      '/api/playurl?bvid=' + encodeURIComponent(entry.bvid) +
      '&cid=' + encodeURIComponent(entry.cid)
    );
    if (purl.code !== 0) return handleError(purl);

    setPlayerDisplay(entry);
    setPlayIcon(true);
    applyRate();
    const seekTarget = resumeSeekTarget(entry);
    resumeTime = 0;
    pendingSeek = seekTarget;
    audio.src = audioUrl(entry);
    audio.play().catch(() => {});
    recordHistory(entry);
    saveState();
    if (entry.charged) {
      toast(
        entry.preview > 0
          ? '充电专属视频，仅可播放试看部分（约 ' + fmtDur(entry.preview) + '）'
          : '充电专属视频，未充电仅可播放部分内容'
      );
    }
  } catch (e) {
    toast('播放出错: ' + ((e && e.message) || e));
  }
  markPlaying();
}

function prev() {
  if (!queue.length) return;
  currentIndex = (currentIndex - 1 + queue.length) % queue.length;
  playQueue();
  saveState();
}

function next() {
  if (!queue.length) return;
  currentIndex = (currentIndex + 1) % queue.length;
  playQueue();
  saveState();
}

function recordHistory(entry) {
  if (!entry || !entry.bvid) return;
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bvid: entry.bvid,
      cid: entry.cid || null,
      title: entry.title || '',
      author: entry.author || '',
      mid: entry.mid || null,
    }),
  }).catch(() => {});
}

/** 判断列表条目是否就是当前播放中的内容（bvid 相同且分 P 不冲突；见 sameEntry） */
function isCurrentItem(it) {
  return sameEntry(queue[currentIndex], it);
}

/** 高亮当前播放项（列表卡片 + 分 P 卡片），并同步各卡片播放按钮的暂停图标 */
function markPlaying() {
  const entry = queue[currentIndex];
  const key = entry ? entry.bvid + ':' + (entry.cid || '') : '';
  const bvid = entry ? entry.bvid : '';
  const playing = !!(entry && audio.src && !audio.paused && !audio.ended);
  document.querySelectorAll('.item').forEach((li) => {
    // 弹层里的项没有 data-bvid 时高亮由各自渲染逻辑负责
    if (!li.dataset.bvid) return;
    const isCur =
      !!bvid &&
      li.dataset.bvid === bvid &&
      (!li.dataset.cid || !entry.cid || String(li.dataset.cid) === String(entry.cid));
    li.classList.toggle('playing', isCur);
    // 同步卡片操作组里的播放按钮：播放中显示暂停图标
    const pb = li.querySelector('[data-playbtn]');
    if (pb) {
      pb.innerHTML = isCur && playing ? ICON.pause : ICON.play;
      if (isCur) pb.title = playing ? '暂停' : '播放';
      else pb.title = '播放';
    }
  });
  document.querySelectorAll('.part-card').forEach((c) => {
    c.classList.toggle('playing', !!key && c.dataset.key === key);
  });
}

function currentKey() {
  return entryKey(queue[currentIndex]);
}

// ---------------------------------------------------------------------------
// 倍速 / 音量
// ---------------------------------------------------------------------------
function fmtSpeed(v) {
  return (Number.isInteger(v) ? v.toFixed(1) : String(v)) + '×';
}

function applyRate() {
  const v = SPEEDS[speedIdx];
  try {
    audio.playbackRate = v;
  } catch (e) {}
  const btn = $('speedBtn');
  if (btn) {
    btn.textContent = fmtSpeed(v);
    btn.title = '播放倍速：' + btn.textContent + '（点击选择）';
  }
  // 同步弹层里的选中态
  const wrap = $('speedOptions');
  if (wrap) {
    wrap.querySelectorAll('.speed-opt').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.speed) === v);
    });
  }
}

/** 构建倍速弹层里的档位按钮（升序排列，方便查找） */
function buildSpeedOptions() {
  const wrap = $('speedOptions');
  if (!wrap) return;
  wrap.innerHTML = '';
  SPEEDS.slice()
    .sort((a, b) => a - b)
    .forEach((v) => {
      const b = el('button', 'speed-opt', fmtSpeed(v));
      b.dataset.speed = String(v);
      b.addEventListener('click', () => setSpeed(v));
      wrap.appendChild(b);
    });
}

function setSpeed(v) {
  const i = SPEEDS.indexOf(v);
  if (i >= 0) speedIdx = i;
  applyRate();
  saveState();
  closeSpeedPop();
}

const VOLUME_ICON_ON =
  '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
  '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>' +
  '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
const VOLUME_ICON_MUTE =
  '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
  '<line x1="23" y1="9" x2="17" y2="15"></line>' +
  '<line x1="17" y1="9" x2="23" y2="15"></line>';

function applyVolume() {
  try {
    audio.volume = isMuted ? 0 : volumeValue;
    audio.muted = isMuted;
  } catch (e) {}
  const icon = $('volumeIcon');
  if (icon) {
    icon.innerHTML = isMuted || volumeValue === 0 ? VOLUME_ICON_MUTE : VOLUME_ICON_ON;
  }
  const slider = $('volumeSlider');
  if (slider) slider.value = String(Math.round(volumeValue * 100));
  const label = $('volumeValue');
  if (label) label.textContent = String(Math.round(volumeValue * 100));
  const muteBtn = $('muteBtn');
  if (muteBtn) {
    // 文案固定为「静音」，只用激活态表达当前是否静音。
    // 之前会切成「取消静音」，四个字把音量弹层撑变形 —— 宽度必须恒定。
    const mutedNow = isMuted || volumeValue === 0;
    muteBtn.classList.toggle('on', mutedNow);
    muteBtn.setAttribute('aria-pressed', mutedNow ? 'true' : 'false');
    muteBtn.title = mutedNow ? '取消静音' : '静音';
  }
  const vb = $('volumeBtn');
  if (vb) vb.title = isMuted ? '已静音（点击调节）' : '音量 ' + Math.round(volumeValue * 100) + '%';
}

/**
 * 把弹层定位到触发按钮的正上方（倍速 / 音量共用）。
 * 注意必须清掉 CSS 里的 right/bottom 兜底值，否则与 left/top 同时生效会把弹层拉变形。
 */
function positionPopover(pop, btn) {
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.classList.remove('hidden');
  const w = pop.offsetWidth || 220;
  const h = pop.offsetHeight || 44;
  let left = r.right - w;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
  pop.style.right = 'auto';
  pop.style.bottom = 'auto';
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, r.top - h - 8) + 'px';
  pop.style.visibility = '';
}

/** 打开某个弹层时先关掉另一个，避免两个浮层叠在一起 */
function openPopover(id, btnId) {
  const pop = $(id);
  if (!pop) return;
  const wasHidden = pop.classList.contains('hidden');
  closeAllPopovers();
  if (wasHidden) positionPopover(pop, $(btnId));
}

/** 所有浮层的 id：倍速 / 音量 / 账号菜单 / 更多菜单 / 卡片菜单 */
const POPOVER_IDS = ['volumePop', 'speedPop', 'accountMenu', 'moreMenu', 'itemMenu', 'collMoreMenu'];

function closeAllPopovers() {
  POPOVER_IDS.forEach((id) => {
    const p = $(id);
    if (p) p.classList.add('hidden');
  });
}

function toggleVolumePop() {
  openPopover('volumePop', 'volumeBtn');
}

function toggleSpeedPop() {
  openPopover('speedPop', 'speedBtn');
}

function closeSpeedPop() {
  const pop = $('speedPop');
  if (pop) pop.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// 评论
// ---------------------------------------------------------------------------
function commentsVisible() {
  return sheetOpen($('commentsModal'));
}

/** 取得视频 aid（用于评论）：优先复用缓存，缺失时回源 /api/view */
async function resolveAid(bvid, cachedAid) {
  if (cachedAid) return cachedAid;
  const info = await ensureView(bvid);
  return (info && info.aid) || null;
}

function showComments(aid, title) {
  const switching = panelVisible() || sheetOpen($('collectionsModal'));
  closeOtherTopSheets($('commentsModal'));
  commentsAid = aid;
  commentsPn = 1;
  showSheetAnimated($('commentsModal'), { skipBgFade: switching });
  $('commentsTitle').textContent = title || '评论';
  $('commentsBody').innerHTML = '';
  $('commentsBody').appendChild(el('div', 'empty', '加载中…'));
  syncPanelButtons();
  loadComments();
}

/** 底部评论按钮：同面板已开 → 向下收回；否则打开/直接切换 */
function toggleComments() {
  if (commentsVisible()) {
    hideSheetAnimated($('commentsModal'));
    syncPanelButtons();
    return;
  }
  openComments();
}

/** 播放器上的评论按钮：针对当前播放曲目 */
async function openComments() {
  const entry = queue[currentIndex];
  if (!entry) {
    toast('当前没有正在播放的内容');
    return;
  }
  const aid = await resolveAid(entry.bvid, entry.aid);
  if (!aid) {
    toast('无法获取评论');
    return;
  }
  entry.aid = aid;
  showComments(aid, '评论');
}

/** 卡片菜单里的「查看评论」：针对任意列表条目 */
async function openCommentsForItem(it) {
  const aid = await resolveAid(it.bvid, it.aid);
  if (!aid) {
    toast('无法获取评论');
    return;
  }
  it.aid = aid;
  showComments(aid, '评论');
}

/** @param {boolean} skipBgFade 仅互斥切换时由内部传 true（理由同 closePanel） */
function closeComments(skipBgFade) {
  // 先启动收回（期间 sheetOpen 已返回 false），再同步按钮，底色才会立刻还原
  hideSheetAnimated(
    $('commentsModal'),
    null,
    skipBgFade === true ? { skipBgFade: true } : undefined
  );
  syncPanelButtons();
}

async function loadComments() {
  const body = $('commentsBody');
  const r = await api(
    '/api/comments?aid=' + encodeURIComponent(commentsAid) +
    '&pn=' + commentsPn + '&ps=20'
  );
  if (!commentsVisible()) return;
  if (r.code !== 0) {
    body.innerHTML = '';
    body.appendChild(el('div', 'empty', r.message || '评论加载失败'));
    return;
  }
  const data = r.data || {};
  const list = data.replies || [];
  if (commentsPn === 1) {
    body.innerHTML = '';
    $('commentsTitle').textContent =
      '评论（' + fmtPlay(data.count || list.length) + '）';
  }
  // 去掉上一次的「加载更多」
  const oldMore = body.querySelector('.loadmore');
  if (oldMore) oldMore.remove();

  if (!list.length && commentsPn === 1) {
    body.appendChild(el('div', 'empty', '暂无评论'));
    return;
  }

  let wrap = body.querySelector('.comment-list');
  if (!wrap) {
    wrap = el('div', 'comment-list');
    body.appendChild(wrap);
  }
  list.forEach((c) => wrap.appendChild(buildComment(c)));

  commentsHasMore = list.length === 20;
  if (commentsHasMore) {
    const more = el('button', 'loadmore', '加载更多');
    more.onclick = () => {
      commentsPn += 1;
      loadComments();
    };
    body.appendChild(more);
  }
}

function buildComment(c) {
  const box = el('div', 'comment-item');
  const head = el('div', 'comment-head');
  // 主楼与楼中楼共用同一套点击逻辑：任何一处都能进主页（无 mid 时给提示）
  head.appendChild(makeCommentUser(c.uname, c.mid));
  if (c.like) head.appendChild(el('span', 'comment-like', '♡ ' + fmtPlay(c.like)));
  box.appendChild(head);
  box.appendChild(el('div', 'comment-text', c.message || ''));
  (c.replies || []).forEach((s) => {
    const sub = el('div', 'comment-sub');
    const sh = el('div', 'comment-head');
    sh.appendChild(makeCommentUser(s.uname, s.mid));
    if (s.like) sh.appendChild(el('span', 'comment-like', '♡ ' + fmtPlay(s.like)));
    sub.appendChild(sh);
    sub.appendChild(el('div', 'comment-text', s.message || ''));
    box.appendChild(sub);
  });
  return box;
}

/** 评论里的用户名：点击关掉评论弹层并进 UP 主页；缺 mid 时提示 */
function makeCommentUser(name, mid) {
  const span = el('span', 'comment-user', name || '未知用户');
  span.title = '查看 UP 主主页';
  span.addEventListener('click', (e) => {
    e.stopPropagation();
    openUpFromEntry(mid, name);
  });
  return span;
}

// ---------------------------------------------------------------------------
// 状态持久化（重启恢复）
// ---------------------------------------------------------------------------
function saveState(keepalive) {
  const state = {
    queue,
    currentIndex,
    currentTime: (audio && audio.currentTime) || 0,
    speed: SPEEDS[speedIdx],
    volume: volumeValue,
    muted: isMuted,
  };
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  };
  if (keepalive) options.keepalive = true;
  fetch('/api/state', options).catch(() => {});
}

async function restoreState() {
  try {
    const r = await api('/api/state');
    const d = r && r.code === 0 && r.data;
    if (d && typeof d.speed === 'number') {
      const i = SPEEDS.indexOf(d.speed);
      if (i >= 0) speedIdx = i;
    }
    if (d && typeof d.volume === 'number') {
      volumeValue = Math.max(0, Math.min(1, d.volume));
    }
    if (d && typeof d.muted === 'boolean') isMuted = d.muted;
    applyRate();
    applyVolume();

    if (!d || !Array.isArray(d.queue) || !d.queue.length) return;
    // 用户在状态恢复完成前已经自己点播过内容 → 不能用旧状态把它们盖掉
    if (userPickedPlayback) return;
    queue = d.queue
      .map((it) => ({
        bvid: it.bvid,
        cid: it.cid || null,
        title: it.title || '',
        part: it.part || null,
        main: it.main || null,
        author: it.author || '',
        mid: it.mid || null,
        duration: it.duration || null,
        aid: it.aid || null,
        charged: !!it.charged,
        preview: it.preview || 0,
      }))
      .filter((it) => it && it.bvid);
    currentIndex =
      typeof d.currentIndex === 'number' &&
      d.currentIndex >= 0 &&
      d.currentIndex < queue.length
        ? d.currentIndex
        : 0;
    resumeTime = Number(d.currentTime) || 0;
    const entry = queue[currentIndex];
    // 记下这个进度属于哪一条：之后只有点回同一条才继续用它（否则会跳过新点的那条）
    resumeKey = entry ? entryKey(entry) : null;
    if (entry) {
      setPlayerDisplay(entry);
      const dur = Number(entry.duration) || 0;
      if (dur > 0) {
        paintSeek(resumeTime, dur);
      }
    }
    toast('已恢复上次播放');
  } catch (e) {
    // 恢复失败不影响正常使用
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
async function refreshNav() {
  const r = await api('/api/nav');
  const d = (r.code === 0 && r.data) || null;
  const logged = !!(d && d.isLogin);
  userNav = {
    isLogin: logged,
    uname: (d && d.uname) || '',
    mid: (d && d.mid) || null,
    face: (d && d.face) || '',
  };
  const btn = $('loginBtn');
  const avatar = $('avatarBtn');
  btn.textContent = logged ? userNav.uname || '已登录' : '登录';
  btn.dataset.logged = logged ? '1' : '';
  // 已登录：显示圆形头像，隐藏文字按钮；未登录反之
  btn.classList.toggle('hidden', logged);
  avatar.classList.toggle('hidden', !logged);
  avatar.title = logged ? (userNav.uname || '账号') + '（点击展开菜单）' : '账号';
  setAvatar(userNav.face);
}

/** 设置头像：优先用 B 站头像（走后端代理），失败则回退到用户名首字 */
function setAvatar(face) {
  const img = $('avatarImg');
  const fallback = $('avatarFallback');
  const showFallback = (text) => {
    img.hidden = true;
    img.removeAttribute('src');
    fallback.hidden = false;
    fallback.textContent = (text || 'U').trim().charAt(0) || 'U';
  };
  if (!face) {
    showFallback(userNav.uname);
    return;
  }
  fallback.hidden = true;
  img.hidden = false;
  img.onerror = () => showFallback(userNav.uname);
  img.src = '/api/img?url=' + encodeURIComponent(face);
}

function showLogin(reason) {
  $('loginStatus').textContent = reason || '请使用 B 站 App 扫码';
  $('loginModal').classList.remove('hidden');
  refreshQr();
}

function closeLogin() {
  clearInterval(pollTimer);
  pollTimer = null;
  $('loginModal').classList.add('hidden');
}

async function refreshQr() {
  clearInterval(pollTimer);
  pollTimer = null;
  $('qrBox').innerHTML = '<div class="qr-hint">加载中…</div>';
  const r = await api('/api/login/qr');
  if (r.code !== 0 || !r.data || !r.data.qrcode_key) {
    $('loginStatus').textContent = '获取二维码失败';
    return;
  }
  qrKey = r.data.qrcode_key;
  const img = document.createElement('img');
  img.className = 'qr-img';
  img.src = '/api/login/qr.png?data=' + encodeURIComponent(r.data.url);
  img.alt = '登录二维码';
  $('qrBox').innerHTML = '';
  $('qrBox').appendChild(img);
  $('loginStatus').textContent = '请使用 B 站 App 扫码';
  pollTimer = setInterval(pollLogin, 2000);
}

async function pollLogin() {
  if (!qrKey) return;
  const r = await api('/api/login/qr/poll?qrcode_key=' + encodeURIComponent(qrKey));
  if (!r || !r.data) return;
  const code = r.data.code;
  if (code === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
    $('loginStatus').textContent = '登录成功';
    await refreshNav();
    setTimeout(closeLogin, 600);
  } else if (code === 86101) {
    $('loginStatus').textContent = '等待扫码…';
  } else if (code === 86090) {
    $('loginStatus').textContent = '已扫码，请在手机上确认';
  } else if (code === 86038) {
    clearInterval(pollTimer);
    pollTimer = null;
    $('loginStatus').textContent = '二维码已过期，正在刷新…';
    await refreshQr();
  } else {
    $('loginStatus').textContent = r.data.message || '状态码 ' + code;
  }
}

// ---------------------------------------------------------------------------
// 音频事件：进度、播放结束、错误重试、卡顿
// ---------------------------------------------------------------------------
async function handleAudioError() {
  setPlayIcon(false);
  const entry = queue[currentIndex];
  if (!entry || !entry.cid) {
    toast('音频加载失败');
    return;
  }
  try {
    // 1. 重新校验当前曲目（区分需要登录 / 临时失效）
    const purl = await api(
      '/api/playurl?bvid=' + encodeURIComponent(entry.bvid) +
      '&cid=' + encodeURIComponent(entry.cid)
    );
    if (purl.code !== 0) {
      if (needsLogin(purl.code, purl.message)) {
        showLogin('播放中断，可能需要登录');
      } else {
        toast(purl.message || '音频加载失败');
      }
      return;
    }
    // 2. 地址有效 → 丢掉旧地址、换一批节点重试一次
    if (retryCount < 1) {
      retryCount += 1;
      toast('播放中断，正在更换节点重试…');
      audio.src = audioUrl(entry, { refresh: true });
      audio.play().catch(() => {});
      return;
    }
    // 3. 仍失败：向音频端点做一次 2 字节探测，把后端记录的失败原因带出来
    const why = await probeAudioFailure(entry);
    toast(why ? '播放失败：' + why.slice(0, 48) : '播放失败，请稍后重试');
  } catch (e) {
    toast('播放出错: ' + ((e && e.message) || e));
  }
}

/**
 * 用 2 字节 Range 请求探一次音频端点，只为取回后端的失败原因
 * （完整原因同时写在 data/app.log，这里只做人类可读的短提示）。
 */
async function probeAudioFailure(entry) {
  try {
    const r = await fetch(audioUrl(entry, { refresh: true }), {
      headers: { Range: 'bytes=0-1' },
    });
    if (r.ok) return '';
    const d = await r.json().catch(() => null);
    return (d && (d.detail || d.message)) || '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 播放卡顿自动恢复
// ---------------------------------------------------------------------------
/**
 * 长音频播放有时会在中途「卡住不再推进」，手动拖一下进度条即可恢复。
 * 这里做的是同一件事：检测到进度长时间不动就轻推一次 currentTime，
 * 强制浏览器重新向后端发起 Range 请求；多次无效则重载音源并续播。
 */
function resetWatchdog() {
  lastPos = -1;
  lastTick = Date.now();
  nudgeCount = 0;
}

function nudgePlayback() {
  try {
    // 极小幅度前移，既触发重新请求，又不影响听感
    audio.currentTime = (audio.currentTime || 0) + 0.001;
    lastTick = Date.now();
  } catch (e) {}
}

function reloadCurrentSource() {
  const entry = queue[currentIndex];
  if (!entry || !entry.cid) return;
  const pos = lastPos > 0 ? lastPos : audio.currentTime || 0;
  pendingSeek = pos;
  // 卡住的根因多半是当前节点在拖延：refresh 让后端换一批新地址，
  // bust 再绕过浏览器缓存，双重确保这次重载真的换了源
  audio.src = audioUrl(entry, { refresh: true, bust: true });
  audio.load();
  audio.play().catch(() => {});
  lastTick = Date.now();
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!audio.src || audio.paused || audio.ended || audio.seeking) {
      lastTick = Date.now();
      return;
    }
    const pos = audio.currentTime || 0;
    if (lastPos < 0 || pos > lastPos + 0.05) {
      lastPos = pos;
      lastTick = Date.now();
      if (nudgeCount > 0) nudgeCount = 0;
      return;
    }
    const stuck = Date.now() - lastTick;
    if (stuck < 2500) return;

    if (nudgeCount < 3) {
      nudgeCount += 1;
      nudgePlayback();
    } else if (nudgeCount < 6) {
      nudgeCount += 1;
      toast('缓冲中，正在恢复…');
      reloadCurrentSource();
    } else {
      // 长时间无解：重置计数，等待下一轮再试，避免频繁重载
      nudgeCount = 0;
      lastTick = Date.now();
    }
  }, 800);
}

// ---------------------------------------------------------------------------
// 自定义进度条（点击 / 拖动 seek）
// ---------------------------------------------------------------------------
let seeking = false; // 是否正在拖动进度条

/** 用 (cur, dur) 直接绘制进度（fill 宽度、thumb 位置、时间文字） */
function paintSeek(cur, dur) {
  const fill = $('seekFill');
  const thumb = $('seekThumb');
  const time = $('seekTime');
  const c = Number(cur) || 0;
  const d = Number(dur) || 0;
  const pct = d > 0 ? Math.max(0, Math.min(100, (c / d) * 100)) : 0;
  if (fill) fill.style.width = pct + '%';
  if (thumb) {
    thumb.style.left = pct + '%';
    thumb.style.display = d > 0 && pct > 0 ? '' : 'none';
  }
  if (time) time.textContent = fmtDur(c) + ' / ' + fmtDur(d);
}

/** 以 audio 当前状态刷新进度条 */
function renderSeek() {
  paintSeek(audio.currentTime || 0, audio.duration || 0);
}

/** 根据鼠标横坐标计算百分比并 seek */
function seekFromEvent(clientX) {
  const bar = $('seekBar');
  const d = audio.duration || 0;
  if (!bar || d <= 0) return;
  const rect = bar.getBoundingClientRect();
  if (rect.width <= 0) return;
  let pct = (clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  audio.currentTime = pct * d;
  paintSeek(pct * d, d);
  resetWatchdog();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
$('searchBtn').addEventListener('click', () => doSearch(1));
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch(1);
});
$('searchInput').addEventListener('input', () => {
  $('searchClear').hidden = !$('searchInput').value;
});
$('searchClear').addEventListener('click', () => {
  $('searchInput').value = '';
  $('searchClear').hidden = true;
  $('searchInput').focus();
});

$('backBtn').addEventListener('click', goBack);
$('brandBtn').addEventListener('click', goHome);
$('playlistBtn').addEventListener('click', () => togglePanel('playlist'));
$('historyBtn').addEventListener('click', () => togglePanel('history'));
$('commentsBtn').addEventListener('click', toggleComments);
$('favBtn').addEventListener('click', favCurrent);

$('savePlaylistBtn').addEventListener('click', savePlaylistAsCollection);
$('closePanel').addEventListener('click', closePanel);
$('clearPanelBtn').addEventListener('click', () => {
  if (currentPanel === 'playlist') clearQueue();
  else if (currentPanel === 'history') clearHistory();
  else if (currentPanel === 'favlist') {
    // 从收藏夹内容返回目录
    currentPanel = 'favfolders';
    renderPanelBody();
  }
});
$('panelModal').addEventListener('click', (e) => {
  if (e.target === $('panelModal')) closePanel();
});
$('closeComments').addEventListener('click', closeComments);
$('commentsModal').addEventListener('click', (e) => {
  if (e.target === $('commentsModal')) closeComments();
});

// 倍速 / 音量
$('speedBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSpeedPop();
});
$('volumeBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleVolumePop();
});
$('volumeSlider').addEventListener('input', (e) => {
  volumeValue = Math.max(0, Math.min(1, Number(e.target.value) / 100));
  if (volumeValue > 0) isMuted = false;
  applyVolume();
});
$('volumeSlider').addEventListener('change', () => saveState());
$('muteBtn').addEventListener('click', () => {
  isMuted = !isMuted;
  applyVolume();
  saveState();
});
document.addEventListener('click', (e) => {
  // 点击弹层外部或触发按钮之外的地方 → 收起所有弹层
  if (e.target.closest && e.target.closest('.popover')) return;
  if (
    e.target.closest &&
    e.target.closest('#volumeBtn, #speedBtn, #avatarBtn, #moreBtn, .item-act, .remove-btn')
  ) {
    return;
  }
  closeAllPopovers();
});

// 页面/弹层滚动时收起浮层，避免菜单与触发按钮错位
document.addEventListener('scroll', closeAllPopovers, true);

$('loginBtn').addEventListener('click', async () => {
  if ($('loginBtn').dataset.logged) {
    await doLogout();
    return;
  }
  showLogin();
});
$('closeLogin').addEventListener('click', closeLogin);

// --- 顶部账号头像菜单 / 更多菜单 ----------------------------------------------
$('avatarBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openTopMenu('accountMenu', 'avatarBtn');
});
$('moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openTopMenu('moreMenu', 'moreBtn');
});

/** 打开顶部某个菜单（两个菜单互斥，同时收起其它浮层） */
function openTopMenu(id, btnId) {
  const pop = $(id);
  if (!pop) return;
  const wasHidden = pop.classList.contains('hidden');
  closeAllPopovers();
  if (wasHidden) positionMenu(pop, $(btnId), 'right');
}

$('accountMenu').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.menu-item');
  if (!btn) return;
  closeAllPopovers();
  const act = btn.dataset.act;
  if (act === 'followings') openFollowings();
  else if (act === 'favorites') openFavFolders();
  else if (act === 'logout') doLogout();
});

$('moreMenu').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.menu-item');
  if (!btn) return;
  closeAllPopovers();
  if (btn.dataset.act === 'collections') openCollections();
  else if (btn.dataset.act === 'quit') quitApp();
});

/** 退出软件：调用后端 /api/desktop/quit 结束进程（区别于关闭按钮的「隐藏到托盘」） */
async function quitApp() {
  try {
    await api('/api/desktop/quit', { method: 'POST' });
  } catch (e) {
    /* 进程已退出时请求可能中断，忽略 */
  }
}

async function doLogout() {
  const r = await api('/api/login/logout');
  if (r.code !== 0) return handleError(r);
  await refreshNav();
  // 已退出时若停留在账号收藏夹面板，退回空态
  if (currentPanel === 'favlist' || currentPanel === 'favfolders') closePanel();
  toast('已退出登录');
}

// --- 收藏列表（歌单）窗口 ------------------------------------------------------
$('collectionsAddBtn').addEventListener('click', createCollection);
$('collectionsImportBtn').addEventListener('click', importCollectionsFlow);
$('collectionsExportBtn').addEventListener('click', exportCollections);
$('collectionsBackBtn').addEventListener('click', () => {
  collectionsView = { mode: 'list' };
  renderCollectionsBody();
});
$('closeCollections').addEventListener('click', closeCollections);
$('collectionsModal').addEventListener('click', (e) => {
  if (e.target === $('collectionsModal')) closeCollections();
});

// --- 合集 / 列表内容弹窗 ----------------------------------------------------
$('closeColl').addEventListener('click', closeCollModal);
$('collModal').addEventListener('click', (e) => {
  if (e.target === $('collModal')) closeCollModal();
});
$('collPlayAllBtn').addEventListener('click', collPlayAll);
$('collQueueBtn').addEventListener('click', collAppendAll);
// 「更多」：收藏 / 批量操作
$('collMoreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('collMoreMenu');
  const wasHidden = pop.classList.contains('hidden');
  closeAllPopovers();
  if (wasHidden) positionMenu(pop, $('collMoreBtn'), 'right');
});
$('collMoreMenu').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.menu-item');
  if (!btn) return;
  closeAllPopovers();
  if (btn.dataset.act === 'fav') collFavAll();
  else if (btn.dataset.act === 'batch') setCollBatch(true);
});
// 批量激活时头部显示的「批量」开关：点击退出批量
$('collBatchBtn').addEventListener('click', () => setCollBatch(false));
$('collSelectAll').addEventListener('click', () => {
  const st = collState;
  if (!st || !st.items) return;
  if (st.selected.size === st.items.length) st.selected.clear();
  else st.items.forEach((_, i) => st.selected.add(String(i)));
  renderCollBody();
});
$('collBatchPlay').addEventListener('click', () => {
  const items = collSelectedItems();
  if (!items.length) return toast('请先选择内容');
  playItems(items, 0);
  closeCollModal();
});
$('collBatchQueue').addEventListener('click', () => {
  const items = collSelectedItems();
  if (!items.length) return toast('请先选择内容');
  appendItemsToQueue(items);
});
$('collBatchFav').addEventListener('click', () => {
  const items = collSelectedItems();
  if (!items.length) return toast('请先选择内容');
  openFavPick(items);
});

// --- «收藏到» 弹层 -----------------------------------------------------------
$('closeFavPick').addEventListener('click', closeFavPick);
$('favPickModal').addEventListener('click', (e) => {
  if (e.target === $('favPickModal')) closeFavPick();
});
$('favPickNewRow').addEventListener('click', openFavNew);

// --- 导入文件（浏览器兜底路径）------------------------------------------------
$('importFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => applyImportText(String(reader.result || ''));
  reader.onerror = () => toast('文件读取失败');
  reader.readAsText(file, 'utf-8');
});

// --- 通用确认弹层：回车等于点主按钮 -------------------------------------------
$('confirmModal').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const actions = $('confirmActions');
  const primary = actions.querySelector('.primary, .danger');
  const btn = primary || actions.querySelector('button');
  if (btn) btn.click();
});

// ESC：从最上层往下关掉一个浮层 / 弹窗
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modals = [
    ['confirmModal', () => $('confirmModal').classList.add('hidden')],
    ['favPickModal', closeFavPick],
    ['collModal', closeCollModal],
    ['collectionsModal', closeCollections],
    ['commentsModal', closeComments],
    ['panelModal', closePanel],
    ['loginModal', closeLogin],
  ];
  for (const [id, close] of modals) {
    const m = $(id);
    if (m && !m.classList.contains('hidden')) {
      close();
      return;
    }
  }
  closeAllPopovers();
});

$('playBtn').addEventListener('click', () => {
  if (!audio.src) {
    if (queue.length) playQueue();
    return;
  }
  if (audio.paused) {
    audio.play();
    setPlayIcon(true);
  } else {
    audio.pause();
    setPlayIcon(false);
  }
});
$('prevBtn').addEventListener('click', prev);
$('nextBtn').addEventListener('click', next);

$('seekBar').addEventListener('click', (e) => seekFromEvent(e.clientX));
$('seekBar').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  seeking = true;
  seekFromEvent(e.clientX);
});
document.addEventListener('mousemove', (e) => {
  if (seeking) seekFromEvent(e.clientX);
});
document.addEventListener('mouseup', () => {
  seeking = false;
});

audio.addEventListener('timeupdate', () => {
  renderSeek();
  const now = Date.now();
  if (now - lastSaveTime >= 5000) {
    lastSaveTime = now;
    saveState();
  }
});
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek > 0) {
    try {
      audio.currentTime = clampSeekTarget(pendingSeek, audio.duration || 0);
    } catch (e) {}
    pendingSeek = 0;
  }
  renderSeek();
});
audio.addEventListener('ended', () => {
  // 位置明显没到结尾却被判定为结束：多半是流被截断，先恢复而不是跳下一首
  const d = audio.duration || 0;
  if (d > 0 && d - (audio.currentTime || 0) > 2) {
    nudgeCount = 3;
    reloadCurrentSource();
    return;
  }
  next();
});
audio.addEventListener('error', () => {
  handleAudioError();
});
audio.addEventListener('play', () => {
  setPlayIcon(true);
  markPlaying(); // 同步各列表卡片的暂停图标
  resetWatchdog();
});
audio.addEventListener('pause', () => {
  setPlayIcon(false);
  markPlaying();
});

audio.addEventListener('stalled', () => {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (audio.readyState < 3 && !stallNotified) {
      stallNotified = true;
      toast('网络卡顿，正在缓冲…');
    }
  }, 8000);
});
audio.addEventListener('playing', () => {
  clearTimeout(stallTimer);
  stallNotified = false;
  resetWatchdog();
});
audio.addEventListener('canplay', () => {
  clearTimeout(stallTimer);
  stallNotified = false;
});
audio.addEventListener('seeked', () => {
  resetWatchdog();
});

window.addEventListener('beforeunload', () => {
  saveState(true);
});

// ---------------------------------------------------------------------------
// 无边框窗口：最小化 / 最大化 / 关闭 / 边缘拖拽缩放
// （端点由 Tauri 内置服务提供；网页端访问失败时静默忽略）
// ---------------------------------------------------------------------------
function winAction(path, payload) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }).catch(() => {});
}

$('winMin').addEventListener('click', () => winAction('/api/desktop/win/min'));
$('winMax').addEventListener('click', () => winAction('/api/desktop/win/max'));
$('winClose').addEventListener('click', () => winAction('/api/desktop/win/close'));

// 标题栏拖拽由 Tauri 内置的 data-tauri-drag-region 机制处理：
// 窗口加载自自定义协议（本地源），Tauri 会注入 drag.js 并允许
// plugin:window|start_dragging 调用。此处不要再自行转发 mousedown ——
// Tauri 的监听器先执行并 stopImmediatePropagation，自定义兜底根本不会触发，
// 且重复调用 start_dragging 会让拖拽抖动。
// 规则（与官方一致）：事件路径上带 data-tauri-drag-region 才触发；
// "deep" 表示整棵子树可拖，但 button/input 等可交互元素仍然优先响应点击。

// ---------------------------------------------------------------------------
// 底部播放器：收起 / 展开
// ---------------------------------------------------------------------------
const PLAYER_COLLAPSED_KEY = 'biliAudioPlayerCollapsed';
let playerCollapsed = false;

/** 把播放器实际高度写进 CSS 变量，供主列表留白与浮层定位使用 */
function syncPlayerHeight() {
  const bar = $('playerBar');
  if (!bar) return;
  const h = bar.offsetHeight || 124;
  document.documentElement.style.setProperty('--player-h', h + 'px');
}

function setPlayerCollapsed(collapsed, persist) {
  playerCollapsed = !!collapsed;
  const bar = $('playerBar');
  if (!bar) return;
  bar.classList.toggle('collapsed', playerCollapsed);
  const toggle = $('playerToggle');
  if (toggle) {
    toggle.title = playerCollapsed ? '展开播放器' : '收起播放器';
    toggle.setAttribute('aria-label', toggle.title);
  }
  syncPlayerHeight();
  if (persist !== false) {
    try {
      localStorage.setItem(PLAYER_COLLAPSED_KEY, playerCollapsed ? '1' : '0');
    } catch (e) {}
  }
}

$('playerToggle').addEventListener('click', () => setPlayerCollapsed(!playerCollapsed));
window.addEventListener('resize', syncPlayerHeight);

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
function init() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(PLAYER_COLLAPSED_KEY) === '1';
  } catch (e) {}
  setPlayerCollapsed(collapsed, false);
  setPlayIcon(false);
  goHome();
  refreshNav();
  buildSpeedOptions();
  applyRate();
  applyVolume();
  startWatchdog();
  restoreState();
  // 字体 / 布局稳定后再量一次高度
  setTimeout(syncPlayerHeight, 60);
}

init();
