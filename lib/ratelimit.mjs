/**
 * lib/ratelimit.mjs —— 降风险控（拟人节奏 + 熔断 + 养号 + 夜间静默）
 * ============================================================================
 * 为什么要有（2026-10-24 使用者提出：知道有封号风险，要一套降风险代码融进去）：
 *   抖音的风控看的是「这个号在一段时间内的行为节奏」——机器号的特征是：
 *   动作间隔恒定、秒回、夜里也不停、短时间高频、撞了 403 还猛重试。
 *   本模块用**拟人化**把这些特征抹平：
 *     ① 每类动作有最小间隔，且在其上叠加随机抖动（不再是固定 45 秒一条）；
 *     ② 任意两个对外动作之间至少隔几秒；
 *     ③ 每小时 / 每天都有硬上限（突发 + 总量）；
 *     ④ 连续几个动作后强制随机长休（模拟人刷累了放下手机）；
 *     ⑤ 夜间静默时段（默认 23:00–08:00）不主动外发；
 *     ⑥ 新号「养号期」配额自动降低、间隔拉长；
 *     ⑦ 撞限流 / 验证码 / 登录失效 ⇒ 熔断，期间所有外发直接拒，并按次数指数退避。
 *
 * 🔴 和 engage.mjs 的分工：
 *   - engage.mjs 管「**业务规矩**」（分享几条、评论几条、同人最多回几次、是否善意）；
 *   - ratelimit.mjs 管「**节奏与安全**」（隔多久、每小时几次、几点别动、撞墙就停）。
 *   发送前先过 engage（业务），再过 ratelimit（安全）。host 与 MCP 都 import 这一份，绕不过去。
 *
 * 状态文件：`$DOUYIN_HOME/ratelimit.json`。不记任何对方隐私 / 评论内容，只记时间戳与计数。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './engage.mjs'

export function rateFile(home) {
  return join(home, 'ratelimit.json')
}

/** 各动作的「最小间隔」基准秒数（实际会叠加随机抖动，且养号期拉长） */
export const BASE_GAP_SEC = {
  comment: 50, // 主动顶层评论：公开、最招眼，最宽
  reply: 35,   // 回复别人评论
  mention: 60, // 真 @（要起 UI 点选），最重
  share: 25,   // 私信分享卡片
  dm: 15,      // 私信文字（只对老大）
}
/** 任意两个不同动作之间的最小间隔（秒） */
export const GAP_ANY_SEC = 12
/** 连续做多少个动作后，强制来一次随机长休 */
export const BURST_AFTER = 4
/** 长休时长区间（秒）：模拟刷累了放下手机 */
export const LONG_REST_SEC = [90, 240]
/** 抖动比例：间隔在 base 的 ±25% 之间浮动 */
const JITTER = 0.25

const EMPTY = () => ({
  day: dayKey(),
  dayTotal: 0,
  hourly: [],          // [{ ts, kind }]，仅保留最近 60 分钟
  last: {},            // { [kind]: ts }
  lastAny: 0,
  streak: 0,
  consecFail: 0,
  tripCount: 0,
  blockedUntil: 0,     // 普通熔断（撞限流/连续失败）
  hardUntil: 0,        // 硬熔断（验证码/登录失效）
  nurtureStartAt: '',  // 养号起点 ISO；空 = 首次外发时种下
  days: {},            // 近几天的每日总量（仅供面板看趋势）
})

export function loadRateState(home) {
  let st = null
  try {
    const j = JSON.parse(readFileSync(rateFile(home), 'utf8'))
    if (j && typeof j === 'object') st = j
  } catch { /* 没有/损坏当新的 */ }
  const e = EMPTY()
  if (!st) return e
  const today = dayKey()
  if (st.day !== today) {
    // 跨天：把昨天总量归档，计数清零（熔断/养号时间戳保留）
    if (st.day) e.days = { ...(st.days || {}), [st.day]: Number(st.dayTotal) || 0 }
    // 只保留近 14 天
    for (const k of Object.keys(e.days)) if (Object.keys(e.days).indexOf(k) < Object.keys(e.days).length - 14) delete e.days[k]
  } else {
    e.day = today
    e.dayTotal = Number(st.dayTotal) || 0
    e.days = (st.days && typeof st.days === 'object') ? st.days : {}
  }
  e.hourly = Array.isArray(st.hourly) ? st.hourly.filter((x) => x && Number(x.ts)) : []
  e.last = (st.last && typeof st.last === 'object') ? st.last : {}
  e.lastAny = Number(st.lastAny) || 0
  e.streak = Number(st.streak) || 0
  e.consecFail = Number(st.consecFail) || 0
  e.tripCount = Number(st.tripCount) || 0
  e.blockedUntil = Number(st.blockedUntil) || 0
  e.hardUntil = Number(st.hardUntil) || 0
  e.nurtureStartAt = String(st.nurtureStartAt || '')
  return e
}

export function saveRateState(home, st) {
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(rateFile(home), JSON.stringify(st, null, 2), 'utf8')
    return true
  } catch { return false }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))))

/** [min,max] 均匀随机（可注入 rand，方便测试） */
export function randBetween(min, max, rand = Math.random) {
  if (max < min) [min, max] = [max, min]
  return min + rand() * (max - min)
}

/**
 * 某动作此刻建议等待的拟人延时（毫秒）：距上次同类/任意动作的间隔不足就补齐，再叠抖动。
 * 返回 { waitMs, gapSec }。纯计算，不落盘。
 */
export function humanGap(kind, st, opts = {}, now = Date.now()) {
  const human = opts.humanMode !== false
  const nurture = nurtureFactor(st, opts) // 养号期 >1 时拉长间隔
  const base = (BASE_GAP_SEC[kind] || 30) * nurture
  const jitter = human ? (1 + randBetween(-JITTER, JITTER, opts.rand)) : 1
  const wantSame = base * jitter
  const wantAny = GAP_ANY_SEC * (human ? (1 + randBetween(-0.2, 0.2, opts.rand)) : 1)
  const lastSame = Number(st.last[kind]) || 0
  const lastAny = Number(st.lastAny) || 0
  const needSame = lastSame ? Math.max(0, wantSame - (now - lastSame) / 1000) : 0
  const needAny = lastAny ? Math.max(0, wantAny - (now - lastAny) / 1000) : 0
  const waitSec = Math.max(needSame, needAny)
  return { waitMs: Math.round(waitSec * 1000), gapSec: Math.round(wantSame) }
}

/** 解析 "HH:MM" 为小时+分钟 */
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null
}

/**
 * 夜间静默：此刻是否落在 [start, end) 内（支持跨零点）。
 * 默认 23:00–08:00。safeQuiet=false 时永远 false。
 */
export function inQuietHours(opts = {}, d = new Date()) {
  if (opts.safeQuiet === false) return false
  const a = parseHM(opts.quietStart ?? '23:00')
  const b = parseHM(opts.quietEnd ?? '08:00')
  if (!a || !b) return false
  const cur = d.getHours() * 60 + d.getMinutes()
  const A = a.h * 60 + a.m
  const B = b.h * 60 + b.m
  if (A === B) return false
  if (A < B) return cur >= A && cur < B        // 同日窗口，如 13:00–17:00
  return cur >= A || cur < B                   // 跨零点，如 23:00–08:00
}

/**
 * 养号系数：养号期内返回 >1（用于拉长间隔）；非养号期返回 1。
 * 养号起点在首次外发时种下；nurtureMode=false 时返回 1。
 */
export function nurtureFactor(st, opts = {}, now = Date.now()) {
  if (opts.nurtureMode === false) return 1
  const days = Number(opts.nurtureDays ?? 7)
  if (!days || days <= 0) return 1
  if (!st.nurtureStartAt) return 1.8 // 还没种下（第一次外发）：按养号首日从严
  const start = Date.parse(st.nurtureStartAt)
  if (!Number.isFinite(start)) return 1.8
  const ageDays = (now - start) / 86400_000
  if (ageDays >= days) return 1
  // 养号期内 1.8 倍间隔（越靠近上线越放松，但这里就用保守常数，简单稳定）
  return 1.8
}

/** 养号期的配额系数（养号期内配额按比例下取整）；非养号期 1 */
export function nurtureQuota(st, opts = {}, now = Date.now()) {
  if (opts.nurtureMode === false) return 1
  const days = Number(opts.nurtureDays ?? 7)
  if (!days || days <= 0) return 1
  if (!st.nurtureStartAt) return 0.4
  const start = Date.parse(st.nurtureStartAt)
  if (!Number.isFinite(start)) return 0.4
  return ((now - start) / 86400_000 >= days) ? 1 : 0.4
}

/** 过去 60 分钟内的动作数 */
function hourCount(st, now) {
  return st.hourly.filter((x) => now - Number(x.ts) <= 3600_000).length
}

/**
 * 外发主闸门（只判断、不等待、不落盘）。
 * @param {string} home 插件家目录
 * @param {string} kind comment|reply|mention|share|dm
 * @param {object} opts 配置（每小时/每日上限、夜间、养号、humanMode 等）
 * @returns {{ok:boolean, reason?:string, waitMs?:number, detail?:any}}
 *   ok=true 时 waitMs 是「建议在发送前等待的拟人毫秒数」（调用方自己 await sleep）。
 */
export function checkGate(home, kind, opts = {}, nowMs = Date.now()) {
  const st = loadRateState(home)
  const now = nowMs
  // ① 硬熔断（验证码 / 登录失效）最优先
  if (now < Number(st.hardUntil)) {
    return { ok: false, reason: 'hard_circuit', waitMs: st.hardUntil - now, detail: { until: st.hardUntil } }
  }
  // ② 普通熔断（撞限流 / 连续失败）
  if (now < Number(st.blockedUntil)) {
    return { ok: false, reason: 'cooldown', waitMs: st.blockedUntil - now, detail: { until: st.blockedUntil, tripCount: st.tripCount } }
  }
  // ③ 夜间静默
  if (inQuietHours(opts, new Date(now))) {
    return { ok: false, reason: 'quiet_hours', detail: { from: opts.quietStart ?? '23:00', to: opts.quietEnd ?? '08:00' } }
  }
  // ④ 配额（养号期下修）
  const q = nurtureQuota(st, opts, now)
  const perHour = Math.max(1, Math.floor((Number(opts.maxActionsPerHour) ?? 8) * q + 0.0001))
  const perDay = Math.max(1, Math.floor((Number(opts.maxActionsPerDay) ?? 20) * q + 0.0001))
  if (st.dayTotal >= perDay) {
    return { ok: false, reason: 'day_cap', detail: { used: st.dayTotal, max: perDay, nurturing: q < 1 } }
  }
  if (hourCount(st, now) >= perHour) {
    const oldest = st.hourly.filter((x) => now - Number(x.ts) <= 3600_000).sort((a, b) => a.ts - b.ts)[0]
    const waitMs = oldest ? Number(oldest.ts) + 3600_000 - now : 0
    return { ok: false, reason: 'hour_cap', waitMs: Math.max(0, waitMs), detail: { max: perHour, nurturing: q < 1 } }
  }
  // ⑤ 拟人间隔（通过的话把建议等待时间返回给调用方）
  const g = humanGap(kind, st, opts, now)
  return { ok: true, waitMs: g.waitMs, detail: { gapSec: g.gapSec, nurturing: q < 1 } }
}

/** 发送成功后记账（更新时间戳、计数、连续失败清零）。返回是否该长休。 */
export function markAction(home, kind, opts = {}, nowMs = Date.now()) {
  const st = loadRateState(home)
  const now = nowMs
  // 养号起点：首次外发时种下
  if (!st.nurtureStartAt) {
    st.nurtureStartAt = new Date(now).toISOString()
  }
  st.hourly = st.hourly.filter((x) => now - Number(x.ts) <= 3600_000)
  st.hourly.push({ ts: now, kind })
  st.last[kind] = now
  st.lastAny = now
  st.dayTotal += 1
  st.streak += 1
  st.consecFail = 0
  let restMs = 0
  // 连续动作后强制随机长休（下一次 gate 会把它体现在 waitMs 里——这里直接记一个"休息到"时间戳）
  if (opts.humanMode !== false && st.streak >= BURST_AFTER) {
    st.streak = 0
    const [lo, hi] = LONG_REST_SEC
    st.restUntil = now + randBetween(lo, hi) * 1000
    restMs = st.restUntil - now
  }
  saveRateState(home, st)
  return { restMs }
}

/**
 * 外发失败时记账。能识别信号时给熔断时长。
 * @param {string} signalText 发送器返回的错误/输出文本（用于识别 403/验证码/登录失效）
 */
export function recordFailure(home, kind, signalText = '', opts = {}, nowMs = Date.now()) {
  const st = loadRateState(home)
  const now = nowMs
  const sig = String(signalText || '').toLowerCase()
  const hard = /验证码|短信验证|滑块|captcha|verify|登录失效|未登录|登录过期|请先登录|login required|not logged|封禁|封号|账号异常|risk|风控拦截|安全验证/.test(sig)
  const limited = /403|429|频繁|限流|过于频繁|rate limit|too many|try again later|操作太快/.test(sig)
  st.consecFail += 1
  let tripped = false
  if (hard) {
    // 硬熔断：直接停 2 小时起步，随次数翻倍（封顶 24 小时）
    st.tripCount += 1
    const mins = Math.min(120 * 2 ** Math.max(0, st.tripCount - 1), 24 * 60)
    st.hardUntil = now + mins * 60_000
    st.blockedUntil = Math.max(st.blockedUntil, st.hardUntil)
    tripped = true
  } else if (limited || st.consecFail >= 3) {
    // 限流：冷却 10 分钟起步，连续熔断翻倍（封顶 4 小时）
    st.tripCount += 1
    const mins = Math.min(10 * 2 ** Math.max(0, st.tripCount - 1), 240)
    st.blockedUntil = Math.max(st.blockedUntil, now + mins * 60_000)
    tripped = true
  }
  saveRateState(home, st)
  return { tripped, hard, limited, consecFail: st.consecFail, blockedUntil: Math.max(st.blockedUntil, st.hardUntil) }
}

/** 手动解除熔断（用户在面板点「恢复」/ doctor 排障后） */
export function resetCircuit(home) {
  const st = loadRateState(home)
  st.blockedUntil = 0
  st.hardUntil = 0
  st.consecFail = 0
  saveRateState(home, st)
  return true
}

/** 面板 / status 用的状态摘要 */
export function rateStatus(home, opts = {}, nowMs = Date.now()) {
  const st = loadRateState(home)
  const now = nowMs
  const q = nurtureQuota(st, opts, now)
  const perHour = Math.max(1, Math.floor((Number(opts.maxActionsPerHour) ?? 8) * q + 0.0001))
  const perDay = Math.max(1, Math.floor((Number(opts.maxActionsPerDay) ?? 20) * q + 0.0001))
  const blocked = now < st.hardUntil ? 'hard' : now < st.blockedUntil ? 'cooldown' : null
  const restUntil = Number(st.restUntil) || 0
  return {
    blocked,
    blockedUntil: blocked ? Math.max(st.blockedUntil, st.hardUntil) : 0,
    inQuiet: inQuietHours(opts, new Date(now)),
    nurturing: q < 1,
    nurtureFactor: q,
    dayUsed: st.dayTotal,
    dayMax: perDay,
    hourUsed: hourCount(st, now),
    hourMax: perHour,
    consecFail: st.consecFail,
    resting: now < restUntil,
    restUntil: now < restUntil ? restUntil : 0,
  }
}

/**
 * 便捷：在发送前 await 这个（它内部做拟人等待）。
 * 返回与 checkGate 相同的结构；ok=true 时已经睡过 waitMs。
 */
export async function awaitGate(home, kind, opts = {}) {
  const g = checkGate(home, kind, opts)
  if (!g.ok) return g
  // 若处于长休窗口，也一并睡掉（长休是「刚连做了几个动作」后的主动休息）
  const st = loadRateState(home)
  const restMs = Number(st.restUntil) && Date.now() < st.restUntil ? st.restUntil - Date.now() : 0
  const waitMs = Math.max(Number(g.waitMs) || 0, restMs)
  if (waitMs > 0) await sleep(waitMs)
  return g
}
