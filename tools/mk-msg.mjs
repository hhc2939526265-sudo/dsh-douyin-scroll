#!/usr/bin/env node
/**
 * tools/mk-msg.mjs —— 把 forward-pick.json 拼成一条能直接发出去的私信正文
 * ============================================================================
 * ⚠️ 2026-10-21 修正：以前用 `https://www.douyin.com/video/<id>` —— 那是我拿 aweme_id
 *   **拼**出来的，不是抖音的分享链接。现在改用接口里的 `share_info.share_url`
 *   （带 share_sign 的官方分享链接，能正常唤起 App / 打开视频）。
 *
 * 官方分享链接一条 ~420 字，所以私信里只放前 N 条（默认 3），其余指向本地清单。
 *
 * 用法: node tools/mk-msg.mjs [top]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'

const HOME = homeDir()
const top = Math.max(1, Math.min(Number(process.argv[2] || 3), 5))

const picked = JSON.parse(readFileSync(join(HOME, 'forward-pick.json'), 'utf8'))
const rows = picked.rows || []
const fm = (n) => {
  n = Number(n) || 0
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}
const d = new Date()
const day = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const lines = [`【刷抖音·清单】${day}｜共 ${rows.length} 条，先给你 ${Math.min(top, rows.length)} 条`]
rows.slice(0, top).forEach((r, i) => {
  const desc = String(r.desc || '').replace(/\s+/g, ' ').slice(0, 34)
  lines.push(`${i + 1}. ${fm(r.digg)}赞 ${desc}`)
  lines.push(r.share_url)
})
if (rows.length > top) lines.push(`还有 ${rows.length - top} 条在本地 out/forward-*.md`)

const text = lines.join('\n')
const f = join(HOME, 'forward-msg.txt')
writeFileSync(f, text, 'utf8')
console.log(text)
console.log('\n--- 长度 =', text.length, '->', f)
