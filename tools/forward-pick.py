#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/forward-pick.py —— 刷一轮：拉候选 → 打分 → 抓画面关键帧 → 生成「转发给我」的清单
============================================================================
只读、**不签名**、不碰写接口。判断依据：
  · 文本信号：desc / tags / author / create_time / duration / digg·comment·collect·share / 高赞评论；
  · ⭐ 画面信号（2026-10-24 起）：对入选候选抓**高清封面 + 关键帧**（有 ffmpeg 时从视频抽
    开头/中间/结尾若干帧，没有 ffmpeg 也一定有封面），写到 `frames/<视频ID>/`，
    让值班那一轮的模型能**真的看到画面**再决定喜不喜欢、要不要分享。
  抓帧失败一律降级为只看文本，不影响主流程。

用法:
  python tools/forward-pick.py            # 拉 feed 3 页 + 热榜，出清单 + 抓帧
  python tools/forward-pick.py --no-frames  # 只出清单，不下载画面
  python tools/forward-pick.py --dump     # 额外打印原始结构，排错用
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402
import random
import time
from datetime import datetime, timezone, timedelta

try:
    from curl_cffi import requests as creq
except ModuleNotFoundError:
    # ⭐ 别让用户对着一长串 traceback 猜：这是「还没装主依赖」，不是插件坏了。
    sys.stderr.write(
        "\n[缺少主依赖] 还没有 curl_cffi。\n"
        "  请在设置页点「装主依赖」（会在插件家目录建 venv 装 curl_cffi + httpx）；\n"
        "  或手动：在插件 venv 里执行  pip install -r requirements.txt\n\n"
    )
    sys.exit(2)

# ⚠️ 2026-10-21 实测：Windows 上 stdout 默认 GBK，遇到标题里的 𝓋 / emoji 这类字符
#    直接 UnicodeEncodeError 崩掉（这一轮就是崩在最后打印清单那一步）。
#    插件是 spawnSync 抓管道的，崩了就等于「取候选失败」—— 一律强制 utf-8，编不出的替换掉。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOME = home_str()
COOKIE_FILE = os.path.join(HOME, "douyin_cookie.txt")
OUT_JSON = os.path.join(HOME, "forward-pick.json")
OUT_MD = os.path.join(HOME, "out", "forward-" + datetime.now().strftime("%Y%m%d-%H%M") + ".md")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
BASE = "https://www.douyin.com"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
          "&version_code=190500&version_name=19.5.0&cookie_enabled=true"
          "&screen_width=1920&screen_height=1080&browser_language=zh-CN"
          "&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0"
          "&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10"
          "&platform=PC&downlink=10&effective_type=4g&round_trip_time=50")

CST = timezone(timedelta(hours=8))


def load_cookie():
    with open(COOKIE_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()


def walk_awemes(obj, bag):
    """递归找所有长成 aweme 的 dict（有 aweme_id + desc）。"""
    if isinstance(obj, list):
        for v in obj:
            walk_awemes(v, bag)
    elif isinstance(obj, dict):
        if "aweme_id" in obj and ("desc" in obj or "statistics" in obj):
            bag[obj["aweme_id"]] = obj
        else:
            for v in obj.values():
                walk_awemes(v, bag)


def stat(a, k):
    s = a.get("statistics") or {}
    try:
        return int(s.get(k) or 0)
    except Exception:
        return 0


def fmts(n):
    if n >= 100000000:
        return "%.1f亿" % (n / 100000000.0)
    if n >= 10000:
        return "%.1f万" % (n / 10000.0)
    return str(n)


def get(s, path, quiet=True):
    try:
        r = s.get(BASE + path, timeout=25)
        time.sleep(1.2)
        if r.status_code != 200:
            if not quiet:
                print("  ! %s -> HTTP %s" % (path.split("?")[0], r.status_code), file=sys.stderr)
            return None
        return r.json()
    except Exception as e:
        if not quiet:
            print("  ! %s -> %s" % (path.split("?")[0], e), file=sys.stderr)
        return None


def load_collector():
    """
    ⭐ 读设置页那两个旋钮（`collector.json`，由 index.js 的 syncCollectorCfg 写）。
    以前这里完全没读它 ⇒ 设置页「文案太短 / 评论少」两个旋钮是死的（改了不起作用）。
    """
    p = os.path.join(HOME, "collector.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f) or {}
    except Exception:
        j = {}
    return {
        "minDescLen": int(j.get("minDescLen") or 0),
        "minComments": int(j.get("minComments") or 0),
    }


def load_config():
    """读插件 config.json（设置页落的）——画面开关 / 每轮条数在这。读不到给默认值。"""
    p = os.path.join(HOME, "config.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _first_url(node):
    """抖音的图片/视频地址字段都是 {'url_list': [...], 'width':..}，取第一个 http 地址。"""
    if isinstance(node, dict):
        ul = node.get("url_list") or []
        for u in ul:
            if isinstance(u, str) and u.startswith("http"):
                return u
    return ""


def pick_media(a):
    """从一个 aweme 里取出「可播放视频地址」和「高清封面地址」。取不到返回空串。"""
    v = a.get("video") or {}
    video_url = ""
    # 优先明确的无水印字段，再退回 bit_rate 里的码流
    for key in ("play_addr_h264", "play_addr_lowbr", "play_addr"):
        video_url = _first_url(v.get(key))
        if video_url:
            break
    if not video_url:
        for br in (v.get("bit_rate") or []):
            video_url = _first_url((br or {}).get("play_addr"))
            if video_url:
                break
    if video_url:
        # 抖音常见做法：playwm（带水印）换 play（不带水印）。换不了就用原地址。
        nowm = video_url.replace("/playwm/", "/play/")
        if nowm != video_url:
            video_url = nowm
    cover_url = _first_url(v.get("origin_cover")) or _first_url(v.get("dynamic_cover")) or _first_url(v.get("cover"))
    return video_url, cover_url


def find_ffmpeg():
    """先找系统 ffmpeg；装了可选依赖 imageio-ffmpeg 时也用它自带的二进制。找不到返回 ''。"""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # noqa: 可选依赖
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return ""


def _dl_bin(s, url, path, timeout=40):
    """下载二进制到 path，带抖音来源头。成功 True。"""
    try:
        r = s.get(url, timeout=timeout, headers={
            "Referer": BASE + "/",
            "Accept": "*/*",
            "Range": "bytes=0-",
        })
        if r.status_code not in (200, 206):
            return False
        data = r.content or b""
        if len(data) < 1024:   # 太小大概率是错误页/占位图（真实封面/视频远大于此）
            return False
        with open(path, "wb") as f:
            f.write(data)
        return True
    except Exception:
        return False


def grab_frames(s, r, a, want_frames, frame_count):
    """
    给一条候选抓画面。返回相对 HOME 的帧路径列表（posix 斜杠）。
    一定尽力给「高清封面」；有 ffmpeg 再从视频抽 frame_count 帧。
    任何失败都静默降级（这条的画面可缺，不能连累整轮）。
    """
    aid = r["aweme_id"]
    ddir = os.path.join(HOME, "frames", str(aid))
    os.makedirs(ddir, exist_ok=True)
    rel = []
    video_url, cover_url = pick_media(a)

    # ① 高清封面（零依赖，先保证有一张能看）
    if cover_url:
        cover_path = os.path.join(ddir, "cover.jpg")
        if (os.path.exists(cover_path) and os.path.getsize(cover_path) > 1024) or _dl_bin(s, cover_url, cover_path):
            rel.append("frames/%s/cover.jpg" % aid)
        time.sleep(random.uniform(0.4, 1.2))

    # ② 关键帧：需要 ffmpeg + 可播放地址
    if want_frames and video_url:
        ff = find_ffmpeg()
        if ff:
            tmp_video = None
            try:
                fd, tmp_video = tempfile.mkstemp(suffix=".mp4", prefix="dyv_")
                os.close(fd)
                if _dl_bin(s, video_url, tmp_video, timeout=60):
                    # 时长（秒）；抽帧位置按比例 10%/45%/80%…，保证开头/中间/结尾都覆盖
                    n = max(1, min(int(frame_count or 3), 6))
                    ratios = [ (i + 1) / (n + 1) for i in range(n) ]
                    dur = float(r.get("duration_s") or 0)
                    made = 0
                    for i, ratio in enumerate(ratios, 1):
                        pos = max(0.5, dur * ratio) if dur else float(3 * i)
                        out = os.path.join(ddir, "frame_%d.jpg" % i)
                        cmd = [ff, "-y", "-ss", ("%.2f" % pos), "-i", tmp_video,
                               "-frames:v", "1", "-q:v", "3", "-vf", "scale=720:-2", out]
                        try:
                            p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                            if p.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 1024:
                                rel.append("frames/%s/frame_%d.jpg" % (aid, i))
                                made += 1
                        except Exception:
                            continue
                    if made:
                        # 清理临时视频（帧已落盘）
                        try:
                            os.remove(tmp_video)
                        except Exception:
                            pass
                        return rel
            except Exception:
                pass
            finally:
                if tmp_video:
                    try:
                        os.remove(tmp_video)
                    except Exception:
                        pass
    r["_video_url_ok"] = bool(video_url)
    r["_ffmpeg"] = bool(find_ffmpeg()) if (want_frames and video_url) else False
    return rel



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true")
    ap.add_argument("--limit", type=int, default=10, help="最多取前几条（默认 10）")
    ap.add_argument("--frames", dest="frames", action="store_true", help="抓高清封面+关键帧（默认开）")
    ap.add_argument("--no-frames", dest="frames", action="store_false", help="只出清单，不下载画面")
    ap.add_argument("--frame-count", type=int, default=0, help="每条抽几个视频关键帧（默认取设置，3；封面始终抓）")
    ap.set_defaults(frames=True)
    args = ap.parse_args()

    limits = load_collector()
    # 画面开关 / 关键帧数量：命令行优先，否则读设置页 config.json
    cfg = load_config()
    want_frames = bool(args.frames and cfg.get("watchFrames", True))
    frame_count = int(args.frame_count or cfg.get("frameCount") or 3)
    if want_frames:
        meta_note = {"frames": "on", "frame_count": frame_count, "ffmpeg": bool(find_ffmpeg())}
    else:
        meta_note = {"frames": "off"}
    # ⭐ 硬筛计数：报告里要能说清"因为什么跳过了几条"，不能只给个最终条数
    dropped = {"no_desc": 0, "too_short_video": 0, "short_and_quiet": 0}

    cookie = load_cookie()
    bag = {}
    meta = []

    with creq.Session(impersonate="chrome") as s:
        s.headers.update({
            "User-Agent": UA, "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": BASE + "/", "Origin": BASE,
        })

        # 1) 推荐流 3 页
        for i in range(1, 4):
            j = get(s, "/aweme/v1/web/tab/feed/?%s&count=20&refresh_index=%d" % (COMMON, i))
            if j:
                before = len(bag)
                walk_awemes(j, bag)
                meta.append({"src": "feed#%d" % i, "new": len(bag) - before, "status": j.get("status_code")})
                if args.dump and i == 1:
                    print("[feed#1 top-level keys] %s" % sorted(j.keys()), file=sys.stderr)

        # 2) 热榜
        j = get(s, "/aweme/v1/web/hot/search/list/?%s&detail_list=1" % COMMON)
        if j:
            before = len(bag)
            walk_awemes(j, bag)
            meta.append({"src": "hot-search", "new": len(bag) - before, "status": j.get("status_code")})

    now = time.time()
    rows = []
    for aid, a in bag.items():
        desc = (a.get("desc") or "").strip()
        if not desc:
            dropped["no_desc"] += 1
            continue
        dur = a.get("duration") or (a.get("video") or {}).get("duration") or 0
        if dur and dur < 12000:          # <12s 多数是模板/广告
            dropped["too_short_video"] += 1
            continue
        d, c, col, sh = stat(a, "digg_count"), stat(a, "comment_count"), stat(a, "collect_count"), stat(a, "share_count")
        # ⭐ 设置页那两个旋钮：文案太短**且**评论少 ⇒ 丢（单条不满足只降权不丢）
        if limits["minDescLen"] and len(desc) < limits["minDescLen"] and c < limits["minComments"]:
            dropped["short_and_quiet"] += 1
            continue
        ct = a.get("create_time") or 0
        age_h = (now - ct) / 3600.0 if ct else 999
        inter = d + c * 2 + col * 3 + sh * 2
        # 评论/点赞比：越高越"有话说"；太高的往往是争议/标题党
        ratio = (c / d) if d else 0
        score = inter
        if 0.02 <= ratio <= 0.25:
            score *= 1.25
        if age_h <= 72:
            score *= 1.15
        si = a.get("share_info") or {}
        official = si.get("share_url") or a.get("share_url") or ""
        rows.append({
            "aweme_id": aid,
            "desc": desc,
            "author": (a.get("author") or {}).get("nickname") or "",
            "sec_uid": (a.get("author") or {}).get("sec_uid") or "",
            "duration_s": round(dur / 1000.0, 1) if dur else None,
            "digg": d, "comment": c, "collect": col, "share": sh,
            "comment_ratio": round(ratio, 4),
            "age_h": round(age_h, 1),
            "score": int(score),
            # ⭐ 官方分享链接（接口直接给的，带 share_sign）——不要自己拼 aweme_id
            "share_url": official or ("https://www.iesdouyin.com/share/video/%s/" % aid),
            # 抖音口令（"复制此链接，打开Dou音搜索"那串）
            "share_desc": (si.get("share_link_desc") or "").replace("%s", official).strip(),
            # 网页地址（能在浏览器打开，但不是分享链接）
            "web_url": "%s/video/%s" % (BASE, aid),
        })

    rows.sort(key=lambda r: -r["score"])
    top = rows[:max(1, args.limit)]

    # ⭐ 给入选候选抓画面（高清封面 + 关键帧），让模型真的"看得到"。任何失败都静默降级。
    frames_summary = {"on": want_frames, "with_video": 0, "cover_only": 0, "none": 0, "ffmpeg": bool(find_ffmpeg())}
    if want_frames:
        with creq.Session(impersonate="chrome") as fs:
            fs.headers.update({
                "User-Agent": UA, "Cookie": cookie, "Referer": BASE + "/", "Origin": BASE,
                "Accept-Language": "zh-CN,zh;q=0.9",
            })
            for r in top:
                a = bag.get(str(r["aweme_id"])) or {}
                frames = grab_frames(fs, r, a, True, frame_count)
                r.pop("_video_url_ok", None); r.pop("_ffmpeg", None)
                has_video = any(os.path.basename(p).startswith("frame_") for p in frames)
                r["frames"] = frames
                r["frames_kind"] = "video" if has_video else ("cover" if frames else "none")
                frames_summary["with_video" if has_video else ("cover_only" if frames else "none")] += 1
                time.sleep(random.uniform(1.5, 4.0))   # 下载之间拟人停顿，别像批量爬虫
    else:
        for r in top:
            r["frames"] = []
            r["frames_kind"] = "off"

    print("采集：%s" % json.dumps(meta, ensure_ascii=False))
    print("画面：%s" % json.dumps(frames_summary, ensure_ascii=False))
    print("硬筛跳过：%s（阈值 文案≥%d 字 / 评论≥%d）" % (
        json.dumps(dropped, ensure_ascii=False), limits["minDescLen"], limits["minComments"]))
    print("去重后候选 %d 条，取前 %d" % (len(rows), len(top)))
    for i, r in enumerate(top, 1):
        print("%2d. [%s] %s" % (i, fmts(r["digg"]), r["desc"][:46]))
        print("    %s · %s · 赞%s 评%s 藏%s 转%s · %s" % (
            r["author"],
            ("%ss" % r["duration_s"]) if r["duration_s"] else "时长未知",
            fmts(r["digg"]), fmts(r["comment"]), fmts(r["collect"]), fmts(r["share"]),
            ("%.0f小时前" % r["age_h"]) if r["age_h"] < 900 else "时间未知"))
        print("    %s" % r["share_url"])

    os.makedirs(os.path.dirname(OUT_MD), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "frames": frames_summary, "rows": top, "dropped": dropped, "thresholds": limits}, f, ensure_ascii=False, indent=1)
    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("# 转发清单 %s\n\n" % datetime.now(CST).strftime("%Y-%m-%d %H:%M"))
        for i, r in enumerate(top, 1):
            f.write("### %s\n" % r["aweme_id"])
            f.write("- %s\n" % r["desc"])
            f.write("- %s · %ss · 赞%s 评%s 藏%s\n" % (r["author"], r["duration_s"], fmts(r["digg"]), fmts(r["comment"]), fmts(r["collect"])))
            f.write("- %s\n\n" % r["share_url"])
    print("\n清单 -> %s" % OUT_MD)


if __name__ == "__main__":
    main()
