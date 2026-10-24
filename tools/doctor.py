#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/doctor.py —— 环境体检（装完插件第一步跑这个）
============================================================================
输出一份人能直接照着修的清单：
  家目录 / Python / venv / Cookie / Node / 浏览器 / CDP 端口 / 必要脚本
每一项都是 ok / warn / bad，bad 会给出「怎么办」。

用法:
  python tools/doctor.py            # 人看的
  python tools/doctor.py --json     # 机器读的
============================================================================
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _home import home_dir, plugin_dir  # noqa: E402

try:
    for _s in (sys.stdout, sys.stderr):
        _s.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def row(name, state, detail="", fix=""):
    return {"item": name, "state": state, "detail": detail, "fix": fix}


def port_alive(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except Exception:
        return False


def find_browser() -> str:
    env = (os.environ.get("DOUYIN_BROWSER") or "").strip()
    if env and Path(env).exists():
        return env
    cands = []
    if sys.platform == "win32":
        for root in filter(None, [os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                                  os.environ.get("LOCALAPPDATA"), r"C:\Program Files",
                                  r"C:\Program Files (x86)", r"D:\Program Files"]):
            cands += [Path(root) / "Google/Chrome/Application/chrome.exe",
                      Path(root) / "Microsoft/Edge/Application/msedge.exe",
                      Path(root) / "Chromium/Application/chrome.exe"]
    elif sys.platform == "darwin":
        cands += [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                  Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")]
    else:
        cands += [Path(p) for p in ("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
                                    "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser")]
    for c in cands:
        try:
            if c.exists():
                return str(c)
        except Exception:
            pass
    return ""


def main() -> int:
    as_json = "--json" in sys.argv
    out = []

    # 1 家目录
    try:
        h = home_dir()
        out.append(row("家目录", "ok", str(h)))
    except Exception as e:
        out.append(row("家目录", "bad", str(e), "设置环境变量 DOUYIN_HOME 指向一个可写目录"))
        h = None

    # 2 Python
    out.append(row("Python", "ok", sys.version.split()[0]))

    # 3 venv
    if h:
        venv = h / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        if venv.exists():
            out.append(row("venv", "ok", str(venv)))
        else:
            out.append(row("venv", "bad", "还没建", "设置页点「装主依赖」，或跑 `python -m venv .venv` 后 pip install -r requirements.txt"))

    # 4 Cookie
    if h:
        ck = h / "douyin_cookie.txt"
        if ck.exists() and ck.read_text(encoding="utf-8", errors="replace").strip():
            out.append(row("Cookie（登录态）", "ok", "已保存"))
        else:
            out.append(row("Cookie（登录态）", "bad", "没有", "跑 `node tools/qr-login.mjs start` 扫码，或把浏览器 Cookie 粘到设置页"))

    # 5 Node
    node = shutil.which(os.environ.get("DOUYIN_NODE") or "node")
    out.append(row("Node", "ok", node) if node else row("Node", "bad", "找不到", "装 Node 22+"))

    # 6 浏览器
    br = find_browser()
    if br:
        out.append(row("浏览器", "ok", br))
    else:
        out.append(row("浏览器", "bad", "找不到 Chrome / Edge / Chromium",
                       "装一个，或把完整路径写进环境变量 DOUYIN_BROWSER"))

    # 7 CDP 端口
    alive = [p for p in range(9334, 9346) if port_alive(p)]
    if alive:
        out.append(row("CDP 端口", "ok", f"{alive[0]} 上已有无头 Chrome（会自动复用）"))
    else:
        out.append(row("CDP 端口", "warn", "现在没有在跑", "第一次跑脚本时会自动起一个，不用管"))

    # 8 关键脚本
    pdir = plugin_dir()
    need = ["index.js", "client.js", "lib/chrome.mjs", "lib/paths.mjs",
            "tools/forward-pick.py", "tools/im-send.mjs", "tools/card-share.mjs",
            "tools/comment-api.mjs", "tools/comment-mention-ui.mjs", "tools/dy-signer.mjs"]
    missing = [f for f in need if not (pdir / f).exists()]
    if missing:
        out.append(row("关键脚本", "bad", "缺 " + ", ".join(missing), "重新安装插件包"))
    else:
        out.append(row("关键脚本", "ok", f"{len(need)} 个都在"))

    bad = [r for r in out if r["state"] == "bad"]
    if as_json:
        print(json.dumps({"ok": not bad, "items": out}, ensure_ascii=False, indent=2))
    else:
        icon = {"ok": "✅", "warn": "⚠️ ", "bad": "❌"}
        for r in out:
            print(f"{icon.get(r['state'], '?')} {r['item']}: {r['detail']}")
            if r["state"] != "ok" and r["fix"]:
                print(f"      → {r['fix']}")
        print()
        print(f"结果：{len(out) - len(bad)} 项正常 / {len(bad)} 项要修")
        if bad:
            print("先把上面标 ❌ 的修掉，再跑值班。")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
