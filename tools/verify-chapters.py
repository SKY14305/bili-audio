"""视频章节（B 站「视频节点」）端到端回归：确认 /api/chapters 返回的节点，
与「直接用 B 站原始接口 + 独立规范实现」算出来的结果**逐条一致**。

为什么必须打真实接口：
  - 章节要靠 WBI 签名请求 `/x/player/wbi/v2`，签名错了 B 站不会报错，
    而是回 `code=-412/-352` 或空数据 —— 界面表现只是「这条视频没有节点」，看不出来；
  - 节点字段名是 `content` / `imgUrl`，与前端要的 `title` / `img` 不同名，
    映射错了同样只表现为「没有节点」。

为什么用「参考实现比对」而不是写死期望值：
  节点由 UP 主随时增删，样本视频的节点数会变。所以本脚本在 Python 里
  独立实现一遍规范（自己的 WBI 签名 + 同样的字段映射），
  再用它作为**被验证对象的对照**：两边算出来必须一致。
  这样既不会因为样本变化而假失败，也真的在验「应用算得对不对」。

两阶段：
  1. 接口层：启动 EXE，把 /api/chapters 的输出与参考实现逐条比对（含按 cid 取、缓存、降级）；
  2. 界面层：在同一个 EXE 上跑一份现场生成的断言用例（落盘 tmp/ui-spec-live-chapters.json），
     走真实的 playQueue → 取节点 → 画刻度 → hover 出标题 → 点击跳转这条链路。
     第 1 阶段只证明后端算得对，端到端「用户真能看见节点」要靠第 2 阶段。

用法（EXE 需是带 dev-server 的构建）：

    source /e/tauri-env/env.sh
    cd src-tauri && cargo build --release --features dev-server && cd ..
    python tools/verify-chapters.py

退出码 0 = 全部通过 / 1 有断言失败 / 2 环境或连接错误。
"""
import hashlib
import io
import json
import os
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
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

# 已知带「视频节点」的样本（含一个多 P：P1 有节点、P2 没有 —— 用来证明节点是**按分P**取的）
SEEDS = ['BV1paaq6ZEFT', 'BV1rWPGzFEn6', 'BV1tia36FEHA', 'BV1Bg411a7fN', 'BV1767y6vEpB']
# 已知没有节点的样本：必须安静地返回空表，而不是报错或 502
NEGATIVE = 'BV1GJ411x7h7'
MULTI_P_SEEDS = ['BV1Bg411a7fN', 'BV1767y6vEpB']
MAX_PARTS = 3  # 多P 只验前几个分P，够证明「按 cid 取」即可

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  -> ' + detail) if detail else ''))


# ---------------------------------------------------------------------------
# 参考实现（独立于 Rust 侧，用来当对照）
# ---------------------------------------------------------------------------
def raw_get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://www.bilibili.com'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode('utf-8'))


def wbi_keys():
    nav = raw_get('https://api.bilibili.com/x/web-interface/nav')
    wi = nav['data']['wbi_img']
    img = wi['img_url'].rsplit('/', 1)[-1].split('.')[0]
    sub = wi['sub_url'].rsplit('/', 1)[-1].split('.')[0]
    orig = img + sub
    return ''.join(orig[i] for i in MIXIN_KEY_ENC_TAB)[:32]


def wbi_sign(mixin_key, params):
    p = dict(params)
    p['wts'] = int(time.time())
    q = '&'.join('%s=%s' % (k, urllib.parse.quote(str(v), safe='')) for k, v in sorted(p.items()))
    for ch in "!'()*":
        q = q.replace(ch, '')
    return q + '&w_rid=' + hashlib.md5((q + mixin_key).encode()).hexdigest()


def ref_pages(bvid):
    """[{page, cid, duration}]"""
    v = raw_get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid)
    if v.get('code') != 0:
        return []
    d = v['data']
    pages = d.get('pages') or []
    if not pages:
        return [{'page': 1, 'cid': d.get('cid'), 'duration': d.get('duration')}]
    return [{'page': p['page'], 'cid': p['cid'], 'duration': p['duration']} for p in pages]


def ref_chapters(mixin_key, bvid, cid):
    """参考实现：直接问 B 站，再按与后端相同的口径规范化"""
    url = ('https://api.bilibili.com/x/player/wbi/v2?' +
           wbi_sign(mixin_key, {'bvid': bvid, 'cid': str(cid)}))
    j = raw_get(url)
    if j.get('code') != 0:
        return None, 'code=%s %s' % (j.get('code'), j.get('message'))
    pts = (j.get('data') or {}).get('view_points') or []
    out = []
    for p in pts:
        frm = p.get('from', -1)
        to = p.get('to', -1)
        title = strip_html(p.get('content') or '')
        if frm < 0 or to <= frm or not title:
            continue
        out.append({'from': frm, 'to': to, 'title': title})
    return out, ''


def strip_html(s):
    out, in_tag = [], False
    for c in s:
        if c == '<':
            in_tag = True
        elif c == '>':
            in_tag = False
        elif not in_tag:
            out.append(c)
    t = ''.join(out)
    for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&#39;', "'")):
        t = t.replace(a, b)
    return t.strip()


def sig(chapters):
    """只比前端真正用到/展示的字段"""
    return [(c['from'], c['to'], c['title']) for c in chapters]


# ---------------------------------------------------------------------------
# 第 2 阶段：界面层用例（现场生成 spec，交给 ui-assert-verify 引擎跑）
# ---------------------------------------------------------------------------
LIVE_SPEC = os.path.join(ROOT, 'tmp', 'ui-spec-live-chapters.json')

# 引擎与 node 都是本机固定资产，路径与 README「自查」段一致
ENGINE = os.path.expanduser('~/.workbuddy/skills/ui-assert-verify/scripts/verify-ui.js')
NODE_CANDIDATES = [
    os.path.expanduser('~/.workbuddy/binaries/node/versions/22.12.0/node.exe'),
    shutil.which('node') or '',
]


def find_node():
    for c in NODE_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    return None


def live_setup(seeds, neg):
    """页面内 setup：真实入口 playQueue 起播 → 等刻度 → 量横坐标 / hover / 点击 / 换无节点视频"""
    return (
        "(async function(){"
        "var t={};window.__t=t;"
        "var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};"
        "var seeds=" + json.dumps(seeds, ensure_ascii=False) + ";"
        "var neg=" + json.dumps(neg, ensure_ascii=False) + ";"
        "var marks=function(){return document.getElementById('seekMarks')};"
        "var bar=document.getElementById('seekBar');"
        "/* 选一条**当前确实带节点**的视频：B 站样本随时会变，所以逐个试而不是写死 */"
        "var list=[],bvid='',cid='';"
        "for(var i=0;i<seeds.length;i++){"
        "var r=await api('/api/chapters?bvid='+seeds[i][0]+'&cid='+seeds[i][1]);"
        "var cs=(r.code===0&&r.data&&r.data.chapters)||[];"
        "if(cs.length){list=cs;bvid=seeds[i][0];cid=seeds[i][1];break;}}"
        "t.found=bvid;t.apiCount=list.length;"
        "/* 走真实播放入口：playQueue 内部按 cid 取节点并画刻度 */"
        "queue=[{bvid:bvid,cid:cid,title:'章节链路验证',author:'',duration:list.length?list[list.length-1].to:0}];"
        "currentIndex=0;"
        "try{await playQueue()}catch(e){t.playErr=String(e)}"
        "var t0=Date.now();"
        "while(Date.now()-t0<15000&&marks().children.length===0)await wait(300);"
        "t.markCount=marks().children.length;"
        "t.markCountMatchesApi=t.markCount===t.apiCount;"
        "/* 再等音频元数据：刻度横坐标按 duration 算，元数据没到位就没得量。"
        "   实测无交互会话里约 0.5s 到位（autoplay 被拦不影响加载元数据）。*/"
        "var t1=Date.now();"
        "while(Date.now()-t1<30000&&!(audio.duration>0))await wait(200);"
        "var d=audio.duration||0;t.duration=d;t.metaWaitMs=Date.now()-t1;t.durationKnown=d>0;"
        "/* 元数据没到位就明确判为「未通过」，不做「没法量就算过」的假通过 */"
        "t.pctViolation=t.durationKnown?null:false;"
        "if(t.durationKnown&&list.length){"
        "/* 横坐标 = 起点/时长，但圆点要整个收在条身内（首节点 0% 会收到距左端一个半径处），"
        "   所以比的是**渲染后的圆点中心**，且期望值同样要过一遍收边规则 */"
        "var br0=bar.getBoundingClientRect();var dotR=3;"
        "var want=list[0].from/d*100;"
        "var wantPx=Math.max(dotR,Math.min(br0.width-dotR,want/100*br0.width));"
        "var rc0=marks().children[0].getBoundingClientRect();"
        "var gotPx=rc0.left+rc0.width/2-br0.left;"
        "t.wantPx=Math.round(wantPx*100)/100;t.gotPx=Math.round(gotPx*100)/100;"
        "t.pctViolation=!(Math.abs(gotPx-wantPx)<0.6);}"
        "/* hover 第一个刻度 → 浮层要显示接口给的那个节点的标题 */"
        "var rc=marks().children[0].getBoundingClientRect();"
        "var x=Math.round(rc.left+rc.width/2);"
        "bar.dispatchEvent(new MouseEvent('mousemove',{clientX:x,bubbles:true}));"
        "var hit=seekMarkAt(x);"
        "t.hoverHit=hit;"
        "t.tipTitle=document.getElementById('seekTipTitle').textContent;"
        "t.tipTimeText=document.getElementById('seekTipTime').textContent;"
        "t.tipMatchesApi=hit>=0&&t.tipTitle===(list[hit].title||'');"
        "/* 点最后一个刻度 → 进度条应画到它的起点 */"
        "var last=list.length-1;"
        "var rl=marks().children[last].getBoundingClientRect();"
        "bar.dispatchEvent(new MouseEvent('click',{clientX:Math.round(rl.left+rl.width/2)+5,bubbles:true}));"
        "t.clickFrom=list[last].from;"
        "t.fillMatchesClick=t.durationKnown?Math.abs(parseFloat(document.getElementById('seekFill').style.width)-list[last].from/d*100)<0.5:null;"
        "/* 换成没有节点的视频 → 刻度必须一个不剩（原视频没节点就不该长出来） */"
        "await loadSeekChapters(neg[0],neg[1]);"
        "t.negApiCount=seekChapters.length;"
        "t.clearedCount=marks().children.length;"
        "return 1})()"
    )


def run_live_stage(seeds, neg):
    """第 2 阶段：EXE 还开着的时候，用真实页面跑一遍界面链路"""
    node = find_node()
    if not node:
        print('找不到 node（找不到可执行文件）—— 无法跑界面层用例')
        return 2
    if not os.path.isfile(ENGINE):
        print('找不到断言引擎：%s（见 README「自查」段）' % ENGINE)
        return 2

    os.makedirs(os.path.dirname(LIVE_SPEC), exist_ok=True)
    spec = {
        '_comment': ('自动生成：由 tools/verify-chapters.py 第 2 阶段写出，指向正在运行的 dev-server EXE。'
                     '不要手改这个文件 —— 改 verify-chapters.py。'),
        'url': 'http://127.0.0.1:%d/' % PORT,
        'viewport': [420, 780],
        'freeze': True,
        'setup': live_setup(seeds, neg),
        'settle': 300,
        'assert': [
            {'name': '样本里存在带节点的视频（真实接口给出的节点数 > 0）',
             'expr': 'window.__t.apiCount > 0', 'eq': True},
            {'name': '真实 playQueue 后刻度数 = 接口给的节点数', 'expr': 'window.__t.markCountMatchesApi', 'eq': True},
            {'name': '音频元数据到位（横坐标与浮层判定都依赖它）', 'expr': 'window.__t.durationKnown', 'eq': True},
            {'name': '刻度横坐标 = 节点起点 / 时长（贴边处按收边规则收进条身）',
             'expr': 'window.__t.pctViolation', 'eq': False},
            {'name': 'hover 刻度显示的是该节点标题（真实接口文案）',
             'expr': 'window.__t.tipMatchesApi', 'eq': True},
            {'name': 'hover 浮层带时间区间', 'expr': 'window.__t.tipTimeText.length > 0', 'eq': True},
            {'name': '点击刻度跳到该节点起点', 'expr': 'window.__t.fillMatchesClick', 'eq': True},
            {'name': '换成无节点的视频 → 刻度清零', 'expr': 'window.__t.clearedCount', 'eq': 0},
        ],
    }
    with open(LIVE_SPEC, 'w', encoding='utf-8') as f:
        json.dump(spec, f, ensure_ascii=False, indent=2)
    print('界面层用例已生成：%s' % LIVE_SPEC)
    print('（用真实页面 http://127.0.0.1:%d/ 跑：playQueue → 取节点 → 画刻度 → hover → 点击）' % PORT)
    print()

    p = subprocess.run([node, ENGINE, LIVE_SPEC], capture_output=True)
    out = p.stdout.decode('utf-8', 'replace')
    print(out.rstrip())
    if p.returncode not in (0, 1):
        print('断言引擎异常退出（code=%s）：%s' % (p.returncode, p.stderr.decode('utf-8', 'replace')[-500:]))
        return 2
    return p.returncode


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXE
    if not os.path.isfile(exe):
        print('找不到 EXE：%s' % exe)
        return 2

    try:
        mixin_key = wbi_keys()
    except Exception as e:
        print('拿不到 WBI 密钥（网络不通？）：%s' % e)
        return 2

    data_dir = tempfile.mkdtemp(prefix='bili-chapters-')
    src_cookie = os.path.join(ROOT, 'dist', 'data', 'cookies.json')
    if os.path.isfile(src_cookie):
        shutil.copy(src_cookie, os.path.join(data_dir, 'cookies.json'))

    env = dict(os.environ)
    env['BILI_DATA_DIR'] = data_dir
    proc = subprocess.Popen([exe], cwd=os.path.dirname(exe), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def app_get(path, timeout=40):
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (PORT, path), timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))

    def app_chapters(bvid, cid):
        return app_get('/api/chapters?bvid=%s&cid=%s' % (bvid, urllib.parse.quote(str(cid))))

    hit_any = False
    multi_p_differs = False
    first_cid = {}

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

        print('样本：%s' % ', '.join(SEEDS))
        print()

        for bvid in SEEDS:
            pages = ref_pages(bvid)
            if not pages:
                check('%s 能取到分P信息' % bvid, False)
                continue
            first_cid[bvid] = pages[0]['cid']
            print('--- %s（%d 个分P，验前 %d 个）---' % (bvid, len(pages), min(len(pages), MAX_PARTS)))
            counts = []
            for p in pages[:MAX_PARTS]:
                cid = p['cid']
                got = app_chapters(bvid, cid)
                want, err = ref_chapters(mixin_key, bvid, cid)
                if want is None:
                    check('%s P%d 参考实现能取到节点' % (bvid, p['page']), False, err)
                    continue
                got_list = (got.get('data') or {}).get('chapters') or []
                counts.append(len(got_list))
                if got.get('code') != 0:
                    check('%s P%d 接口返回 code=0' % (bvid, p['page']), False,
                          'code=%s %s' % (got.get('code'), got.get('message')))
                    continue
                check('%s P%d 节点与参考实现逐条一致（%d 个）' % (bvid, p['page'], len(want)),
                      sig(got_list) == sig(want),
                      '' if sig(got_list) == sig(want) else '应用=%s 参考=%s' % (sig(got_list)[:3], sig(want)[:3]))
                if want:
                    hit_any = True
                    # 结构不变量：起点非负、区间正长度、按起点升序且不重叠
                    ok_struct = all(
                        c['from'] >= 0 and c['to'] > c['from'] for c in got_list
                    ) and all(
                        got_list[i + 1]['from'] >= got_list[i]['to'] for i in range(len(got_list) - 1)
                    )
                    check('%s P%d 节点区间健全且不重叠' % (bvid, p['page']), ok_struct,
                          'from/to=%s' % [(c['from'], c['to']) for c in got_list][:4])
                    check('%s P%d 每个节点都带标题' % (bvid, p['page']),
                          all((c.get('title') or '').strip() for c in got_list))

                # 缓存：同一个键再问一次必须命中缓存且内容不变
                again = app_chapters(bvid, cid)
                again_list = (again.get('data') or {}).get('chapters') or []
                check('%s P%d 第二次请求命中缓存且内容一致' % (bvid, p['page']),
                      bool((again.get('data') or {}).get('cached')) and sig(again_list) == sig(got_list))

            if len(set(counts)) > 1:
                multi_p_differs = True
            print('    各分P 节点数：%s' % counts)

            # 缺 cid 时的降级：节点按分P 下发，没有 cid 就当作没有节点，但不能报错
            r = app_get('/api/chapters?bvid=' + bvid)
            check('%s 缺 cid 时安静返回空表（不报错）' % bvid,
                  r.get('code') == 0 and not ((r.get('data') or {}).get('chapters')))
            print()

        # 没有节点的视频：这是**绝大多数**情况，必须安静地返回空表
        pg = ref_pages(NEGATIVE)
        if pg:
            r = app_chapters(NEGATIVE, pg[0]['cid'])
            want, _ = ref_chapters(mixin_key, NEGATIVE, pg[0]['cid'])
            check('%s（无节点视频）返回 code=0 且节点为空' % NEGATIVE,
                  r.get('code') == 0 and not ((r.get('data') or {}).get('chapters')),
                  '参考实现也算了 %s 个' % (len(want) if want is not None else '?'))

        print()
        check('样本里存在带节点的视频（否则本次没验到解析链路）', hit_any)
        check('多P 视频不同分P 的节点数不同 → 证明节点确实按 cid 取（不是只看 bvid）',
              multi_p_differs)

        # ---------------- 第 2 阶段：界面链路（EXE 还开着才有意义）----------------
        print()
        print('=== 第 2 阶段：界面链路（真实页面 playQueue → 刻度 → hover → 点击）===')
        ordered = [b for b in MULTI_P_SEEDS + SEEDS if b in first_cid]
        seeds = [[b, first_cid[b]] for b in ordered]
        neg_pages = ref_pages(NEGATIVE)
        neg = [NEGATIVE, neg_pages[0]['cid'] if neg_pages else '']
        live_code = run_live_stage(seeds, neg)
        check('界面层用例全部通过（明细见上方引擎输出）', live_code == 0, '退出码 %s' % live_code)
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
