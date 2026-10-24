/**
 * lib/engage.mjs —— 主动互动的「额度账本」＋「善意 / 可回答」判断
 * ============================================================================
 * 为什么要有（2026-10-24 使用者提出的硬规矩）：
 *   ① 大肥鱼自己刷视频，**可以给刷到的视频发评论，但不是每条都评**。
 *   ② 有人回复了它发的评论，**可以回**，但：
 *        · 只回**善意、好回答**的评论（恶意 / 抬杠 / 引战 / 引流 / 索要隐私的不回）；
 *        · **对同一个人最多回复 N 次**（默认 2，防拉锯纠缠、防风控）。
 *   ③ 每类外发动作都有每日上限（默认保守档，面板可改）。
 *
 * 🔴 这些是**硬规则**，不能只靠提示词"求模型自觉"——
 *    host 工具（index.js）和 MCP server（tools/mcp-server.mjs）**都 import 这一份**，
 *    任何调用方（DSH 内值班、外部 AI、MCP）都在同一条闸上，绕不过去。
 *
 * 状态文件：`$DOUYIN_HOME/engage.json`，**按天滚动**（自然日零点重置）。
 * 形状：
 *   {
 *     "day": "2026-10-24",
 *     "proactiveComments": 1,   // 今天主动发的顶层评论（无 reply_to）
 *     "shares": 2,              // 今天主动分享卡片给主人
 *     "replies": 3,             // 今天回复别人的总条数
 *     "perPerson": { "uidA": 2, "uidB": 1 },  // 今天对每个人的回复次数
 *     "skipped": { "hostile": 1, "person_cap": 2 }  // 被拦下的原因计数
 *   }
 *
 * 🔒 只存本机家目录；不记对方隐私原文（perPerson 只记次数，不记评论内容）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 本地自然日 key（YYYY-MM-DD，跟面板/state 的 dayKey 同口径：用本机时区） */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function engageFile(home) {
  return join(home, 'engage.json')
}

const EMPTY = (day) => ({
  day,
  proactiveComments: 0,
  shares: 0,
  replies: 0,
  perPerson: {},
  skipped: {},
})

/** 读账本；跨天自动翻篇（不覆盖文件，返回新对象，由调用方决定是否落盘） */
export function loadLedger(home) {
  try {
    const j = JSON.parse(readFileSync(engageFile(home), 'utf8'))
    if (j && typeof j === 'object') {
      const today = dayKey()
      if (j.day !== today) return EMPTY(today)
      return {
        day: today,
        proactiveComments: Number(j.proactiveComments) || 0,
        shares: Number(j.shares) || 0,
        replies: Number(j.replies) || 0,
        perPerson: (j.perPerson && typeof j.perPerson === 'object') ? j.perPerson : {},
        skipped: (j.skipped && typeof j.skipped === 'object') ? j.skipped : {},
      }
    }
  } catch { /* 没有/损坏就当新的 */ }
  return EMPTY(dayKey())
}

/** 落盘（建目录失败不抛——记不上账不该让发送本身崩） */
export function saveLedger(home, ledger) {
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(engageFile(home), JSON.stringify(ledger, null, 2), 'utf8')
    return true
  } catch { return false }
}

const bumpSkip = (ledger, reason) => {
  ledger.skipped[reason] = Number(ledger.skipped[reason] || 0) + 1
}

/* ─────────────────────────── 主动评论 / 分享 每日上限 ─────────────────────────── */

/** 主动顶层评论（无 reply_to）：今天还能不能发 */
export function canProactiveComment(home, maxPerDay) {
  const ledger = loadLedger(home)
  const max = Math.max(0, Number(maxPerDay) || 0)
  const used = ledger.proactiveComments
  return { ok: max > 0 && used < max, used, max, left: Math.max(0, max - used) }
}

export function countProactiveComment(home) {
  const ledger = loadLedger(home)
  ledger.proactiveComments += 1
  saveLedger(home, ledger)
  return ledger.proactiveComments
}

/** 分享卡片给主人：今天还能不能发 */
export function canShare(home, maxPerDay) {
  const ledger = loadLedger(home)
  const max = Math.max(0, Number(maxPerDay) || 0)
  const used = ledger.shares
  return { ok: max > 0 && used < max, used, max, left: Math.max(0, max - used) }
}

export function countShare(home) {
  const ledger = loadLedger(home)
  ledger.shares += 1
  saveLedger(home, ledger)
  return ledger.shares
}

/* ─────────────────────────── 回复别人：同人上限 + 每日上限 ─────────────────────────── */

/**
 * 还能不能回「这个人」。
 * @param {string} home 插件家目录
 * @param {string} uid 对方 uid（拿不到就传空 —— 退化为只按每日总上限，不按人卡）
 * @param {{perPerson:number, perDay:number}} lim
 */
export function canReplyTo(home, uid, lim = {}) {
  const perPerson = Math.max(0, Number(lim.perPerson ?? 2))
  const perDay = Math.max(0, Number(lim.perDay ?? 10))
  const ledger = loadLedger(home)
  const personUsed = uid ? Number(ledger.perPerson[String(uid)] || 0) : 0
  const used = ledger.replies
  if (used >= perDay) return { ok: false, reason: 'daily_cap', used, max: perDay, personUsed, perPerson }
  if (uid && personUsed >= perPerson) {
    return { ok: false, reason: 'person_cap', uid: String(uid), personUsed, perPerson }
  }
  return { ok: true, used, max: perDay, personUsed, perPerson, left: Math.max(0, perDay - used) }
}

/** 记下一次「已回复」（每日总数 + 按人计数） */
export function countReply(home, uid) {
  const ledger = loadLedger(home)
  ledger.replies += 1
  if (uid) ledger.perPerson[String(uid)] = Number(ledger.perPerson[String(uid)] || 0) + 1
  saveLedger(home, ledger)
  return { replies: ledger.replies, personUsed: uid ? Number(ledger.perPerson[String(uid)] || 0) : 0 }
}

/** 记录一次被拦（不发送也要落账，便于面板看“为什么没回”） */
export function noteSkipped(home, reason, uid) {
  const ledger = loadLedger(home)
  bumpSkip(ledger, String(reason || 'unknown'))
  if (uid) ledger.perPerson[String(uid)] = Number(ledger.perPerson[String(uid)] || 0) // 预热键
  saveLedger(home, ledger)
  return ledger.skipped
}

/* ─────────────────────────── 善意 / 可回答判断（硬兜底） ─────────────────────────── */
/**
 * 规则只做**硬兜底**：拦明确的恶意 / 引流 / 引战 / 敏感 / 纯索要。
 * "这句话值不值得回、怎么接"的**主要判断交给模型**（值班章程里写了判据）。
 * 规则宁可保守（少杀），避免把正常互动误判掉。
 *
 * @returns {{ok:boolean, reason?:string, label?:string}}
 *   ok=false 表示**不要回**；reason 给代码用，label 给人看。
 */
export function classifyReply(text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: 'empty', label: '空内容' }

  // ① 引流 / 广告 / 索要（站外导流、刷量、索要隐私）
  if (/(微信|加\s*v?x?|vx|v信|➕v|私我|私信我|加我|网盘|资源|代刷|互赞|互粉|点赞关注|关注一下|转发一下|返现|优惠券|抽奖|领红包|群\s*[0-9]|qq\s*[0-9]{5,}|Q\s*[0-9]{5,}|给我刷|帮我刷|做个广告|店铺链接|主页链接|橱窗)/i.test(t)) {
    return { ok: false, reason: 'solicit', label: '引流 / 广告 / 索要' }
  }
  // ② 索要隐私 / 联系方式
  if (/(手机号|电话|身份证|住址|地址|在哪上班|工资多少|多少钱一个月|发张照片|开视频|裸照|约吗|约不约|出来玩)/.test(t)) {
    return { ok: false, reason: 'privacy', label: '索要隐私 / 骚扰' }
  }
  // ③ 辱骂 / 攻击 / 诅咒
  if (/(傻逼|傻b|sb|草泥马|操你|滚蛋|恶心|有病|智障|脑残|废物|垃圾|贱人|婊|去死|该死|喷子|网络乞丐|装什么装|装什么|恶心死|丑|矮穷矬|low\s*b)/i.test(t)) {
    return { ok: false, reason: 'hostile', label: '辱骂 / 敌意' }
  }
  // ④ 引战 / 敏感（政治、宗教、地域、性别对立）
  if (/(政治|宗教|地域黑|女拳|南拳|男拳|打拳|滚出中国|汉奸|卖国|台独|港独|新疆|西藏|领导人)/.test(t)) {
    return { ok: false, reason: 'sensitive', label: '引战 / 敏感' }
  }
  // ⑤ 纯抬杠 / 无实质且无善意（很短、只是挑衅）。宁可少杀：只拦"就这/无语/呵呵"这类**单独成句**
  if (/^(就这[?？!.。…]*|无语[.。…]*|呵呵[.。…]*|什么玩意[?？!.。…]*|就这水平[?？!.。…]*|不会吧不会吧[?？!.。…]*)$/.test(t)) {
    return { ok: false, reason: 'unanswerable', label: '纯抬杠 / 没有可回答的内容' }
  }
  // 其余默认放行（问题、夸奖、共鸣、补充、正常讨论、哈哈哈…），由模型决定怎么回。
  return { ok: true, label: '善意 / 可回答' }
}

/** 兼容旧调用名 */
export function isFriendlyReply(text) {
  return classifyReply(text)
}
