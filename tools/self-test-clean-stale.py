#!/usr/bin/env python
"""clean-stale-build-cache.py 的自测：构造假缓存，验证「能检出 / 能清理 / 不误报」。

为什么值得留一个自测：这个工具是「编译突然失败时的救火工具」，
真到需要它的那一刻它要是不准（漏检或误删），代价是 cargo clean + 一二十分钟重编。

    python tools/self-test-clean-stale.py
退出码 0 = 通过。
"""
import io
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOL = os.path.join(HERE, 'clean-stale-build-cache.py')
FAKE = os.path.join(ROOT, 'tmp', 'self-test-target')

# 一个肯定不存在的旧项目根
STALE = r'E:\nowhere\old-place\bili-audio-tauri\src-tauri\target\release\build\tauri-deadbeef\out'
# 当前项目自己的路径（不应被当成污染）
CURRENT = os.path.join(ROOT, 'src-tauri', 'target', 'release', 'build', 'tauri-cafe', 'out')

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  -> ' + detail) if detail else ''))


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def run(*extra):
    p = subprocess.run(
        [sys.executable, TOOL, FAKE] + list(extra),
        capture_output=True,
    )
    return p.returncode, p.stdout.decode('utf-8', 'replace')


try:
    shutil.rmtree(FAKE, ignore_errors=True)
    # 污染条目：build script 输出里写着不存在的旧路径
    write(os.path.join(FAKE, 'release', 'build', 'tauri-deadbeef', 'output'),
          'cargo:PERMISSION_FILES_PATH=%s\\permissions\n' % STALE)
    # 正常条目：写着当前项目路径，不能被误判
    write(os.path.join(FAKE, 'release', 'build', 'tauri-cafe', 'output'),
          'cargo:PERMISSION_FILES_PATH=%s\\permissions\n' % CURRENT)
    write(os.path.join(FAKE, 'release', 'build', 'tauri-cafe', 'keep.txt'), 'x')

    rc, out = run()
    check('扫描模式检出 1 个受污染条目', '发现 1 个受污染条目' in out, out.strip().splitlines()[-1] if out.strip() else '')
    check('扫描模式报告旧路径', 'nowhere' in out)
    check('扫描模式不误报当前项目路径', 'tauri-cafe' not in out)
    check('扫描模式退出码为 1（有待处理项）', rc == 1, 'rc=%d' % rc)
    check('扫描模式下不删任何东西',
          os.path.isfile(os.path.join(FAKE, 'release', 'build', 'tauri-deadbeef', 'output')))

    rc2, out2 = run('--apply')
    check('清理模式退出码 0', rc2 == 0, 'rc=%d' % rc2)
    check('污染条目已删除',
          not os.path.isdir(os.path.join(FAKE, 'release', 'build', 'tauri-deadbeef')))
    check('未受影响的条目保留',
          os.path.isfile(os.path.join(FAKE, 'release', 'build', 'tauri-cafe', 'keep.txt')))

    rc3, out3 = run()
    check('清理后复查：报告无污染', '未发现指向旧路径' in out3 and rc3 == 0, 'rc=%d' % rc3)
finally:
    shutil.rmtree(FAKE, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print()
print('共 %d 项，失败 %d' % (len(results), len(failed)))
sys.exit(0 if not failed else 1)
