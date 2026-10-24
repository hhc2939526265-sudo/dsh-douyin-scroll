#!/usr/bin/env node
/**
 * tools/dy-signer.mjs —— 自己实现的抖音 Web 签名器（**纯 Node + jsdom，不开浏览器**）
 *
 * 凭据从哪来：从一份开源签名器的 V8 字节码里读出的可读字符串还原的调用顺序：
 *   ① jsdom 建页面，head 里挂 <script src=...runtime_bundler... project-id="64">
 *   ② 依次把 7 个 SDK 用 vm.runInContext 灌进页面上下文
 *   ③ window.bdSlardar.init({bid:'douyin_web'})
 *   ④ window.bdms.init({aid:6383, pageId:1, paths:{include:[^/aweme/v1/ ...]}})
 *      （bdms 已被打过补丁：改写 URL 后会回调 window.__capUrl）
 *   ⑤ 造一个 XHR open+send，bdms 把 a_bogus 补进 URL → __capUrl 抓到
 *   ⑥ window.use("webSignUrl")(rel) 再补 uifid + timestamp + x-secsdk-web-signature
 *
 * 协议：NDJSON over stdin/stdout（和那个开源签名器一致，方便直接替换）。
 *   → {"id":1,"url":"/aweme/v1/...","cookies":{"ttwid":"...","UIFID_TEMP":"..."}}
 *   ← {"id":1,"ok":true,"signedUrl":"https://www.douyin.com/aweme/...&a_bogus=...","headers":{}}
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { homeDir } from '../lib/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homeDir()
const SIGNER_DIR = process.env.DY_SIGNER_DIR || join(HOME, 'signer')
const SDK_DIR = join(SIGNER_DIR, 'sdk')
const require = createRequire(join(SIGNER_DIR, 'noop.js'))
const { JSDOM } = require('jsdom')

const UA = process.env.DY_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const PLATFORM = process.env.DY_PLATFORM || 'Win32'
const LANG = process.env.DY_LANG || 'zh-CN'
const ORDER = ['webmssdk.js', 'secsdk-runtime.js', 'sdk-glue.js', 'bdms-signer.js', 'slardar.js', 'captcha-sdk.js', 'verifycenter.js']

const html = `<!doctype html><html><head>
<script src="https://lf-security.bytegoofy.com/obj/security-secsdk/runtime_bundler_34_v2.js" project-id="64" custom-report-host=""></script>
</head><body><div id="captcha_container"></div></body></html>`

let dom = null
let ctx = null

function boot() {
  dom = new JSDOM(html, {
    url: 'https://www.douyin.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window
  w.navigator.__proto__ = w.navigator.__proto__ // noop
  const define = (obj, k, fn) => { try { Object.defineProperty(obj, k, { get: fn, configurable: true }) } catch { /* ignore */ } }
  define(w.navigator, 'userAgent', () => UA)
  define(w.navigator, 'appVersion', () => UA.replace('Mozilla/', ''))
  define(w.navigator, 'platform', () => PLATFORM)
  define(w.navigator, 'language', () => LANG)
  define(w.navigator, 'languages', () => [LANG, LANG.split('-')[0] || 'zh'])
  define(w.navigator, 'vendor', () => 'Google Inc.')
  define(w.navigator, 'hardwareConcurrency', () => 8)
  define(w.navigator, 'deviceMemory', () => 8)
  define(w.navigator, 'webdriver', () => false)
  define(w.screen, 'width', () => 1920)
  define(w.screen, 'height', () => 1080)
  define(w.screen, 'colorDepth', () => 24)
  define(w, 'devicePixelRatio', () => 1)

  // 补 Node 那边的 Request/Response 等（glue/bdms 会用到）
  for (const k of ['Request', 'Headers', 'Response', 'AbortController', 'TextEncoder', 'TextDecoder', 'Blob', 'FormData', 'atob', 'btoa', 'fetch']) {
    if (globalThis[k] && w[k] === undefined) { try { w[k] = globalThis[k] } catch { /* ignore */ } }
  }

  // head 里那个 script 元素必须能被 document.currentScript / querySelector 找到
  const script = w.document.querySelector('script[src*="/obj/security-secsdk/runtime"]')
  if (script) Object.defineProperty(w.document, 'currentScript', { get: () => script, configurable: true })

  ctx = dom.window
  const context = vm.createContext(ctx) // 不是必须，用下面 getInternalVMContext
  return dom
}

function runInPage(code, filename) {
  try {
    vm.runInContext(code, dom.getInternalVMContext(), { filename, timeout: 60_000 })
    return true
  } catch (e) {
    console.log(`[signer] load ${filename} 失败：${String(e?.message ?? e).slice(0, 200)}`)
    return false
  }
}

function initSdks() {
  for (const f of ORDER) {
    const p = join(SDK_DIR, f)
    if (!existsSync(p)) { console.log('[signer] 缺文件 ' + p); continue }
    runInPage(readFileSync(p, 'utf8'), f)
  }
  const w = dom.window
  // slardar
  try { if (w.bdSlardar?.init) w.bdSlardar.init({ bid: 'douyin_web' }) } catch (e) { console.log('[signer] slardar init 失败：' + e.message) }
  // bdms
  try {
    w.bdms.init({
      aid: 6383,
      pageId: 1,
      paths: {
        include: [new RegExp('^/webcast/'), new RegExp('^/aweme/v1/'), new RegExp('^/aweme/v2/'), new RegExp('/douplus/')],
        exclude: [new RegExp('/aweme/v1/play/'), new RegExp('douyinvod\\.com')],
      },
    })
    console.log('[signer] bdms.init ok')
  } catch (e) {
    console.log('[signer] bdms.init 失败：' + String(e?.message ?? e).slice(0, 200))
  }
  // 抓 URL
  w.__capUrl = function (u) { w.__lastSignedUrl = u }
  console.log('[signer] verifySDK=' + typeof w.verifySDK + ' __ku=' + typeof w.__ku + ' webSignUrl=' + typeof (w.use && w.use('webSignUrl')))
}

function setCookies(cookies) {
  const w = dom.window
  for (const [k, v] of Object.entries(cookies || {})) {
    try { w.document.cookie = `${k}=${v}; path=/` } catch { /* ignore */ }
  }
}

async function signOne(url, cookies) {
  const w = dom.window
  setCookies(cookies)
  w.__lastSignedUrl = null
  let webId = ''
  try { webId = await w.verifySDK.getCaptchaWebId() } catch (e) { console.log('[signer] getCaptchaWebId 失败：' + String(e?.message ?? e).slice(0, 120)) }
  if (typeof w.__ku === 'function' && !w.__kuInstalled) {
    try {
      w.__ku({ getFp: () => String(webId), render: function () {}, xhrAsyncSend: undefined })
      w.__kuInstalled = true
    } catch (e) { console.log('[signer] __ku 失败：' + String(e?.message ?? e).slice(0, 120)) }
  }

  const xhr = new w.XMLHttpRequest()
  xhr.open('GET', url, true)
  try { xhr.send() } catch (e) { console.log('[signer] xhr.send 抛错：' + String(e?.message ?? e).slice(0, 160)) }

  const deadline = Date.now() + 8000
  while (Date.now() < deadline && !w.__lastSignedUrl) await new Promise((r) => setTimeout(r, 50))
  if (!w.__lastSignedUrl) return { err: 'no signed url captured' }

  let signed = w.__lastSignedUrl
  let rel = signed
  if (signed.indexOf('://') >= 0) { const parts = signed.split('/'); rel = '/' + parts.slice(3).join('/') }
  const ws = w.use('webSignUrl')(rel)
  const pathSigned = (ws && ws.url) || rel
  const origin = (signed.match(/^(https?:\/\/[^/]+)/) || [])[1] || 'https://www.douyin.com'
  return { signedUrl: origin + pathSigned, headers: (ws && ws.headers) || {} }
}

/* ─────────────── 主入口 ─────────────── */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/dy-signer.mjs')
if (isMain) {
  const argUrl = process.argv.slice(2).find((a) => !a.startsWith('--'))
  boot()
  initSdks()
  if (argUrl) {
    const cookies = JSON.parse(process.env.DY_COOKIES || '{}')
    signOne(argUrl, cookies).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0) }).catch((e) => { console.log('ERR ' + e.message); process.exit(1) })
  } else {
    console.log('[signer] ready（无参：只做自检）')
    process.exit(0)
  }
}
