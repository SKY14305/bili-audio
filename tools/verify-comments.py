"""评论链路端到端回归：确认**楼中楼（回复）也带 UP 主 mid**。

为什么必须打真实接口：楼中楼漏 `mid` 时，前端「回复里的用户名」点了只提示
「暂未获取到该 UP 主的 ID」，而主楼却能进主页 —— 这种差异在静态检查里看不出来，
只有把接口返回体当被验证对象才证明得了。

用法（EXE 需是带 dev-server 的构建，否则不会监听端口）：

    source /e/tauri-env/env.sh
    cd src-tauri && cargo build --release --features dev-server && cd ..
    python tools/verify-comments.py

退出码 0 = 全部通过。
"""
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, 'src-tauri', 'target', 'release', 'bili-audio.exe')
PORT = 37210
BVID_RE = re.compile(r'BV[0-9A-Za-z]{10}')
MAX_VIDEOS = 6

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  -> ' + detail) if detail else ''))


def get_json(path):
    url = 'http://127.0.0.1:%d%s' % (PORT, path)
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def wait_port(proc, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None:
            return False
        try:
            socket.create_connection(('127.0.0.1', PORT), timeout=1).close()
            return True
        except OSError:
            time.sleep(0.5)
    return False


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXE
    if not os.path.isfile(exe):
        print('找不到 EXE：%s' % exe)
        return 2

    data_dir = tempfile.mkdtemp(prefix='bili-audio-comments-')
    src_cookie = os.path.join(ROOT, 'dist', 'data', 'cookies.json')
    if os.path.isfile(src_cookie):
        shutil.copy(src_cookie, os.path.join(data_dir, 'cookies.json'))

    env = dict(os.environ)
    env['BILI_DATA_DIR'] = data_dir
    proc = subprocess.Popen([exe], cwd=os.path.dirname(exe), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        if not wait_port(proc):
            print('EXE 未监听 %d —— 请用 `cargo build --release --features dev-server` 构建后再跑' % PORT)
            return 2

        # 用搜索接口攒一批 bvid（参数名是 kw，不是 keyword；不依赖具体字段名，直接扫 BV 号）
        try:
            raw = json.dumps(get_json('/api/search?kw=%s&page=1' % urllib.parse.quote('音乐')), ensure_ascii=False)
        except Exception as e:
            print('搜索接口调用失败：%s' % e)
            return 2
        bvids = []
        for m in BVID_RE.finditer(raw):
            if m.group(0) not in bvids:
                bvids.append(m.group(0))
            if len(bvids) >= MAX_VIDEOS:
                break
        print('候选视频：%s' % (bvids or '(空)'))
        if not bvids:
            check('能从 /api/search 取到候选视频', False, '搜索无结果')
            return 1

        total_main = 0
        total_reply = 0
        main_missing = []
        reply_missing = []
        used = []

        for bvid in bvids:
            try:
                v = get_json('/api/view?bvid=' + bvid)
            except Exception:
                continue
            d = v.get('data') or {}
            aid = d.get('aid')
            if v.get('code') != 0 or not aid:
                continue
            try:
                c = get_json('/api/comments?aid=%s&pn=1&ps=20' % aid)
            except Exception:
                continue
            if c.get('code') != 0:
                continue
            replies = (c.get('data') or {}).get('replies') or []
            if not replies:
                continue
            used.append(bvid)
            for item in replies:
                total_main += 1
                if item.get('mid') in (None, ''):
                    main_missing.append('%s/%s' % (bvid, item.get('uname')))
                for sub in (item.get('replies') or []):
                    total_reply += 1
                    if sub.get('mid') in (None, ''):
                        reply_missing.append('%s/%s' % (bvid, sub.get('uname')))
            if total_reply >= 3:
                break

        print()
        print('采样视频 %d 个：%s' % (len(used), used))
        print('主评论 %d 条，楼中楼 %d 条' % (total_main, total_reply))
        print()

        check('取到主评论样本', total_main > 0, 'main=%d' % total_main)
        check('主评论都带 mid', total_main > 0 and not main_missing,
              '缺 mid: %s' % main_missing[:5])
        check('取到楼中楼样本（否则无法验证回复链路）', total_reply > 0, 'reply=%d' % total_reply)
        check('楼中楼都带 mid（缺了就无法点进 UP 主页）', total_reply > 0 and not reply_missing,
              '缺 mid: %s' % reply_missing[:5])
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        shutil.rmtree(data_dir, ignore_errors=True)

    print()
    failed = [n for n, ok in results if not ok]
    print('共 %d 项，失败 %d' % (len(results), len(failed)))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
