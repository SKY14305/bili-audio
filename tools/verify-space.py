"""UP 投稿分页端到端回归：确认「投稿多的 UP 也能正常翻页」。

这条链路曾整段失效，且症状具有误导性：
  - 请求不带 User-Agent（reqwest 默认 UA）→ B 站直接回 **412**；
  - 少了页面版参数（tid / keyword / platform / web_location / order_avoided）→
    B 站**不报错**，只回 `code=0 + count=0 + 空列表`，界面就变成「0 投稿」。
投稿少的 UP 因为首页命中率较高，不容易看出问题；投稿 25.9 万的 UP 则几乎必现。

补齐后仍有**概率性限流**（实测单次成功率约两三成），所以后端会内部重试 3 次、
前端失败时再重试 1 次。本脚本按「用户点一次加载更多」的口径验收：几次尝试内应拿到数据。

用法（EXE 需是带 dev-server 的构建）：

    source /e/tauri-env/env.sh
    cd src-tauri && cargo build --release --features dev-server && cd ..
    python tools/verify-space.py

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
PAGES = (1, 2, 3)
TRIES = 4  # 模拟用户点击 + 重试的容忍次数

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  -> ' + detail) if detail else ''))


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXE
    if not os.path.isfile(exe):
        print('找不到 EXE：%s' % exe)
        return 2

    data_dir = tempfile.mkdtemp(prefix='bili-space-')
    src_cookie = os.path.join(ROOT, 'dist', 'data', 'cookies.json')
    if os.path.isfile(src_cookie):
        shutil.copy(src_cookie, os.path.join(data_dir, 'cookies.json'))

    env = dict(os.environ)
    env['BILI_DATA_DIR'] = data_dir
    proc = subprocess.Popen([exe], cwd=os.path.dirname(exe), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def get(path, timeout=60):
        url = 'http://127.0.0.1:%d%s' % (PORT, path)
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))

    def fetch_page(mid, pn):
        """模拟用户点一次加载更多；返回 (count, 条数, 第几次尝试成功)"""
        for t in range(1, TRIES + 1):
            try:
                r = get('/api/space/videos?mid=%s&pn=%d&ps=20' % (mid, pn))
            except Exception:
                time.sleep(1.0)
                continue
            d = r.get('data') or {}
            vlist = ((d.get('list') or {}).get('vlist')) or []
            cnt = ((d.get('page') or {}).get('count')) or 0
            if vlist:
                return cnt, len(vlist), t
            time.sleep(1.0)
        return 0, 0, TRIES

    try:
        up = False
        t0 = time.time()
        while time.time() - t0 < 30:
            if proc.poll() is not None:
                break
            try:
                socket.create_connection(('127.0.0.1', PORT), timeout=1).close()
                up = True
                break
            except OSError:
                time.sleep(0.5)
        if not up:
            print('EXE 未监听 %d —— 请用 `cargo build --release --features dev-server` 构建' % PORT)
            return 2

        # 找一个「投稿很多的 UP」：搜它的名字 → 取视频 owner
        targets = []
        for kw, must in (('索尼音乐中国', '索尼'), ('音乐', None)):
            try:
                raw = json.dumps(get('/api/search?kw=' + urllib.parse.quote(kw)), ensure_ascii=False)
            except Exception:
                continue
            for m in BVID_RE.finditer(raw):
                v = get('/api/view?bvid=' + m.group(0))
                d = v.get('data') or {}
                if not d.get('mid'):
                    continue
                if must and must not in (d.get('name') or ''):
                    continue
                if (d['mid'], d.get('name')) not in targets:
                    targets.append((d['mid'], d.get('name')))
                break
            if len(targets) >= 2:
                break

        if not targets:
            check('能定位到测试 UP（需要搜索接口可用）', False)
            return 1
        print('测试对象：%s' % targets)
        print()

        for mid, name in targets[:2]:
            print('--- %s (mid=%s) ---' % (name, mid))
            counts = []
            for pn in PAGES:
                cnt, n, t = fetch_page(mid, pn)
                counts.append(cnt)
                print('    pn=%d -> count=%s 条数=%d（第 %d 次尝试成功）' % (pn, cnt, n, t))
            check('%s 第 1 页能加载到投稿' % name, counts[0] > 0, 'count=%s' % counts[0])
            check('%s 第 2 页能加载到投稿（不再静默返回空而卡住）' % name, counts[1] > 0,
                  'count=%s' % counts[1])
            check('%s 第 3 页能加载到投稿' % name, counts[2] > 0, 'count=%s' % counts[2])
            check('%s 各页总数一致（不会被清零）' % name,
                  len(set(c for c in counts if c)) <= 1, 'counts=%s' % counts)
            print()
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

    failed = [n for n, ok in results if not ok]
    print('共 %d 项，失败 %d' % (len(results), len(failed)))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
