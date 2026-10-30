/**
 * lib/memory.mjs —— 对话记忆（私信 / 评论区的上下文）
 * ============================================================================
 * 为什么要有：
 *   2026-10-22 用户要求「回消息 / 持续聊天，这些是要带记忆上下文的」。
 *   没有记忆的话，每次读私信都是"第一次见" —— 不知道上次聊到哪、他是什么人、
 *   什么事已经说过了，回的话就会重复、跑题、或者把人当陌生人。
 *
 * 🔴 三条设计约束：
 *   ① **只存本机**：`$DOUYIN_HOME/memory/` 下面，不上传任何地方。
 *      私信内容是最私密的东西之一，绝不能进仓库 / 日志 / 报告。
 *   ② **有上限**：每个人最多留 80 条、每条 200 字。不做无限增长。
 *   ③ **不编造**：没有记录就是没有。**绝不**用"记忆里似乎说过"来填空。
 *
 * 存储形状（`memory/dm-<sec_uid>.json`）：
 *   {
 *     who: { sec_uid, nick },
 *     updatedAt: "2026-10-22T...",
 *     rounds: 3,                       // 聊过几轮（每次 read/reply 算一次接触）
 *     facts: ["他在杭州", "养了只猫"],   // 长期事实（由模型判断后写入）
 *     messages: [                       // 按时间**旧→新**
 *       { at: "...", from: "me"|"them", text: "...", kind: "text"|"card" }
 *     ]
 *   }
 *
 * 评论区的记忆形状（`memory/comment-<aweme_id>.json`）类似，但按"视频"归档：
 *   { aweme_id, updatedAt, seen: ["cid1", ...], mine: [{cid,text,at}], notes: [] }
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const MAX_MESSAGES = 400
const MAX_TEXT = 400
const MAX_FACTS = 60

/** 把 sec_uid / aweme_id 变成安全文件名（只留字母数字下划线和中划线） */
const safeKey = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown'

const nowIso = () => new Date().toISOString()

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonSafe(file, value) {
  try { writeFileSync(file, JSON.stringify(value, null, 1), 'utf8'); return true } catch { return false }
}

export function memoryDir(home) {
  const d = join(home, 'memory')
  try { mkdirSync(d, { recursive: true }) } catch { /* 建不了就退化成"没有记忆" */ }
  return d
}

/* ─────────────────────────── 私信记忆 ─────────────────────────── */

const dmFile = (home, secUid) => join(memoryDir(home), `dm-${safeKey(secUid)}.json`)

export function loadDmMemory(home, secUid) {
  if (!secUid) return null
  const j = readJsonSafe(dmFile(home, secUid), null)
  if (!j || typeof j !== 'object') return null
  return {
    who: j.who || { sec_uid: secUid, nick: '' },
    updatedAt: j.updatedAt || '',
    rounds: Number(j.rounds) || 0,
    facts: Array.isArray(j.facts) ? j.facts.filter((x) => typeof x === 'string').slice(0, MAX_FACTS) : [],
    messages: Array.isArray(j.messages) ? j.messages.filter((m) => m && m.text) : [],
  }
}

/**
 * 把一次读到的会话**合并**进记忆。
 * ⭐ 合并而不是覆盖：抖音只给我最近 60 条，整段覆盖会把更早的记忆冲掉。
 *    用 `from+text` 做去重键（没有稳定的消息 id 可用 —— 2026-10-22 查过，DOM 里没有）。
 */
export function mergeDmMemory(home, secUid, nick, msgs) {
  if (!secUid || !Array.isArray(msgs)) return null
  const prev = loadDmMemory(home, secUid) || { who: { sec_uid: secUid, nick: '' }, rounds: 0, facts: [], messages: [] }
  const idx = new Map()
  prev.messages.forEach((m, i) => idx.set(`${m.from}|${String(m.text).slice(0, 60)}`, i))
  const merged = [...prev.messages]
  let added = 0
  let retimed = 0
  for (const m of msgs) {
    const text = String(m.text || '').trim()
    if (!text) continue
    const key = `${m.from}|${text.slice(0, 60)}`
    const realAt = String(m.at || '').trim()
    const hit = idx.get(key)
    if (hit !== undefined) {
      /* ⭐ 2026-10-27：老记录的时间是"合并那一刻"写坏的（一天里全同一秒）。
         这次读回来带了真实 at ⇒ 顺手校正，历史消息也能归到正确的那天。 */
      if (realAt && merged[hit].at !== realAt) { merged[hit].at = realAt; retimed++ }
      continue
    }
    idx.set(key, merged.length)
    merged.push({
      /* ⭐ 2026-10-27：用消息自己的时间（im-http 读回来带 at）。
         以前一律写"合并那一刻" ⇒ "昨天你答应我什么"这种问题对不上日期。 */
      at: realAt || nowIso(),
      from: m.from === 'me' ? 'me' : (m.from === 'them' ? 'them' : 'unknown'),
      text: text.slice(0, MAX_TEXT),
      // ⚠️ 2026-10-22 修正：抖音的 `aweType` 在**普通文字消息**上也有值（实测是 700），
      //    只有分享卡片是 800 ⇒ 不能拿"有没有 awe"判卡片，得看具体值。
      kind: Number(m.awe) === 800 ? 'card' : 'text',
    })
    added++
  }
  // 只留最近 N 条（按时间排，别让新读到的好消息被顺序打乱）
  merged.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
  const trimmed = merged.slice(-MAX_MESSAGES)
  const out = {
    who: { sec_uid: secUid, nick: nick || prev.who?.nick || '' },
    updatedAt: nowIso(),
    rounds: (Number(prev.rounds) || 0) + (added ? 1 : 0),
    facts: prev.facts.slice(0, MAX_FACTS),
    messages: trimmed,
  }
  writeJsonSafe(dmFile(home, secUid), out)
  return { ...out, added, retimed, total: trimmed.length }
}

/** 记一条自己发出去的消息（发完立刻进记忆，不用等下次读） */
export function noteSent(home, secUid, nick, text, kind = 'text') {
  if (!secUid || !text) return null
  return mergeDmMemory(home, secUid, nick, [{ from: 'me', text, awe: kind === 'card' ? 800 : 0 }])
}

/** 往记忆里加"长期事实"（模型判断值得记的：住哪、养什么、在意什么） */
export function addFacts(home, secUid, facts) {
  if (!secUid || !Array.isArray(facts) || !facts.length) return null
  const prev = loadDmMemory(home, secUid)
  if (!prev) return null
  const set = new Set(prev.facts)
  for (const f of facts) {
    const s = String(f || '').trim()
    if (s) set.add(s.slice(0, 80))
  }
  prev.facts = [...set].slice(0, MAX_FACTS)
  prev.updatedAt = nowIso()
  writeJsonSafe(dmFile(home, secUid), prev)
  return prev
}

/** 给模型看的上下文摘要（**只给最近几条 + 事实**，别把 80 条全塞进去烧 token） */
export function dmContext(home, secUid, { recent = 12 } = {}) {
  const m = loadDmMemory(home, secUid)
  if (!m || !m.messages.length) return null
  return {
    who: m.who,
    rounds: m.rounds,
    last_talk_at: m.updatedAt,
    facts: m.facts,
    recent: m.messages.slice(-recent),
    total_remembered: m.messages.length,
  }
}

/* ─────────────────────────── 评论区记忆 ─────────────────────────── */

const cmFile = (home, awemeId) => join(memoryDir(home), `comment-${safeKey(awemeId)}.json`)

export function loadCommentMemory(home, awemeId) {
  if (!awemeId) return null
  const j = readJsonSafe(cmFile(home, awemeId), null)
  if (!j || typeof j !== 'object') return null
  return {
    aweme_id: String(j.aweme_id || awemeId),
    updatedAt: j.updatedAt || '',
    seen: Array.isArray(j.seen) ? j.seen : [],
    mine: Array.isArray(j.mine) ? j.mine : [],
    notes: Array.isArray(j.notes) ? j.notes : [],
  }
}

/** 记下自己在某条视频下发过的评论（真 @ 走的 UI 拿不到 cid，只能按正文记） */
export function noteMyComment(home, awemeId, { cid = '', text = '', mention = '' }) {
  if (!awemeId || !text) return null
  const prev = loadCommentMemory(home, awemeId) || { aweme_id: String(awemeId), seen: [], mine: [], notes: [] }
  prev.mine.push({ at: nowIso(), cid: String(cid || ''), text: String(text).slice(0, MAX_TEXT), mention: String(mention || '') })
  prev.mine = prev.mine.slice(-40)
  prev.updatedAt = nowIso()
  writeJsonSafe(cmFile(home, awemeId), prev)
  return prev
}

/** 记下"这条评论我处理过了"（避免同一个 @ 反复回） */
export function markSeen(home, awemeId, cids) {
  if (!awemeId || !Array.isArray(cids) || !cids.length) return null
  const prev = loadCommentMemory(home, awemeId) || { aweme_id: String(awemeId), seen: [], mine: [], notes: [] }
  const set = new Set(prev.seen)
  for (const c of cids) if (c) set.add(String(c))
  prev.seen = [...set].slice(-300)
  prev.updatedAt = nowIso()
  writeJsonSafe(cmFile(home, awemeId), prev)
  return prev
}

/* ─────────────────── 人物档案（模型自己维护的长期笔记） ───────────────────
 * 2026-10-27 老大反馈「记忆点太差，问它我昨天答应了它什么，说不出来」。
 * 光存原始消息不够（400 条也在滚、也不成句）⇒ 让模型每天整理一份 notes-<sec>.md：
 *   「他是什么人 / 约定与答应过的事（带日期）/ 最近在忙什么 / 没说完的事」
 * 回话、回评论、读私信时把这份 notes + 最近两三天的按天时间线一起塞给模型。
 */

const notesFile = (home, secUid) => join(memoryDir(home), `notes-${safeKey(secUid)}.md`)

export function notesPath(home, secUid) { return notesFile(home, secUid) }

export function loadNotes(home, secUid) {
  try { return readFileSync(notesFile(home, secUid), 'utf8') } catch { return '' }
}

export function saveNotes(home, secUid, text) {
  try {
    writeFileSync(notesFile(home, secUid), String(text || '').slice(0, 24000), 'utf8')
    return true
  } catch { return false }
}

/** 最近 N 天的消息按**本地日期**分组（回答"昨天/前天"这类问题用） */
export function dmTimeline(home, secUid, { days = 3, perDay = 60 } = {}) {
  const m = loadDmMemory(home, secUid)
  if (!m || !m.messages.length) return null
  const tz = 8 * 3600_000
  const dayOf = (iso) => {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    return new Date(t + tz).toISOString().slice(0, 10)
  }
  const groups = new Map()
  for (const msg of m.messages) {
    const d = dayOf(msg.at) || '未知日期'
    if (!groups.has(d)) groups.set(d, [])
    groups.get(d).push(msg)
  }
  const out = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, days)
    .map(([day, list]) => ({
      day,
      n: list.length,
      lines: list.slice(-perDay).map((x) => `${x.from === 'me' ? '我' : (x.from === 'them' ? '他' : '?')}：${x.text}`),
    }))
  return { who: m.who, total: m.messages.length, days: out }
}

/** 一段给 prompt 直接用的时间线文本（带日期标题） */
export function dmTimelineText(home, secUid, { days = 2, perDay = 40 } = {}) {
  const t = dmTimeline(home, secUid, { days, perDay })
  if (!t) return ''
  return t.days.map((g) => `【${g.day}】\n${g.lines.join('\n')}`).join('\n\n')
}

/* ─────────────────────────── 维护 ─────────────────────────── */

/** 看看记忆占了多少地方（面板上显示用） */
export function memoryStats(home) {
  const d = memoryDir(home)
  const out = { dir: d, dm: 0, comment: 0, bytes: 0 }
  try {
    for (const f of readdirSync(d)) {
      if (!/\.json$/.test(f)) continue
      if (f.startsWith('dm-')) out.dm++
      else if (f.startsWith('comment-')) out.comment++
      try { out.bytes += readFileSync(join(d, f)).length } catch { /* 读不到就跳过 */ }
    }
  } catch { /* 没有就没有 */ }
  return out
}

/** 删掉某人的记忆（用户要"忘掉他"时用） */
export function forgetDm(home, secUid) {
  try {
    const f = dmFile(home, secUid)
    if (existsSync(f)) rmSync(f)
    return { ok: true, forgotten: secUid }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/** 清空所有记忆（谨慎；只有用户明确要求才调） */
export function forgetAll(home) {
  const d = memoryDir(home)
  let n = 0
  try {
    for (const f of readdirSync(d)) {
      if (!/\.json$/.test(f)) continue
      try { rmSync(join(d, f)); n++ } catch { /* 单个删不掉就跳过 */ }
    }
  } catch { /* 目录都没有 */ }
  return { ok: true, removed: n }
}
