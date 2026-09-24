#!/usr/bin/env python
"""清理 target/ 里指向「已不存在的项目路径」的 build-script 缓存。

什么时候需要它：项目目录改过名（例如 bili-audio-tauri -> bili-audio）之后，
cargo 缓存的 build script 输出里仍写着旧绝对路径，编译会直接失败，报错形如：

    failed to read plugin permissions: failed to read file
    '\\\\?\\E:\\...\\bili-audio-tauri\\src-tauri\\target\\release\\build\\tauri-xxxx\\out\\...'
    (os error 3)

根因是 `tauri` / `tauri-plugin-*` 这些 crate 的 build script 输出（`cargo:..._PATH=...`）
被 cargo 缓存并回放给下游，路径被固定在缓存里。删掉这些条目即可让 build script 重跑，
代价是重编受影响的少数 crate —— 比 `cargo clean`（全量重编）快得多。

用法（项目根目录或 src-tauri 目录均可）：

    python tools/clean-stale-build-cache.py                 # 扫描，报告问题（默认 target/）
    python tools/clean-stale-build-cache.py --apply         # 扫描并清理
    python tools/clean-stale-build-cache.py <target 目录>    # 指定 target（便于自测）

工具本身的自测：`python tools/self-test-clean-stale.py`（构造假缓存，验证能检出、能清理、不误报）。
"""
import io
import os
import re
import shutil
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)
# 第一个非选项参数可指定 target 目录（自测用）
_args = [a for a in sys.argv[1:] if not a.startswith('--')]
TARGET = _args[0] if _args else os.path.join(PROJECT_ROOT, 'src-tauri', 'target')

# 缓存里出现的 Windows 绝对路径；我们只关心它是否指向本项目。
# ⚠ 反斜杠只写一层转义：raw 字符串里的 `\\` 恰好是「匹配一个反斜杠」。
#    写成 `\\\\` 会变成「匹配两个连续反斜杠」，而真实路径里只有一个 —— 会静默漏检。
WIN_PATH = re.compile(rb'[A-Za-z]:\\[^"\r\n]*?\\src-tauri\\')


def stale_roots(blob, current_root):
    """blob 里出现的、指向已不存在目录的项目根路径集合"""
    found = set()
    for m in WIN_PATH.finditer(blob):
        p = m.group(0).decode('utf-8', 'replace').rstrip('\\')
        # p 形如 E:\软件资源数据\WorkBuddy\bili-audio\src-tauri
        root = p.rsplit('\\src-tauri', 1)[0]
        if root.lower() != current_root.lower():
            found.add(root)
    return found


def main():
    apply = '--apply' in sys.argv
    if not os.path.isdir(TARGET):
        print('找不到 target 目录：%s' % TARGET)
        return 2

    print('项目根：%s' % PROJECT_ROOT)
    print('模式：%s' % ('清理' if apply else '仅扫描（加 --apply 才动手）'))
    print()

    dirty_dirs = []
    stale_seen = set()

    for prof in ('release', 'debug'):
        base = os.path.join(TARGET, prof)
        if not os.path.isdir(base):
            continue

        # 1) build/<crate>-<hash>/  ——  cargo 会回放这里的 output
        broot = os.path.join(base, 'build')
        dirty_crates = set()
        if os.path.isdir(broot):
            for entry in sorted(os.listdir(broot)):
                d = os.path.join(broot, entry)
                if not os.path.isdir(d):
                    continue
                bad = set()
                for fn in os.listdir(d):
                    if fn == 'output' or fn.startswith('output-'):
                        with open(os.path.join(d, fn), 'rb') as f:
                            bad |= stale_roots(f.read(), PROJECT_ROOT)
                if bad:
                    stale_seen |= bad
                    crate = entry.rsplit('-', 1)[0]
                    dirty_crates.add(crate)
                    dirty_dirs.append((prof, 'build', entry, sorted(bad)))

        # 2) .fingerprint/<crate>-<hash>/  ——  同一个 crate 的 fingerprint 一并清，
        #    否则 cargo 可能认为 build script 仍然新鲜而跳过重跑
        froot = os.path.join(base, '.fingerprint')
        if os.path.isdir(froot):
            for entry in sorted(os.listdir(froot)):
                d = os.path.join(froot, entry)
                if not os.path.isdir(d):
                    continue
                crate = entry.rsplit('-', 1)[0]
                bad = set()
                if crate in dirty_crates:
                    bad.add('(同 crate 的 build 缓存)')
                else:
                    for fn in os.listdir(d):
                        if fn.startswith('output-'):
                            with open(os.path.join(d, fn), 'rb') as f:
                                b = stale_roots(f.read(), PROJECT_ROOT)
                            if b:
                                bad |= b
                if bad:
                    stale_seen |= {x for x in bad if x != '(同 crate 的 build 缓存)'}
                    dirty_dirs.append((prof, 'fingerprint', entry, sorted(bad)))

    if not dirty_dirs:
        print('OK：未发现指向旧路径的 build-script 缓存。')
        return 0

    print('发现 %d 个受污染条目，涉及的旧路径：' % len(dirty_dirs))
    for s in sorted(stale_seen):
        print('   %s' % s)
    print()
    for prof, kind, entry, bad in dirty_dirs:
        print('   [%s/%s] %s' % (prof, kind, entry))
    print()

    if not apply:
        print('加 --apply 执行清理（只删这些条目，其余编译产物保留）。')
        return 1

    n = 0
    for prof, kind, entry, _ in dirty_dirs:
        sub = 'build' if kind == 'build' else '.fingerprint'
        path = os.path.join(TARGET, prof, sub, entry)
        shutil.rmtree(path, ignore_errors=True)
        n += 1
    print('已清理 %d 个条目。请重新执行 cargo build。' % n)
    print('（若仍失败，说明还有其它 crate 受影响，重跑本脚本或 cargo clean。）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
