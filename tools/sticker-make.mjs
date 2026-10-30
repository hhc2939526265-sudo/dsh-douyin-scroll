/**
 * tools/sticker-make.mjs —— 大肥鱼自己做表情包（2026-10-28 老大要求）
 * ============================================================================
 * 三种来源，都是"二创/原创"：
 *   ① 从视频里截一帧当表情（`--from-aweme <id> [--at 秒]`）—— 看到喜欢的画面就存下来；
 *   ② 拿现成图片/表情再加工（`--from-file <路径> [--caption 文字]`）—— 在别人的图上加自己的话；
 *   ③ 纯原创文字表情（`--text "文字"`）—— 黑底/白底大字，最像"自己做的"。
 *
 * 做出来的图进 `<HOME>/inbox/made-*.png`，并**自动登记进表情库**（status=pending）。
 * 🔴 审核仍归大肥鱼自己：Read 这张图 → douyin_sticker_review（approve 才允许发）。
 *
 * 用法：
 *   node tools/sticker-make.mjs --from-aweme 7699751419654924537 --at 3.2 --caption "就是这个表情"
 *   node tools/sticker-make.mjs --from-file <图片路径> --caption "笑死"
 *   node tools/sticker-make.mjs --text "老大～～" --bg '#20222b' --fg '#ffffff'
 * 输出：{ ok, file, key, status, hint }
 * ============================================================================
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DOUYIN_DUTY_HOME || process.env.DOUYIN_HOME || join(homedir(), '.dsh', 'douyin-duty')
const PLUGIN = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

const argOf = (name, dflt = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--') ? process.argv[i + 1] : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const out = (o) => { console.log(JSON.stringify(o, null, 2)); process.exit(o && o.ok ? 0 : 1) }

const FROM_AWEME = argOf('from-aweme')
const FROM_FILE = argOf('from-file')
const TEXT = argOf('text')
const CAPTION = argOf('caption')
const SIZE = Math.max(160, Math.min(Number(argOf('size', '480')) || 480, 800))
const AT = Math.max(0, Number(argOf('at', '1.5')) || 1.5)
const BG = argOf('bg', '#1f2028')
const FG = argOf('fg', '#ffffff')
const NAME = argOf('name', '')

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const outDir = join(HOME, 'inbox')
const outFile = join(outDir, `made-${stamp}.png`)

function findFfmpeg() {
  if (process.env.DOUYIN_FFMPEG) return process.env.DOUYIN_FFMPEG
  try {
    const base = join(HOME, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
    const f = readdirSync(base).find((x) => /^ffmpeg.*\.exe$/i.test(x))
    if (f) return join(base, f)
  } catch { /* 没装 */ }
  const w = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' })
  const p = String(w.stdout || '').split(/\r?\n/)[0].trim()
  return p || ''
}

function runFfmpeg(args) {
  const ff = findFfmpeg()
  if (!ff) return { ok: false, error: '找不到 ffmpeg（装了 imageio-ffmpeg 就有）' }
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) return { ok: false, error: `ffmpeg 失败：${String(r.stderr || '').slice(0, 300)}` }
  return { ok: true }
}

/** 文字自动换行（中文按字切；先把行数算好，再均分，避免最后一行只剩一个字） */
function wrapText(s, per, maxLines = 4) {
  const arr = Array.from(String(s || '').trim())
  if (!arr.length) return ''
  const lines = Math.min(maxLines, Math.max(1, Math.ceil(arr.length / Math.max(1, per))))
  const n = Math.ceil(arr.length / lines)
  const outArr = []
  for (let i = 0; i < arr.length; i += n) outArr.push(arr.slice(i, i + n).join(''))
  return outArr.slice(0, maxLines).join('\n')
}

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '').replace(/%/g, '\\%').replace(/\r?\n/g, '\\n')

/** 字体路径：ffmpeg 滤镜里 Windows 盘符冒号必须转义 */
const FONT = (existsSync('C:/Windows/Fonts/msyhbd.ttc') ? 'C\\:/Windows/Fonts/msyhbd.ttc' : 'C\\:/Windows/Fonts/msyh.ttc')

/** 把文字写进临时文件（drawtext 的 textfile 方式最稳，换行/标点都不炸） */
function textFile(content, tag = 'cap') {
  const p = join(outDir, `cap-${stamp}-${tag}.txt`)
  writeFileSync(p, String(content), 'utf8')
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

/** 给一张图加字幕（底部大字 + 描边），返回输出路径 */
function captionImage(src, dst, text) {
  const fs = Math.round(SIZE / 9)
  const wrapped = wrapText(text, Math.max(4, Math.floor((SIZE - 60) / fs)))
  const dt = [
    `drawtext=fontfile='${FONT}'`,
    `textfile='${textFile(wrapped, 'cap')}'`,
    `fontcolor=${FG}`, 'borderw=5', 'bordercolor=black@0.85',
    `fontsize=${fs}`, 'line_spacing=6',
    'x=(w-text_w)/2', 'y=h-text_h-24',
  ].join(':')
  return runFfmpeg([
    '-i', src,
    '-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE},${dt}`,
    '-frames:v', '1', dst,
  ])
}

async function frameFromAweme(awemeId, atSec) {
  const { openPage, sleep } = await import('file:///' + PLUGIN.replace(/\\/g, '/') + '/lib/chrome.mjs')
  const c = await openPage()
  try {
    await c.send('Page.navigate', { url: `https://www.douyin.com/video/${awemeId}` })
    // 等播放器真的起来（最大 30 秒）：宽度 > 200 且 readyState >= 2
    let ready = false
    for (let i = 0; i < 15; i++) {
      await sleep(2000)
      ready = await c.ev(`(function(){var vs=document.querySelectorAll('video');
        for(var i=0;i<vs.length;i++){var r=vs[i].getBoundingClientRect();if(r.width>200&&vs[i].readyState>=2)return true}
        return false})()`)
      if (ready) break
    }
    if (!ready) return { ok: false, error: '播放器没起来（30 秒内没有可用的 video）' }

    // 定位到目标时间点（暂停后 seek，等它真的到位）
    await c.ev(`(function(){var vs=document.querySelectorAll('video');var v=null;
      for(var i=0;i<vs.length;i++){var r=vs[i].getBoundingClientRect();if(r.width>200){v=vs[i];break}}
      if(!v)return 0; try{v.pause();v.currentTime=${atSec}}catch(e){} return 1})()`)
    for (let i = 0; i < 10; i++) {
      await sleep(600)
      const t = Number(await c.ev(`(function(){var vs=document.querySelectorAll('video');
        for(var i=0;i<vs.length;i++){var r=vs[i].getBoundingClientRect();if(r.width>200)return vs[i].currentTime||0}return -1})()`))
      if (Math.abs(t - atSec) < 0.6) break
    }
    await sleep(700)
    // 暂停后播放器会盖一层"播放按钮/控制条"，截图前先藏掉（只藏覆盖层，不动 video 本身）
    await c.ev(`(function(){
      var st=document.createElement('style');
      st.textContent='.xgplayer-play,.xgplayer-start,.xgplayer-controls,[class*=play-icon],[class*=playIcon],[class*=poster],.xgplayer-poster{display:none!important}';
      document.head.appendChild(st);
      var all=document.querySelectorAll('div,span,img');
      for(var i=0;i<all.length;i++){var e=all[i];if(e.querySelector&&e.querySelector('video'))continue;
        var cls=String(e.className||'');var r=e.getBoundingClientRect();
        if(r.width>140&&r.height>140&&/play|poster|cover|mask/i.test(cls)){e.style.setProperty('display','none','important')}}
      return 1})()`)
    await sleep(400)
    const rect = JSON.parse(await c.ev(`(function(){var vs=document.querySelectorAll('video');var v=null;
      for(var i=0;i<vs.length;i++){var r=vs[i].getBoundingClientRect();if(r.width>200){v=vs[i];break}}
      if(!v)return '{}'; var r=v.getBoundingClientRect(); var s=Math.min(r.width,r.height);
      return JSON.stringify({x:Math.round(r.x+(r.width-s)/2),y:Math.round(r.y+(r.height-s)/2),width:Math.round(s),height:Math.round(s)})})()`))
    if (!rect.width) return { ok: false, error: '拿不到视频区域' }
    const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } })
    if (!shot || !shot.data) return { ok: false, error: '截图失败' }
    mkdirSync(outDir, { recursive: true })
    const raw = join(outDir, `made-${stamp}-raw.png`)
    writeFileSync(raw, Buffer.from(shot.data, 'base64'))
    return { ok: true, file: raw }
  } finally {
    try { c.close() } catch { /* ignore */ }
  }
}

(async () => {
  mkdirSync(outDir, { recursive: true })
  let src = ''
  let mode = ''
  if (FROM_AWEME) {
    const got = await frameFromAweme(FROM_AWEME, AT)
    if (!got.ok) out({ ok: false, error: got.error })
    src = got.file
    mode = 'frame'
  } else if (FROM_FILE) {
    if (!existsSync(FROM_FILE)) out({ ok: false, error: `文件不存在：${FROM_FILE}` })
    src = FROM_FILE
    mode = 'rework'
  } else if (TEXT) {
    mode = 'text'
  } else {
    out({ ok: false, error: '要给来源：--from-aweme / --from-file / --text 三选一' })
  }

  let r
  if (mode === 'text') {
    const fs = Math.round(SIZE / 7)
    const wrapped = wrapText(TEXT, Math.max(3, Math.floor((SIZE - 80) / fs)), 3)
    const dt = [
      `drawtext=fontfile='${FONT}'`,
      `textfile='${textFile(wrapped, 'txt')}'`, `fontcolor=${FG}`, `fontsize=${fs}`, 'line_spacing=10',
      'x=(w-text_w)/2', 'y=(h-text_h)/2',
    ].join(':')
    r = runFfmpeg(['-f', 'lavfi', '-i', `color=c=${BG}:s=${SIZE}x${SIZE}:d=1`, '-vf', dt, '-frames:v', '1', outFile])
  } else if (CAPTION) {
    r = captionImage(src, outFile, CAPTION)
  } else {
    r = runFfmpeg(['-i', src, '-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`, '-frames:v', '1', outFile])
  }
  if (!r.ok) out({ ok: false, error: r.error, mode })

  // 登记进表情库（pending，等大肥鱼自己 Read 后审核）
  const { addSticker, stickerStats } = await import('file:///' + PLUGIN.replace(/\\/g, '/') + '/lib/stickers.mjs')
  const name = NAME || (mode === 'text' ? `自制文字：${String(TEXT).slice(0, 20)}` : (CAPTION ? `自制：${String(CAPTION).slice(0, 20)}` : `自制：${mode}`))
  const add = addSticker(HOME, { url: outFile, thumb: outFile, name, kind: 'sticker', source: 'made', aweme_id: FROM_AWEME || '' })

  out({
    ok: true, mode, file: outFile, key: add.key, status: add.status,
    stats: stickerStats(HOME),
    hint: '先用 Read 打开 file 看一遍画面（别瞎审），再 douyin_sticker_review 决定 approve / block 并打标签。',
  })
})().catch((e) => out({ ok: false, error: String(e?.message ?? e) }))
