#!/usr/bin/env python3
"""
tools/smoke.py —— 不依赖 DSH、不联网的**判断层自检**
============================================================================
用途：装进 DSH 之前，先确认「预筛 + 打分 + 证据包」这套判断逻辑是通的。

跑法（在插件根目录）：
    python tools/smoke.py

⚠️ 2026-10-21：以前这里 `import prescreen`（来自 vendor/douyin-mcp 的内置 MCP）。
   那套已经整个删了，所以这份自检改成**完全自包含**：规则直接照抄
   tools/forward-pick.py 里那一套，保证「自检看到的判断」和「真跑时的判断」是同一个口径。
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 与 forward-pick.py 保持一致的门槛
MIN_DESC_LEN = 12
MIN_COMMENTS = 3
MIN_DURATION_MS = 12_000          # <12 秒多半是模板 / 广告
MAX_DURATION_MS = 30 * 60_000     # >30 分钟太长
MAX_AGE_H = 24 * 30               # 超过一个月算旧

NEGATIVE_WORDS = ("被骗", "就这", "标题党", "白期待", "失望")
SELL_WORDS = ("好物", "链接在", "橱窗", "下单", "优惠券", "领券")


def line(ch: str = "─", n: int = 72) -> str:
    return ch * n


def stat(c: dict, k: str) -> int:
    s = c.get("stats") or {}
    try:
        return int(s.get(k) or 0)
    except Exception:
        return 0


def effective_text(c: dict) -> str:
    """去掉 #话题 之后还剩多少有效信息 —— 这是判断"有没有内容"的关键。"""
    desc = (c.get("desc") or "").strip()
    for t in (c.get("tags") or []):
        desc = desc.replace("#" + str(t), "")
    return desc.strip()


def drop_reason(c: dict) -> str | None:
    """先过筛：留下 None，丢弃给原因。"""
    desc = (c.get("desc") or "").strip()
    if not desc:
        return "没有文案"
    eff = effective_text(c)
    cm = stat(c, "comment")
    if len(eff) < MIN_DESC_LEN and cm < MIN_COMMENTS:
        return f"文案太短（有效 {len(eff)} 字）且评论少（{cm} 条）"
    dur = c.get("duration") or 0
    if dur and dur < MIN_DURATION_MS:
        return f"太短（{dur / 1000:.0f} 秒，多是模板 / 广告）"
    if dur and dur > MAX_DURATION_MS:
        return f"太长（{dur / 60000:.0f} 分钟）"
    if any(w in desc for w in SELL_WORDS):
        return "带货迹象"
    age = c.get("_age_hours")
    if age is not None and age > MAX_AGE_H:
        return f"太旧（{age / 24:.0f} 天前）"
    return None


def score(c: dict) -> tuple[int, int, float]:
    """和 forward-pick.py 同一套：综合互动 + 评论比我 + 新近度。"""
    d, cm, col, sh = stat(c, "digg"), stat(c, "comment"), stat(c, "collect"), stat(c, "share")
    inter = d + cm * 2 + col * 3 + sh * 2
    ratio = (cm / d) if d else 0.0
    s = float(inter)
    if 0.02 <= ratio <= 0.25:      # 评论/点赞在合理区间 ⇒ 有话说，不是纯刷到
        s *= 1.25
    age = c.get("_age_hours")
    if age is not None and age <= 72:
        s *= 1.15                  # 三天内的更新
    return int(s), inter, ratio


def packet(c: dict) -> dict:
    """模型**实际看到**的证据包（不是原始 JSON）"""
    d, cm, col, sh = stat(c, "digg"), stat(c, "comment"), stat(c, "collect"), stat(c, "share")
    cmts = sorted(c.get("comments") or [], key=lambda x: -(x.get("digg_count") or 0))[:3]
    neg = [w for w in NEGATIVE_WORDS if any(w in (x.get("text") or "") for x in cmts)]
    return {
        "aweme_id": c.get("aweme_id"),
        "作者": c.get("author"),
        "文案": (c.get("desc") or "")[:70],
        "有效正文长度": len(effective_text(c)),
        "时长": (f"{c.get('duration') / 1000:.0f} 秒" if c.get("duration") else "未知"),
        "年龄": (f"{c['_age_hours']:.0f} 小时前" if c.get("_age_hours") is not None else "未知"),
        "互动": f"赞 {d} · 评 {cm} · 藏 {col} · 转 {sh}",
        "比值": {
            "评/赞": round(cm / d, 4) if d else 0,
            "藏/赞": round(col / d, 4) if d else 0,
            "转/赞": round(sh / d, 4) if d else 0,
        },
        "高赞评论": [(x.get("text") or "")[:46] for x in cmts],
        "负面信号": neg,
    }


def main() -> int:
    sample = os.path.join(ROOT, "prompts", "sample-candidates.json")
    if not os.path.exists(sample):
        print(f"找不到示例数据：{sample}")
        return 1
    try:
        with open(sample, encoding="utf-8") as f:
            cands = json.load(f)
    except Exception as e:  # noqa: BLE001
        print(f"示例数据读不出来：{type(e).__name__}: {e}")
        return 1
    if isinstance(cands, dict):
        cands = cands.get("candidates") or []

    print(line("="))
    print(f"① 取候选：{len(cands)} 条（内置示例数据，不联网）")

    kept, dropped = [], []
    for c in cands:
        why = drop_reason(c)
        if why:
            dropped.append((c.get("aweme_id"), why))
        else:
            kept.append(c)

    print(line("="))
    print(f"② 代码层预筛：进 {len(cands)} → 留 {len(kept)}，丢 {len(dropped)}（**这一步不花 token**）")
    for aid, why in dropped:
        print(f"   · {aid} — {why}")

    scored = []
    for c in kept:
        s, inter, ratio = score(c)
        scored.append((s, inter, ratio, c))
    scored.sort(key=lambda x: -x[0])

    print(line("="))
    print("③ 打分排序（分 = 赞 + 评×2 + 藏×3 + 转×2，再乘评论比 / 新近度加权）")
    for s, inter, ratio, c in scored:
        print(f"   {s:>12,}  {c.get('aweme_id')}  {str(c.get('desc'))[:34]}")

    print(line("="))
    print("④ 证据包（模型**实际看到**的就是这个，不是原始 JSON）")
    for s, inter, ratio, c in scored[:3]:
        p = packet(c)
        print()
        print(f"   {p['aweme_id']}  {p['作者']}  {p['时长']}  {p['年龄']}")
        print(f"     文案（有效 {p['有效正文长度']} 字）：{p['文案']}")
        print(f"     互动：{p['互动']}")
        print(f"     比值：{p['比值']}")
        print(f"     负面信号：{p['负面信号'] or '无'}")
        for t in p["高赞评论"]:
            print(f"     [评论] {t}")

    print()
    print(line("="))
    print("⑤ 结论：判断层是通的。真正跑一轮时，模型拿这些证据 + 章程里的判据出结论，")
    print("   并且**必须引用具体证据**；证据不够就写「判断不了」。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
