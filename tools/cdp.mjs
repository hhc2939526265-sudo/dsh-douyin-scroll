#!/usr/bin/env node
/**
 * tools/cdp.mjs —— 直接跟 bb-browser 那个 Chrome 说 CDP，绕开所有引号转义问题
 *
 * 用法：
 *   node tools/cdp.mjs <js文件> [--port 9222] [--tab <tabId>]
 *
 * 为什么不用 `bb-browser eval`：PowerShell 会把 JS 里的双引号吃掉，
 * 那个 Chrome 里跑的是**已经登录的抖音页面**，页面自己的 fetch 会被 secsdk 补上签名 ——
 * 只有这样才可能把写接口打穿。
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const PORT = argOf('--port', '9222')
const TAB = argOf('--tab', '')

const expr = readFileSync(file, 'utf8')

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const pages = list.filter((t) => t.type === 'page')
const target = TAB ? pages.find((p) => p.id.includes(TAB) || p.url.includes(TAB)) : pages.find((p) => p.url.includes('douyin')) || pages[0]
if (!target) { console.error('没有可用的 page target'); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id
  pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})

ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch { return }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})

ws.addEventListener('open', async () => {
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      console.log('❌ 页面里抛错：', JSON.stringify(r.exceptionDetails).slice(0, 600))
    } else {
      const v = r.result?.value
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
    }
    ws.close()
    process.exitCode = 0
  } catch (e) {
    console.error('CDP 失败：', e?.message ?? e)
    process.exitCode = 1
  }
})

ws.addEventListener('error', (e) => { console.error('WS 错误', e?.message ?? e); process.exitCode = 1 })
