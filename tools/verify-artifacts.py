#!/usr/bin/env python
"""
产物校验：确认 dist/ 里的 EXE 与安装包确实带上了新图标、新名称与新前端逻辑。

为什么不看源码就算数：
  - 便携版 EXE 的界面是 rust-embed 内嵌的（无外部文件），改完前端不重新构建的话
    产物里还是旧逻辑；只有把产物当被验证对象去读，才能证明「打包进去了」。
  - 安装包（NSIS）整体被 LZMA 压缩，直接搜字节查不到里面的东西，
    所以改为解析 PE 资源目录，把安装包自己的图标（RT_ICON）取出来比对。

用法（项目根目录）：
    python tools/verify-artifacts.py

退出码：0 全部通过 / 1 有校验失败。
"""
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_ICO = os.path.join(ROOT, "src-tauri", "icons", "icon.ico")
PORTABLE = os.path.join(ROOT, "dist", "bili-audio.exe")
SETUP = os.path.join(ROOT, "dist", "bili Audio_1.0.0_x64-setup.exe")
PRODUCT = "bili Audio"
STALE_NAME = "B站音频台"
FRONTEND_MARKERS = [
    "mergeInsertNext",          # 下一首播放：移动而非重复
    "mergeAppend",              # 添加播放列表：跳过已存在条目
    "closeOtherTopSheets",      # 顶层弹层互斥
    "entryKey",                 # 统一去重键
    "已在播放列表中",
    "已调整到下一首播放",
    "ensureMidsThenRepaint",    # 缺 mid 的条目补齐 UP 主 id 后重绘
    "entryMid",                 # 条目缺 mid 时用 owner.mid 兜底（否则 UP 主名点不动）
    "probeAudioFailure",        # 播放失败时把后端记录的失败原因带出来
    "更换节点重试",              # 播放中断时丢掉旧地址、换一批新节点
    "音频区间超出文件范围",       # 越界 Range 回 416，而不是伪装成「所有节点不可用」
    "isChargedItem",            # 充电标识：条目自带 charged 优先
    "paintChargeBadges",        # 充电角标刷新（不碰多P卡片条）
    "loadChargesForList",       # 播放列表 / 历史也刷充电角标
    "ensureInfoForList",        # 只补分P信息、不画卡片条
    "aria-pressed",             # 静音按钮改为状态切换（文案恒定，宽度不跳）
    "resumeSeekTarget",         # 恢复进度只对被恢复的那一条生效（否则会跳过新点的条目）
    "clampSeekTarget",          # seek 目标越界时回退到从头播
    "userPickedPlayback",       # 用户已主动点播则不再用旧状态覆盖
    "fmtCount",                 # 计数标识超万位换 W+（投稿/列表/历史/评论/收藏夹）
]

failures = []


def ico_entries(path):
    """返回 {边长: 该条目的原始字节}（ICO 内的图片数据原样取出）"""
    raw = open(path, "rb").read()
    count = struct.unpack_from("<H", raw, 4)[0]
    out = {}
    for i in range(count):
        w, _h, _c, _r, _p, _b, size, off = struct.unpack_from("<BBBBHHII", raw, 6 + i * 16)
        out[w or 256] = raw[off:off + size]
    return out


def pe_resource_blobs(raw, type_id):
    """从 PE 映像里取出指定类型（RT_ICON=3 / RT_GROUP_ICON=14）的资源原始数据"""
    lfanew = struct.unpack_from("<I", raw, 0x3C)[0]
    assert raw[lfanew:lfanew + 4] == b"PE\0\0", "不是有效的 PE 文件"
    coff = lfanew + 4
    nsec, = struct.unpack_from("<H", raw, coff + 2)
    opt_size, = struct.unpack_from("<H", raw, coff + 16)
    opt = coff + 20
    magic, = struct.unpack_from("<H", raw, opt)
    # DataDirectory 起点：PE32 在 0x60，PE32+ 在 0x70（两者前面的字段长度不同）
    dd = opt + (0x60 if magic == 0x10B else 0x70)
    res_rva, = struct.unpack_from("<I", raw, dd + 2 * 8)
    secs = []
    base = opt + opt_size
    for i in range(nsec):
        s = base + i * 40
        va, _sz = struct.unpack_from("<II", raw, s + 12)
        praw, rawsz = struct.unpack_from("<II", raw, s + 20)
        secs.append((va, praw, rawsz or _sz))

    def to_off(rva):
        for va, praw, sz in secs:
            if va <= rva < va + sz:
                return praw + (rva - va)
        return None

    blobs = []
    root = to_off(res_rva)

    # 资源目录每一项是 {Name/ID, Offset} 两个 4 字节字段，两个字段各有一个高位标志：
    #   Name 字段高位 = 1 → 该值是「名字字符串」的偏移；否则它就是整数 ID（类型/编号）
    #   Offset 字段高位 = 1 → 指向子目录；否则指向数据条目
    # 混用这两个字段会永远匹配不到类型，从而“一个图标都取不出来”。
    def walk(off, level):
        named, ids = struct.unpack_from("<HH", raw, off + 12)
        for i in range(named + ids):
            e = off + 16 + i * 8
            name_field, off_field = struct.unpack_from("<II", raw, e)
            ident = None if (name_field & 0x80000000) else name_field
            if off_field & 0x80000000:
                sub = root + (off_field & 0x7FFFFFFF)
                if level == 0:
                    if ident == type_id:
                        walk(sub, 1)
                elif level == 1:
                    walk(sub, 2)
                else:
                    walk(sub, 3)
            elif level == 2:
                data_rva, size = struct.unpack_from("<II", raw, root + off_field)
                fo = to_off(data_rva)
                if fo is not None:
                    blobs.append(raw[fo:fo + size])

    walk(root, 0)
    return blobs


def dib_to_rgba(data):
    """把 ICO 里的 DIB（BITMAPINFOHEADER + 32bpp XOR 位图，可选 AND 掩码）解成 RGBA。
    返回 (w, h, bytearray) 或 None（非 DIB）。"""
    if len(data) < 40:
        return None
    hdr_size, w, h, planes, bpp = struct.unpack_from("<IiiHH", data, 0)
    if hdr_size != 40 or bpp not in (24, 32) or w <= 0 or h <= 0:
        return None
    row = w * (bpp // 8)
    row += (-row) % 4
    # ICO 的 DIB 里 biHeight = XOR 位图 + AND 掩码，是真实高度的两倍
    height = h
    if h % 2 == 0 and len(data) >= 40 + row * (h // 2):
        height = h // 2
    out = bytearray(w * height * 4)
    for y in range(height):
        src = 40 + (height - 1 - y) * row        # DIB 自下而上存储
        for x in range(w):
            o = src + x * (bpp // 8)
            b, g, r = data[o], data[o + 1], data[o + 2]
            a = data[o + 3] if bpp == 32 else 255
            d = (y * w + x) * 4
            out[d:d + 4] = bytes((r, g, b, a))
    return (w, height, out)


def png_encode(path, w, h, rgba):
    """最小 PNG 编码（仅 8bit RGBA、无滤波），用于把人眼校验的图落盘"""
    import zlib
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n" +
           chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    open(path, "wb").write(png)


def icon_fingerprint(w, h, rgba):
    """图标的像素指纹：出现最多的颜色（背景）+ 亮像素占比（三条白杠）"""
    from collections import Counter
    cnt = Counter()
    bright = 0
    for i in range(0, len(rgba), 4):
        rgb = (rgba[i], rgba[i + 1], rgba[i + 2])
        cnt[rgb] += 1
        if sum(rgb) > 600:            # 接近白
            bright += 1
    total = w * h
    bg, hits = cnt.most_common(1)[0]
    return bg, hits / total, bright / total


def check(cond, label):
    print(("  PASS  " if cond else "  FAIL  ") + label)
    if not cond:
        failures.append(label)


def main():
    entries = ico_entries(ICON_ICO)
    sig = {size: data[:64] for size, data in entries.items()}

    print(f"[1] 便携版 EXE  {PORTABLE}")
    if not os.path.exists(PORTABLE):
        check(False, "dist/bili-audio.exe 存在")
        return 1
    raw = open(PORTABLE, "rb").read()
    check(len(raw) > 8 * 1024 * 1024, f"体积 {len(raw):,} B（单文件，内嵌前端与图标）")
    for size in (32, 256):
        check(raw.count(sig[size]) > 0, f"图标 {size}x{size} 已作为资源嵌入")
    check(raw.count(PRODUCT.encode("utf-16-le")) > 0, f"版本信息含产品名 “{PRODUCT}”")
    check(raw.count(STALE_NAME.encode("utf-16-le")) == 0, f"无旧名残留 “{STALE_NAME}”")
    for m in FRONTEND_MARKERS:
        check(raw.count(m.encode()) > 0, f"内嵌前端含 {m}")

    print(f"[2] NSIS 安装包  {SETUP}")
    if not os.path.exists(SETUP):
        check(False, "安装包存在")
        return 1
    sraw = open(SETUP, "rb").read()
    check(len(sraw) > 1024 * 1024, f"体积 {len(sraw):,} B")
    check(sraw.count(PRODUCT.encode("utf-16-le")) > 0, f"安装包内文本含 “{PRODUCT}”")
    check(sraw.count(STALE_NAME.encode("utf-16-le")) == 0, f"无旧名残留 “{STALE_NAME}”")
    icons = pe_resource_blobs(sraw, 3)
    check(len(icons) > 0, f"安装包带 RT_ICON 图标资源（{len(icons)} 个）")
    # 安装包（makensis）会把图标重新编码（PNG→DIB，甚至调色板格式），无法整块字节比对，
    # 所以两条路都走：PNG 比字节，DIB 解出像素看内容 —— 品牌图标 = 深黑底(#18181b)+白色竖条。
    # 不设 installerIcon 时 makensis 会用自带的「地球+下载箭头」默认图标，这条断言正是拦它的。
    ours = set(entries.values())
    dump_dir = os.path.join(ROOT, "tmp", "setup-icons")
    # 上一轮跑出来的图先清掉，避免把过期的图标当成这轮的结果看
    if os.path.isdir(dump_dir):
        import shutil
        shutil.rmtree(dump_dir, ignore_errors=True)
    hits = []
    dumped = 0
    for blob in icons:
        if blob in ours:
            hits.append("PNG 字节一致")
            continue
        dec = dib_to_rgba(blob)
        if not dec:
            continue
        w, h, rgba = dec
        bg, share, bright = icon_fingerprint(w, h, rgba)
        if all(abs(c - t) <= 8 for c, t in zip(bg, (0x18, 0x18, 0x1B))) and share > 0.5 and bright > 0.05:
            hits.append(f"{w}x{h} DIB 像素匹配")
            os.makedirs(dump_dir, exist_ok=True)
            png_encode(os.path.join(dump_dir, f"setup-icon-{w}x{h}.png"), w, h, rgba)
            dumped += 1
    check(len(hits) > 0, f"安装包图标 = 品牌图标（命中 {len(hits)}/{len(icons)}）：{hits}")
    if dumped:
        print(f"         可人眼复核的图已导出: {dump_dir}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
