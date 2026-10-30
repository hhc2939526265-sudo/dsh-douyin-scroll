#!/usr/bin/env node
/**
 * tools/comment-sticker-harvest.mjs —— 从评论区接口里捞「平台贴纸」
 * ============================================================================
 * 为什么需要它：抖音的**图片评论**要账号灰度权限（新号往往没有），但**平台贴纸**
 * 走评论 publish 的 `sticker_id` 参数，不需要图片权限 —— 这才是新号真能发表情包的路。
 * 贴纸 id 只能从别人的评论数据里拿（DOM 抓不到），所以这里在页面上下文里翻
 * `/aweme/v1/web/comment/list/`（页面自己带 cookie / 签名），把带 sticker 的评论挖出来。
 *
 * 用法:
 *   node tools/comment-sticker-harvest.mjs --aweme <id> [--pages 3]
 *
 * 输出一行 JSON：
 *   { ok, aweme_id, pages, scanned, n, stickers: [ { sticker_id, uri, urls:[], from_cid } ] }
 * ⚠️ 只读，不发任何东西。
 */
import { openPage, sleep } from '../lib/chrome.mjs'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEME = String(argOf('--aweme', '')).trim()
const PAGES = Math.max(1, Math.min(6, Number(argOf('--pages', '3')) || 3))
const MAX_SAVE = Math.max(0, Math.min(30, Number(argOf('--max', '12')) || 12))
const INGEST = String(argOf('--ingest', '1')) !== '0'
const HOME = process.env.DOUYIN_DUTY_HOME || process.env.DOUYIN_HOME || join(homedir(), '.dsh', 'douyin-duty')
const INBOX = join(HOME, 'inbox')
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

/** 按文件头判扩展名（宿主 Read 图片要看后缀） */
function sniffExt(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return '.png'
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49) return '.gif'
  if (b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return '.webp'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return '.jpg'
  return '.bin'
}

/** 下载一张图到 inbox；返回本地路径（失败返回 ''） */
async function saveImage(url, tag = 'h') {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36', referer: 'https://www.douyin.com/' },
    })
    if (!r.ok) return ''
    const b = Buffer.from(await r.arrayBuffer())
    if (b.length < 1500) return ''
    const ext = sniffExt(b)
    if (ext === '.bin') return ''
    const name = `${tag}-${createHash('sha1').update(url).digest('hex').slice(0, 16)}${ext}`
    const p = join(INBOX, name)
    if (!existsSync(p)) { mkdirSync(INBOX, { recursive: true }); writeFileSync(p, b) }
    return p
  } catch { return '' }
}

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }

try {
  const c = await openPage()
  const chromed = c.status
  const cur = String(await c.ev('location.href') || '')
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
  }

  const js = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var PAGES = ${PAGES};
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
    function urlsOf(st, add){
      var keys = ['static_url','animate_url','animated_url','static_url_list','animated_url_list','url'];
      for (var i=0;i<keys.length;i++){
        var v = st[keys[i]];
        if (typeof v === 'string' && /^https?:/.test(v)) add(v);
        else if (Array.isArray(v)) for (var k=0;k<v.length;k++){
          if (typeof v[k] === 'string' && /^https?:/.test(v[k])) add(v[k]);
          else if (v[k] && typeof v[k].url === 'string') add(v[k].url);
        }
        else if (v && Array.isArray(v.url_list)) for (var m=0;m<v.url_list.length;m++){
          if (typeof v.url_list[m] === 'string' && /^https?:/.test(v.url_list[m])) add(v.url_list[m]);
        }
      }
    }
    var seen = {}, list = [], imgs = [], scanned = 0, pages = 0;
    function take(st, cid){
      if (!st || typeof st !== 'object') return;
      // ⚠️ 平台贴纸 id 是 19 位长整数：JSON 解析成 Number 会丢精度，必须优先用 id_str
      var sid = String(st.sticker_id || st.id_str || st.id || '').trim();
      if (!sid) return;
      var us = [];
      urlsOf(st, function(u){ if (us.indexOf(u) < 0) us.push(u) });
      if (!us.length) return;                      // 没图就没法审核，跳过
      if (seen[sid]) return;
      seen[sid] = 1;
      list.push({ sticker_id: sid, uri: String(st.uri || ''), urls: us.slice(0, 3), from_cid: String(cid || '') });
    }
    function takeImg(cm, cid){
      var il = cm && cm.image_list;
      if (!Array.isArray(il) || !il.length) return;
      for (var i=0;i<il.length;i++){
        var it = il[i] || {};
        var us = [];
        ['origin_url','download_url','thumb_url','owner_watermark_image','medium_url'].forEach(function(k){
          var v = it[k];
          if (v && Array.isArray(v.url_list)) for (var m=0;m<v.url_list.length;m++) if (typeof v.url_list[m] === 'string') us.push(v.url_list[m]);
        });
        if (!us.length) continue;
        imgs.push({ url: us[0], from_cid: String(cid || ''), nick: String((cm.user && cm.user.nickname) || '') });
      }
    }
    var cursor = 0;
    for (var p = 0; p < PAGES; p++) {
      var r = await fetch('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
        aweme_id: AWEME, count: '20', cursor: String(cursor), item_type: '0'
      })), { credentials:'include', headers:{ accept:'application/json' } });
      var t = await r.text();
      var j = null; try { j = JSON.parse(t) } catch(e) { j = null }
      if (!j) break;
      var cs = j.comments || [];
      scanned += cs.length; pages++;
      for (var i=0;i<cs.length;i++){
        take(cs[i].sticker, cs[i].cid);
        takeImg(cs[i], cs[i].cid);
        var rs = cs[i].reply_comment || [];
        for (var k=0;k<rs.length;k++) { take(rs[k].sticker, rs[k].cid); takeImg(rs[k], rs[k].cid) }
      }
      if (!j.has_more) break;
      var next = Number(j.cursor || 0);
      if (!next || next === cursor) break;
      cursor = next;
      await new Promise(function(res){ setTimeout(res, 600) });
    }
    return JSON.stringify({ ok:true, scanned: scanned, pages: pages, stickers: list, images: imgs.slice(0, 40) });
  })()`

  let res = null
  try { res = JSON.parse(await c.ev(js)) } catch { res = null }
  c.close()
  await sleep(200)
  if (!res) { out({ ok: false, error: '评论接口没返回可解析结果（可能未登录）', chrome: chromed }); process.exit(1) }

  // 落盘 + 入库（只有本地文件才能被 Read 审核，也只有本地文件能当图片发出去）
  let saved = []
  let ing = { added: 0, blocked: 0, pending: 0, dup: 0 }
  if (INGEST && MAX_SAVE > 0) {
    const cand = [
      ...(res.images || []).map((x) => ({ url: x.url, from_cid: x.from_cid })),
      ...(res.stickers || []).map((x) => ({ url: (x.urls || [])[0], from_cid: x.from_cid, sticker_id: x.sticker_id })),
    ].filter((x) => x.url)
    for (const it of cand.slice(0, MAX_SAVE)) {
      const p = await saveImage(it.url, 'cm')
      if (!p) continue
      const { addSticker } = await import('../lib/stickers.mjs')
      const r = addSticker(HOME, { url: p, thumb: p, kind: 'sticker', source: 'comment', name: '', aweme_id: AWEME })
      if (r.added) { saved.push(p); if (r.status === 'blocked') ing.blocked++; else ing.pending++; }
      else ing.dup++
    }
  }
  out({
    ok: true, aweme_id: AWEME, chrome: chromed, pages: res.pages, scanned: res.scanned,
    n: (res.stickers || []).length, images: (res.images || []).length,
    saved: saved.length, ingest: ing,
    stickers: res.stickers || [],
    files: saved.slice(0, 12),
    hint: saved.length ? '先用 Read 打开这些 files 看画面，再 douyin_sticker_review 决定 approve/block（没审的不能发）' : '这次没捞到能存的图',
  })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
  process.exit(1)
}
