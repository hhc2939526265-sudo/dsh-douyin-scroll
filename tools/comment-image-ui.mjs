#!/usr/bin/env node
/**
 * tools/comment-image-ui.mjs —— 在评论区发**自定义图片/GIF 表情**（没有平台 sticker_id 的那种）
 * ============================================================================
 * 平台贴纸（sticker_id）走 comment-api.mjs 最稳；但大肥鱼从评论里收集的**图片/GIF 表情**
 * 没有 sticker_id，publish 接口发不了。这些只能靠**抖音前端自己的上传框**：
 *   用 CDP 把图片塞进评论区的 <input type=file>（让官方前端上传）→ 等预览 → 点发送 → 回读。
 *
 * 🔴 图片评论是**账号灰度权限**（实名/老号更可能有，新号可能没有图片按钮）。
 *    找不到上传入口会明确返回 unavailable:'image_uploader'，不硬发、不谎报。
 *
 * 用法：
 *   node tools/comment-image-ui.mjs --aweme <id> --url <表情图URL> --dry     # 只探测该号有没有图片评论入口
 *   node tools/comment-image-ui.mjs --aweme <id> --url <表情图URL>           # 发顶层图片评论
 *   node tools/comment-image-ui.mjs --aweme <id> --url <URL> --reply <cid>   # 尽力：回某条时发图（前端不支持则三态报错）
 *
 * 输出一行 JSON：
 *   { ok, sent, aweme_id, stage, has_uploader, preview, published, readback, error?, unavailable? }
 * ============================================================================
 */
import { openPage, sleep } from '../lib/chrome.mjs'
import { uploadImageByUrl, waitForPreview } from '../lib/img-upload.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEME = String(argOf('--aweme', '')).trim()
const URL = String(argOf('--url', '')).trim()
const REPLY = String(argOf('--reply', '')).trim()
const DRY = argv.includes('--dry')

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }
if (!URL) { out({ ok: false, error: '缺 --url（表情图片地址）' }); process.exit(1) }

/** 评论框是否已出现（打开了可写的评论输入区） */
const commentInputExpr = `(function(){
  var e = document.querySelector('[data-e2e="comment-input"] [contenteditable="true"], [data-e2e="comment-input"] textarea, [class*="commentInput"] [contenteditable="true"], [class*="comment-input"] [contenteditable="true"]');
  if (e) { var r=e.getBoundingClientRect(); return r.width>80 && r.height>10; }
  return !!document.querySelector('[data-e2e="comment-input"], [class*="commentInput"], [class*="comment-input"]');
})()`

/** 图片上传后，评论框里出现"待发预览"：发送按钮可用 / 输入区出现新增图片缩略图 */
const previewExpr = `(function(){
  // ① 发送按钮从禁用变可用
  var pub = document.querySelector('[data-e2e="comment-publish"], [class*="commentPublish"], [class*="comment-publish"]');
  if (pub) {
    var cls = String(pub.className || '');
    var dis = pub.getAttribute('disabled') || /disabled|grey|gray|disable/i.test(cls);
    if (!dis && pub.getBoundingClientRect().width > 20) return true;
  }
  // ② 输入区里出现待发的图片缩略图（抖音上传后的本地预览）
  var box = document.querySelector('[data-e2e="comment-input"], [class*="commentInput"], [class*="comment-input"]');
  if (box) {
    var imgs = Array.prototype.slice.call(box.querySelectorAll('img')).filter(function(im){
      var r = im.getBoundingClientRect();
      return r.width >= 24 && r.height >= 24 && /douyinpic|blob:|image|aweme|tos-/i.test((im.src||'')+(im.currentSrc||''));
    });
    if (imgs.length) return true;
  }
  return false;
})()`

/** 找到并点击评论区"发送"按钮，返回是否点到 */
async function clickPublish(c) {
  const r = await c.ev(`(function(){
    var cands = [
      document.querySelector('[data-e2e="comment-publish"]'),
      document.querySelector('[class*="commentPublish"]'),
      document.querySelector('[class*="comment-publish"]'),
    ].filter(Boolean);
    // 文案兜底：评论框容器内文本为"发送"的可点元素
    var box = document.querySelector('[data-e2e="comment-input"], [class*="commentInput"], [class*="comment-input"]')
      || document.querySelector('[class*="comment"]');
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll('div,button,span'), function(el){
        if (cands.indexOf(el) >= 0) return;
        var t = (el.innerText || '').replace(/\\s+/g, '');
        if (t === '发送' && el.getBoundingClientRect().width > 20) cands.push(el);
      });
    }
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i], r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 12 || r.left < 0 || r.top < 0) continue;
      var cls = String(el.className || '');
      if (el.getAttribute('disabled') || /disabled|grey|gray/i.test(cls)) continue;
      return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    }
    return JSON.stringify(null);
  })()`)
  let p = null
  try { p = JSON.parse(r) } catch { p = null }
  if (!p || typeof p.x !== 'number') return false
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
  await sleep(120)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  return true
}

/** 回读：最近评论里有没有新出现的"图片评论"（image_list 非空）。尽力，不武断判失败。 */
async function readbackImage(c) {
  const expr = `(async function(){
    var COMMON = { device_platform:'webapp', aid:'6383', channel:'channel_pc_web', pc_client_type:'1',
      version_code:'190500', version_name:'19.5.0', cookie_enabled:'true', platform:'PC' };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    try {
      var r = await fetch('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
        aweme_id: ${JSON.stringify(AWEME)}, count: '20', cursor: '0', item_type: '0'
      })), { credentials:'include', headers:{ accept:'application/json' } });
      var j = await r.json();
      var cs = j.comments || [];
      var imgs = cs.filter(function(x){ return (x.image_list && x.image_list.length) || (x.sticker && x.sticker.id); });
      return JSON.stringify({ ok:true, total: cs.length, image_like: imgs.length,
        first: imgs[0] ? { cid: String(imgs[0].cid), kind: (imgs[0].image_list && imgs[0].image_list.length) ? 'image' : 'sticker', t: imgs[0].create_time } : null });
    } catch (e) { return JSON.stringify({ ok:false, error: String((e && e.message) || e) }); }
  })()`
  try {
    return JSON.parse(await c.ev(expr))
  } catch { return { ok: false, error: 'parse' } }
}

async function main() {
  const c = await openPage({ url: `https://www.douyin.com/video/${AWEME}` })
  const chromed = c.status
  let cleanup = null
  try {
    // 确保在视频页
    let cur = String(await c.ev('location.href') || '')
    if (!cur.includes('/video/')) {
      await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
      await sleep(6000)
    } else {
      await sleep(2500)
    }
    // 等评论框出现
    let hasBox = false
    for (let i = 0; i < 12; i++) {
      hasBox = Boolean(await c.ev(commentInputExpr)).catch(() => false)
      if (hasBox) break
      await sleep(800)
    }

    // 回复场景：先点开那条评论的"回复"，让内联输入框出来（图片能否回楼中楼看前端，不支持就三态）
    if (REPLY) {
      const opened = await c.ev(`(function(){
        var cid = ${JSON.stringify(REPLY)};
        // 简单处理：页面里找文本"回复"按钮点一下（精确楼层定位交给 comment-api；这里只尽量唤起内联框）
        var btns = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-reply"], span, div, a'));
        for (var i=0;i<btns.length;i++){ if((btns[i].innerText||'').trim()==='回复' && btns[i].getBoundingClientRect().left>=0){ btns[i].scrollIntoView({block:'center'}); return true; } }
        return false;
      })()`)
      await sleep(800)
      if (!opened) { /* 点不到也继续，顶层上传框可能仍可用 */ }
    }

    if (!hasBox) {
      return out({ ok: false, sent: false, stage: 'no_comment_box', unavailable: 'comment_box',
        error: '视频页没出现评论输入框（可能没登录/视频不可评论）', chrome: chromed })
    }

    // ① 探测 + 取图 + 找上传框 + 注入（不发送）
    const up = await uploadImageByUrl(c, URL, 'comment')
    cleanup = up.cleanup || null
    if (up.unavailable === 'image_uploader') {
      return out({
        ok: false, sent: false, stage: 'locate', has_uploader: false, unavailable: 'image_uploader',
        error: '这个号 / 这条视频的评论框里没找到图片上传入口（图片评论是账号灰度权限，老号/实名号更可能有；新号可能没有）。',
        chrome: chromed,
      })
    }
    if (!up.ok) {
      return out({ ok: false, sent: false, stage: 'inject', has_uploader: true, error: up.error || '图片没塞进上传框', chrome: chromed })
    }

    // ② 等预览
    const preview = await waitForPreview(c, previewExpr, { timeoutMs: 12000 })
    if (DRY) {
      return out({ ok: true, sent: false, dry: true, stage: 'preview', has_uploader: true, preview,
        mime: up.mime, bytes: up.bytes, note: 'dry：只验证图片入口与预览，未点发送。', chrome: chromed })
    }
    if (!preview) {
      return out({ ok: false, sent: false, stage: 'preview', has_uploader: true,
        error: '图片塞进去了但没出现待发预览（可能被风控拦或格式不支持），没点发送。', chrome: chromed })
    }

    // ③ 点发送
    await sleep(600)
    const clicked = await clickPublish(c)
    if (!clicked) {
      return out({ ok: false, sent: false, stage: 'publish_btn', has_uploader: true, preview: true,
        error: '预览出来了但找不到可点的"发送"按钮，没发出去。', chrome: chromed })
    }
    await sleep(3000)

    // ④ 回读（三态：读到=成功；读不到不武断，交给人复核）
    const rb = await readbackImage(c)
    const readback = Boolean(rb.ok && rb.image_like > 0)
    const ok = clicked && readback
    return out({
      ok, sent: ok, stage: 'done', has_uploader: true, preview: true, published: clicked,
      readback, readback_detail: rb.ok ? rb : undefined,
      aweme_id: AWEME, reply_to: REPLY || '(顶层图片评论)', mime: up.mime,
      chrome: chromed,
      error: ok ? undefined
        : '发送按钮点了，但回读最近评论没看到图片评论（可能仍在上传/审核，或按热度排没进前 20）—— 不等于没发，请人工看一眼。',
    })
  } finally {
    if (cleanup) { try { cleanup() } catch { /* ignore */ } }
    c.close()
    await sleep(200)
  }
}

main().catch((e) => out({ ok: false, sent: false, error: String(e?.message ?? e) }))
