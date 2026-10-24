/**
 * lib/stickers.mjs —— 大肥鱼的表情包（贴纸）库：收集 + 安全审核 + 每日额度
 * ============================================================================
 * 为什么要有（2026-10-25 使用者提出）：
 *   ① 大肥鱼评论/私信要**能发表情包**；
 *   ② 表情包要**自己在抖音评论和聊天里收集**（不预制、不硬塞）；
 *   ③ 🔴 安全红线：**色情、暴力、血腥、恐怖、恶心、违法、未成年向、辱骂一律不要**；
 *      只留可爱 / 萌 / 抽象 / 搞笑 / 大肥鱼这类**无不良**的。
 *
 * 怎么保证安全（双保险，缺一不可）：
 *   ① 名称/来源先过一层**分类黑名单**（用中性书面词粗筛，命中直接 blocked）；
 *   ② 图片内容最终由「大肥鱼」（视觉模型）逐张看过再拍板：收集来的先 pending，
 *      值班轮 Read 贴纸图，调 douyin_sticker_review 判定 approve/block 并打标签。
 *      🔴 **只有 status=approved 的才允许发**（stickerSafeOnly 开关锁死，默认开）。
 *      模块本身不做图像识别，绝不"猜它安全"就放行；第一层漏判的也会被视觉审核挡下。
 *
 * 收集什么：抖音评论接口里的贴纸（评论带 sticker_id / sticker 对象，封面图可直接 Read）；
 *           私信里的表情图（img 地址）。平台贴纸用 sticker_id 发（评论 publish 原生支持），
 *           自定义图片/GIF 只存来源、发送走 UI 尽力而为（web 端不保证成功）。
 *
 * 状态文件：`$DOUYIN_HOME/stickers.json`
 *   {
 *     "items": {
 *       "<key>": { "key","sticker_id","name","url","thumb","kind","source","tags":[],
 *                  "status":"pending|approved|blocked","reason","addedAt","reviewedAt","used":0 }
 *     },
 *     "day": "2026-10-25", "sent": 0, "sentIds": []
 *   }
 * 🔒 只存本机；贴纸图本身不下载（存 url，发/审时按需读），不打包、不上传。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dayKey } from './engage.mjs'

export function stickersFile(home) {
  return join(home, 'stickers.json')
}

/**
 * 🔴 不良内容名称/来源分类黑名单（中性书面词，命中即 blocked，不进待审）。
 * 八大类：色情、暴力血腥、恐怖、恶心、违法、未成年向、辱骂、以及其它不适。
 * 第一层只做粗筛，更彻底的内容安全由视觉审核（reviewSticker）兜底。
 */
const BLOCKED_RE = [
  /色情|淫秽|裸体|成人(?!向成长)?|18禁|情色|裸露|卖淫|嫖娼|裸聊|约炮|性暗示|性交易|色情网站|裸贷/,
  /暴力|血腥|砍(人|杀|头)|割(喉|腕)|杀(人|戮|死|害)|尸体|死尸|尸块|分尸|虐杀|酷刑|枪(击|杀|战)|爆头|伤口|车祸|坠楼/,
  /恐怖|惊悚|灵异|鬼屋|吓(人|尿)|诅咒|邪术|阴间/,
  /自杀|轻生|自残|割腕|轻生|跳(楼|河)|上吊|吞药/,
  /恶心|呕吐|粪便|蛆虫|脓疮|密集恐|排泄物|肛门|下体/,
  /毒品|吸毒|赌博|博彩|网赌|赌场|诈骗|刷单|走私|枪支|弹药|管制刀具|违禁/,
  /未成年|幼女|儿童(色情|裸|性)|萝莉|正太(?!怪)|儿童不宜|学生妹裸/,
  /辱骂|侮辱|骂人|脏话|贱人|狗东西|死全家|人渣|废物|滚蛋|去死去死/,
]

/** 友好的标签关键词（给大肥鱼审核时参考；不作为放行依据，只是辅助打标签） */
export const FRIENDLY_TAGS = [
  '可爱', '萌', '抽象', '搞笑', '沙雕', '大肥鱼', '猫咪', '狗狗', '动物', '治愈',
  '表情包', '搞怪', '委屈', '开心', '卖萌', '摸鱼', '摆烂', '打工人', '干饭', '谢谢',
]

/** 名称/来源是否命中不良黑名单（空名不报，交给视觉审核） */
export function nameBlocked(name) {
  const s = String(name || '').toLowerCase()
  if (!s.trim()) return false
  for (const re of BLOCKED_RE) {
    if (re.test(s)) return true
  }
  return false
}

/** 唯一 key：优先贴纸 id，没有就用图片 url 哈希（平台贴纸都有 id；自定义图走 url） */
export function stickerKey(rec) {
  const id = String(rec.sticker_id || rec.stickerId || '').trim()
  if (id) return 'sid:' + id
  const u = String(rec.url || rec.thumb || '').trim()
  if (u) return 'url:' + createHash('sha1').update(u).digest('hex').slice(0, 16)
  return ''
}

const EMPTY = () => ({ items: {}, day: dayKey(), sent: 0, sentIds: [] })

export function loadStickers(home) {
  try {
    const j = JSON.parse(readFileSync(stickersFile(home), 'utf8'))
    if (j && typeof j === 'object' && j.items) {
      if (j.day !== dayKey()) { j.day = dayKey(); j.sent = 0; j.sentIds = [] }
      j.sent = Number(j.sent) || 0
      j.sentIds = Array.isArray(j.sentIds) ? j.sentIds : []
      return j
    }
  } catch { /* 无/损坏当新的 */ }
  return EMPTY()
}

export function saveStickers(home, s) {
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(stickersFile(home), JSON.stringify(s, null, 2), 'utf8')
    return true
  } catch { return false }
}

/**
 * 收集一条贴纸（从评论/私信解析出来后调用）。
 * 名称命中黑名单直接 blocked；否则 pending 等大肥鱼视觉审核。
 * 已存在不覆盖（保留原审核结果/标签）。
 * @returns {{added:boolean,key:string,status:string,reason?:string}}
 */
export function addSticker(home, rec) {
  const key = stickerKey(rec)
  if (!key) return { added: false, key: '', status: 'none', reason: 'no_id_or_url' }
  const s = loadStickers(home)
  if (s.items[key]) return { added: false, key, status: s.items[key].status, reason: 'duplicate' }
  const name = String(rec.name || '').trim()
  const bad = nameBlocked(name) || nameBlocked(rec.source || '')
  const item = {
    key,
    sticker_id: String(rec.sticker_id || rec.stickerId || '').trim(),
    name,
    url: String(rec.url || '').trim(),
    thumb: String(rec.thumb || rec.url || '').trim(),
    kind: rec.kind === 'gif' ? 'gif' : 'sticker',
    source: String(rec.source || 'comment'),   // comment | dm | builtin
    aweme_id: String(rec.aweme_id || ''),
    tags: [],
    status: bad ? 'blocked' : 'pending',
    reason: bad ? '名称命中不良黑名单' : '',
    addedAt: new Date().toISOString(),
    reviewedAt: null,
    used: 0,
  }
  s.items[key] = item
  saveStickers(home, s)
  return { added: true, key, status: item.status, reason: item.reason }
}

/** 批量收集，返回汇总 */
export function ingestStickers(home, recs) {
  let added = 0, blocked = 0, pending = 0, dup = 0
  for (const rec of Array.isArray(recs) ? recs : []) {
    const r = addSticker(home, rec)
    if (r.added) { added++; if (r.status === 'blocked') blocked++; else pending++ }
    else if (r.reason === 'duplicate') dup++
  }
  return { added, blocked, pending, dup }
}

/** 大肥鱼视觉审核结果落库（decision=approved|blocked）。不存在的 key 报错。 */
export function reviewSticker(home, key, decision, tag = '', reason = '') {
  const s = loadStickers(home)
  const it = s.items[key]
  if (!it) return { ok: false, error: 'sticker_not_found' }
  if (decision === 'approved') {
    // 视觉说通过，但名称黑名单仍拥有最高否决权（防模型被带偏）
    if (nameBlocked(it.name) || nameBlocked(it.source)) {
      it.status = 'blocked'
      it.reason = '名称黑名单（视觉放行也不允许）'
      it.reviewedAt = new Date().toISOString()
      saveStickers(home, s)
      return { ok: true, key, status: 'blocked', reason: it.reason }
    }
    it.status = 'approved'
    it.reason = ''
    const t = String(tag || '').trim()
    if (t && !it.tags.includes(t)) it.tags.push(t)
  } else if (decision === 'blocked') {
    it.status = 'blocked'
    it.reason = String(reason || '视觉审核：含不良/不适内容').slice(0, 120)
  } else {
    return { ok: false, error: 'bad_decision' }
  }
  it.reviewedAt = new Date().toISOString()
  saveStickers(home, s)
  return { ok: true, key, status: it.status }
}

/** 列出贴纸（默认只列 approved；可按 status/tag 过滤） */
export function listStickers(home, { status = 'approved', tag = '', limit = 200 } = {}) {
  const s = loadStickers(home)
  let arr = Object.values(s.items)
  if (status && status !== 'all') arr = arr.filter((x) => x.status === status)
  if (tag) arr = arr.filter((x) => x.tags.includes(tag))
  arr.sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)))
  return arr.slice(0, limit)
}

/** 今日已发贴纸数（跨天自动翻篇） */
export function stickerSentToday(home) {
  const s = loadStickers(home)
  return Number(s.sent) || 0
}

/** 发送成功后记账（当日计数 + 该贴纸使用次数） */
export function markStickerSent(home, key) {
  const s = loadStickers(home)
  s.sent = Number(s.sent || 0) + 1
  if (!s.sentIds.includes(dayKey() + ':' + key)) s.sentIds.push(dayKey() + ':' + key)
  if (s.items[key]) s.items[key].used = Number(s.items[key].used || 0) + 1
  saveStickers(home, s)
  return { sent: s.sent }
}

/**
 * 挑一张可以发的贴纸（只挑 approved）。
 * @param tag 可指定偏好标签；带 sticker_id 的平台贴纸优先（保证真发得出去）。
 * @returns 贴纸对象或 null（没有可用的）
 */
export function pickSticker(home, tag = '') {
  const pool = listStickers(home, { status: 'approved', limit: 500 }).filter((x) =>
    !tag || x.tags.includes(tag) || (x.name || '').includes(tag))
  if (!pool.length) return null
  const withId = pool.filter((x) => x.sticker_id)
  const arr = withId.length ? withId : pool
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 计数（面板/状态用） */
export function stickerStats(home) {
  const s = loadStickers(home)
  const items = Object.values(s.items)
  return {
    approved: items.filter((x) => x.status === 'approved').length,
    pending: items.filter((x) => x.status === 'pending').length,
    blocked: items.filter((x) => x.status === 'blocked').length,
    sentToday: Number(s.sent) || 0,
  }
}
