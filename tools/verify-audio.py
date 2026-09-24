"""音频链路端到端回归：直接向被测 EXE 的 /api/audio 发原始 HTTP 请求。

为什么必须打真实产物：这些断言针对的是**响应本体的 HTTP 语义**，
静态检查或复刻逻辑都证明不了「送进 WebView2 media 引擎的东西是对的」。

用法（EXE 必须是带 dev-server 的构建，否则不会监听端口）：

    source /e/tauri-env/env.sh
    cargo build --release --features dev-server
    python tools/verify-audio.py                 # 默认用 target/release/bili-audio.exe

退出码 0 = 全部通过。断言与期望值取自「代码应有的行为」，不取自实测值。
"""
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EXE = os.path.join(ROOT, 'src-tauri', 'target', 'release', 'bili-audio.exe')
PORT = 37210

# 目标视频：B 站把它三档音轨的 baseUrl 全指向 PCDN（*.mcdn.bilivideo.cn:8082），
# 正是「某个视频怎么都播不了」那类样本；对照视频的 baseUrl 全是常规 CDN。
TARGET = ('BV1XDYX69EC2', '41825929420')
CONTROL = ('BV1AdKp6dEo3', '40133791513')

results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  -> ' + detail) if detail else ''))


def raw_get(port, path, headers=None, cap=8 * 1024 * 1024):
    s = socket.create_connection(('127.0.0.1', port), timeout=120)
    req = 'GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\n' % (path, port)
    for k, v in (headers or {}).items():
        req += '%s: %s\r\n' % (k, v)
    req += '\r\n'
    s.sendall(req.encode())
    buf = b''
    try:
        while True:
            b = s.recv(65536)
            if not b:
                break
            buf += b
            if len(buf) >= cap:
                break
    except OSError:
        pass
    s.close()
    head, _, body = buf.partition(b'\r\n\r\n')
    lines = head.decode('latin-1').split('\r\n')
    status = int(lines[0].split()[1]) if len(lines[0].split()) > 1 else 0
    hdr = {}
    for ln in lines[1:]:
        if ':' in ln:
            k, v = ln.split(':', 1)
            hdr[k.strip().lower()] = v.strip()
    return status, hdr, body


def top_level_boxes(data):
    out, off = [], 0
    while off + 8 <= len(data):
        size = struct.unpack('>I', data[off:off + 4])[0]
        typ = data[off + 4:off + 8].decode('latin-1')
        if size == 0:
            out.append(typ)
            break
        if size == 1:
            if off + 16 > len(data):
                break
            size = struct.unpack('>Q', data[off + 8:off + 16])[0]
        out.append(typ)
        if size < 8:
            break
        off += size
    return out


def parse_total(content_range):
    """从 'bytes 0-509116/509117' 里取出总长"""
    try:
        return int(content_range.split('/')[-1])
    except (ValueError, AttributeError, IndexError):
        return None


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXE
    if not os.path.isfile(exe):
        print('找不到 EXE：%s' % exe)
        return 2

    data_dir = tempfile.mkdtemp(prefix='bili-audio-verify-')
    src_cookie = os.path.join(ROOT, 'dist', 'data', 'cookies.json')
    if os.path.isfile(src_cookie):
        shutil.copy(src_cookie, os.path.join(data_dir, 'cookies.json'))
        print('已复用登录态（临时副本，跑完即删）')

    env = dict(os.environ)
    env['BILI_DATA_DIR'] = data_dir
    proc = subprocess.Popen([exe], cwd=os.path.dirname(exe), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        # 等端口（dev-server 版本才会监听）
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
            print('EXE 未监听 %d —— 请用 `cargo build --release --features dev-server` 构建后再跑' % PORT)
            return 2

        for label, (bvid, cid) in (('target/PCDN视频', TARGET), ('ctrl/常规CDN视频', CONTROL)):
            print()
            print('=' * 72)
            print('###', label, bvid)
            api = '/api/audio?bvid=%s&cid=%s' % (bvid, cid)

            # 1) 播放地址解析：每档音轨都要带上全部备用地址
            st, _, body = raw_get(PORT, '/api/playurl?bvid=%s&cid=%s' % (bvid, cid))
            try:
                d = json.loads(body.decode('utf-8'))
            except Exception:
                d = {}
            tracks = (d.get('data') or {}).get('audio') or []
            urls_per_track = [len(t.get('urls') or []) for t in tracks]
            check('%s 播放地址解析出音轨' % label, len(tracks) > 0, 'tracks=%d' % len(tracks))
            check('%s 每档音轨都带备用地址（urls>=2）' % label,
                  bool(urls_per_track) and min(urls_per_track) >= 2,
                  'urls=%s' % urls_per_track)
            hosts = []
            for t in tracks:
                for u in (t.get('urls') or []):
                    hosts.append(u.split('/')[2])
            check('%s 常规 CDN 排在 PCDN 之前' % label,
                  bool(hosts) and ('mcdn' not in hosts[0]),
                  '首个候选=%s' % (hosts[0] if hosts else '-'))

            # 2) 带 Range 必须回 206 + Content-Range（不能是 200）
            st, hdr, body = raw_get(PORT, api, {'Range': 'bytes=0-'})
            total = None
            if st not in (200, 206):
                check('%s 带 Range 请求成功' % label, False, 'status=%d body=%s' % (st, body[:80]))
            else:
                check('%s 带 Range 请求回 206（不是 200）' % label, st == 206, 'status=%d' % st)
                cr = hdr.get('content-range', '')
                check('%s 206 必须带合法 Content-Range' % label,
                      cr.startswith('bytes ') and '/' in cr, 'content-range=%s' % (cr or '-'))
                cl = hdr.get('content-length')
                check('%s Content-Length 与实际 body 一致' % label,
                      bool(body) and cl == str(len(body)),
                      'header=%s actual=%d' % (cl, len(body)))
                total = parse_total(cr)

            # 3) 不带 Range：200（完整资源）或 206（本端按分片取），
            #    但响应头必须自洽 —— 声明了 Accept-Ranges 就不能给出语义矛盾的组合；
            #    两种情况下音频本体都要能被 WebView2 独立解码
            st2, hdr2, body2 = raw_get(PORT, api)
            cr2 = hdr2.get('content-range', '')
            hdr_ok = (st2 == 200 and not cr2) or (
                st2 == 206 and cr2.startswith('bytes ') and '/' in cr2
            )
            check('%s 不带 Range 的响应头自洽（200无CR / 206带CR）' % label,
                  hdr_ok, 'status=%d content-range=%s' % (st2, cr2 or '-'))
            boxes = top_level_boxes(body2) if body2 else []
            check('%s 音频本体含 ftyp+moov（WebView2 可独立解码）' % label,
                  'ftyp' in boxes and 'moov' in boxes, 'boxes=%s' % boxes[:6])
            if total is None:
                total = parse_total(cr2) or (len(body2) or None)

            # 4) 越界区间：应当是 416，而不是 502「所有音频节点均不可用」
            if total:
                st3, _, body3 = raw_get(PORT, api, {'Range': 'bytes=%d-' % total})
                check('%s 越界 Range 回 416 而非 502' % label, st3 == 416,
                      'status=%d body=%s' % (st3, body3[:70]))
                st4, hdr4, _ = raw_get(PORT, api, {'Range': 'bytes=%d-%d' % (total, total + 10)})
                check('%s 越界区间（起止都越界）回 416' % label, st4 == 416, 'status=%d' % st4)
            else:
                check('%s 能取到音频总长以便测越界' % label, False, 'Content-Range 缺失')

            # 5) refresh=1 可强制重新解析（失败重试路径依赖它）；
            #    非法 Range（后缀形式）不得把请求打成 5xx
            st5, _, _ = raw_get(PORT, api + '&refresh=1', {'Range': 'bytes=-1'})
            check('%s refresh=1 可用且非法 Range 不返回 5xx' % label,
                  st5 in (200, 206, 416), 'status=%d' % st5)

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        # 临时 data 目录里有真实登录态的副本，必须收干净，不能留在磁盘上
        shutil.rmtree(data_dir, ignore_errors=True)

    print()
    print('=' * 72)
    failed = [r for r in results if not r[1]]
    print('共 %d 项，通过 %d，失败 %d' % (len(results), len(results) - len(failed), len(failed)))
    for name, _, detail in failed:
        print('  FAIL %s  %s' % (name, detail))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
