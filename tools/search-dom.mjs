#!/usr/bin/env node
/**
 * tools/search-dom.mjs —— 按**关键词**去抖音搜索结果页抓视频（DOM 路线）
 * ============================================================================
 * 为什么要有这个：`forward-pick.py` 只拉「推荐流 3 页 + 热榜」，
 * 完全**不按关键词发请求** ⇒ 刷到什么全由这个小号的观看历史决定。
 * 结果是：老大设了 10 个关键词，实际永远只在刷小猫小狗（2026-10-25 反馈）。
 *
 * 搜索接口 `/aweme/v1/web/general/search/single/` 需要 a_bogus 签名，
 * 本机签名器不可用（`search_nil_type: verify_check`，data 恒为空）。
 * 但**搜索结果页本身是前端签好再发的** ⇒ 用无头 Chrome 打开页面、
 * 从 DOM 里把视频卡片扒下来，绕开签名。
 *
 * 用法:
 *   node tools/search-dom.mjs --kw 美食 --n 12
 *   node tools/search-dom.mjs --kw "deepseek教程" --n 8 --scroll 4
 *
 * 输出：一行 JSON
 *   { ok, keyword, n, scrolls, items:[{aweme_id, desc, author, digg_text, digg, cover, url}] }
 * ============================================================================
 */
import { sleep, openPage } from '../lib/chrome.mjs'

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const KW = String(argOf('--kw', '')).trim()
const N = Math.max(1, Math.min(Number(argOf('--n', '12')) || 12, 40))
const SCROLLS = Math.max(0, Math.min(Number(argOf('--scroll', '3')) || 0, 10))
const TIMEOUT_MS = Math.max(30_000, Math.min(Number(argOf('--timeout', '90000')) || 90_000, 240_000))

if (!KW) { out({ ok: false, error: '缺 --kw' }); process.exit(1) }

/** 页面里跑的解析：把所有 /video/<id> 链接的卡片拆成一条条 */
const EXTRACT_JS = (want) => `(function(){
  var want = ${JSON.stringify(want)};
  function txt(e){ return e ? ((e.innerText || '').replace(/\\s+/g,' ').trim()) : '' }
  function num(s){
    if (!s) return 0;
    var m = String(s).replace(/,/g,'').match(/([0-9]+(?:\\.[0-9]+)?)(万|w|W|亿)?/);
    if (!m) return 0;
    var v = parseFloat(m[1]);
    if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') v *= 10000;
    if (m[2] === '亿') v *= 100000000;
    return Math.round(v);
  }
  var seen = {}, out = [];
  var as = [].slice.call(document.querySelectorAll('a[href*="/video/"]'));
  for (var i = 0; i < as.length; i++) {
    var a = as[i];
    var m = /\\/video\\/(\\d{10,25})/.exec(a.getAttribute('href') || a.href || '');
    if (!m) continue;
    var id = m[1];
    if (seen[id]) continue;
    // 往上找到一个"像卡片"的容器（含图片、文字够长）
    var box = a, best = a;
    for (var up = 0; up < 6 && box; up++) {
      box = box.parentElement;
      if (!box) break;
      var t = txt(box);
      if (t.length >= 12) { best = box; if (box.querySelector('img')) break }
    }
    var t2 = txt(best);
    if (!t2) continue;
    // 作者：卡片里最像昵称的短文本（@ 开头优先）
    var author = '';
    var at = t2.match(/@([^\\s@]{1,20})/);
    if (at) author = at[1];
    // 点赞：卡片里带"万"或纯数字的短文本，取最大的那个
    var diggText = '', digg = 0;
    var cands = t2.match(/[0-9]+(?:\\.[0-9]+)?\\s*[万亿wW]?/g) || [];
    for (var k = 0; k < cands.length; k++) {
      var v = num(cands[k]);
      if (v > digg) { digg = v; diggText = cands[k].trim() }
    }
    var img = best.querySelector('img') || a.querySelector('img');
    var cover = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
    // 文案：把作者/数字那几段剪掉，剩下的最长一段
    var desc = t2.replace(/@[^\\s@]{1,20}/g, ' ').replace(/[0-9]+(?:\\.[0-9]+)?\\s*[万亿wW]?/g, ' ').trim();
    if (desc.length > 200) desc = desc.slice(0, 200);
    seen[id] = 1;
    out.push({ aweme_id: id, desc: desc, author: author, digg_text: diggText, digg: digg, cover: cover.slice(0, 400), url: 'https://www.douyin.com/video/' + id });
    if (out.length >= want) break;
  }
  return JSON.stringify(out);
})()`

async function main() {
  const c = await openPage()
  const { send, ev } = c
  const url = `https://www.douyin.com/search/${encodeURIComponent(KW)}?type=video`
  await send('Page.navigate', { url })
  await sleep(7000)
  // 搜索结果页偶尔先弹登录框/验证 —— 关掉再说
  try {
    await ev(`(function(){
      var btn=[].slice.call(document.querySelectorAll('div,span,button')).filter(function(e){
        var t=(e.innerText||'').trim(); return t==='取消'||t==='关闭'||t==='我知道了'
      });
      for (var i=0;i<btn.length;i++){ try{ btn[i].click() }catch(e){} }
      return btn.length;
    })()`)
  } catch { /* 没有弹层就算了 */ }

  let items = []
  for (let s = 0; s <= SCROLLS; s++) {
    try {
      const raw = await ev(EXTRACT_JS(N))
      const got = JSON.parse(raw || '[]')
      const have = new Set(items.map((x) => x.aweme_id))
      for (const it of got) if (!have.has(it.aweme_id) && it.desc) { items.push(it); have.add(it.aweme_id) }
    } catch { /* 这一屏解析失败不影响后面的 */ }
    if (items.length >= N) break
    await ev(`(function(){ window.scrollBy(0, 1600); return document.body.scrollHeight })()`)
    await sleep(1800)
  }

  // 封面/时长可能为空 —— 交给后面的证据包按 cover_only 处理，这里不编
  out({ ok: true, keyword: KW, n: items.length, scrolls: SCROLLS, url, items: items.slice(0, N) })
}

const guard = setTimeout(() => {
  out({ ok: false, keyword: KW, error: `搜索「${KW}」超时（${Math.round(TIMEOUT_MS / 1000)}s）` })
  process.exit(1)
}, TIMEOUT_MS)
main().then(() => clearTimeout(guard)).catch((e) => {
  clearTimeout(guard)
  out({ ok: false, keyword: KW, error: String((e && e.message) || e) })
  process.exit(1)
})
