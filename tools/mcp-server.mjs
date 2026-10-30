#!/usr/bin/env node
/**
 * tools/mcp-server.mjs —— 把「刷抖音」的能力通过 MCP 暴露出去，别的 agent 工具也能直接用。
 *
 * 为什么要有它：
 *   插件本体是 DSH 的 bundle —— 只有在 DSH 里才看得见 `douyin_*` 工具。
 *   但使用者可能还想让**别的 agent 工具**（Claude Code / Codex / Cursor / Cline /
 *   另一个 DSH profile …）也能用同一套能力。MCP 是这些工具共同的接口。
 *
 * 🔴 三条设计约束（别改）：
 *   ① **零依赖**：只用 Node 内置模块。这个包没有 node_modules，也不能为了 MCP
 *      再拉一个 SDK 进来（那会把"装插件"变成"装前端工程"）。
 *   ② **stdout 只许出 JSON-RPC**：任何调试信息一律走 stderr。
 *      MCP 的 stdio 传输就是"一行一个 JSON"，多打一个字都会把客户端弄崩。
 *   ③ **和插件共用同一批 tools/* 脚本** —— 不复制业务逻辑，行为跟 DSH 里那份一致。
 *
 * 协议：MCP 2025-06-18（legacy initialize 流程）。
 *   新客户端（如 DSH 的 dsh-mcp-client）会先探一次 `server/discover`（2026-07-28）；
 *   我们明确回 `-32601 Method not found`，它就会自动回落到 legacy —— 这是标准做法。
 *
 * 用法（别的 agent 工具的配置里写）：
 *   command: node
 *   args:    ["<插件目录>/tools/mcp-server.mjs"]
 *   env:     { "DOUYIN_HOME": "<插件家目录>" }
 *
 * 自测（不接任何客户端）：
 *   node tools/mcp-server.mjs --selftest
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
// 大肥鱼自主互动硬规则（与 host index.js 共用同一账本，MCP 调用也绕不过去）
import {
  canReplyTo, countReply, canProactiveComment, countProactiveComment,
  canShare, countShare,
  classifyReply, noteSkipped,
} from '../lib/engage.mjs'
// ⭐ v0.3.9 降风险控（与 host 共用同一份，值班轮走 MCP 也绕不过）
import {
  awaitGate, markAction, recordFailure, loadRateState, nurtureQuota,
} from '../lib/ratelimit.mjs'
// ⭐ v0.4.0 表情包库：收集 + 安全审核 + 只发 approved + 每日贴纸额度（与 host 共用同一份）
import {
  ingestStickers, listStickers, reviewSticker, stickerStats, stickerSentToday, markStickerSent,
} from '../lib/stickers.mjs'
// ⭐ v0.5.0 情绪内核：自己的心情（事件驱动、有惯性与衰减），只影响口气不影响该做的事
import {
  ensureMood, moodGet, moodFeel, decayMood, moodPromptBlock, MOOD_EVENTS,
} from '../lib/mood.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SERVER_NAME = 'douyin-scroll'
const SERVER_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0') } catch { return '0' }
})()

/** 插件家目录：DOUYIN_HOME → DSH_HOME/douyin-duty → ~/.dsh/douyin-duty（和 lib/paths.mjs 同一口径） */
const HOME = (() => {
  const fromEnv = String(process.env.DOUYIN_HOME || '').trim()
  if (fromEnv) return resolve(fromEnv)
  const dshHome = String(process.env.DSH_HOME || '').trim()
  return resolve(join(dshHome || join(homedir(), '.dsh'), 'douyin-duty'))
})()

/* ─────────────────────────── 子进程小工具 ─────────────────────────── */

const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  DOUYIN_HOME: HOME,
  ...extra,
})

const venvPython = () => process.platform === 'win32'
  ? join(HOME, '.venv', 'Scripts', 'python.exe')
  : join(HOME, '.venv', 'bin', 'python')

const hasVenv = () => existsSync(venvPython())

const PY = () => (hasVenv() ? venvPython() : (process.platform === 'win32' ? 'python' : 'python3'))

const run = (cmd, args, timeout = 240_000) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    env: pyEnv(),
    cwd: HOME,
    windowsHide: true,
  })
  return {
    status: r.status ?? -1,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || r.error || ''),
  }
}

const runNode = (script, args = [], timeout = 240_000) => run(process.execPath, [join(ROOT, 'tools', script), ...args], timeout)
const runPy = (script, args = [], timeout = 240_000) => run(PY(), [join(ROOT, 'tools', script), ...args], timeout)

const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

const pickJson = (s) => {
  const t = String(s || '')
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

/** 等一会儿（异步，不占 CPU —— 别用 busy-wait，那会把宿主烤热） */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

const dayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const config = () => readJson(join(HOME, 'config.json'), {}) || {}

/**
 * ⭐ 发出去之前的最后一道整理（2026-10-25 老大改了口径）。
 *    以前是把「老大，」硬钉在开头 —— 老大说太机械，要求**称呼按内容自然放置**。
 *    所以这里只做清理，**不再补前缀**；称呼由模型按上下文自己安排（prompt 里已交代）。
 *    与 host index.js 的 withTitle 同一套规则（MCP 是值班轮的主路径，两边必须一致）。
 */
const withTitle = (s, c) => {
  const name = String((c && c.ownerTitle) ?? '老大').trim()
  let body = String(s || '').trim().replace(/\s*——\s*/g, '，').replace(/\s*--+\s*/g, '，').replace(/，{2,}/g, '，')
  if (!body) return body
  if (name) {
    // 只收拾「连写两遍称呼」这种手滑，不动位置
    const dup = new RegExp(`^${name}[，,、\\s]+${name}[，,、\\s]*`)
    body = body.replace(dup, `${name}，`)
  }
  return body
}

/* ⭐⭐ v0.3.9 风控 + 私信铁闸（与 host index.js 同一套规则） ===================== */
/**
 * ⭐ 2026-10-25 老大改的口径（与 host index.js 的 capAfterNurture 一致）：
 *    默认 100/260，只在**养号前 3 天**真的生效；出了养号期还是默认值 ⇒ 传 0 = 不限。
 *    使用者手动把数字改掉了 ⇒ 那就按他改的继续卡（尊重他显式设置的值）。
 */
const lateCaps = (c) => {
  const H = 100, D = 260
  let nurturing = true
  try { nurturing = nurtureQuota(loadRateState(HOME), { nurtureMode: c.nurtureMode !== false, nurtureDays: Number(c.nurtureDays) || 3 }) < 1 } catch { nurturing = true }
  const h = Number(c.maxActionsPerHour) || H
  const d = Number(c.maxActionsPerDay) || D
  if (!nurturing) return { h: h === H ? 0 : h, d: d === D ? 0 : d }
  return { h, d }
}

const rateOpts = () => {
  const c = config()
  return {
    humanMode: c.humanMode !== false,
    safeQuiet: c.safeQuiet !== false,
    quietStart: String(c.quietStart || '23:55'),
    quietEnd: String(c.quietEnd || '08:00'),
    // ⭐ 2026-10-25：默认 100/260；**只有养号前 3 天真的卡**，之后不限额（手动改过数字才继续卡）
    maxActionsPerHour: lateCaps(c).h,
    maxActionsPerDay: lateCaps(c).d,
    nurtureMode: c.nurtureMode !== false,
    nurtureDays: Number(c.nurtureDays) || 3,
  }
}
const RATE_NOTE = {
  hard_circuit: '🔴 撞到验证码/登录失效/账号异常，已硬熔断，一段时间内停止一切外发（设置页可手动恢复）',
  cooldown: '撞了限流或连续失败，冷却中，先停手别再发',
  quiet_hours: '现在是夜间静默时段，不主动对外发（默认 23:00–08:00）',
  day_cap: '今天对外动作已到上限，明天再发',
  hour_cap: '这一小时动作太密，过会儿再发',
}
const rateBlocked = (g) => ({
  ok: false, blocked: true, sent: false, reason: g.reason,
  detail: g.detail || {}, waitMs: g.waitMs || 0,
  note: RATE_NOTE[g.reason] || '风控闸拦住了，先别发',
})
/** 私信铁闸：只允许老大（dmToId）。返回 null 放行，否则 blocked */
const ownerOnlyGate = (c, toId) => {
  const owner = String(c.dmToId || '').trim()
  const target = String(toId || '').trim()
  if (!owner) return { ok: false, blocked: true, reason: 'owner_not_set', sent: false, error: '还没设置老大的稳定 ID（dmToId），不能给任何人发私信', hint: '让使用者在设置里填「老大的稳定 ID（sec_uid）」' }
  if (!target) return { ok: false, blocked: true, reason: 'owner_not_set', sent: false, error: '没有收件人，且未配置老大', hint: '让使用者在设置里填「老大的稳定 ID（sec_uid）」' }
  if (target !== owner) return { ok: false, blocked: true, reason: 'owner_only', sent: false, error: '私信锁死：只和老大一人收发，不发给其他任何人', detail: { target } }
  return null
}
const rateFailFromText = (kind, ...parts) => {
  const text = parts.map((p) => (typeof p === 'string' ? p : (p?.error || p?.stderr || (p == null ? '' : JSON.stringify(p))))).join(' ')
  return recordFailure(HOME, kind, text, rateOpts())
}

const cookieOk = () => {
  try { return existsSync(join(HOME, 'douyin_cookie.txt')) && readFileSync(join(HOME, 'douyin_cookie.txt'), 'utf8').trim().length > 0 } catch { return false }
}

const PICK_RE = /^#{2,3}[ \t]*(\d{15,25})/gm
const countPicks = (file) => {
  try {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
    const ids = new Set()
    for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
    return ids.size
  } catch { return 0 }
}

/* ─────────────────────────── 工具实现 ─────────────────────────── */

const needSetup = () => {
  if (!hasVenv()) return { ok: false, error: '还没装运行环境', hint: '在 DSH 设置页「刷抖音 → ② 装主依赖」点一下（建 venv，装 curl_cffi + httpx）' }
  return null
}

const needLogin = () => {
  if (!cookieOk()) return { ok: false, error: '还没有登录', hint: '在 DSH 设置页扫码，或命令行跑 node tools/qr-login.mjs start；也可以直接粘 Cookie' }
  return null
}

const TOOLS = [
  /* ── 体检 / 状态 ── */
  {
    name: 'douyin_status',
    title: '刷抖音 · 今日状态',
    description: '看今天跑了没跑、挑了几条、额度剩多少、报告在哪、登录/环境是否就绪。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const cfg = config()
      const st = readJson(join(HOME, 'state.json'), {}) || {}
      const report = join(HOME, 'out', `${dayKey()}.md`)
      return {
        ok: true,
        home: HOME,
        loggedIn: cookieOk(),
        venvReady: hasVenv(),
        perDay: Number(cfg.perDay ?? 5),
        pickedToday: countPicks(report),
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        report,
        hasReport: existsSync(report),
        note: '这只是状态；要真的刷一轮，请让使用者在 DSH 设置页点「现在跑一轮」，或调 douyin_forward 取候选。',
      }
    },
  },
  {
    name: 'douyin_doctor',
    title: '刷抖音 · 环境体检',
    description: '检查家目录、Node、Python、venv、Cookie、浏览器、CDP、关键文件、人设。装完插件第一件事就跑它。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const r = runNode('doctor.mjs', ['--json'], 90_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检脚本没返回可解析结果', stderr: String(r.stderr || '').slice(0, 300) }
      return { ...j, hint: (j.must_fix || []).length ? '先把 must_fix 里的修掉' : '没有硬伤' }
    },
  },
  {
    name: 'douyin_whoami',
    title: '刷抖音 · 登录状态',
    description: '看抖音登录还在不在、当前是哪个号。只读，不影响登录态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      const bad = needLogin()
      if (bad) return bad
      const r = runPy('session-guard.py', ['check'], 90_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检没返回结果', stderr: String(r.stderr || '').slice(0, 300) }
      return { ok: true, logged_in: j.alive === true, ...j }
    },
  },

  /* ── 取候选 ── */
  {
    name: 'douyin_forward',
    title: '刷抖音 · 取一轮候选',
    description: '拉推荐流候选并打分，返回清单（含官方分享链接 share_url）。只用只读接口，不碰写接口，不影响登录态。',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: '返回前几条（默认 10，最多 30）' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const top = Math.max(1, Math.min(Number(args?.top) || 10, 30))
      const r = runPy('forward-pick.py', ['--limit', String(top)], 300_000)
      if (r.status !== 0) return { ok: false, error: '取候选失败', stderr: String(r.stderr || '').slice(0, 400) }
      const picked = readJson(join(HOME, 'forward-pick.json'), {}) || {}
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, top)
      return {
        ok: true,
        picked: rows.length,
        sources: picked.meta || [],
        frames: picked.frames || { on: false },
        // ⭐ v0.4.0 台词来源统计（official_subtitle / asr / none）
        spoken: (picked.frames && picked.frames.spoken) || { official_subtitle: 0, asr: 0, none: 0 },
        dropped: picked.dropped || {},
        list: rows.map((x) => ({
          aweme_id: x.aweme_id,
          desc: x.desc,
          author: x.author,
          duration_s: x.duration_s,
          age_h: x.age_h,
          digg: x.digg,
          comment: x.comment,
          collect: x.collect,
          share: x.share,
          share_url: x.share_url,
          web_url: x.web_url,
          // ⭐ 画面证据：相对工作区（插件家）的帧路径，用 Read 打开看封面/关键帧；frames_kind=none 就只看文本
          frames: Array.isArray(x.frames) ? x.frames : [],
          frames_kind: x.frames_kind || 'none',
          // ⭐ v0.4.0 台词：官方字幕或本地 Whisper（无则空串、kind=none/off）
          spoken: typeof x.spoken === 'string' ? x.spoken : '',
          spoken_kind: x.spoken_kind || 'none',
        })),
      }
    },
  },
  {
    name: 'douyin_comments',
    title: '刷抖音 · 读评论',
    description: '取一个作品下的评论（签名的只读接口，带楼中楼）。判断「好不好玩」的主要文本依据。',
    inputSchema: {
      type: 'object',
      properties: { aweme_id: { type: 'string', description: '作品/图文 ID' } },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const id = String(args?.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺 aweme_id' }
      const r = runPy('api-comments.py', [id], 300_000)
      const lines = String(r.stdout || '').split('\n')
      const items = lines.filter((l) => /^\s{2}cid=|^\s{6}└ /.test(l)).map((s) => s.replace(/^\s+/, ''))
      if (r.status !== 0) return { ok: false, error: '拉评论失败', stderr: String(r.stderr || '').slice(0, 300) }
      // ⭐ v0.4.0 评论里看到的贴纸收进表情库（先待审，approve 才可用）
      let stickers = { added: 0, blocked: 0, pending: 0, dup: 0 }
      if (config().collectSticker !== false) {
        const line = lines.find((l) => l.startsWith('STICKERS_JSON='))
        if (line) { try { stickers = ingestStickers(HOME, JSON.parse(line.slice('STICKERS_JSON='.length))) } catch { /* 忽略坏行 */ } }
      }
      return {
        ok: true,
        aweme_id: id,
        count: items.filter((s) => s.startsWith('cid=')).length,
        comments: items,
        stickers,
        stickerLibrary: stickerStats(HOME),
      }
    },
  },
  {
    name: 'douyin_notices',
    title: '刷抖音 · 互动通知',
    description: '读抖音互动通知：谁 @ 了你（含别人评论区里的 @）、谁关注/评论/点赞。只读，不改已读状态。',
    inputSchema: {
      type: 'object',
      properties: { raw: { type: 'boolean', description: '连原始条目一起返回（默认 false）' } },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const argv = [join(ROOT, 'tools', 'notice-read.py')]
      if (args?.raw) argv.push('--raw')
      const r = run(venvPython(), argv, 150_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
      return j
    },
  },

  /* ── 发送（全部要 confirm） ── */
  {
    name: 'douyin_share_card',
    title: '刷抖音 · 分享卡片给好友',
    description: '把视频以抖音分享卡片发给好友（不是文字链接 —— 文字链接在抖音里点不开）。'
      + '先发卡片、隔几秒再发 reason。受每日分享上限（设置 sharePerDay，默认 5）。'
      + '值班轮自动跑时按章程传 confirm:true；手动调用先给人看预览再发。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '视频 ID（19 位）；不给就用最近一轮清单里的' },
        to: { type: 'string', description: '好友昵称（只用于显示）；留空用配置 dmTo' },
        to_id: { type: 'string', description: '好友稳定 id（sec_uid）；重名时必须给；留空用配置 dmToId' },
        top: { type: 'number', description: '不给 aweme_id 时发清单前 N 条（默认 1，最多 3）' },
        reason: { type: 'string', description: '卡片之后单独发的一条正文：为什么值得看（≤300 字）' },
        reason_delay_sec: { type: 'number', description: '卡片发出后隔几秒再发 reason（默认 5）' },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回预览' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const to = String(args?.to || cfg.dmTo || '').trim()
      const toId = String(args?.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或让使用者在设置里填「私信发给谁」+「稳定 ID」' }
      const ob = ownerOnlyGate(cfg, toId)
      if (ob) return ob
      const reasonText = withTitle(String(args?.reason || '').trim(), cfg)
      let ids = []
      if (args?.aweme_id) ids = [String(args.aweme_id).trim()]
      else {
        const rows = readJson(join(HOME, 'forward-pick.json'), {})?.rows || []
        ids = rows.slice(0, Math.max(1, Math.min(Number(args?.top) || 1, 3))).map((r) => String(r.aweme_id))
      }
      if (!ids.length) return { ok: false, error: '没有可用视频 ID', hint: '先调 douyin_forward 拉一轮' }
      if (args?.confirm !== true) {
        const rows = readJson(join(HOME, 'forward-pick.json'), {})?.rows || []
        return {
          ok: true, sent: false, needsConfirm: true, to, count: ids.length,
          preview: ids.map((id) => {
            const r = rows.find((x) => String(x.aweme_id) === id) || {}
            return { aweme_id: id, desc: String(r.desc || '').slice(0, 60), author: r.author || '', share_url: r.share_url || '' }
          }),
          reason: String(args?.reason || '').trim() || undefined,
          note: '没发送 —— 先把预览给使用者看，他点头后再用 confirm:true 调一次',
        }
      }
      /* 大肥鱼每日分享上限 —— ⚠️ 2026-10-25 起**默认不限**：发几条由它自己判断；
         只有把 sharePerDay 显式设成 > 0 时这个旧上限才生效 */
      const shareCapMax = Number(cfg.sharePerDay ?? 0)
      if (shareCapMax > 0) {
        const shareCap = canShare(HOME, shareCapMax)
        if (!shareCap.ok) {
          noteSkipped(HOME, 'share_cap')
          return { ok: false, blocked: 'share_cap', error: `今天给老大分享卡片已到上限（${shareCap.used}/${shareCap.max} 条）—— 好东西也别刷屏，明天再继续` }
        }
        if (ids.length > shareCap.left) ids = ids.slice(0, shareCap.left)
      }
      // ⭐ 需求⑥：分享必须带一句自己的看法
      if (!reasonText) {
        return {
          ok: false, blocked: true, reason: 'need_reason', sent: false,
          error: '分享给老大必须带一句你自己的看法（reason）：这条视频哪里好、为什么想给老大看',
          hint: '补一两句口语化的 reason，再 confirm:true',
        }
      }
      // ⭐ 风控闸（v0.3.9）
      // ⭐ 私信分享额度与评论区 @ 老大**分开记**（kindDayCap；0 = 不限），互不挤占
      const gate = await awaitGate(HOME, 'share', { ...rateOpts(), kindDayCap: Number(config().shareDmPerDay) || 0 })
      if (!gate.ok) return rateBlocked(gate)
      const sent = []
      for (let i = 0; i < ids.length; i++) {
        const argv = [ids[i], to]
        if (toId) argv.push('--to-id', toId)
        const r = runNode('card-share.mjs', argv, 200_000)
        const j = pickJson(r.stdout) || { ok: false, aweme_id: ids[i], stderr: String(r.stderr || '').slice(0, 200) }
        sent.push(j)
        if (!(j && j.ok)) break
        if (i < ids.length - 1) await sleep(2200)
      }
      const okN = sent.filter((x) => x && x.sent).length
      if (okN) countShare(HOME, okN)
      let reason = null
      if (okN && reasonText) {
        const gap = Math.max(0, Math.min(Number(args?.reason_delay_sec ?? 5) || 0, 60))
        if (gap > 0) await sleep(gap * 1000)
        const rArgs = []
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        rArgs.push('--text', reasonText)
        const r3 = runNode('im-send.mjs', rArgs, 240_000)
        reason = pickJson(r3.stdout) || { ok: false, error: '理由那一条没返回可解析结果' }
      }
      // ⭐ 风控记账（v0.3.9）
      const allOk = okN === ids.length && (!reason || reason.ok)
      if (okN && allOk) markAction(HOME, 'share', rateOpts())
      else if (okN || sent.some((x) => x && !x.ok)) rateFailFromText('share', JSON.stringify(sent), reason && !reason.ok ? reason.error : '')
      return {
        ok: allOk,
        sent: okN, total: ids.length, to,
        results: sent.map((x) => ({ aweme_id: x.aweme_id, ok: !!x.ok, sent: !!x.sent, error: x.error })),
        reason: reason || undefined,
        note: '卡片是否真的落地，请让使用者自己在抖音里看一眼（这个 MCP 版没做回读）',
      }
    },
  },
  {
    name: 'douyin_dm',
    title: '刷抖音 · 发私信',
    description: '发一条私信给抖音好友（无头浏览器，页面自己签名）。🔴 先问使用者，confirm:true 才发。'
      + '要给视频请用 douyin_share_card（先卡片后文字）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '好友昵称（只用于显示）；留空用配置 dmTo' },
        to_id: { type: 'string', description: '好友稳定 id（sec_uid）；留空用配置 dmToId' },
        text: { type: 'string', description: '私信正文（与 sticker_key 二选一）。⭐ 想连发几条就**用换行分段**，工具会一条条发出去（像真人连发）；不必每句都带称呼，一段里出现一次即可，位置随内容自然安排' },
        sticker_key: { type: 'string', description: '给老大发一张图片表情：表情库 key（必须已审核 approved），走聊天框图片上传，受每日贴纸上限' },
        dry: { type: 'boolean', description: '只验证通道，不真发' },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回草稿' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const to = String(args?.to || cfg.dmTo || '').trim()
      const toId = String(args?.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或让使用者在设置里填私信对象' }
      // ⭐ 私信铁闸（v0.3.9）：只发给老大
      const ob = ownerOnlyGate(cfg, toId)
      if (ob) return ob
      const text = withTitle(String(args?.text || '').trim(), cfg)
      // ⭐ 图片表情（sticker_key）：只发给老大
      const skey = String(args?.sticker_key || '').trim()
      if (skey) {
        const st = listStickers(HOME, { status: 'all', limit: 500 }).find((x) => x.key === skey)
        if (!st) return { ok: false, error: '表情库里没有这个 key' }
        if (cfg.stickerSafeOnly !== false && st.status !== 'approved') {
          return { ok: false, blocked: 'not_approved', status: st.status,
            error: st.status === 'blocked' ? '这张表情审核没过，不能发' : '这张表情还没审核：先 Read thumb 用 douyin_sticker_review 放行' }
        }
        const imgUrl = String(st.url || st.thumb || '').trim()
        if (!imgUrl) return { ok: false, unsupported: 'no_image_url', error: '这张表情没有可上传的图片地址' }
        const perDay = Math.max(0, Number(cfg.stickerPerDay ?? 0) || 0)
        const usedToday = stickerSentToday(HOME)
        // ⭐ 2026-10-25 老大要求「发几个表情不设上限」⇒ perDay=0 = 不限（以前 0 是"禁止"）
        if (perDay > 0 && usedToday >= perDay) return { ok: false, blocked: 'sticker_cap', used: usedToday, max: perDay, error: `今天发表情已到上限（${usedToday}/${perDay}），明天再发` }
        if (args?.confirm !== true) {
          return { ok: true, sent: false, needsConfirm: true, kind: 'image', to, to_id: toId || undefined,
            sticker: { key: st.key, name: st.name, kind: st.kind, thumb: st.thumb, url: imgUrl },
            quota: { stickerToday: `${usedToday}/${perDay}` }, note: '没发送 —— 确认合适后 confirm:true（只发给老大）。' }
        }
        if (args?.dry !== true) {
          const g = await awaitGate(HOME, 'dm', rateOpts())
          if (!g.ok) return rateBlocked(g)
        }
        const a2 = []
        if (to) a2.push('--to', to)
        if (toId) a2.push('--to-id', toId)
        a2.push('--image', imgUrl)
        if (args?.dry) a2.push('--dry')
        const r2 = runNode('im-send.mjs', a2, 300_000)
        const j2 = pickJson(r2.stdout)
        if (!j2) { if (args?.dry !== true) rateFailFromText('dm', r2.stdout, r2.stderr); return { ok: false, error: '图片发送器没返回可解析结果', stderr: String(r2.stderr || '').slice(0, 300) } }
        if (j2.unavailable === 'image_uploader') {
          return { ok: false, sent: false, unavailable: 'image_uploader', error: j2.error || '聊天框没有图片上传入口；评论区平台贴纸不受影响。' }
        }
        if (j2.sent && args?.dry !== true) { markAction(HOME, 'dm', rateOpts()); markStickerSent(HOME, st.key) }
        else if (!j2.ok && !j2.sent && args?.dry !== true) rateFailFromText('dm', j2, r2.stdout, r2.stderr)
        return j2
      }
      if (!text) return { ok: false, error: '正文为空（传 text 或 sticker_key）' }
      // ⭐ 视频链接拦截：视频一律走官方分享卡片
      if (/v\.douyin\.com|douyin\.com\/video|iesdouyin\.com\/share|\.iesdouyin\.net/i.test(text)) {
        return {
          ok: false, blocked: true, reason: 'use_share_card',
          error: '正文里有抖音视频链接 —— 视频请走 douyin_share_card 官方分享卡片；这条文字只留你对视频的看法',
          hint: '先 douyin_share_card({aweme_id, reason, confirm:true})，纯文字想法由它的 reason 带上',
        }
      }
      if (args?.confirm !== true) {
        return { ok: true, sent: false, needsConfirm: true, to, to_id: toId || undefined, draft: text.slice(0, 1500), len: text.length, note: '没发送 —— 先把草稿给使用者看' }
      }
      if (args?.dry !== true) {
        // ⭐ 2026-10-25：私信只发给老大（owner_only）⇒ 夜间静默 + 小时/日上限豁免；
        //    拟人间隔与熔断照旧（公开动作的上限不受影响）。
        const g = await awaitGate(HOME, 'dm', {
          ...rateOpts(), safeQuiet: false, maxActionsPerHour: 999, maxActionsPerDay: 999,
        })
        if (!g.ok) return rateBlocked(g)
      }
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      argv.push('--text', text)
      if (args?.dry) argv.push('--dry')
      const r = runNode('im-send.mjs', argv, 240_000)
      const j = pickJson(r.stdout)
      if (!j) { if (args?.dry !== true) rateFailFromText('dm', r.stdout, r.stderr); return { ok: false, error: '发送器没返回可解析结果', stderr: String(r.stderr || '').slice(0, 300) } }
      if (j.sent && args?.dry !== true) markAction(HOME, 'dm', rateOpts())
      else if (!j.ok && !j.sent && args?.dry !== true) rateFailFromText('dm', j, r.stdout, r.stderr)
      return j
    },
  },
  {
    name: 'douyin_comment_reply',
    title: '刷抖音 · 发评论 / 回复评论',
    description: '在评论区发一条评论，或回复某条评论（一条 fetch，不点 UI，不弹短信验证，1 秒）。'
      + '⚠️ 这条发的是**普通评论/回复**：正文里的「@昵称」只是文字，对方收不到 @ 通知；'
      + '但**回复**会让对方收到「回复了我的评论」通知。'
      + '⭐ 对方那条在**楼中楼**里（别人楼下）时，还要传 root_comment_id（楼根）—— '
      + '不然通知会发给楼主而不是他。楼根从 douyin_notices / douyin_at_me 的返回里直接拿。'
      + '🔴 大肥鱼规矩：**不给 comment_id 是主动顶层评论**，受每日上限（默认 3，不是每条都评）；'
      + '**给 comment_id 是回复别人**，再带上 reply_to_uid / reply_to_text —— 工具会硬拦「同一人每天最多回 2 次」和「恶意/抬杠/引流/索要隐私」。'
      + '🔴 要真 @ 用 douyin_comment_mention。值班轮自动跑时按章程传 confirm:true；手动调用先给人看草稿。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '作品/图文 id' },
        text: { type: 'string', description: '评论正文（≤500 字）' },
        comment_id: { type: 'string', description: '要回复的评论 cid；留空 = 发顶层评论（主动评论，受每日上限）。可以是顶层评论，也可以是楼中楼里的某条' },
        root_comment_id: {
          type: 'string',
          description: '【可选】楼根 cid（这栋楼第一条顶层评论）。回复**楼中楼**时用；'
            + '不给会自动判，判不出来会拒绝发送（不会瞎猜）。',
        },
        reply_to_uid: { type: 'string', description: '【回复别人时建议带】对方 uid（douyin_at_me 返回）；用于「同一人每天最多回 2 次」硬计数' },
        reply_to_text: { type: 'string', description: '【回复别人时建议带】对方那条评论原文；用于「只回善意/好回答的」硬兜底' },
        confirm: { type: 'boolean', description: '🔴 值班轮自动跑时按章程传 true；手动调用先给使用者看草稿' },
      },
      required: ['aweme_id', 'text'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const aweme = String(args?.aweme_id || '').trim()
      const rawText = String(args?.text || '').trim()
      const replyTo = String(args?.comment_id || '').trim()
      const rootCid = String(args?.root_comment_id || '').trim()
      const replyToUid = String(args?.reply_to_uid || '').trim()
      const replyToText = String(args?.reply_to_text || '').trim()
      const cfg = config()
      const text = withTitle(rawText, cfg)
      if (!aweme) return { ok: false, error: '缺 aweme_id' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字）` }
      if (args?.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, aweme_id: aweme,
          comment_id: replyTo || '(顶层评论)',
          root_comment_id: rootCid || '(自动判)',
          draft: text, len: text.length,
          how: replyTo
            ? (rootCid ? `楼中楼回复：reply_id=${rootCid}、reply_to_reply_id=${replyTo}`
              : `楼中楼回复：楼根自动判、reply_to_reply_id=${replyTo}`)
            : '顶层普通评论：**不会通知任何人**',
          note: '没发送 —— 先把草稿给使用者看',
        }
      }
      /* ── 大肥鱼自主行为硬规则（与 host 共用 lib/engage.mjs） ── */
      if (!replyTo) {
        // 顶层主动评论：不是每条都评，受每日上限（默认 3）
        const cap = canProactiveComment(HOME, Number(cfg.proactiveCommentPerDay ?? 0))
        if (!cap.ok) {
          noteSkipped(HOME, 'proactive_cap')
          return { ok: false, blocked: 'proactive_cap', error: `今天主动评论已到上限（${cap.used}/${cap.max} 条）—— 不是每条都评`, hint: '去设置把「每天最多主动评论几条」调大，或明天再发。' }
        }
      }
      if (replyTo) {
        if (cfg.replyKindOnly !== false && replyToText) {
          const c = classifyReply(replyToText)
          if (!c.ok) {
            noteSkipped(HOME, c.reason, replyToUid)
            return { ok: false, blocked: 'unfriendly', skipped: c.reason, error: `对方这条属于「${c.label}」，按规矩不回（只回善意、好回答的）` }
          }
        }
        const rc = canReplyTo(HOME, replyToUid, { perPerson: Number(cfg.replyPerPerson ?? 2), perDay: Number(cfg.replyPerDay ?? 0) })
        if (!rc.ok) {
          noteSkipped(HOME, rc.reason, replyToUid)
          if (rc.reason === 'person_cap') {
            return { ok: false, blocked: 'person_cap', person_used: rc.personUsed, per_person: rc.perPerson, error: `今天已经回过这个人 ${rc.personUsed} 次（上限 ${rc.perPerson} 次/人/天）—— 不再回，避免拉锯/招黑` }
          }
          return { ok: false, blocked: 'daily_cap', used: rc.used, max: rc.max, error: `今天回复别人已到上限（${rc.used}/${rc.max} 条），明天再回` }
        }
      }
      // ⭐ 风控闸（v0.3.9）：回复=reply，顶层主动评论=comment
      const rlKind = replyTo ? 'reply' : 'comment'
      const rlGate = await awaitGate(HOME, rlKind, rateOpts())
      if (!rlGate.ok) return rateBlocked(rlGate)
      const argv = ['--aweme', aweme, '--text', text]
      if (replyTo) argv.push('--reply', replyTo)
      if (rootCid) argv.push('--root', rootCid)
      const r = runNode('comment-api.mjs', argv, 260_000)
      const j = pickJson(r.stdout)
      if (!j) { rateFailFromText(rlKind, r.stdout, r.stderr); return { ok: false, error: '发送器没返回可解析结果', stderr: String(r.stderr || '').slice(0, 300) } }
      if (j.need_root) {
        return {
          ok: false, need_root: true, ...j,
          hint: '这条 cid 在楼中楼里，但判不出楼根 ⇒ **没发出**。'
            + '先 douyin_notices / douyin_at_me 读一次拿 root_comment_id，再传进来。',
        }
      }
      // 403 限流：喂风控（会冷却），别重试
      if (j.http === 403 || /403|Forbidden|频繁|验证码|登录失效/i.test(String(j.error || j.head || ''))) {
        rateFailFromText(rlKind, '403 限流 ' + String(j.error || j.head || ''))
        return { ok: false, blocked: true, reason: 'cooldown', rate_limited: true, ...j, hint: '抖音限流了，风控已进入冷却，别重试（设置页可手动恢复）。' }
      }
      // 真发成功才记账（业务额度 + 风控节奏）
      if (j.ok) {
        markAction(HOME, rlKind, rateOpts())
        if (replyTo) countReply(HOME, replyToUid)
        else countProactiveComment(HOME)
      } else {
        rateFailFromText(rlKind, j, j.error || j.head || '')
      }
      // 核实"真的进了楼没有"（脚本发完会重读那一楼）
      if (j.ok && j.placement && j.placement.ok === false) {
        j.warning = j.placement.warn
      }
      return j
    },
  },

  /* ── 读私信 / 说明 ── */
  {
    name: 'douyin_im_read',
    title: '刷抖音 · 读私信',
    description: '读最近一个会话的消息，每条带 from（me/them/unknown），能分清谁说的。只读。'
      + '⭐ 会自动带上记忆（context）：之前聊过什么、这个人的长期事实。回话前先看它。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '会话昵称；留空用配置 dmTo' },
        to_id: { type: 'string', description: '稳定 id（sec_uid）；重名时给' },
        limit: { type: 'number', description: '返回最近几条（默认 30，最多 60）' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const to = String(args?.to || cfg.dmTo || '').trim()
      const toId = String(args?.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道读谁的会话' }
      // ⭐ 私信铁闸（v0.3.9）：只读老大的会话，其他人的一律不看
      const ob = ownerOnlyGate(cfg, toId)
      if (ob) return { ...ob, action: 'read' }
      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNode('im-send.mjs', argv, 240_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '读不到会话', stderr: String(r.stderr || '').slice(0, 300) }
      if (!j.ok) return j
      const all = Array.isArray(j.messages) ? j.messages : []
      const limit = Math.max(1, Math.min(Number(args?.limit) || 30, 60))
      // ⭐ v0.4.0 聊天里的表情图顺手收集（只收对方发来的，先待审、安全通过才可用）
      let stickers = { added: 0, blocked: 0, pending: 0, dup: 0 }
      if (cfg.collectSticker !== false) {
        try {
          const recs = all
            .filter((m) => m && m.from === 'them' && typeof m.sticker === 'string' && /^https?:/.test(m.sticker))
            .map((m) => ({ url: m.sticker, thumb: m.sticker, kind: 'gif', source: 'dm', name: '' }))
          if (recs.length) stickers = ingestStickers(HOME, recs)
        } catch { /* 收集失败不影响读私信 */ }
      }
      return {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid, count: j.count,
        mine: j.mine, them: j.them, unknown: j.unknown,
        messages: all.slice(-limit),
        their_latest: all.filter((m) => m.from === 'them').slice(-3).reverse(),
        stickers,
        stickerLibrary: stickerStats(HOME),
      }
    },
  },
  {
    name: 'douyin_at_me',
    title: '刷抖音 · 谁在评论区跟我说话',
    description: '把「谁 / 在哪个视频 / 说了什么 / 是 @ 我还是回复我」整理好。只读。含两类：'
      + '① @ 我（type 45/46）② **回复了我的评论**（type 31/32，每条带 uid、comment_id、root_comment_id、replying_to）。'
      + '⭐ 回别人（type 31/32）一律用 douyin_comment_reply mode=api（默认），并把返回的 uid 传 reply_to_uid、原文传 reply_to_text：'
      + '工具会硬拦「同一人每天最多回 2 次」和「恶意/抬杠/引流/索要隐私」。**只回善意、好回答的；不好回的就不回。**',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多看几条（默认 10，最多 30）' },
        include_seen: { type: 'boolean', description: '连已经回过的也列出来' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const argv = [join(ROOT, 'tools', 'notice-read.py'), '--raw']
      const r = run(venvPython(), argv, 150_000)
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
      const ats = (Array.isArray(j.items) ? j.items : []).filter((x) => x && (x.type === 45 || x.type === 46 || x.type === 31 || x.type === 32))
      const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 30))
      const atN = ats.filter((x) => x.type === 45 || x.type === 46).length
      const replyN = ats.filter((x) => x.type === 31 || x.type === 32).length
      return {
        ok: true,
        at_n: atN,
        reply_n: replyN,
        total_n: ats.length,
        list: ats.slice(0, limit).map((a) => {
          const isReply = a.type === 31 || a.type === 32
          return {
            kind: isReply ? '回复了我的评论' : '@ 了我',
            nickname: a.nickname || '', uid: a.uid || '',
            content: String(a.content || '').slice(0, 300),
            aweme_id: a.aweme_id || undefined, comment_id: a.comment_id || undefined,
            root_comment_id: a.root_comment_id || undefined,
            replying_to: a.reply_to_text || undefined,
            video_url: a.video_url || undefined,
            created_at: a.create_time || undefined,
          }
        }),
        hint: ats.length
          ? '回别人（回复了我的评论）：douyin_comment_reply { aweme_id, comment_id, root_comment_id, text, reply_to_uid, reply_to_text, mode:"api", confirm:true }。'
            + '工具会硬拦「同一人每天最多回 2 次」和「恶意/抬杠/引流」；只回善意、好回答的。'
          : '最近没有新的 @ / 回复',
      }
    },
  },
  {
    /**
     * ⭐⭐ 真 @ 评论（2026-10-23 加，因使用者反馈"@ 不出来"）
     *
     * 🔴 背景：抖音的 @ 只有**UI 点选**才作数 —— API 直发时服务端会把 mention 的
     *    sec_uid 剥掉（名字变蓝、点开空页、对方收不到通知）。
     *    所以 `douyin_comment_reply` 只能发普通评论；**真 @ 必须走这个工具**，
     *    它内部跑 tools/comment-mention-ui.mjs：滚输入框 → 真实点开 DraftJS →
     *    CDP 键盘打 @ → 真实鼠标点弹层里那一行 → 补正文 → 点红色箭头发布。
     *
     * ⚠️ 前提：必须已登录、必须装了 Chrome（要起无头浏览器）、昵称要能在弹层里搜到。
     */
    name: 'douyin_comment_mention',
    title: '刷抖音 · 评论区真 @（UI 点选）',
    description: '在别人视频的评论区发一条**真正 @ 到某人**的评论（名字可点、对方收到通知）。'
      + '⚠️ 比普通评论慢（要起无头 Chrome 点选弹层），且要求昵称能在 @ 弹层里搜到。'
      + '🔴 先问使用者，confirm:true 才发。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '作品/图文 id' },
        name: { type: 'string', description: '要 @ 的人的抖音昵称（必须和对方昵称完全一致）' },
        text: { type: 'string', description: '评论正文（≤500 字；不用自己写 @昵称，工具会自动加）' },
        sec_uid: { type: 'string', description: '【可选】被 @ 人的 sec_uid —— 给了就走 API + text_extra（1 秒发出、有 cid），不给才用 UI 点选。@ 老大时不必给（自动用「私信发给谁」那位）' },
        confirm: { type: 'boolean', description: '🔴 必须由使用者当场同意后传 true，否则只回草稿' },
        dry: { type: 'boolean', description: 'true = 只走到点选完就停（不发布），用于验证昵称搜不搜得到' },
      },
      required: ['aweme_id', 'name', 'text'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const aweme = String(args?.aweme_id || '').trim()
      const name = String(args?.name || '').trim()
      const text = String(args?.text || '').trim()
      if (!aweme) return { ok: false, error: '缺 aweme_id' }
      if (!name) return { ok: false, error: '缺 name（要 @ 的昵称）' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字）` }
      // ⭐ 需求⑥（v0.3.9）：@ 老大看视频必须带一句自己的看法，不能只 @ 不说话
      if (text.trim().length < 4) {
        return { ok: false, blocked: true, reason: 'need_reason', error: '@ 老大时必须带上一两句你自己的看法（这条视频哪里值得看），不能只 @ 不说话', hint: 'text 写一两句口语化表达，再 confirm:true' }
      }
      if (args?.confirm !== true && args?.dry !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, aweme_id: aweme, mention: name,
          draft: `@${name} ${text}`, len: text.length,
          note: '没发送 —— 先把草稿给使用者看；想先验证昵称能不能 @ 到，可传 dry:true（只点选不发布）',
        }
      }
      // ⭐ 风控闸（v0.3.9）：dry 只点选不发布，不过闸
      if (args?.dry !== true) {
        // ⭐ 评论区 @ 老大 与私信分享**分开记额度**（各走各的计数；0 = 不限）
        const g = await awaitGate(HOME, 'mention', { ...rateOpts(), kindDayCap: Number(config().shareMentionPerDay) || 0 })
        if (!g.ok) return rateBlocked(g)
      }
      /**
       * ⭐ 2026-10-25：有 sec_uid 就先走 API + text_extra（实测服务端保住 sec_uid、对方能收到通知），
       *    比 UI 点选快 30 倍还有 cid；UI 只作兜底（它慢、拿不到 cid，且实测有时点了没发出去）。
       */
      /**
       * ⭐ 2026-10-27（真因订正）：**UI 点选是唯一能真 @ 的路**。
       *    真因：评论区发布被风控要求过一次短信验证（「接收短信验证码」）—— 没过之前点发布只回
       *    200 空 body、输入框不清空；过了之后 UI 点选发布成功、服务端**保住 mention 实体**
       *    （实测 cid 7701038612288750351，text_extra 原样保留，老大确实收到「@ 了我」通知）。
       *    API 直发虽然快、有 cid，但 mention 被服务端剥掉（三组对照实测）⇒ 只当兜底。
       */
      let uiVerifyNeeded = false
      if (args?.dry !== true) {
        let r0 = runNode('comment-mention-ui.mjs', ['--aweme', aweme, '--name', name, '--text', text], 300_000)
        /** 2026-10-28：@ 时好时坏 ⇒ 非验证类失败重试一次 */
        let j0 = pickJson(r0.stdout)
        if (j0 && !j0.ok && !j0.verification_required) {
          r0 = runNode('comment-mention-ui.mjs', ['--aweme', aweme, '--name', name, '--text', text], 300_000)
          j0 = pickJson(r0.stdout)
        }
        if (j0?.ok) {
          markAction(HOME, 'mention', rateOpts())
          return {
            ...j0, via: 'ui-mention', mention: name, text, mention_verified: true,
            note: '真 @ 走 UI 点选 —— mention 实体保住了，对方会收到「@ 了我」通知。⚠️ UI 路径的 cid 是发完回查评论列表找回的（能删、能回读 text_extra）。',
          }
        }
        if (j0?.verification_required) {
          uiVerifyNeeded = true
        } else if (j0) {
          rateFailFromText('mention', j0, r0.stdout, r0.stderr)
        }
      }
      /**
       * 🔴 2026-10-28：验证没过就**不要用 API 假装发出去** ——
       *    那样只会留下一条纯文字「@昵称 …」的评论，对方收不到通知（老大报的就是这个）。
       */
      if (uiVerifyNeeded) {
        return {
          ok: false, verification_required: true, aweme_id: aweme, mention: name, text,
          error: '要真 @ 得先过一次抖音短信验证（评论区发布风控）：验证没过之前发布的评论会被静默丢弃',
          hint: '让使用者跑：node tools/comment-verify.mjs --aweme ' + aweme + ' --request-code，拿到 6 位码后 --code <码>；过了之后 UI 点选就能真 @ 上。',
        }
      }
      const cfgNow = config()
      const nameSec = String(args?.sec_uid || '').trim()
        || (name && String(cfgNow.dmTo || '').trim() === name ? String(cfgNow.dmToId || '').trim() : '')
      if (args?.dry !== true && nameSec) {
        const body = text.startsWith('@') ? text : `@${name}  ${text}`
        const ar = runNode('comment-api.mjs', ['--aweme', aweme, '--text', body, '--mention-secuid', nameSec], 180_000)
        const aj = pickJson(ar.stdout)
        if (aj?.ok) {
          markAction(HOME, 'mention', rateOpts())
          /**
           * ⭐ 2026-10-27：**发出去 ≠ @ 到了**。实测抖音 web 端发评论时服务端会把 mention 实体剥掉
           *    （老大 / 视频作者 / 普通网友三种目标都试过，关注后也一样），这时对方收不到 @ 通知 ——
           *    自动补一张私信卡片才是真通知（同一条视频两路不会重复，channel-log 保证）。
           */
          const dropped = aj.mention_dropped === true || aj.mention_kept === false
          if (dropped) {
            const to = String(cfgNow.dmTo || '').trim()
            const toId = String(cfgNow.dmToId || '').trim()
            let fb = { ok: false, skipped: 'no_dm_to' }
            if (to) {
              const argv2 = [aweme, to]
              if (toId) argv2.push('--to-id', toId)
              const rr = runNode('card-share.mjs', argv2, 200_000)
              fb = pickJson(rr.stdout) || { ok: false, error: '补卡片没返回结果' }
            }
            return {
              ...aj, via: 'api-mention', mention: name, text: body, mention_verified: false, mention_dropped: true,
              fallback_dm: { ok: Boolean(fb.ok), sent: Boolean(fb.sent), blocked: fb.blocked, error: fb.error, to },
              note: '评论发出去了，但**平台把 @ 实体剥掉**了 —— 他收不到 @ 通知；'
                + (fb.ok ? '已自动补一张私信卡片通知他。' : '补卡片也没成，需要在报告里说明。'),
            }
          }
          return { ...aj, via: 'api-mention', mention: name, mention_verified: true, text: body, note: '真 @ 走 API + text_extra（回读确认 sec_uid 保住了），对方能收到 @ 通知' }
        }
        rateFailFromText('mention', aj, ar.stdout, ar.stderr)
      }
      const argv = ['--aweme', aweme, '--name', name, '--text', text]
      if (args?.dry === true) argv.push('--dry')
      const r = runNode('comment-mention-ui.mjs', argv, 300_000)
      const j = pickJson(r.stdout)
      if (!j) { if (args?.dry !== true) rateFailFromText('mention', r.stdout, r.stderr); return { ok: false, error: '真 @ 执行器没返回可解析结果', stdout: String(r.stdout || '').slice(0, 400), stderr: String(r.stderr || '').slice(0, 300) } }
      if (args?.dry !== true) {
        if (j.ok) markAction(HOME, 'mention', rateOpts())
        else rateFailFromText('mention', j, r.stdout, r.stderr)
      }
      return j
    },
  },
  {
    name: 'douyin_mood',
    title: '刷抖音 · 心情（情绪内核）',
    description: '看 / 记你自己的心情（不设档位，外放由你按场合决定）。'
      + 'action=read 看此刻什么心情、今天整体、最近轨迹；action=feel 记一笔刚发生的事（看到好笑的/被治愈/被抬杠/老大来了…），心情会跟着变。'
      + '⭐ 心情不是任务：不记也不会错，它只影响你说话的口气，不影响该做的事。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'feel'], description: 'read / feel' },
        kind: { type: 'string', description: 'action=feel：' + Object.keys(MOOD_EVENTS).join(' / ') },
        note: { type: 'string', description: '一句话为什么（写进轨迹）' },
        strength: { type: 'number', description: '强度 0.5~1.5，默认 1' },
      },
      additionalProperties: false,
    },
    handler: (a = {}) => {
      ensureMood(HOME)
      if (String(a.action || 'read') === 'feel') {
        const r = moodFeel(HOME, String(a.kind || ''), {
          note: String(a.note || '').slice(0, 120),
          strength: Math.max(0.4, Math.min(1.5, Number(a.strength) || 1)),
        })
        if (!r.ok) return r
        return { ok: true, label: r.label, v: Number(r.v.toFixed(3)), a: Number(r.a.toFixed(3)), why: r.why }
      }
      const g = moodGet(HOME)
      return { ok: true, ...g, kinds: Object.keys(MOOD_EVENTS) }
    },
  },
  {
    name: 'douyin_guide',
    title: '刷抖音 · 使用说明',
    description: '返回这个插件给别的 agent 看的使用说明（工具清单、安全红线、MCP 配置）。第一次接进来先读它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      try {
        return { ok: true, doc: readFileSync(join(ROOT, 'AI-USAGE.md'), 'utf8') }
      } catch (e) {
        return { ok: false, error: '找不到 AI-USAGE.md（插件包不完整）', detail: String(e?.message ?? e) }
      }
    },
  },
  {
    name: 'douyin_sticker_list',
    title: '刷抖音 · 表情库',
    description: '列大肥鱼表情库：pending（待审）/ approved（已通过、可发）/ blocked（已拦）/ all。表情都是自己收集的。新收集的先 Read 它的 thumb 图，再调 douyin_sticker_review 拍板。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending / approved / blocked / all，默认 approved' },
        tag: { type: 'string', description: '可选：只看某标签' },
        limit: { type: 'number', description: '最多返回多少条，默认 50' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const status = ['pending', 'approved', 'blocked', 'all'].includes(args?.status) ? args.status : 'approved'
      const items = listStickers(HOME, {
        status, tag: String(args?.tag || ''), limit: Math.max(1, Math.min(Number(args?.limit) || 50, 200)),
      }).map((x) => ({
        key: x.key, sticker_id: x.sticker_id, name: x.name, thumb: x.thumb, url: x.url,
        kind: x.kind, source: x.source, tags: x.tags, status: x.status, reason: x.reason,
        addedAt: x.addedAt, reviewedAt: x.reviewedAt, used: x.used,
      }))
      return { ok: true, status, count: items.length, stats: stickerStats(HOME), sentToday: stickerSentToday(HOME), items }
    },
  },
  {
    name: 'douyin_sticker_review',
    title: '刷抖音 · 表情安全审核',
    description: '🔴 表情包安全审核（必须先 Read 贴纸 thumb 图看过内容再调）。只有可爱/萌/抽象/搞笑/大肥鱼/治愈/萌宠这类无不良才能 approve；色情、暴力、血腥、恐怖、恶心、违法、涉政、辱骂、未成年向一律 block。这是能否发表情包的总闸。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '贴纸 key（douyin_sticker_list 返回）' },
        decision: { type: 'string', description: 'approved 或 blocked' },
        tag: { type: 'string', description: 'approve 时给的标签（可爱/抽象/大肥鱼/萌宠/治愈…）' },
        reason: { type: 'string', description: 'blocked 时一句话原因' },
      },
      required: ['key', 'decision'],
      additionalProperties: false,
    },
    handler: (args) => {
      const key = String(args?.key || '').trim()
      const decision = String(args?.decision || '').trim()
      if (!key || !['approved', 'blocked'].includes(decision)) return { ok: false, error: '缺 key 或 decision 非法' }
      const r = reviewSticker(HOME, key, decision, String(args?.tag || ''), String(args?.reason || ''))
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r, stats: stickerStats(HOME) }
    },
  },
  {
    name: 'douyin_sticker_make',
    title: '刷抖音 · 自己做表情包',
    description: '自己做一个表情包：① from_aweme + at 从视频某一秒截帧（看到喜欢的画面就存）；② from_file 拿现成图片/表情再加一句 caption；③ text 纯原创文字表情。做完进表情库（pending）——你必须先 Read 返回的 file 看清画面，再用 douyin_sticker_review 决定 approve/block，没审过的发不出去。做不做、做几张全由你自己判断。',
    inputSchema: {
      type: 'object',
      properties: {
        from_aweme: { type: 'string', description: '来源视频 id（三选一）' },
        at: { type: 'number', description: '截第几秒（默认 1.5）' },
        from_file: { type: 'string', description: '来源图片本地路径（三选一）' },
        text: { type: 'string', description: '纯原创文字表情的内容（三选一）' },
        caption: { type: 'string', description: '可选：底部加一句大字' },
        name: { type: 'string', description: '可选：起个名字' },
        size: { type: 'number', description: '边长像素（默认 480）' },
      },
      additionalProperties: false,
    },
    handler: (args = {}) => {
      const argv = []
      const aw = String(args.from_aweme || '').trim()
      const ff = String(args.from_file || '').trim()
      const tx = String(args.text || '').trim()
      if (aw) argv.push('--from-aweme', aw, '--at', String(Number(args.at) || 1.5))
      else if (ff) argv.push('--from-file', ff)
      else if (tx) argv.push('--text', tx)
      else return { ok: false, error: '要给来源：from_aweme / from_file / text 三选一' }
      if (args.caption) argv.push('--caption', String(args.caption))
      if (args.name) argv.push('--name', String(args.name))
      if (args.size) argv.push('--size', String(args.size))
      const r = runNode('sticker-make.mjs', argv, 260_000)
      let j = null
      const raw = String(r.stdout || '').trim()
      try { j = JSON.parse(raw) } catch { j = null }
      if (!j) {
        try { j = JSON.parse(raw.split(/\r?\n/).filter(Boolean).pop()) } catch { j = null }
      }
      if (!j || !j.ok) return { ok: false, error: (j && j.error) || '做表情失败', stderr: String(r.stderr || '').slice(-300) }
      return { ...j, stats: stickerStats(HOME) }
    },
  },
  {
    name: 'douyin_sticker_collect',
    title: '刷抖音 · 评论区捡表情包',
    description: '从某条视频的评论区把别人发的图片/表情下载下来、登记进表情库（pending）。看到喜欢的就收，收完先 Read 返回的 files 看画面，再用 douyin_sticker_review 决定 approve/block。只在真的觉得好玩时收，别每条都扫（费时间费流量）。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '从哪条视频的评论区捡' },
        pages: { type: 'number', description: '翻几页评论（默认 2，最多 6）' },
        max: { type: 'number', description: '最多存几张（默认 8）' },
      },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    handler: (args = {}) => {
      const aw = String(args.aweme_id || '').trim()
      if (!aw) return { ok: false, error: '缺 aweme_id' }
      const argv = ['--aweme', aw, '--pages', String(Math.max(1, Math.min(Number(args.pages) || 2, 6))),
        '--max', String(Math.max(1, Math.min(Number(args.max) || 8, 30))), '--ingest', '1']
      const r = runNode('comment-sticker-harvest.mjs', argv, 300_000)
      let j = null
      try { j = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()) } catch { j = null }
      if (!j || !j.ok) return { ok: false, error: (j && j.error) || '捡表情失败', stderr: String(r.stderr || '').slice(-300) }
      return { ...j, stats: stickerStats(HOME) }
    },
  },
  {
    name: 'douyin_comment_sticker',
    title: '刷抖音 · 发表情包',
    description: '在评论区发一个表情包（平台贴纸优先，走 publish 原生 sticker_id；自定义图片/GIF 走评论框图片上传）。贴纸来自自己收集且审核通过的表情库。给 comment_id 是回某条，不给是顶层。受风控节奏、每日上限、每日贴纸上限约束，要 confirm 才真发。图片/GIF 需要该号有图片评论权限（老号/实名号通常有），没有入口会明确返回 image_uploader，不谎报。',
    inputSchema: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', description: '作品/图文 id' },
        sticker_key: { type: 'string', description: '表情库贴纸 key（推荐）' },
        sticker_id: { type: 'string', description: '或直接给平台贴纸 id（sticker_key 优先）' },
        comment_id: { type: 'string', description: '可选：回某条评论 cid；留空 = 顶层表情评论' },
        root_comment_id: { type: 'string', description: '可选：楼根 cid' },
        reply_to_uid: { type: 'string', description: '回复别人时建议带：对方 uid（同人≤2）' },
        reply_to_text: { type: 'string', description: '回复别人时建议带：对方原文（只回善意）' },
        confirm: { type: 'boolean', description: '🔴 用户当场同意后传 true' },
      },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const bad = needLogin() || needSetup()
      if (bad) return bad
      const cfg = config()
      const aweme = String(args?.aweme_id || '').trim()
      const skey = String(args?.sticker_key || '').trim()
      const rawSid = String(args?.sticker_id || '').trim()
      const replyTo = String(args?.comment_id || '').trim()
      const rootCid = String(args?.root_comment_id || '').trim()
      const replyToUid = String(args?.reply_to_uid || '').trim()
      const replyToText = String(args?.reply_to_text || '').trim()
      if (!aweme) return { ok: false, error: '缺 aweme_id' }
      if (cfg.useSticker !== true) {
        return { ok: false, blocked: 'sticker_disabled', error: '发表情包默认关闭。等表情库收集并审核过一些安全贴纸后，去设置页打开「允许发表情包」。' }
      }
      let sticker = null
      if (skey) {
        sticker = listStickers(HOME, { status: 'all', limit: 500 }).find((x) => x.key === skey) || null
        if (!sticker) return { ok: false, error: '表情库里没有这个 key（先 douyin_sticker_list 看）' }
      } else if (rawSid) {
        sticker = listStickers(HOME, { status: 'all', limit: 500 }).find((x) => x.sticker_id === rawSid)
          || { sticker_id: rawSid, status: 'pending', name: '' }
      } else return { ok: false, error: '缺 sticker_key（推荐）或 sticker_id' }
      if (cfg.stickerSafeOnly !== false && sticker.status !== 'approved') {
        return {
          ok: false, blocked: 'not_approved', status: sticker.status,
          error: sticker.status === 'blocked' ? '这张表情审核没过（含不良/不适），不能发'
            : '这张表情还没审核：先 Read thumb，用 douyin_sticker_review 判定 approve 才能发',
        }
      }
      const mode = sticker.sticker_id ? 'sticker' : 'image'
      const imageUrl = String(sticker.url || sticker.thumb || '').trim()
      if (mode === 'image' && !imageUrl) {
        return { ok: false, unsupported: 'custom_image_no_url', error: '这张自定义图片没有可取地址（url/thumb 为空），无法上传' }
      }
      const perDay = Math.max(0, Number(cfg.stickerPerDay ?? 0) || 0)
      const usedToday = stickerSentToday(HOME)
      if (perDay > 0 && usedToday >= perDay) return { ok: false, blocked: 'sticker_cap', used: usedToday, max: perDay, error: `今天发表情已到上限（${usedToday}/${perDay}），明天再发` }
      if (!replyTo) {
        const cap = canProactiveComment(HOME, Number(cfg.proactiveCommentPerDay ?? 0))
        if (!cap.ok) return { ok: false, blocked: 'proactive_cap', error: `今天主动评论（含表情）已到上限（${cap.used}/${cap.max}），明天再继续` }
      } else {
        if (cfg.replyKindOnly !== false && replyToText) {
          const c = classifyReply(replyToText)
          if (!c.ok) { noteSkipped(HOME, c.reason, replyToUid); return { ok: false, blocked: 'unfriendly', skipped: c.reason, error: `对方这条属于「${c.label}」，按规矩不发表情回` } }
        }
        const rc = canReplyTo(HOME, replyToUid, { perPerson: Number(cfg.replyPerPerson ?? 2), perDay: Number(cfg.replyPerDay ?? 0) })
        if (!rc.ok) {
          noteSkipped(HOME, rc.reason, replyToUid)
          if (rc.reason === 'person_cap') return { ok: false, blocked: 'person_cap', error: `今天已回过这个人 ${rc.personUsed} 次（上限 ${rc.perPerson}），不再发表情回` }
          return { ok: false, blocked: 'daily_cap', error: `今天回复已到上限（${rc.used}/${rc.max}），明天再回` }
        }
      }
      if (args?.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, send_mode: mode, aweme_id: aweme, comment_id: replyTo || '(顶层表情评论)',
          sticker: { key: sticker.key, sticker_id: sticker.sticker_id, name: sticker.name, kind: sticker.kind, tags: sticker.tags, thumb: sticker.thumb, url: imageUrl || undefined },
          quota: { stickerToday: `${usedToday}/${perDay}` },
          note: mode === 'image'
            ? '没发送 —— 这是自定义图片/GIF，将走评论框图片上传（需该号有图片评论权限）。确认合适、没认错视频后 confirm:true。'
            : '没发送 —— 确认合适、没认错视频后用 confirm:true 再调一次。',
        }
      }
      const rlKind = replyTo ? 'reply' : 'comment'
      const gate = await awaitGate(HOME, rlKind, rateOpts())
      if (!gate.ok) return rateBlocked(gate)
      let toolName, argv
      if (mode === 'sticker') {
        toolName = 'comment-api.mjs'
        argv = ['--aweme', aweme, '--sticker', String(sticker.sticker_id)]
        if (replyTo) argv.push('--reply', replyTo)
        if (rootCid) argv.push('--root', rootCid)
      } else {
        toolName = 'comment-image-ui.mjs'
        argv = ['--aweme', aweme, '--url', imageUrl]
        if (replyTo) argv.push('--reply', replyTo)
      }
      const r = runNode(toolName, argv, 300_000)
      const j = pickJson(r.stdout)
      if (!j) { rateFailFromText(rlKind, r.stdout, r.stderr); return { ok: false, error: '表情发送器没返回可解析结果', send_mode: mode, stderr: String(r.stderr || '').slice(0, 300) } }
      // 图片通路：该号没图片评论入口，是"没发出去"不是限流，不熔断
      if (mode === 'image' && j.unavailable === 'image_uploader') {
        return { ok: false, sent: false, send_mode: 'image', unavailable: 'image_uploader', stage: j.stage, error: j.error || '这个号/这条视频没有图片评论入口（灰度权限）；平台贴纸不受影响。' }
      }
      if (mode === 'sticker' && j.need_root) return { ok: false, need_root: true, ...j, hint: '楼中楼判不出楼根，先拿 root_comment_id 再传（没发出）' }
      if (mode === 'sticker' && (j.http === 403 || /403|Forbidden|频繁|验证码|登录失效/i.test(String(j.error || j.head || '')))) {
        rateFailFromText(rlKind, '403 限流 ' + String(j.error || j.head || ''))
        return { ok: false, blocked: true, reason: 'cooldown', rate_limited: true, ...j, hint: '抖音限流了，风控已冷却，别重试。' }
      }
      if (j.ok) {
        markAction(HOME, rlKind, rateOpts())
        markStickerSent(HOME, sticker.key)
        if (replyTo) countReply(HOME, replyToUid); else countProactiveComment(HOME)
      } else {
        rateFailFromText(rlKind, j, j.error || j.head || '')
      }
      return { ...j, sent: Boolean(j.ok), kind: rlKind, send_mode: mode, sticker: { key: sticker.key, sticker_id: sticker.sticker_id, name: sticker.name, kind: sticker.kind }, stickerStats: stickerStats(HOME) }
    },
  },
]

/* ─────────────────────────── JSON-RPC / MCP 传输 ─────────────────────────── */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const send = (msg) => {
  try { process.stdout.write(JSON.stringify(msg) + '\n') } catch { /* 管道断了就随它去 */ }
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })

/** 工具结果统一包成 MCP content */
const asContent = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return {
    content: [{ type: 'text', text }],
    isError: value && typeof value === 'object' && value.ok === false ? true : undefined,
  }
}

const handleRequest = async (msg) => {
  const { id, method, params } = msg || {}
  const isNotification = id === undefined || id === null

  switch (method) {
    /* ⭐ 新客户端（2026-07-28）会先探这个；明确回"没有" ⇒ 它自动回落 legacy initialize */
    case 'server/discover':
      return fail(id, -32601, 'Method not found: server/discover (this server speaks MCP 2025-06-18)')

    case 'initialize': {
      const asked = String(params?.protocolVersion || '')
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0]
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: '刷抖音插件（dsh-douyin-scroll）的 MCP 入口。第一次用先调 douyin_guide 读说明；发任何东西前必须先问使用者，得到同意才传 confirm:true。',
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined

    case 'ping':
      return reply(id, {})

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const name = String(params?.name || '')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return fail(id, -32602, `Unknown tool: ${name}`)
      try {
        const value = await tool.handler(params?.arguments || {})
        return reply(id, asContent(value))
      } catch (e) {
        return reply(id, asContent({ ok: false, error: String(e?.message ?? e) }))
      }
    }

    default:
      if (isNotification) return undefined
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

/* ─────────────────────────── 入口 ─────────────────────────── */

if (process.argv.includes('--selftest')) {
  // 不接客户端，自己跑一遍协议握手 + tools/list —— selfcheck.mjs 也用它
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'douyin_status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} },
  ]
  for (const l of lines) {
    const out = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (s) => { out.push(String(s)); return true }
    await handleRequest(l)
    process.stdout.write = orig
    const text = out.join('').trim().split('\n')[0] || '{}'
    const j = JSON.parse(text)
    if (j.error) console.log(`#${l.id} ${l.method} -> error ${j.error.code} ${j.error.message.slice(0, 60)}`)
    else if (j.result?.tools) console.log(`#${l.id} ${l.method} -> ${j.result.tools.length} tools: ${j.result.tools.map((t) => t.name).join(', ')}`)
    else console.log(`#${l.id} ${l.method} -> ok ${JSON.stringify(j.result).slice(0, 120)}`)
  }
  process.exitCode = 0
} else {
  process.stderr.write(`[douyin-mcp] ${SERVER_NAME} v${SERVER_VERSION} 已启动（家=${HOME}，${TOOLS.length} 个工具）\n`)
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = String(line || '').trim()
    if (!t) return
    let msg
    try { msg = JSON.parse(t) } catch { process.stderr.write('[douyin-mcp] 收到非 JSON 行，已忽略\n'); return }
    Promise.resolve(handleRequest(msg)).catch((e) => {
      process.stderr.write(`[douyin-mcp] 处理 ${msg?.method} 出错：${e?.message ?? e}\n`)
      if (msg?.id !== undefined) fail(msg.id, -32603, String(e?.message ?? e))
    })
  })
  rl.on('close', () => { process.exitCode = 0 })
}
