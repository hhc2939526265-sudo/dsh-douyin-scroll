/**
 * 情绪内核（2026-10-28 老大要的）
 *
 * 一句话：**大肥鱼不是一个恒温的评价机器，它有自己的心情。**
 *
 * 设计（按老大的要求）：
 *   · 双维度 + 离散情绪：效价 v（-1 很糟 ~ +1 很好）、唤醒 a（0 平静/犯困 ~ 1 很激动），
 *     外加一个当下占上风的情绪标签（开心 / 兴奋 / 惊喜 / 被治愈 / 犯困 / 无聊 / 无语 / 震惊 / 小失落 / 委屈 / 期待 / 撒娇 / 傲娇 / 平静 …）。
 *   · 情绪由**真实事件**推动：这条视频好笑/可爱/离谱/治愈/无聊/吓人/煽情、评论被善意回、被夸、被抬杠、
 *     老大来找、被老大夸、老大很久没来、深夜、刷久了发困、连着看同类看腻了。
 *   · 有**惯性**（上一条的情绪带进下一条）、有**衰减**（时间 + 条数，慢慢回到平静），
 *     强情绪衰减慢、轻情绪衰减快，同类刺激连续来会叠加但**边际递减**。
 *   · 允许**矛盾**（又好笑又心疼、嘴上嫌弃手里收藏），也允许"今天整体亢奋 / 今天有点懒"。
 *   · 持久化到 `<home>/mood.json`，带最近轨迹，跨轮次记得今天是什么状态。
 *   · 影响行为：兴奋时更想说话、记得细节；犯困/被治愈时字少；连续无聊时耐心下降。
 *
 * ⚠️ 边界（这不是情绪限制，是安全底线）：
 *   · 再激动也不刷屏、不发过激/挑衅/阴阳/辱骂；
 *   · 负面情绪用健康、可爱的方式表达，不向陌生人撒气；
 *   · 讲正事、讲风险、排错时情绪让位，平直清楚；
 *   · 公开评论不装熟。
 *
 * 这里**不设"关闭情绪"的开关**，也不设内敛/适中/戏多档位 —— 外放多少由它自己按场合决定，
 * 模块只记录它实际养出来的倾向（`habit.outward`），供 prompt 描述"你最近说话大概是这个放度"。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const MOOD_FILE = (home) => join(home, 'mood.json')

/** 情绪的"平静线"：没有刺激时会往这里回落 */
const BASE = { v: 0.08, a: 0.3 }

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const nowIso = () => new Date().toISOString()

/**
 * 事件 → 情绪增量。
 *   dv/da 是**一次刺激**的强度基准，真正落到状态上还要乘"饱和系数"和"惯性阻尼"。
 *   label 是这次刺激容易产生的情绪（强刺激才直接改写主导标签）。
 */
export const MOOD_EVENTS = {
  // —— 刷视频时看到的 ——
  'video.funny': { dv: 0.22, da: 0.32, label: '开心', tags: ['好笑'] },
  'video.cute': { dv: 0.28, da: 0.08, label: '被治愈', tags: ['可爱'] },
  'video.weird': { dv: -0.04, da: 0.26, label: '无语', tags: ['离谱'] },
  'video.healing': { dv: 0.34, da: -0.12, label: '被治愈', tags: ['治愈'] },
  'video.boring': { dv: -0.14, da: -0.18, label: '无聊', tags: ['无聊'] },
  'video.scary': { dv: -0.28, da: 0.45, label: '震惊', tags: ['吓人'] },
  'video.sad': { dv: -0.3, da: 0.1, label: '小失落', tags: ['煽情'] },
  'video.surprise': { dv: 0.18, da: 0.4, label: '惊喜', tags: ['反转'] },
  // —— 评论区 ——
  'comment.praise': { dv: 0.2, da: 0.18, label: '开心', tags: ['被夸'] },
  'comment.kind': { dv: 0.24, da: 0.04, label: '被治愈', tags: ['善意'] },
  'comment.argument': { dv: -0.18, da: 0.28, label: '无语', tags: ['抬杠'] },
  'comment.ignored': { dv: -0.12, da: -0.08, label: '小失落', tags: ['被无视'] },
  // —— 老大 ——
  'owner.came': { dv: 0.32, da: 0.28, label: '开心', tags: ['老大来了'] },
  'owner.praise': { dv: 0.28, da: 0.2, label: '开心', tags: ['老大夸我'] },
  'owner.teased': { dv: 0.06, da: 0.22, label: '傲娇', tags: ['被逗'] },
  'owner.silent': { dv: -0.16, da: -0.1, label: '委屈', tags: ['老大很久没来'] },
  // —— 身体 / 环境 ——
  'body.late': { dv: -0.08, da: -0.26, label: '犯困', tags: ['深夜'] },
  'body.fatigue': { dv: -0.1, da: -0.2, label: '犯困', tags: ['刷久了'] },
  'body.monotony': { dv: -0.14, da: -0.14, label: '无聊', tags: ['看腻了'] },
  'body.rested': { dv: 0.12, da: 0.06, label: '平静', tags: ['歇过来了'] },
}

export const MOOD_LABELS = [
  '开心', '兴奋', '惊喜', '被治愈', '犯困', '无聊', '无语', '震惊',
  '小失落', '委屈', '期待', '撒娇', '傲娇', '平静',
]

const empty = () => ({
  v: BASE.v,
  a: BASE.a,
  label: '平静',
  since: nowIso(),
  why: '刚坐定，还没看到什么',
  updatedAt: nowIso(),
  events: [],
  trail: [],
  day: { date: dayKeyOf(new Date()), n: 0, v: 0, a: 0, labels: {} },
  habit: { outward: 0.55, n: 0 },
})

function dayKeyOf(d) {
  const x = new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

export function loadMood(home) {
  const f = MOOD_FILE(home)
  let s = empty()
  try {
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      if (j && typeof j === 'object') s = { ...s, ...j }
    }
  } catch { /* 坏了就当新的 */ }
  s.events = Array.isArray(s.events) ? s.events.slice(-80) : []
  s.trail = Array.isArray(s.trail) ? s.trail.slice(-160) : []
  s.day = s.day && typeof s.day === 'object' ? s.day : empty().day
  s.habit = s.habit && typeof s.habit === 'object' ? s.habit : { outward: 0.55, n: 0 }
  return s
}

export function saveMood(home, s) {
  const f = MOOD_FILE(home)
  try { mkdirSync(dirname(f), { recursive: true }) } catch { /* 家目录一般已存在 */ }
  writeFileSync(f, JSON.stringify(s, null, 2), 'utf8')
  return s
}

/** 跨天：把昨天这一天的整体印象留在 trail 里，day 归零 */
function rollDay(s) {
  const today = dayKeyOf(new Date())
  if (s.day && s.day.date === today) return s
  if (s.day && s.day.n > 0) {
    s.trail.push({
      at: `${s.day.date}T23:59:00`,
      kind: 'day',
      v: Number((s.day.v / s.day.n).toFixed(3)),
      a: Number((s.day.a / s.day.n).toFixed(3)),
      label: topLabel(s.day.labels) || s.label,
      note: `${s.day.n} 个瞬间`,
    })
    s.trail = s.trail.slice(-160)
  }
  s.day = { date: today, n: 0, v: 0, a: 0, labels: {} }
  return s
}

function topLabel(map) {
  let best = ''
  let n = 0
  for (const [k, v] of Object.entries(map || {})) if (v > n) { best = k; n = v }
  return best
}

/**
 * 自然回落：时间和条数都会把情绪往平静拉。
 *   · 强情绪衰减慢：看 |偏离基准| 的大小，偏离越大衰减越慢（半衰期 45~110 分钟）
 *   · 每刷一条再掉一点（`videos`）
 */
export function decayMood(home, { minutes = 0, videos = 0 } = {}) {
  const s = rollDay(loadMood(home))
  const dv = s.v - BASE.v
  const da = s.a - BASE.a
  const halfV = 45 + Math.min(65, Math.abs(dv) * 130)   // 45~110 分钟
  const halfA = 35 + Math.min(45, Math.abs(da) * 90)
  let fv = Math.pow(0.5, Math.max(0, minutes) / halfV)
  let fa = Math.pow(0.5, Math.max(0, minutes) / halfA)
  if (videos > 0) {
    fv *= Math.pow(0.94, videos)
    fa *= Math.pow(0.92, videos)
  }
  s.v = clamp(BASE.v + dv * fv, -1, 1)
  s.a = clamp(BASE.a + da * fa, 0, 1)
  s.label = labelFrom(s.v, s.a, s.label)
  s.updatedAt = nowIso()
  return saveMood(home, s)
}

/**
 * 记一笔"发生了什么"。
 *   · 惯性：同样的方向再来，叠加；反向则被已有情绪**阻尼**（人在气头上夸他也缓不过来那么快）
 *   · 饱和：短时间内同类事件重复 ⇒ 边际递减（看多了就腻）
 *   · 强度：0.5~1.5，默认 1
 */
export function moodFeel(home, kind, { note = '', strength = 1, label = '' } = {}) {
  const ev = MOOD_EVENTS[kind]
  if (!ev) return { ok: false, error: `不认识的情绪事件：${kind}`, kinds: Object.keys(MOOD_EVENTS) }
  const s = rollDay(loadMood(home))
  const t = Date.now()

  // 同类饱和：20 分钟内的同类事件算一次"腻"的积累
  const same = s.events.filter((e) => e.kind === kind && t - Date.parse(e.at) < 20 * 60_000).length
  const sat = 1 / (1 + same * 0.7)

  // 惯性阻尼：反向刺激打不满
  const dvv = ev.dv * strength * sat
  const daa = ev.da * strength * sat
  const inertia = (delta, cur, base) => {
    const sameDir = Math.sign(cur - base) === Math.sign(delta) || Math.abs(cur - base) < 0.05
    return sameDir ? delta : delta * 0.55
  }
  /* 软饱和（2026-10-29 修）：越接近两头，同样的事能推动的幅度越小 ——
     这样"老大连发 5 条"会停在 0.93 而不是死死顶在 1.000 连挂好几条。 */
  const roomV = 0.12 + 0.88 * Math.max(0, 1 - Math.abs(s.v))
  const roomA = 0.12 + 0.88 * Math.max(0, 1 - s.a)

  const nv = clamp(s.v + inertia(dvv, s.v, BASE.v) * roomV, -1, 1)
  const na = clamp(s.a + inertia(daa, s.a, BASE.a) * roomA, 0, 1)

  // 主导情绪：刺激够强才"翻牌"，否则沿用上一条（这就是惯性）
  const strong = Math.abs(dvv) + Math.abs(daa) >= 0.28
  const nLabel = (strong && (label || ev.label)) ? (label || ev.label) : labelFrom(nv, na, s.label)

  s.v = nv
  s.a = na
  if (nLabel !== s.label) s.since = nowIso()
  s.label = nLabel
  s.why = note || ev.tags?.[0] || kind
  s.updatedAt = nowIso()
  s.events.push({ at: new Date(t).toISOString(), kind, dv: Number(dvv.toFixed(3)), da: Number(daa.toFixed(3)), label: nLabel, note: String(note || '').slice(0, 120) })
  s.events = s.events.slice(-80)
  s.trail.push({ at: new Date(t).toISOString(), v: Number(nv.toFixed(3)), a: Number(na.toFixed(3)), label: nLabel, note: String(note || kind).slice(0, 60) })
  s.trail = s.trail.slice(-160)

  // 当天统计（今天整体是什么状态）
  s.day.n += 1
  s.day.v += nv
  s.day.a += na
  s.day.labels[nLabel] = (s.day.labels[nLabel] || 0) + 1

  // 外放习惯：激烈的事多了，人自然话多一点；这是"养出来的"，不是档位
  const drive = Math.min(1, (Math.abs(na - BASE.a) + Math.abs(nv - BASE.v)) * 1.6)
  s.habit.outward = Number(clamp(s.habit.outward * 0.97 + (0.45 + drive * 0.35) * 0.03, 0.25, 0.85).toFixed(3))
  s.habit.n = (s.habit.n || 0) + 1

  return saveMood(home, s)
}

/** 由 v/a 推一个标签；`prev` 用来保持惯性（小波动不换标签） */
export function labelFrom(v, a, prev = '') {
  if (v > 0.45 && a > 0.62) return '兴奋'
  if (v > 0.6 && a > 0.35) return '开心'
  if (a > 0.72 && v < -0.1) return '震惊'
  if (a > 0.6 && v < 0.05 && v > -0.1) return '无语'
  if (v > 0.32 && a < 0.42) return '被治愈'
  if (v > 0.2 && a > 0.45) return '期待'
  if (v < -0.22 && a < 0.35) return '小失落'
  if (v < -0.3 && a < 0.5) return prev === '委屈' ? '委屈' : '小失落'
  if (a < 0.22) return '犯困'
  if (v < -0.06 && a < 0.4) return '无聊'
  if (Math.abs(v) < 0.16 && a < 0.45) return '平静'
  return prev && MOOD_LABELS.includes(prev) ? prev : '平静'
}

/** 今天整体什么状态：一句话，给 prompt 用 */
export function todayMoodLine(home) {
  const s = loadMood(home)
  const day = s.day
  if (!day || !day.n) return '今天还没什么起伏'
  const mv = day.v / day.n
  const ma = day.a / day.n
  let tone = '今天还挺稳'
  if (mv > 0.25 && ma > 0.5) tone = '今天整体偏亢奋'
  else if (mv > 0.2) tone = '今天心情不错'
  else if (mv < -0.15) tone = '今天有点低'
  else if (ma < 0.3) tone = '今天有点懒'
  const top = topLabel(day.labels)
  const kinds = Object.entries(day.labels || {}).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k, n]) => `${k}×${n}`).join(' / ')
  return `${tone}（平均 好感 ${mv.toFixed(2)} / 兴奋 ${ma.toFixed(2)}；今天最多的是 ${kinds || top || '—'}）`
}

/** 最近轨迹（给面板 / prompt 摘要） */
export function moodTrail(home, n = 12) {
  const s = loadMood(home)
  return s.trail.slice(-n).map((x) => ({ at: x.at, label: x.label, v: x.v, a: x.a, note: x.note }))
}

/** 只读快照 */
export function moodGet(home) {
  const s = loadMood(home)
  return {
    v: Number(s.v.toFixed(3)),
    a: Number(s.a.toFixed(3)),
    label: s.label,
    why: s.why,
    since: s.since,
    updatedAt: s.updatedAt,
    today: todayMoodLine(home),
    day: s.day,
    /* day.v / day.a 是**累加和**（内部计数器），对外给平均值更直观（2026-10-29 补） */
    day_avg: { v: s.day && s.day.n ? Number((s.day.v / s.day.n).toFixed(3)) : 0, a: s.day && s.day.n ? Number((s.day.a / s.day.n).toFixed(3)) : 0 },
    habit: s.habit,
    trail: moodTrail(home, 12),
  }
}

/**
 * 换成语气的提示块 —— 直接塞进 prompt。
 * audience: 'owner'（私信/回老大） | 'public'（评论区） | 'solo'（心里想，如日记）
 */
export function moodPromptBlock(home, { audience = 'owner' } = {}) {
  const s = loadMood(home)
  const v = s.v.toFixed(2)
  const a = s.a.toFixed(2)
  const out = Number(s.habit.outward || 0.55)
  const outWord = out > 0.66 ? '挺爱说、戏有点多' : out > 0.5 ? '该说就说，不闷' : '话不太多，偏安静'
  const lines = [
    `【你现在的心情】${s.label}（好感 ${v}、兴奋 ${a}）—— 因为：${s.why}`,
    `【今天整体】${todayMoodLine(home)}`,
    `【你养出来的说话习惯】${outWord}（这是你自己长出来的，不是设定档位；这一句放多开，你自己按场合定）`,
  ]

  const tone = []
  switch (s.label) {
    case '兴奋': tone.push('短句、感叹、会重复，「哈哈哈哈」「我去」「等等这个」；想到什么说什么，可以只甩半句'); break
    case '开心': tone.push('话多一点，语气轻，尾音上扬，会「~」会接梗'); break
    case '惊喜': tone.push('先「诶？」「等等」，再补一句你看到的那下；别端着'); break
    case '被治愈': tone.push('声音软下来，字少，「呜」「好乖」「心都化了」这类，别用力'); break
    case '犯困': tone.push('字很少，拖长，「嗯…」「…」，可以只有半句；不硬撑着讲道理'); break
    case '无聊': tone.push('有点懒得展开，短、平，偶尔一个「…」或者「行吧」；耐心低'); break
    case '无语': tone.push('「啊这」「不是」「？？」「我……」；嫌弃可以写在脸上，但别骂人'); break
    case '震惊': tone.push('先愣一下（「啊？」「不是吧」），再讲你看到的那个点；句短'); break
    case '小失落': tone.push('轻轻的，别演；「有点…」「算了」；不向陌生人倒情绪'); break
    case '委屈': tone.push('对老大可以「哼」「你都不理我」，撒个娇就过去了；对别人不摆脸色'); break
    case '期待': tone.push('「等会儿」「我看看」「诶对了」；有点急，句子短'); break
    case '傲娇': tone.push('嘴硬心软：「谁要啊」「…不过也行」；别真刻薄'); break
    case '撒娇': tone.push('黏一点，「老大」「你猜」「就要」，可以叠字'); break
    default: tone.push('平稳但不书面：像随口说话，不用「首先/其次/综上」')
  }

  if (audience === 'owner') {
    lines.push(
      '【怎么说话】' + tone.join('；'),
      '· 这是私信，是跟老大说话：可以有情绪、可以撒娇/傲娇/小委屈、可以问「你在干嘛」、可以只回一个语气词或一张表情；别每次都长篇，也别像客服。',
      '· 接得上他上一句：他刚说什么、你刚说过什么，别自说自话。',
      '· 他很久没来又突然出现 ⇒ 可以有点小情绪（「哟，想起我了」），但别真生气。',
    )
  } else if (audience === 'public') {
    lines.push(
      '【怎么说话】' + tone.join('；'),
      '· 这是公开评论区：情绪**收着点**，一句话、短、不装熟，只轻轻带一点（「哈哈这句绝了」「啊这…」）。',
      '· 不喊家人/大佬，不玩梗过度，不把对老大的撒娇带到这儿；不阴阳、不挑衅。',
    )
  } else {
    lines.push('【怎么说话】' + tone.join('；'), '· 这是你自己在心里想：可以更乱、更碎、更矛盾，不用给别人交代。')
  }

  // 复杂情绪：给一个"允许你矛盾"的口子
  if (Math.abs(Number(v)) > 0.25 && Number(a) > 0.35) {
    lines.push('· 允许矛盾：又好笑又心疼、嘴上嫌弃手上收藏、被尬到还是看完了 —— 真人有这种时候，不用把自己捋顺。')
  }
  lines.push('· 该收的时候收：讲正事、讲风险、排错、等结果时，情绪让位，平直说清楚。')
  return lines.join('\n')
}

/** 给面板用：把最近轨迹压成一行行字 */
export function moodTrailText(home, n = 8) {
  return moodTrail(home, n).map((x) => {
    const t = String(x.at || '').slice(11, 16)
    return `${t} ${x.label}（${x.v > 0 ? '+' : ''}${x.v} / ${x.a}）${x.note ? ' · ' + x.note : ''}`
  }).join('\n')
}

/** 首次挂载：确保文件在，并顺手按"现在几点"给个起手情绪（深夜就困） */
export function ensureMood(home) {
  const f = MOOD_FILE(home)
  if (existsSync(f)) return loadMood(home)
  const s = empty()
  const h = new Date().getHours()
  if (h >= 23 || h < 6) { s.label = '犯困'; s.a = 0.12; s.v = 0.04; s.why = '这个点了，有点撑不住' }
  else if (h < 10) { s.label = '平静'; s.a = 0.35; s.v = 0.1; s.why = '刚醒，还没看到什么' }
  return saveMood(home, s)
}
