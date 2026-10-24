/**
 * lib/tastes.mjs —— 大肥鱼的「口味画像」（它自己刷视频学到的偏好）
 * ============================================================================
 * 为什么要有（2026-10-24 使用者要求）：
 *   这个插件不是"替老大筛选的秘书"，而是**让 DSH 自己刷、自己学习、慢慢养出审美**的
 *   拟人账号。它刷过的视频里，哪些标签/作者/类型让它觉得"好看、想转发、想评论"，
 *   要沉淀下来，下一轮带着这些偏好去刷——**越刷越知道自己喜欢什么**。
 *
 * 怎么运转（刻意做成"追加一行 + 宿主聚合"，稳）：
 *   · 值班轮的大肥鱼，每发现一条"真的打动我"的视频，就往 `tastes-inbox.jsonl`
 *     **追加一行 JSON**（跟写 seen.md 一样，只追加、不覆盖）。
 *   · 宿主在**下一轮启动前**调 summarizeTaste() 聚合成画像，把摘要喂给模型。
 *   · 纯 jsonl 追加：即使模型某行写坏了，聚合时跳过坏行即可，不影响整体。
 *
 * 状态文件：`$DOUYIN_HOME/tastes-inbox.jsonl`（只存本机，不进仓库 / 报告）。
 * 每行形状：
 *   {"at":"2026-10-24T12:00:00Z","kind":"实用","tag":"美食","author":"昵称",
 *    "why":"收藏/点赞 0.21，高赞都在求配方，我也想学着做","aweme_id":"..."}
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_TASTES = 600      // 只保留最近 600 条观察，画像不无限膨胀
const MAX_TAG = 12
const MAX_RECENT = 12
const MAX_WHY = 80

export function tasteInboxFile(home) {
  return join(home, 'tastes-inbox.jsonl')
}

/** 读全部观察（逐行容错：坏行跳过，不报错给上层） */
export function loadTasteItems(home) {
  let raw = ''
  try { raw = readFileSync(tasteInboxFile(home), 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

const normToken = (s) => String(s || '').trim().replace(/[#＃\s]+/g, '').slice(0, 20)
const tally = (items, pick, min = 1) => {
  const m = new Map()
  for (const it of items) {
    const v = pick(it)
    if (!v) continue
    m.set(v, (m.get(v) || 0) + 1)
  }
  return [...m.entries()]
    .map(([name, n]) => ({ name, n }))
    .filter((x) => x.n >= min)
    .sort((a, b) => b.n - a.n)
}

/** 追加一条观察；宿主内部用（值班轮模型也可直接往 jsonl 追加一行，等价） */
export function appendTaste(home, item = {}) {
  const why = String(item.why || '').trim().slice(0, MAX_WHY)
  const tag = normToken(item.tag)
  const author = normToken(item.author)
  const kind = normToken(item.kind)
  const awemeId = String(item.aweme_id || '').trim().slice(0, 32)
  if (!why && !tag && !kind) return { ok: false, error: '观察太空（至少给 tag / kind / why 之一）' }
  const row = { at: new Date().toISOString(), kind: kind || '', tag: tag || '', author: author || '', why, aweme_id: awemeId }
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(tasteInboxFile(home), JSON.stringify(row) + '\n', 'utf8')
    // 裁剪：超过上限只留最近的
    const items = loadTasteItems(home)
    if (items.length > MAX_TASTES) {
      writeFileSync(tasteInboxFile(home), items.slice(-MAX_TASTES).map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
    }
    return { ok: true, total: loadTasteItems(home).length }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/** 聚合画像：类型分布、常看标签、常看作者、最近学到的 */
export function summarizeTaste(home) {
  const items = loadTasteItems(home)
  const count = items.length
  const kinds = tally(items, (x) => x.kind || '').slice(0, MAX_TAG)
  const tags = tally(items, (x) => x.tag || '').slice(0, MAX_TAG)
  const authors = tally(items, (x) => x.author || '').slice(0, 8)
  const recent = items.slice(-MAX_RECENT).reverse()
  return { count, kinds, tags, authors, recent }
}

/** 生成可直接注入值班轮提示词的中文画像摘要；还没学到东西时返回空串 */
export function tasteProfileText(home) {
  const p = summarizeTaste(home)
  if (!p.count) return ''
  const line = (arr) => arr.length ? arr.map((x) => `${x.name}×${x.n}`).join('、') : '（还没攒够）'
  const whyLines = p.recent
    .filter((x) => x.why)
    .slice(0, 6)
    .map((x, i) => `${i + 1}. ${x.tag ? `【${x.tag}】` : ''}${x.why}`)
    .join('\n  ')
  return [
    '🐟 你目前的口味画像（这是你自己刷视频一点点攒下来的，不是别人给的设定）：',
    `  · 已记录 ${p.count} 条「让你心动」的观察；`,
    `  · 你偏好的类型：${line(p.kinds)}；`,
    `  · 你常停留的标签：${line(p.tags)}；`,
    p.authors.length ? `  · 你常看的作者：${line(p.authors)}；` : '  · 还没攒出固定常看的作者；',
    whyLines ? `  · 最近学到的：\n  ${whyLines}` : '',
  ].filter(Boolean).join('\n')
}

/** 清空口味画像（设置页"重置口味"时用） */
export function resetTastes(home) {
  try {
    writeFileSync(tasteInboxFile(home), '', 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
