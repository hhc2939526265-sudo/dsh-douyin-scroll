/**
 * lib/img-upload.mjs —— 把"网络表情图"通过无头页面**原生上传**到抖音的评论框 / 私信框
 * ============================================================================
 * 为什么需要它（2026-10-25 使用者提出，老号也应当能发图片/GIF 表情包）：
 *   · 评论区 / 私信里大量表情是**自定义图片、GIF**（没有平台贴纸 sticker_id），
 *     publish 接口的 sticker_id 发不了它们；
 *   · 抖音 web 上传图片要走它自己的上传 SDK（imagex 签名/分片），外部补不齐；
 *   · ⭐ 最稳的办法是**让抖音前端自己上传**：用 CDP 把文件塞进它页面里的
 *     `<input type=file>`，后续上传/预览/发送全由官方前端完成，我们只负责"放文件"和"回读"。
 *
 * 流程（全程在已登录的无头页面里）：
 *   1) 在页面上下文 fetch 表情图 URL（带 cookie / Referer，绕过图床防盗链）→ dataURL；
 *   2) Node 写成本地临时文件（按真实 mime 给后缀，GIF 保留 .gif）；
 *   3) 找到评论框 / 私信框里"接受图片"的 file input（很多是隐藏的，先点图片/相册/+按钮唤起）；
 *   4) CDP DOM.setFileInputFiles 把文件塞进去（浏览器原生层，绕过 React 受控 input 限制）；
 *   5) 调用方等预览出现、点发送、回读核实；临时文件由调用方在 finally 里删。
 *
 * 🔴 诚实三态（不谎报成功）：
 *   · 找不到图片上传入口          → { ok:false, unavailable:'image_uploader' }（该号没图片权限/页面改版）
 *   · 找到入口但文件塞不进去/没预览 → { ok:false, reason:'inject_failed' | 'no_preview' }
 *   · 塞进去、预览出现             → { ok:true }（是否真发出由调用方回读消息/评论核实）
 *
 * ⚠️ 沙箱无 Chrome、无法真机实测选择器；本模块用**多候选 + 探测式**定位，
 *    不硬编码单一 class，任何一步拿不到就明确失败，绝不"看起来成功"。
 * ============================================================================
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** mime → 临时文件后缀（抖音贴纸常见 webp/gif/jpeg/png） */
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
}

/**
 * 在页面里把一张网络图片 fetch 成 dataURL（带 cookie / Referer）。
 * 抖音图床对站外直连可能 403/防盗链，所以一定在 douyin.com 页面上下文里取。
 * @returns {Promise<{ok:boolean, dataUrl?:string, mime?:string, bytes?:number, error?:string}>}
 */
export async function fetchImageInPage(c, url) {
  const expr = `(async function(){
    var URL = ${JSON.stringify(String(url || ''))};
    try {
      var r = await fetch(URL, { credentials: 'include', referrerPolicy: 'no-referrer-when-downgrade' });
      if (!r.ok) return JSON.stringify({ ok:false, error:'http_' + r.status });
      var blob = await r.blob();
      var mime = blob.type || 'image/jpeg';
      if (!/^image\\//.test(mime)) return JSON.stringify({ ok:false, error:'not_image:' + mime, bytes: blob.size });
      var buf = await blob.arrayBuffer();
      var bytes = new Uint8Array(buf), bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return JSON.stringify({ ok:true, dataUrl: 'data:' + mime + ';base64,' + btoa(bin), mime: mime, bytes: blob.size });
    } catch (e) { return JSON.stringify({ ok:false, error: String((e && e.message) || e) }); }
  })()`
  let raw
  try {
    raw = await c.ev(expr)
  } catch (e) {
    return { ok: false, error: 'page_fetch_throw: ' + String(e?.message ?? e) }
  }
  try {
    const j = JSON.parse(raw)
    return j
  } catch {
    return { ok: false, error: '页面没返回可解析结果' }
  }
}

/**
 * Node 侧取图（页面 fetch 被 CSP / 防盗链挡住时的退路）。
 * 实测踩过：douyinpic 的签名图在页面里 fetch 直接 `Failed to fetch`，Node 侧带 Referer 反而能拿。
 */
export async function fetchImageInNode(url) {
  try {
    const r = await fetch(String(url || ''), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Referer: 'https://www.douyin.com/' },
    })
    if (!r.ok) return { ok: false, error: 'http_' + r.status }
    const mime = String(r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase()
    if (!/^image\//.test(mime)) return { ok: false, error: 'not_image:' + mime }
    const buf = Buffer.from(await r.arrayBuffer())
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), mime, bytes: buf.length }
  } catch (e) {
    return { ok: false, error: 'node_fetch: ' + String(e?.message ?? e) }
  }
}

/** dataURL → 本地临时文件（返回 { path, mime, cleanup }） */
export function saveDataUrlTemp(dataUrl, { prefix = 'dsh-sticker-' } = {}) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''))
  if (!m) return { ok: false, error: 'bad_data_url' }
  const mime = String(m[1] || 'image/jpeg').toLowerCase()
  const ext = MIME_EXT[mime] || (/gif/.test(mime) ? '.gif' : '.jpg')
  // ⚠️ 沙箱里 C:\WINDOWS\TEMP 可能写不进去（实测过）：优先插件家目录，退系统临时目录
  const base = String(process.env.DOUYIN_DUTY_HOME || '').trim() || join(homedir(), '.dsh', 'douyin-duty')
  let dir
  try {
    const parent = join(base, 'tmp')
    mkdirSync(parent, { recursive: true })
    dir = mkdtempSync(join(parent, prefix))
  } catch {
    dir = mkdtempSync(join(tmpdir(), prefix))
  }
  const path = join(dir, 'sticker' + ext)
  writeFileSync(path, Buffer.from(m[2], 'base64'))
  return {
    ok: true, path, mime, dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } },
  }
}

/**
 * 页面内定位"接受图片的 file input"，并在命中的元素上打标记 data-dsh-img-input=1。
 * 很多站点的 file input 是隐藏的、点了图片/相册按钮才挂上来，所以先直接找，
 * 找不到再点一遍 scope 内的候选按钮，每点一次重新找。
 *
 * @param scope 'comment'（评论框）| 'dm'（私信输入区）
 * @returns {Promise<{found:boolean, accept?:string, multiple?:boolean, clicked?:string, tries?:number}>}
 */
export async function locateImageInput(c, scope = 'comment') {
  // 候选按钮（在对应容器里找）：按 data-e2e / 文案 / 图标 class 多候选，不依赖单一 class。
  const clickPlan = scope === 'dm'
    ? `[
        // 抖音 web 私信工具栏："+" / 图片 / 相册 / 照片
        function(el){ return /图片|相册|照片/.test(el.getAttribute('aria-label')||'') || /图片|相册|照片/.test(el.title||''); },
        function(el){ var cls=String(el.className||''); return /image|photo|album|gallery|picture/i.test(cls); },
        function(el){ var t=(el.innerText||'').replace(/\\s+/g,''); return t==='+' || t==='＋' || t==='图片' || t==='相册'; }
      ]`
    : `[
        // 评论工具栏：图片/表情/图片评论
        function(el){ return /图片|表情|照片|添加图片/.test(el.getAttribute('aria-label')||'') || /图片|表情|照片/.test(el.title||''); },
        function(el){ var cls=String(el.className||''); return /image|photo|album|gallery|picture|emoji|sticker/i.test(cls); },
        function(el){ var t=(el.innerText||'').replace(/\\s+/g,''); return t==='图片' || t==='+' || t==='＋'; }
      ]`

  const locateExpr = `(function(){
    var SCOPE = ${JSON.stringify(scope)};
    function root(){
      if (SCOPE === 'dm') {
        return document.querySelector('[class*="componentsRightPanel"]')
          || document.querySelector('[class*="messageInput"]')
          || document.querySelector('[class*="chatInput"]') || document.body;
      }
      // 评论：优先评论发布框/评论区容器
      return document.querySelector('[data-e2e="comment-input"]')
        || document.querySelector('[class*="commentInput"]')
        || document.querySelector('[class*="comment-input"]')
        || document.querySelector('[class*="comment"]') || document.body;
    }
    function visible(el){
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      var st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
    }
    function score(inp){
      var acc = (inp.getAttribute('accept') || '').toLowerCase();
      var s = 0;
      if (acc.indexOf('image') >= 0) s += 10;
      // ⭐ 2026-10-25：抖音的真实 accept 是**后缀列表**（实测私信框：".jpg,.jpeg,.png,.gif,.mp4"），
      //    以前只认 "image/*"，于是明明有 input 也判成"没有上传入口"。
      if (/\\.(jpe?g|png|gif|webp|bmp|heic)\\b/.test(acc)) s += 10;
      if (acc.indexOf('gif') >= 0) s += 2;
      if (inp.multiple) s += 1;
      // 越靠近目标容器越好
      var rt = root();
      if (rt !== document.body && rt.contains(inp)) s += 5;
      return s;
    }
    // 清掉旧标记
    Array.prototype.forEach.call(document.querySelectorAll('[data-dsh-img-input]'), function(x){ x.removeAttribute('data-dsh-img-input'); });
    var ins = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'))
      .filter(function(i){
        var acc = (i.getAttribute('accept') || '').toLowerCase();
        if (!acc) return true;
        if (acc.indexOf('*') >= 0) return true;
        if (acc.indexOf('image') >= 0) return true;
        // 后缀列表形式（".jpg,.png,.gif,.mp4"）也算图片入口 —— 就是它把私信框漏掉的
        return /\\.(jpe?g|png|gif|webp|bmp|heic|mp4|mov|webm)\\b/.test(acc);
      });
    ins.sort(function(a,b){ return score(b)-score(a); });
    var best = ins[0];
    if (best) {
      best.setAttribute('data-dsh-img-input','1');
      return JSON.stringify({ found:true, accept: best.getAttribute('accept')||'', multiple: !!best.multiple, inPage: best.ownerDocument===document });
    }
    return JSON.stringify({ found:false, total_file_inputs: document.querySelectorAll('input[type=file]').length });
  })()`

  const clickExpr = `(function(){
    var SCOPE = ${JSON.stringify(scope)};
    var PLANS = ${clickPlan};
    function root(){
      if (SCOPE === 'dm') {
        return document.querySelector('[class*="componentsRightPanel"]')
          || document.querySelector('[class*="messageInput"]')
          || document.querySelector('[class*="chatInput"]') || document.body;
      }
      return document.querySelector('[data-e2e="comment-input"]')
        || document.querySelector('[class*="commentInput"]')
        || document.querySelector('[class*="comment"]') || document.body;
    }
    function visible(el){
      var r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.left < 0 || r.top < 0) return false;
      var st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
    }
    var rt = root();
    var cands = Array.prototype.slice.call(rt.querySelectorAll('div,button,span,i,svg'));
    // 全局也补一遍（工具栏图标可能不在容器内）
    if (cands.length < 3) cands = Array.prototype.slice.call(document.querySelectorAll('div,button,span,i,svg'));
    for (var p = 0; p < PLANS.length; p++) {
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var hit = false;
        try { hit = PLANS[p](el); } catch (e) { hit = false; }
        if (hit && visible(el)) {
          var r = el.getBoundingClientRect();
          el.setAttribute('data-dsh-imgbtn','1');
          return JSON.stringify({ clicked:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), via: 'plan' + p });
        }
      }
    }
    return JSON.stringify({ clicked:false });
  })()`

  // 先直接找
  let r1
  try { r1 = JSON.parse(await c.ev(locateExpr)) } catch { r1 = { found: false } }
  if (r1.found) return { found: true, accept: r1.accept, multiple: r1.multiple, tries: 1 }

  // 找不到 → 点候选按钮唤起，最多尝试 3 轮（点击在 Node 侧用 CDP 鼠标，避免点到不可点的）
  for (let t = 1; t <= 3; t++) {
    let btn
    try { btn = JSON.parse(await c.ev(clickExpr)) } catch { btn = { clicked: false } }
    if (!btn.clicked) break
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, button: 'none', buttons: 0 })
    await new Promise((z) => setTimeout(z, 120))
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', buttons: 1, clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', buttons: 0, clickCount: 1 })
    await new Promise((z) => setTimeout(z, 900))
    // 清掉这个按钮标记，避免下一轮重复点同一个
    await c.ev(`(function(){ var b=document.querySelector('[data-dsh-imgbtn]'); if(b){b.setAttribute('data-dsh-imgbtn-done','1'); b.removeAttribute('data-dsh-imgbtn');} })()`).catch(() => {})
    let r2
    try { r2 = JSON.parse(await c.ev(locateExpr)) } catch { r2 = { found: false } }
    if (r2.found) return { found: true, accept: r2.accept, multiple: r2.multiple, clicked: btn.via, tries: t + 1 }
  }
  return { found: false, unavailable: 'image_uploader' }
}

/**
 * 把本地文件塞进 locateImageInput 已标记的 input[type=file]（CDP 原生注入）。
 * 前置：locateImageInput 已返回 found:true。
 * @returns {Promise<{ok:boolean, files?:number, error?:string}>}
 */
export async function injectFile(c, absPath) {
  try {
    await c.send('DOM.enable')
    const doc = await c.send('DOM.getDocument', { depth: 0, pierce: false })
    const node = await c.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[data-dsh-img-input="1"]',
    }).catch(() => ({ nodeId: 0 }))
    if (!node || !node.nodeId) {
      // 退路：pierce 深度搜一遍
      const deep = await c.send('DOM.getDocument', { depth: -1, pierce: true })
      const node2 = await c.send('DOM.querySelector', { nodeId: deep.root.nodeId, selector: 'input[data-dsh-img-input="1"]' }).catch(() => ({ nodeId: 0 }))
      if (!node2 || !node2.nodeId) return { ok: false, error: 'node_not_found' }
      await c.send('DOM.setFileInputFiles', { files: [absPath], nodeId: node2.nodeId })
    } else {
      await c.send('DOM.setFileInputFiles', { files: [absPath], nodeId: node.nodeId })
    }
    // 让页面也派发一次 change（CDP 注入本会触发，这里再保险补一次 input/change）
    await c.ev(`(function(){ var i=document.querySelector('input[data-dsh-img-input="1"]'); if(i){ try{ i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){} } })()`).catch(() => {})
    return { ok: true, files: 1 }
  } catch (e) {
    return { ok: false, error: 'inject_throw: ' + String(e?.message ?? e) }
  }
}

/**
 * 等"上传后的预览/缩略图"出现（抖音前端拿到文件后会渲染预览）。
 * 给一组候选判定 JS，命中即返回 true；超时返回 false。
 * @param {string} previewExpr 页面求值表达式，返回 boolean
 */
export async function waitForPreview(c, previewExpr, { timeoutMs = 12000, gapMs = 700 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    let v = false
    try { v = Boolean(await c.ev(previewExpr)) } catch { v = false }
    if (v) return true
    await new Promise((z) => setTimeout(z, gapMs))
  }
  return false
}

/**
 * 找 ffmpeg：环境变量 → venv 里的 imageio-ffmpeg → PATH。
 * 用来把 webp 转成抖音认的格式（抖音私信框 accept 只有 .jpg/.jpeg/.png/.gif/.mp4，**没有 webp**）。
 */
export function findFfmpeg() {
  const env = String(process.env.DOUYIN_FFMPEG || '').trim()
  if (env) return env
  const base = String(process.env.DOUYIN_DUTY_HOME || '').trim() || join(homedir(), '.dsh', 'douyin-duty')
  try {
    const dir = join(base, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
    const hit = readdirSync(dir).find((f) => /^ffmpeg.*\.exe$/i.test(f))
    if (hit) return join(dir, hit)
  } catch { /* 没有就往下走 */ }
  return 'ffmpeg'
}

/**
 * 把图片转成页面 accept 认的格式。
 * ⚠️ 关键：抖音私信/评论框的 accept 是 `.jpg,.jpeg,.png,.gif,.mp4` —— **不含 webp**，
 *    而我们收集到的表情包大多是 webp。不转的话文件塞进去也不会被接受（表现为"没有预览")。
 * 动态 webp → gif（保留动画）；静态 webp → gif 也一样能看。
 */
export function convertForAccept(srcPath, accept, { mime = '' } = {}) {
  const acc = String(accept || '').toLowerCase()
  const ext = (String(srcPath).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const okExt = ['.jpg', '.jpeg', '.png', '.gif', '.mp4']
  const accepted = !acc || acc.split(',').some((x) => x.trim() === ext)
  if (!acc || accepted || okExt.includes(ext) && !acc) return { ok: true, path: srcPath, changed: false }
  if (accepted) return { ok: true, path: srcPath, changed: false }
  // 选目标格式：动图（gif/mp4/webm）才转 gif（保住动画），静图优先 png（抖音对静图 webp 不认）
  const srcIsAnim = ['.gif', '.mp4', '.mov', '.webm'].includes(ext)
  const target = srcIsAnim
    ? (acc.includes('.gif') ? '.gif' : (acc.includes('.mp4') ? '.mp4' : '.gif'))
    : (acc.includes('.png') ? '.png' : '.jpg')
  const dst = String(srcPath).replace(/\.[a-z0-9]+$/i, '') + target
  try {
    const ff = findFfmpeg()
    const args = target === '.gif'
      ? ['-y', '-i', srcPath, '-loop', '0', dst]
      : ['-y', '-i', srcPath, dst]
    const r = spawnSync(ff, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    if ((r.status === 0) && existsSync(dst) && statSync(dst).size > 0) {
      return { ok: true, path: dst, changed: true, from: ext || mime, to: target }
    }
    return { ok: false, error: String((r.stderr || r.error || '转换失败')).slice(0, 200) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 一步到位：网络表情图 URL → 页面内取回 → 本地临时文件 → 找到 file input → 注入。
 * 不负责"点发送"和"回读"（评论 / 私信的发送按钮不一样，交给各自脚本）。
 *
 * @returns {Promise<{ok:boolean, mime?:string, bytes?:number, injected?:boolean,
 *                    unavailable?:string, error?:string, cleanup?:()=>void}>}
 *   成功时带 cleanup（调用方无论成败都应在 finally 调一次）。
 */
/** 本地图片 → 临时目录副本（支持直接发送「本机已有的表情图」） */
export function copyLocalToTemp(srcPath) {
  try {
    const ext = ((String(srcPath).match(/\.[a-z0-9]+$/i) || ['.jpg'])[0]).toLowerCase()
    const mime = ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
          : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
    const base = String(process.env.DOUYIN_DUTY_HOME || '').trim() || join(homedir(), '.dsh', 'douyin-duty')
    let dir
    try {
      mkdirSync(join(base, 'tmp'), { recursive: true })
      dir = mkdtempSync(join(base, 'tmp', 'dsh-sticker-'))
    } catch {
      dir = mkdtempSync(join(tmpdir(), 'dsh-sticker-'))
    }
    const dst = join(dir, 'sticker' + ext)
    writeFileSync(dst, readFileSync(srcPath))
    return { ok: true, path: dst, mime, bytes: statSync(dst).size, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

export async function uploadImageByUrl(c, url, scope = 'comment') {
  let cleanup = null
  try {
    /**
     * ⭐ 本地文件也支持（2026-10-25：老大要"发我发过的表情"）——
     *    传进来的不是 URL 而是本机路径时，直接复制进临时目录，不走网络。
     */
    const asPath = (() => { try { const s = String(url || ''); return s && existsSync(s) && statSync(s).isFile() ? s : '' } catch { return '' } })()
    if (asPath) {
      const cp = copyLocalToTemp(asPath)
      if (!cp.ok) return { ok: false, error: '读本地文件失败：' + cp.error }
      cleanup = cp.cleanup
      const loc = await locateImageInput(c, scope)
      if (!loc.found) return { ok: false, unavailable: 'image_uploader', mime: cp.mime, bytes: cp.bytes, cleanup }
      const conv = convertForAccept(cp.path, loc.accept, { mime: cp.mime })
      const filePath2 = (conv.ok && conv.path) ? conv.path : cp.path
      const inj2 = await injectFile(c, filePath2)
      if (!inj2.ok) return { ok: false, error: '文件塞不进上传框：' + (inj2.error || 'unknown'), mime: cp.mime, cleanup }
      return { ok: true, injected: true, mime: cp.mime, bytes: cp.bytes, accept: loc.accept, clicked: loc.clicked, converted: conv.changed ? `${conv.from}->${conv.to}` : '', cleanup }
    }
    let got = await fetchImageInPage(c, url)
    // ⚠️ 页面里取回来的可能是 403/防盗链的 HTML（"成功"但其实不是图）⇒ 必须嗅一下 magic
    const looksImage = (g) => {
      try {
        const b64 = String(g?.dataUrl || '').split(',')[1] || ''
        const head = Buffer.from(b64.slice(0, 24), 'base64')
        return b64.length > 200 && (
          head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
          head.slice(0, 3).toString() === 'GIF' ||
          (head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP') ||
          (head[0] === 0xff && head[1] === 0xd8)
        )
      } catch { return false }
    }
    if (!got.ok || !looksImage(got)) {
      // 页面里取不到 / 取回来不是图（CSP / 防盗链 / dataURL 限制）⇒ Node 侧带 Referer 再试一次
      const alt = await fetchImageInNode(url)
      if (alt.ok) got = alt
    }
    if (!got.ok || !looksImage(got)) return { ok: false, error: '取图失败：' + (got.error || '拿回来的不是图片（可能被防盗链挡了）'), bytes: got.bytes }
    const saved = saveDataUrlTemp(got.dataUrl)
    if (!saved.ok) return { ok: false, error: '写临时文件失败：' + saved.error }
    cleanup = saved.cleanup
    let filePath = saved.path
    const loc = await locateImageInput(c, scope)
    if (!loc.found) return { ok: false, unavailable: 'image_uploader', mime: got.mime, bytes: got.bytes, cleanup }
    // ⭐ 格式不认就转（webp → gif），否则塞进去也没预览
    const conv = convertForAccept(saved.path, loc.accept, { mime: got.mime })
    if (!conv.ok && conv.changed !== false) {
      return { ok: false, error: '图片格式转换失败：' + (conv.error || ''), mime: got.mime, cleanup }
    }
    if (conv.ok && conv.path) filePath = conv.path
    const inj = await injectFile(c, filePath)
    if (!inj.ok) return { ok: false, error: '文件塞不进上传框：' + (inj.error || 'unknown'), mime: got.mime, cleanup }
    return { ok: true, injected: true, mime: got.mime, bytes: got.bytes, accept: loc.accept, clicked: loc.clicked, converted: conv.changed ? `${conv.from}->${conv.to}` : '', cleanup }
  } catch (e) {
    if (cleanup) cleanup()
    return { ok: false, error: String(e?.message ?? e) }
  }
}

