#!/usr/bin/env node
/**
 * tools/comment-verify.mjs —— 过一次「评论区发布要短信验证」的坎，然后让 UI 路径能真正发评论
 * ============================================================================
 * 2026-10-27 实测：在无头 Chrome 里点发布箭头，抖音会弹「接收短信验证码」——
 *   为确保是本人操作抖音账号，请输入当前手机号 191****34 收到的短信验证码。
 *   此时 /comment/publish 返回 200 **空 body**、输入框不清空 ⇒ 以前看起来"假成功"。
 *
 * 结论：这条账号在这台机器上要过一次短信验证才允许 UI 发评论。
 *       过完之后，点选 @ 弹层那条路才可能把 mention 实体交给服务端（这是唯一能真 @ 的路）。
 *
 * 用法：
 *   node tools/comment-verify.mjs --aweme <id> --request-code      # 弹窗并点「获取验证码」
 *   node tools/comment-verify.mjs --aweme <id> --code 123456       # 填码 → 验证 → 再点发布
 *   node tools/comment-verify.mjs --aweme <id> --status            # 只看当前有没有弹窗
 */
import fs from 'node:fs'
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEME = String(argOf('--aweme', '')).trim()
const CODE = String(argOf('--code', '')).trim()
const REQ = argv.includes('--request-code')
const STATUS = argv.includes('--status')
const TEXT = String(argOf('--text', '验证一下能不能发')).trim()
const SHOT = process.env.DOUYIN_SHOT || ''
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }
if (!AWEME) { out({ ok: false, error: '用法: --aweme <id> [--request-code | --code 123456 | --status]' }); process.exit(1) }

const c = await openPage()
const shot = async (tag) => {
  if (!SHOT) return
  try {
    const s = await c.send('Page.captureScreenshot', { format: 'png' })
    if (s && s.data) fs.writeFileSync(SHOT.replace(/\.png$/i, `-${tag}.png`), Buffer.from(s.data, 'base64'))
  } catch { /* 截图失败不影响主流程 */ }
}
const mv = (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
const click = async (x, y) => {
  await mv(x, y); await sleep(140)
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(60)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
/** 按可见文字找元素中心点（叶子优先、最窄优先） */
const byText = async (text, tag = '') => JSON.parse(await c.ev(`(function(){
  var T=${JSON.stringify(text)}; var best=null;
  document.querySelectorAll('button,div,span,a,li').forEach(function(e){
    var s=(e.innerText||'').trim(); if (s!==T) return;
    var r=e.getBoundingClientRect(); if(!(r.width>10&&r.height>10)) return;
    if (best && best.w<=r.width) return;
    best={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};
  });
  return JSON.stringify(best||{});
})()`))

await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
await sleep(9000)

const modalState = async () => JSON.parse(await c.ev(`(function(){
  var t=String(document.body.innerText||'');
  var need = t.indexOf('接收短信验证码')>=0 || t.indexOf('为确保是本人操作')>=0 || t.indexOf('请输入验证码')>=0;
  var m = t.match(/手机号\\s*(1\\d{2}\\*+\\d{2,4})/);
  var btn=null;
  document.querySelectorAll('button,div,span').forEach(function(e){
    if(String(e.innerText||'').trim()==='获取验证码'){ var r=e.getBoundingClientRect(); if(r.width>20&&!btn) btn={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} }
  });
  return JSON.stringify({ need_verify: need, phone_hint: m?m[1]:'', has_get_code: !!btn });
})()`))

let st = await modalState()
if (STATUS) { await shot('status'); c.close(); out({ ok: true, ...st }); }

/** 打开评论框 → 输入文字 → 点发布箭头（用来把验证弹窗叫出来 / 顺带真发一条） */
const tryPublish = async (text) => {
  const box = JSON.parse(await c.ev(`(function(){var e=document.getElementById('comment-input-container');if(!e)return '{}';e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`))
  if (!box.x) return { ok: false, error: '没有评论输入框' }
  await click(box.x, box.y); await sleep(1300)
  const ed = JSON.parse(await c.ev(`(function(){var e=document.querySelector('.public-DraftEditor-content');if(!e)return '{}';var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`))
  if (!ed.x) return { ok: false, error: '没有编辑器' }
  await click(ed.x, ed.y); await sleep(300)
  await c.send('Input.insertText', { text }); await sleep(900)
  const btn = JSON.parse(await c.ev(`(function(){var root=document.getElementById('comment-input-container');if(!root)return '{}';var svgs=root.querySelectorAll('svg');for(var i=0;i<svgs.length;i++){if(String(svgs[i].innerHTML||'').indexOf('FE2C55')<0)continue;var r=svgs[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}return '{}'})()`))
  if (!btn.x) return { ok: false, error: '没有发布箭头' }
  await click(btn.x, btn.y); await sleep(4200)
  return { ok: true }
}

if (REQ && !st.need_verify) {
  await tryPublish(TEXT)
  st = await modalState()
}

if (st.need_verify && !CODE) {
  // 打开弹窗 + 点「获取验证码」
  if (REQ && st.has_get_code) {
    const g = await byText('获取验证码')
    if (g.x) { await click(g.x, g.y); await sleep(2500) }
  }
  st = await modalState()
  await shot('need-code')
  c.close()
  out({ ok: false, verification_required: true, ...st, hint: '本次要过短信验证：--request-code 让它发码，然后 --code <收到的6位>' })
}

if (CODE) {
  // 先触发弹窗（点一次发布），再填码
  if (!st.need_verify) {
    const box = JSON.parse(await c.ev(`(function(){var e=document.getElementById('comment-input-container');if(!e)return '{}';e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`))
    if (box.x) { await click(box.x, box.y); await sleep(1300) }
    const ed = JSON.parse(await c.ev(`(function(){var e=document.querySelector('.public-DraftEditor-content');if(!e)return '{}';var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`))
    if (ed.x) { await click(ed.x, ed.y); await sleep(300) }
    await c.send('Input.insertText', { text: TEXT }); await sleep(900)
    const btn = JSON.parse(await c.ev(`(function(){var root=document.getElementById('comment-input-container');if(!root)return '{}';var svgs=root.querySelectorAll('svg');for(var i=0;i<svgs.length;i++){if(String(svgs[i].innerHTML||'').indexOf('FE2C55')<0)continue;var r=svgs[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}return '{}'})()`))
    if (btn.x) { await click(btn.x, btn.y); await sleep(4000) }
    st = await modalState()
  }
  if (!st.need_verify) { await shot('no-modal'); c.close(); out({ ok: false, error: '这次没弹验证码（可能已经验证过 / 或发布成功）—— 先看截图' }) }
  // 填码
  const inp = JSON.parse(await c.ev(`(function(){
    var es=document.querySelectorAll('input'); var best=null;
    for (var i=0;i<es.length;i++){ var e=es[i]; var ph=String(e.placeholder||'');
      if (ph.indexOf('验证码')<0) continue; var r=e.getBoundingClientRect(); if(!(r.width>40)) continue;
      best={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; }
    return JSON.stringify(best||{});
  })()`))
  if (!inp.x) { await shot('no-input'); c.close(); out({ ok: false, error: '弹了验证码但找不到输入框' }) }
  await click(inp.x, inp.y); await sleep(300)
  await c.send('Input.insertText', { text: CODE }); await sleep(600)
  const okBtn = await byText('验证')
  if (!okBtn.x) { await shot('no-verify-btn'); c.close(); out({ ok: false, error: '找不到「验证」按钮' }) }
  await click(okBtn.x, okBtn.y); await sleep(4000)
  await shot('after-code')
  const after = await modalState()
  const edAfter = String(await c.ev(`(function(){ var e=document.querySelector('.public-DraftEditor-content'); return e?String(e.innerText||'').slice(0,80):'(gone)'; })()`))
  c.close()
  out({ ok: true, verified: !after.need_verify, still_modal: after.need_verify, editor_after: edAfter, note: '验证过了就看 editor_after 有没有清空；清空 = 评论真的发出去并过审' })
}
c.close()
out({ ok: true, ...st })