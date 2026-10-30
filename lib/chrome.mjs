/**
 * lib/chrome.mjs —— 插件里**唯一**的浏览器入口
 * ============================================================================
 * 为什么要有这个文件：
 *   2026-10-22 之前，9 个脚本各自写一份 `C:\Program Files\Google\Chrome\...` +
 *   各自的 `ensureChrome()` + 各自的 `new WebSocket(CDP)`。
 *   换台设备（Chrome 装在别的盘 / 只有 Edge）就全部静默失效。
 *
 * 这里统一做四件事：
 *   ① 找浏览器：DOUYIN_BROWSER → Chrome → Edge → Chromium（Windows / macOS / Linux 全试）
 *   ② 找端口：runtime.json 里记着就用它，否则从 9334 往上找空闲的（被占就换，别让用户改代码）
 *   ③ 起无头 Chrome（`--headless=new`，屏幕上无窗口），已起就复用
 *   ④ 连 CDP，给一个带 send/ev/close 的小客户端
 *
 * ⚠️ 规矩：`tools/` 下**任何**脚本都不许自己 `new WebSocket` 或写死 chrome.exe。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { profileDir, readRuntime, writeRuntime } from './paths.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────────────────── ① 找浏览器 ───────────────────────── */

const CANDIDATES = () => {
  const out = []
  const env = String(process.env.DOUYIN_BROWSER || '').trim()
  if (env) out.push(env)                                  // ① 用户显式指定，最高优先
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files', 'D:\\Program Files (x86)']
    for (const r of roots.filter(Boolean)) {
      out.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      out.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      out.push(join(r, 'Chromium', 'Application', 'chrome.exe'))
    }
    // 免安装版常见位置
    for (const r of roots.filter(Boolean)) out.push(join(r, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  return out
}

/** 找得到就返回绝对路径，找不到返回 ''（不抛，让 doctor 去报） */
export function findBrowser() {
  for (const p of CANDIDATES()) {
    try { if (p && existsSync(p)) return p } catch { /* 继续找 */ }
  }
  return ''
}

/* ───────────────────────── ② 找端口 ───────────────────────── */

const portFree = (port) => new Promise((res) => {
  const s = createServer()
  s.once('error', () => res(false))
  s.once('listening', () => s.close(() => res(true)))
  s.listen(port, '127.0.0.1')
})

const cdpAlive = async (port) => {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
}

/**
 * 决定用哪个端口：
 *   ① 环境变量 IM_CDP_PORT 优先（调试时手动指定）
 *   ② runtime.json 里记着的端口，且它上面已经有 CDP 在跑 ⇒ 直接复用
 *   ③ **扫 9334–9373，只要哪个端口上有 CDP 在跑、且是我们这个 profile ⇒ 复用**
 *      （2026-10-22 踩的坑：同一个 user-data-dir 不能起第二个 Chrome。
 *        如果只按"空闲端口"去挑，会挑到一个空端口然后起新实例 —— 新实例
 *        因为 profile 被占用直接退出，于是"60 秒连不上 CDP"。必须先找活着的。）
 *   ④ 都不行才找空闲端口起新的
 */
export async function pickPort() {
  const forced = Number(process.env.IM_CDP_PORT || 0)
  if (forced) return forced

  const remembered = Number(readRuntime().cdpPort || 0)
  if (remembered && await cdpAlive(remembered)) return remembered

  // ③ 扫一遍：有没有已经活着的 CDP（可能是别的脚本起的）
  for (let p = 9334; p < 9334 + 40; p++) {
    if (await cdpAlive(p)) {
      writeRuntime({ cdpPort: p })
      return p
    }
  }

  // ④ 没有活的，找一个空闲端口起新的
  for (let p = 9334; p < 9334 + 40; p++) {
    if (await portFree(p)) return p
  }
  throw new Error('9334–9373 全被占用了，找不到空闲的调试端口')
}

/* ───────────────────────── ③ 起无头 Chrome ───────────────────────── */

/**
 * 保证有一个可用的无头 Chrome。
 * @returns {{port:number, status:'reused'|'launched', browser:string}}
 */
export async function ensureChrome({ url = 'https://www.douyin.com/' } = {}) {
  const port = await pickPort()
  if (await cdpAlive(port)) {
    writeRuntime({ cdpPort: port })
    await maybeSeedCookies(port)
    return { port, status: 'reused', browser: readRuntime().browser || '' }
  }

  const browser = findBrowser()
  if (!browser) {
    throw new Error(
      '找不到可用的浏览器。装一个 Chrome / Edge / Chromium 就行；'
      + '装在特殊位置的话，把完整路径写进环境变量 DOUYIN_BROWSER。',
    )
  }

  const profile = profileDir()
  mkdirSync(profile, { recursive: true })

  const p = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', '--lang=zh-CN',
    url,
  ], { detached: true, stdio: 'ignore' })
  p.unref()

  for (let i = 0; i < 60; i++) {
    if (await cdpAlive(port)) {
      writeRuntime({ cdpPort: port, browser })
      await maybeSeedCookies(port)
      return { port, status: 'launched', browser }
    }
    await sleep(500)
  }
  throw new Error(`无头 Chrome 起来了但 ${port} 上连不上 CDP（60 秒超时）`)
}

/* ───────────────────────── ④ CDP 客户端 ───────────────────────── */

/**
 * 只在 `DOUYIN_SEED_COOKIE=1` 的进程里、把 douyin_cookie.txt 灌进当前浏览器。
 * 主浏览器（刷视频那轮）不会被调用 —— 它本来就登录着；只有并行回话那份新 profile 需要。
 */
let _seeded = false
async function maybeSeedCookies(port) {
  if (_seeded) return
  if (String(process.env.DOUYIN_SEED_COOKIE || '') !== '1') return
  _seeded = true
  try {
    const f = join(homedir(), '.dsh', 'douyin-duty', 'douyin_cookie.txt')
    const fallback = process.env.DOUYIN_HOME ? join(process.env.DOUYIN_HOME, 'douyin_cookie.txt') : ''
    const file = existsSync(f) ? f : (fallback && existsSync(fallback) ? fallback : '')
    if (!file) return
    const raw = readFileSync(file, 'utf8')
    const r = await seedCookies(port, raw)
    if (r && r.ok) console.error(`[chrome] 登录态已灌入回话 profile（${r.set}/${r.total} 条）`)
    else console.error(`[chrome] 灌 cookie 没成功：${JSON.stringify(r)}`)
  } catch (e) {
    console.error(`[chrome] 灌 cookie 出错（不影响启动）：${e?.message ?? e}`)
  }
}

/**
 * 连上页面，返回 { send, ev, close, port }。
 * `ev(expr)` 在页面里求值并返回值 —— 大部分脚本只用得到这个。
 */
export async function connectPage(port) {
  const usePort = Number(port) || (await pickPort())
  const list = await (await fetch(`http://127.0.0.1:${usePort}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('douyin'))
    || list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有可用的 page target（Chrome 起来了吗？）')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('连不上 CDP WebSocket')), { once: true })
  })
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pend.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await send('Page.enable')
  await send('Runtime.enable')

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 240))
    return r.result?.value
  }

  return {
    send, ev, port: usePort,
    close: () => { try { ws.close() } catch { /* 已经关了 */ } },
  }
}

/** 一步到位：确保 Chrome + 连上页面。脚本里最常用这个。 */
export async function openPage(opts = {}) {
  const { port, status, browser } = await ensureChrome(opts)
  const page = await connectPage(port)
  return { ...page, status, browser }
}

/**
 * ⭐ 把 `douyin_cookie.txt` 里的登录态灌进一个**新的** profile（2026-10-26）。
 *
 * 为什么要这个：回话要能和刷视频并行，就得有第二份浏览器 profile；而 Chrome 对
 * `Default\Network\Cookies` 是**独占打开**的，主浏览器在跑的时候根本拷不出来
 * （实测 Windows 直接报"正由另一进程使用"）。
 * 于是改成：新 profile 起来后，用 CDP 的 `Network.setCookie` 把 cookie 逐条写进去 —— 不碰被锁的文件。
 *
 * 只在 `DOUYIN_SEED_COOKIE=1` 且 profile 是 chat 那份时由 ensureChrome 调用。
 */
export async function seedCookies(port, rawCookie) {
  const raw = String(rawCookie || '').trim()
  if (!raw) return { ok: false, error: '没有 cookie 可灌' }
  const pairs = raw.split(/;\s*/).map((s) => s.trim()).filter(Boolean)
  const page = await connectPage(port)
  await page.send('Network.enable').catch(() => { /* 老版本可能不支持，下面逐条会报错 */ })
  let ok = 0; const failed = []
  const HOSTS = ['.douyin.com', '.iesdouyin.com']
  for (const kv of pairs) {
    const i = kv.indexOf('=')
    if (i <= 0) continue
    const name = kv.slice(0, i).trim()
    const value = kv.slice(i + 1)
    if (!name) continue
    let done = false
    for (const domain of HOSTS) {
      try {
        const r = await page.send('Network.setCookie', { name, value, domain, path: '/', secure: true, httpOnly: false, sameSite: 'None' })
        if (r && r.success !== false) { done = true; break }
      } catch (e) { /* 换下一个域再试 */ }
    }
    if (done) ok++; else failed.push(name)
  }
  page.close()
  return { ok: ok > 0, set: ok, failed: failed.slice(0, 10), total: pairs.length }
}

/* ───────────────────────── 体检（给 doctor 用） ───────────────────────── */

export async function chromeDoctor() {
  const browser = findBrowser()
  const remembered = Number(readRuntime().cdpPort || 0)
  const alive = remembered ? await cdpAlive(remembered) : false
  const port = alive ? remembered : await pickPort().catch(() => 0)
  return {
    browser: browser || '',
    browser_found: Boolean(browser),
    cdp_port: port,
    cdp_alive: alive,
    profile: profileDir(),
    env_override: String(process.env.DOUYIN_BROWSER || ''),
  }
}

export { homedir }
