#!/usr/bin/env node
/**
 * tools/doctor.mjs —— 环境体检（**纯 Node，不依赖 Python**）
 * ============================================================================
 * 为什么必须纯 Node：
 *   这是"装完插件第一件事"要跑的东西。可 Python 环境正是「装主依赖」要建的目标 ——
 *   如果 doctor 自己依赖 Python，用户第一次点它必然得到「Python 没装好」，
 *   那就成了鸡生蛋：不知道缺什么 → 不敢装 → 还是不知道缺什么。
 *
 *   所以：Node 侧能查的全在这里查；Python/venv 只是**其中一项**，缺了就报缺，
 *   不影响其他项（浏览器、家目录、Cookie、端口）照常检查。
 *
 * 用法:
 *   node tools/doctor.mjs            # 人看的
 *   node tools/doctor.mjs --json     # 机器读的（设置页 / douyin_doctor 用）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { homeDir, pluginDir, cookieFile, runtimeFile, profileDir } from '../lib/paths.mjs'
import { findBrowser, chromeDoctor } from '../lib/chrome.mjs'

const asJson = process.argv.includes('--json')
const items = []
const row = (item, state, detail = '', fix = '') => items.push({ item, state, detail, fix })

/* ── 1. 家目录 ── */
let home = ''
try {
  home = homeDir()
  row('家目录', 'ok', home)
} catch (e) {
  row('家目录', 'bad', String(e?.message ?? e), '设置环境变量 DOUYIN_HOME 指向一个可写目录')
}

/* ── 2. Node ── */
const nodeVer = process.versions.node
const major = Number(nodeVer.split('.')[0])
if (major >= 22) row('Node', 'ok', nodeVer)
else row('Node', 'bad', `${nodeVer}（需要 ≥22）`, '升级 Node 到 22 或更新')

/* ── 3. Python（只是其中一项，缺了不影响别的） ── */
const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
const pyProbe = spawnSync(pyCmd, ['--version'], { encoding: 'utf8' })
if (pyProbe.status === 0) {
  row('Python', 'ok', String(pyProbe.stdout || pyProbe.stderr || '').trim())
} else {
  row('Python', 'warn', '系统里没有 python',
    '点「② 装主依赖」会自动建 venv（需要机器上有 uv 或 python 3.10+）')
}

/* ── 4. venv（装依赖之后才有） ── */
if (home) {
  const venvPy = join(home, '.venv', 'Scripts', 'python.exe')
  const venvPyNix = join(home, '.venv', 'bin', 'python')
  if (existsSync(venvPy) || existsSync(venvPyNix)) {
    row('主依赖 venv', 'ok', existsSync(venvPy) ? venvPy : venvPyNix)
  } else {
    row('主依赖 venv', 'warn', '还没建',
      '点「② 装主依赖」—— 装 curl_cffi + httpx，约 30 秒。取候选/读评论/发私信都要它')
  }
}

/* ── 5. Cookie ── */
if (home) {
  const ck = cookieFile()
  let ok = false
  try { ok = existsSync(ck) && readFileSync(ck, 'utf8').trim().length > 0 } catch { ok = false }
  if (ok) row('Cookie（登录态）', 'ok', '已保存')
  else row('Cookie（登录态）', 'bad', '没有',
    '下面「抖音 Cookie / 登录」那块扫码，或粘一条浏览器 Cookie')
}

/* ── 6. 浏览器 ── */
const br = findBrowser()
if (br) row('浏览器', 'ok', br)
else row('浏览器', 'bad', '找不到 Chrome / Edge / Chromium',
  '装一个就行；装在特殊位置的话把完整路径写进环境变量 DOUYIN_BROWSER')

/* ── 7. CDP 端口 ── */
try {
  const d = await chromeDoctor()
  if (d.cdp_alive) row('无头浏览器', 'ok', `${d.cdp_port} 上已有实例（会自动复用）`)
  else row('无头浏览器', 'warn', `现在没在跑（下次需要时会在 ${d.cdp_port || '9334'} 起一个）`)
} catch (e) {
  row('无头浏览器', 'warn', String(e?.message ?? e), '跑一次取候选或发私信时会自动拉起')
}

/* ── 8. 关键文件 ── */
const pdir = pluginDir()
const need = ['index.js', 'client.js', 'lib/chrome.mjs', 'lib/paths.mjs',
  'tools/forward-pick.py', 'tools/im-send.mjs', 'tools/card-share.mjs',
  'tools/comment-api.mjs', 'tools/comment-mention-ui.mjs', 'tools/dy-signer.mjs']
const missing = need.filter((f) => !existsSync(join(pdir, f)))
if (missing.length) row('关键文件', 'bad', '缺 ' + missing.join(', '), '重新安装插件包')
else row('关键文件', 'ok', `${need.length} 个都在`)

/* ── 9. 人设（顺手报一下用的是哪层） ── */
if (home) {
  const mine = join(home, 'persona.md')
  if (existsSync(mine)) row('人设', 'ok', '用你自己写的那份（$DOUYIN_HOME/persona.md）')
  else if (existsSync(join(pdir, 'prompts', 'persona.md'))) row('人设', 'ok', '用插件自带那份')
  else if (existsSync(join(pdir, 'prompts', 'persona.default.md'))) row('人设', 'ok', '用默认中性人设')
  else row('人设', 'warn', '一份都没有', '插件包不完整，重装')
}

/* ── 汇总 ── */
const bad = items.filter((r) => r.state === 'bad')
const warn = items.filter((r) => r.state === 'warn')
const okAll = bad.length === 0

if (asJson) {
  console.log(JSON.stringify({ ok: okAll, items, must_fix: bad, warns: warn }, null, 2))
} else {
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' }
  for (const r of items) {
    console.log(`${icon[r.state] || '?'} ${r.item}：${r.detail}`)
    if (r.state !== 'ok' && r.fix) console.log(`      → ${r.fix}`)
  }
  console.log()
  console.log(`结果：${items.length - bad.length - warn.length} 项正常 / ${warn.length} 项待办 / ${bad.length} 项必须修`)
  if (bad.length) {
    console.log('先把标 ❌ 的修掉，再装依赖 / 跑值班。')
  } else if (warn.length) {
    console.log('没有硬伤。标 ⚠️ 的装完依赖、登完录就会自己变绿。')
  } else {
    console.log('全绿，可以跑值班了。')
  }
}
process.exitCode = okAll ? 0 : 1
