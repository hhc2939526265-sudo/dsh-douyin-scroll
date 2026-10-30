#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/api-comments.py —— 用签名拉某条作品/图文下的评论，列出「谁·说了什么·cid」
用途：找「号主在评论区 @ 我」的那条，拿到 cid 当 reply_id。
只读。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402
import urllib.parse

import httpx

HOME = home_str()
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_node():
    """本机 node 不一定在 PATH，也不一定是 C:\\Program Files\\nodejs（DSH 自带一份）→ 逐个找。"""
    import glob
    import shutil
    cands = [os.environ.get("DOUYIN_NODE") or "", os.environ.get("NODE_BIN") or "",
             shutil.which("node") or "",
             os.path.join(os.path.dirname(sys.executable), "node.exe"),
             r"C:\Program Files\nodejs\node.exe"]
    cands += sorted(glob.glob(os.path.expanduser(r"~\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe")))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return "node"


NODE = _find_node()
SIGNER = os.path.join(PLUGIN, "tools", "dy-signer.mjs")
COOKIE = open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8").read().strip()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
JAR = {}
for p in COOKIE.split(";"):
    if "=" in p:
        k, v = p.split("=", 1)
        JAR[k.strip()] = v.strip()

COMMON = {
    "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
    "pc_client_type": "1", "version_code": "190500", "version_name": "19.5.0",
    "cookie_enabled": "true", "screen_width": "1920", "screen_height": "1080",
    "browser_language": "zh-CN", "browser_platform": "Win32",
    "browser_name": "Chrome", "browser_version": "141.0.0.0",
    "engine_name": "Blink", "engine_version": "141.0.0.0",
    "os_name": "Windows", "os_version": "10", "platform": "PC",
}
qs = lambda d: "&".join("%s=%s" % (urllib.parse.quote(str(k)), urllib.parse.quote(str(v))) for k, v in d.items())


def sign(rel):
    env = dict(os.environ, DY_COOKIES=json.dumps(JAR, ensure_ascii=False), DOUYIN_HOME=HOME)
    p = subprocess.run([NODE, SIGNER, rel], capture_output=True, cwd=PLUGIN, env=env, timeout=240)
    out = p.stdout.decode("utf-8", "replace")
    i = out.find("{")
    if i < 0:
        return {"err": out[-300:]}
    return json.loads(out[i:out.rfind("}") + 1])


def _first_url(v):
    """从抖音嵌套 url_list / dict 结构里容错抠出第一个 http(s) 地址。"""
    if isinstance(v, str):
        return v if v.startswith("http") else ""
    if isinstance(v, list):
        for x in v:
            u = _first_url(x)
            if u:
                return u
    if isinstance(v, dict):
        for k in ("url_list", "url", "origin_url", "static_url", "animate_url", "download_url", "uri"):
            if k in v:
                u = _first_url(v[k])
                if u:
                    return u
    return ""


def extract_sticker(c):
    """从一条评论 raw 里抠贴纸 / 图片评论（表情包收集入口）。没有返回 None。只读。"""
    if not isinstance(c, dict):
        return None
    st = c.get("sticker") or {}
    sid = str(c.get("sticker_id") or (st.get("id") if isinstance(st, dict) else "") or "").strip()
    url = ""
    kind = "sticker"
    if isinstance(st, dict):
        url = (_first_url(st.get("url_list")) or _first_url(st.get("url"))
               or _first_url(st.get("static_url")) or _first_url(st.get("animate_url"))
               or _first_url(st.get("origin_url")))
    if not sid and not url:
        imgs = c.get("image_list") or []
        if imgs:
            url = _first_url(imgs[0])
            kind = "gif"
    name = (st.get("name") if isinstance(st, dict) else "") or c.get("text") or ""
    if sid or url:
        return {"sticker_id": sid, "name": str(name)[:60], "url": url,
                "kind": kind, "source": "comment", "aweme_id": str(c.get("aweme_id") or "")}
    return None


def _pagefetch_comments(aweme, pages=2):
    """
    ⭐ 2026-10-29：**页面上下文读评论**（不依赖外部签名器）。
    签名器坏了（signedUrl 缺失）之后，兜底一直是「打开视频页滚屏抓 DOM」，可抖音现在
    会给自动化浏览器弹「验证码中间页」⇒ DOM 抓 0 条、还看不出原因。
    这里改用 tools/comment-read-api.mjs（页面同源 fetch），并把「被验证码拦住」如实报上来。
    返回 (items, why)；why='captcha_interstitial' 表示被拦。
    """
    script = os.path.join(PLUGIN, "tools", "comment-read-api.mjs")
    if not os.path.isfile(script):
        return [], ""
    try:
        r = subprocess.run([NODE, script, "--aweme", str(aweme), "--pages", str(pages), "--limit", "60"],
                           capture_output=True, timeout=260,
                           env={**os.environ, "DOUYIN_HOME": HOME})
        out = (r.stdout or b"").decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("page-fetch 读评论失败：%s\n" % e)
        return [], ""
    i, j = out.find("{"), out.rfind("}")
    if i < 0 or j <= i:
        return [], ""
    try:
        data = json.loads(out[i:j + 1])
    except Exception:  # noqa: BLE001
        return [], ""
    if isinstance(data, dict) and data.get("reason") == "captcha_interstitial":
        return [], "captcha_interstitial"
    items = data.get("items") if isinstance(data, dict) else None
    return [x for x in (items or []) if isinstance(x, dict) and (x.get("text") or x.get("nick"))], ""


def _dom_comments(aweme, scroll=4):
    """读评论的兜底链：① 页面上下文 fetch（最快、不依赖签名器）② 滚屏抓 DOM。
    返回 (items, video)。items=[{"nick":..., "text":...}]；video 里出现 "__captcha__": True 表示被验证码拦住。"""
    pf, why = _pagefetch_comments(aweme, pages=2)
    if pf:
        return pf, {}
    if why == "captcha_interstitial":
        # 被验证码拦在中间页：别再滚屏白跑（只会得到 0 条，还让人误以为"没人评论"）
        return [], {"__captcha__": True}
    script = os.path.join(PLUGIN, "tools", "comment-read-dom.mjs")
    if not os.path.isfile(script):
        return [], {}
    try:
        r = subprocess.run([NODE, script, "--aweme", str(aweme), "--scroll", str(scroll)],
                           capture_output=True, timeout=260,
                           env={**os.environ, "DOUYIN_HOME": HOME})
        out = (r.stdout or b"").decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("dom 读评论失败：%s\n" % e)
        return [], {}
    i, j = out.find("{"), out.rfind("}")
    if i < 0 or j <= i:
        return [], {}
    try:
        data = json.loads(out[i:j + 1])
    except Exception:  # noqa: BLE001
        return [], {}
    items = data.get("items") if isinstance(data, dict) else None
    video = data.get("video") if isinstance(data, dict) else None
    return [x for x in (items or []) if isinstance(x, dict) and (x.get("text") or x.get("nick"))], (video or {})


def _dom_main(aweme):
    """把 DOM 读到的评论打成 host 认识的格式（以 `  cid=N` 开头的行），并回退成功。"""
    import re as _re
    items, video = _dom_comments(aweme)
    clean = []
    for x in items:
        nick = str(x.get("nick") or "").strip()
        txt = _re.sub(r"^\.\.\.\s*", "", str(x.get("text") or "")).strip()
        if not txt or _re.match(r"^(精选|搜索|充钻石|推荐|登录)\s*$", nick):
            continue
        if "视频数据加载中" in txt:
            continue
        # ⭐ 2026-10-29：page-fetch 拿到的是**真 cid**，别再自己编号 ——
        #    回复/删除/@ 都要用真 cid；只有滚屏 DOM 那条路才没有 cid。
        clean.append((str(x.get("cid") or ""), nick, txt, int(x.get("digg") or 0)))
    if not clean:
        if isinstance(video, dict) and video.get("__captcha__"):
            print(json.dumps({
                "ok": False, "reason": "captcha_interstitial",
                "err": "抖音把浏览器拦在「验证码中间页」上，读不到这条视频的评论",
                "hint": "让老大在设置页点「打开浏览器」手动过一次滑块/验证码（或者用 tools/comment-verify.mjs），之后就能读了",
            }, ensure_ascii=False))
            return 1
        print(json.dumps({"ok": False, "err": "签名接口与 DOM 兜底都没读到评论"}, ensure_ascii=False))
        return 1
    real_cids = sum(1 for c in clean if c[0].isdigit() and len(c[0]) > 10)
    print("page=0 status_code=0 comments=%d 新=%d has_more=False  源=%s" % (
        len(clean), len(clean), "page-fetch" if real_cids else "dom"))
    for n, (cid, nick, txt, digg) in enumerate(clean, start=1):
        print("  cid=%s  %s  [%s]  赞%s  %s" % (cid or n, nick, txt[:100], digg, "page-fetch" if cid else "dom"))
    print("合计 %d 条（兜底链：page-fetch%s）" % (len(clean), "" if real_cids else " → 滚屏 DOM"))
    # ⭐ 2026-10-25：把「这条视频是什么」一起带给 host —— 老大在评论区 @ 你、
    #    问的又跟视频有关时，回话前必须先知道视频在讲什么。
    print("VIDEO_JSON=" + json.dumps({
        "desc": str((video or {}).get("desc") or "")[:400],
        "author": str((video or {}).get("author") or "")[:60],
        "tags": list((video or {}).get("tags") or [])[:8],
        "title": str((video or {}).get("title") or "")[:120],
    }, ensure_ascii=False))
    print("STICKERS_JSON=[]")
    return 0


def main():
    aweme = sys.argv[1] if len(sys.argv) > 1 else "7698980229549139835"
    try:
        return _api_main(aweme)
    except Exception as e:  # noqa: BLE001
        # 常见原因：$DOUYIN_HOME/signer 下缺 sdk 资产 / jsdom ⇒ KeyError: 'signedUrl'
        sys.stderr.write("签名接口失败（%s），改走 DOM 兜底\n" % e)
        return _dom_main(aweme)


def _api_main(aweme):
    seen = set()
    total = 0
    stickers = {}   # key -> 贴纸记录（去重）；供大肥鱼表情包库收集
    for page in range(4):
        rel = "/aweme/v1/web/comment/list/?" + qs({**COMMON, "aweme_id": aweme, "count": 20, "cursor": page * 20, "item_type": 0})
        s = sign(rel)
        if s.get("err"):
            raise RuntimeError(s["err"])
        u = s["signedUrl"]
        if not u.startswith("http"):
            u = "https://www.douyin.com" + u
        h = {"User-Agent": UA, "Accept": "application/json, text/plain, */*", "Referer": "https://www.douyin.com/",
             "Origin": "https://www.douyin.com", "Cookie": COOKIE, **(s.get("headers") or {})}
        r = httpx.get(u, headers=h, timeout=30, follow_redirects=True)
        j = r.json()
        cs = j.get("comments") or []
        fresh = [c for c in cs if c.get("cid") not in seen]
        print("page=%d status_code=%s comments=%d 新=%d has_more=%s" % (page, j.get("status_code"), len(cs), len(fresh), j.get("has_more")))
        for c in fresh:
            seen.add(c.get("cid"))
            total += 1
            u_ = (c.get("user") or {}).get("nickname") or ""
            txt = (c.get("text") or "").replace("\n", " ")
            print("  cid=%s  %s  [%s]  赞%s  %s" % (c.get("cid"), u_, txt[:100], c.get("digg_count"), c.get("create_time")))
            for rr in (c.get("reply_comment") or [])[:6]:
                print("      └ reply cid=%s %s [%s]  %s" % (rr.get("cid"), (rr.get("user") or {}).get("nickname"),
                                                            (rr.get("text") or "").replace("\n", " ")[:90], rr.get("create_time")))
                st = extract_sticker(rr)
                if st and (st["sticker_id"] or st["url"]):
                    stickers.setdefault(st["sticker_id"] or st["url"], st)
            st = extract_sticker(c)
            if st:
                stickers.setdefault(st["sticker_id"] or st["url"], st)
        if not fresh or not j.get("has_more"):
            break
    print("合计 %d 条" % total)
    # ⭐ 表情包收集：机器可读一行，host/MCP 抓到后喂给 lib/stickers.mjs（安全审核通过才允许用）
    print("STICKERS_JSON=" + json.dumps(list(stickers.values()), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
