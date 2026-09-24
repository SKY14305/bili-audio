#!/usr/bin/env python
"""验证正式产物「不监听任何端口」—— 这是本项目的核心承诺。

封装版的界面与全部 API 都走自定义协议 `biliaudio://`，请求在进程内经
`tower::oneshot` 派发给 axum Router，不创建 TCP 监听。断言分三层：

  1. dev-server 端口（127.0.0.1:37210）连不上；
  2. 用 `netstat -ano` 确认该 PID 名下**没有任何 LISTENING 套接字**（比只探一个端口强）；
  3. EXE 二进制里不含 dev-server 启动分支的字面量 —— 说明 `const DEV_SERVER: bool = false`
     把整段监听代码在编译期裁掉了，而不是「运行时没走到」。

用法（会启动 GUI 约 5 秒后自动收掉）：

    python tools/verify-no-port.py

退出码 0 = 通过。（用临时 data 目录，不会碰 dist/data 里的真实数据。）
"""
import io
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'dist', 'bili-audio.exe')
DEV_PORT = 37210
DEV_MARKER = 'dev-server 已启动'

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  -> ' + detail) if detail else ''))


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else EXE
    if not os.path.isfile(exe):
        print('找不到产物：%s（先跑 npx tauri build 并拷到 dist/）' % exe)
        return 2

    data_dir = tempfile.mkdtemp(prefix='bili-audio-port-')
    env = dict(os.environ)
    env['BILI_DATA_DIR'] = data_dir

    proc = subprocess.Popen([exe], cwd=os.path.dirname(exe), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('启动 %s  pid=%d' % (exe, proc.pid))
    try:
        time.sleep(5)
        check('进程存活（GUI 正常启动）', proc.poll() is None, 'exit=%s' % proc.poll())

        port_open = True
        try:
            socket.create_connection(('127.0.0.1', DEV_PORT), timeout=2).close()
        except OSError:
            port_open = False
        check('dev-server 端口 %d 连不上' % DEV_PORT, not port_open)

        out = subprocess.run(['netstat', '-ano'], capture_output=True).stdout
        text = out.decode('gbk', 'replace')
        listening = []
        for ln in text.splitlines():
            parts = ln.split()
            if len(parts) >= 5 and parts[0].upper() == 'TCP' and parts[3].upper() == 'LISTENING':
                if parts[4] == str(proc.pid):
                    listening.append(parts[1])
        check('该进程无任何 LISTENING 套接字', not listening, '监听了 %s' % listening)

        raw = open(exe, 'rb').read()
        n = raw.count(DEV_MARKER.encode('utf-8'))
        check('EXE 内不含 dev-server 启动分支的字面量（编译期已裁掉）', n == 0, '出现 %d 次' % n)
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
    print()
    print('共 %d 项，失败 %d' % (len(results), len(failed)))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
