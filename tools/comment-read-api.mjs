#!/usr/bin/env node
/**
 * tools/comment-read-api.mjs —— 在**页面上下文**里读评论区（不依赖外部签名器）
 * ============================================================================
 * 为什么需要它：
 *   · `tools/api-comments.py` 走的是「外部签名器 + HTTP」，签名器坏了就整条读不到；
 *   · `tools/comment-read-dom.mjs` 走的是「打开视频页 + 滚屏抓 DOM」，可现在抖音会给这种
 *     直链访问弹「验证码中间页」（实测 title=`验证码中间页`、评论 0 条），等于白跑；
 *   · 而**页面自己发起的 fetch** 带 cookie、带页面上下文，不需要 a_bogus —— 我们捞贴纸/
 *     发评论一直是这么干的（`tools/comment-sticker-harvest.mjs` 就是这套）。
 *   所以这里把「读评论」也搬到页面上下文：先确保停在 douyin.com 的正常页面（首页），
 *   再用同源 fetch 翻 `/aweme/v1/web/comment/list/`。
 *
 * 用法:
 *   node tools/comment-read-api.mjs --aweme <id> [--pages 2] [--limit 40]
 *
 * 输出一行 JSON：
 *   { ok, aweme_id, pages, scanned, items:[{cid,nick,text,digg,is_reply}],
 *     pinned:<0|1>, note }
 * ⚠️ 只读，不发任何东西。
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEME = String(argOf('--aweme', '')).trim()
const PAGES = Math.max(1, Math.min(8, Number(argOf('--pages', '2')) || 2))
const LIMIT = Math.max(1, Math.min(200, Number(argOf('--limit', '40')) || 40))
// ⚠️ 必须显式 process.exit：CDP 的 websocket 会让事件循环一直活着，
//    从 python（subprocess.run 等 EOF）里调就会"输出完了却不退出" ⇒ 白等到超时。
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exit(o.ok ? 0 : 1) }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }

function cookieNames() {
  return 'ok'
}

try {
  const c = await openPage()

  /** 当前页面是不是抖音的验证码/拦截中间页 */
  const pageState = async () => {
    const j = await c.ev(`(function(){
      var desc = document.querySelector('[data-e2e="video-desc"]');
      var h1 = document.querySelector('h1');
      return JSON.stringify({
        url: location.href,
        title: document.title || '',
        desc: (desc && desc.innerText) || (h1 && h1.innerText) || '',
        body: (document.body ? document.body.innerText : '').slice(0, 200)
      });
    })()`)
    let st = {}
    try { st = JSON.parse(String(j || '{}')) } catch { st = {} }
    const blob = `${st.title} ${st.desc} ${st.body}`
    const captcha = /验证码中间页|安全验证|滑块|请完成验证|访问过于频繁/.test(blob)
    const onDouyin = /douyin\.com/.test(String(st.url || ''))
    return { ...st, captcha, onDouyin }
  }

  let ps = await pageState()
  if (!ps.onDouyin || ps.captcha) {
    // 首页是"正常页面"概率最高的入口；先在首页待一会儿再发同源请求
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
    ps = await pageState()
    if (ps.captcha) {
      out({ ok: false, aweme_id: AWEME, reason: 'captcha_interstitial', error: '抖音把浏览器拦在「验证码中间页」上了，读不到评论', title: ps.title })
      process.exit(1)
    }
  }
  cookieNames()

  const js = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var PAGES = ${PAGES};
    var LIMIT = ${LIMIT};
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    function one(cm, rootCid){
      var u = cm.user || {};
      var t = String(cm.text || '');
      return {
        cid: String(cm.cid || ''),
        nick: String(u.nickname || ''),
        uid: String(u.uid || ''),
        text: t,
        digg: Number(cm.digg_count || 0),
        is_reply: rootCid ? true : Boolean(cm.reply_id && cm.reply_id !== '0'),
        reply_to_cid: String(cm.reply_id || ''),
        root_cid: String(rootCid || '')
      };
    }
    var items = [], seen = {}, cursor = 0, pages = 0, scanned = 0, status = 0;
    for (var p = 0; p < PAGES; p++) {
      var r = await fetch('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
        aweme_id: AWEME, count: '20', cursor: String(cursor), item_type: '0'
      })), { credentials:'include', headers:{ accept:'application/json' } });
      status = r.status;
      var j = null;
      try { j = await r.json() } catch(e) { j = null }
      if (!j) break;
      var cs = j.comments || [];
      scanned += cs.length; pages++;
      for (var i=0;i<cs.length && items.length<LIMIT;i++){
        var cm = cs[i] || {};
        var cid = String(cm.cid || '');
        if (cid && !seen[cid]) { seen[cid] = 1; items.push(one(cm, '')) }
        var rs = cm.reply_comment || [];
        for (var k=0;k<rs.length && items.length<LIMIT;k++){
          var rc = rs[k] || {};
          var rcid = String(rc.cid || '');
          if (rcid && !seen[rcid]) { seen[rcid] = 1; items.push(one(rc, cid)) }
        }
      }
      if (!j.has_more) break;
      cursor = Number(j.cursor || 0) || (cursor + 20);
      await new Promise(function(go){ setTimeout(go, 900) });
    }
    return JSON.stringify({ items: items, pages: pages, scanned: scanned, status: status });
  })()`

  const raw = await c.ev(js)
  let r = {}
  try { r = JSON.parse(String(raw || '{}')) } catch { r = {} }
  const items = Array.isArray(r.items) ? r.items : []
  out({
    ok: items.length > 0,
    aweme_id: AWEME,
    via: 'page-fetch',
    pages: r.pages || 0,
    scanned: r.scanned || 0,
    http: r.status || 0,
    total: items.length,
    items,
    note: items.length
      ? `页面上下文直接读到了 ${items.length} 条评论（不依赖外部签名器）`
      : '接口返回 0 条 —— 可能是这条视频关了评论，或者页面还没登录',
  })
} catch (e) {
  out({ ok: false, aweme_id: AWEME, error: String((e && e.message) || e) })
}
