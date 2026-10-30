#!/usr/bin/env node
/**
 * tools/comment-api.mjs —— 在抖音评论区发评论/回复某条评论（**一条 fetch，不点 UI**）
 * ============================================================================
 * 为什么是"页面里 fetch"这一条路（三种都实测过）：
 *   ① 点评论区 UI      → 能发，但抖音会弹**短信验证**（要使用者给码）
 *   ② Python 自己签名 POST → **HTTP 403**（写接口要强签名 getBdTicketGuardHeader，外部补不齐）
 *   ③ ⭐ 在无头页面的上下文里 fetch → **HTTP 200，不弹验证**（页面自己把签名补齐）
 *
 * ── 🔴 2026-10-23 修的 bug：reply_id 和 reply_to_reply_id 不是一回事 ──────────
 *   旧代码：
 *       body.reply_id = REPLY; body.reply_to_reply_id = REPLY;   // ← 两个塞同一个值
 *   后果（实测到的服务端落库）：
 *       「回复」号主的顶层评论 → 结果 level=1、root_comment_id=它自己
 *       **变成了另一条顶层评论，压根没进楼**。看着成功，其实位置全错。
 *   真实结构（从别人的正常回复里读出来的）：
 *       回顶层评论 X  ⇒ reply_id = X        ，reply_to_reply_id = 0（不传）
 *       回楼中楼   Y  ⇒ reply_id = Y.reply_id，reply_to_reply_id = Y
 *       也就是：**reply_id 永远是"楼根"，reply_to_reply_id 才是"具体回哪条"**。
 *
 *   所以现在参数拆成两个：
 *       --reply <cid>   要回的那条（可以给顶层，也可以给楼中楼）
 *       --root  <cid>   楼根（level1）。不给就自动判定；判不出来**拒绝发送**，绝不瞎猜
 *   判不出来还硬发，就会变成一条悄悄冒出来的顶层评论 —— 那是最坏的一种错。
 *
 * 用法:
 *   node tools/comment-api.mjs --aweme <id> --text "..."                      # 顶层评论
 *   node tools/comment-api.mjs --aweme <id> --text "..." --reply <cid>        # 回某人（自动判楼根）
 *   node tools/comment-api.mjs --aweme <id> --text "..." --reply <cid2> --root <cid1>
 *   node tools/comment-api.mjs --aweme <id> --text "..." --reply <cid> --dry  # 只解析不发送
 *
 * 输出一行 JSON：{ ok, http, cid, reply_to, root, text, raw?, error? }
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { channelsOf, markChannel } from '../lib/channels.mjs'
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const AWEME = String(argOf('--aweme', '')).trim()
const REPLY = String(argOf('--reply', '')).trim()
const ROOT = String(argOf('--root', '')).trim()
const FILE = String(argOf('--file', '')).trim()
let TEXT = (FILE ? readFileSync(FILE, 'utf8').trim() : String(argOf('--text', '')).trim())
  // ⚠️ 2026-10-25 老大抱怨「——」像 AI 写的 ⇒ 最后一道闸：评论发出去之前统一换成逗号
  .replace(/\s*——\s*/g, '，').replace(/\s*--+\s*/g, '，').replace(/，{2,}/g, '，')
// ⭐ v0.4.0 贴纸评论：传平台贴纸 id（表情库 sticker_id）；此时 text 可留空（贴纸即内容）
const STICKER = String(argOf('--sticker', '')).trim()

/**
 * 🔴 2026-10-22：这里以前**静默忽略** `--mention-*`（根本不读这几个参数）。
 *    调用方以为传了就能真 @，实际发出去的是普通评论：名字不变蓝、对方收不到通知，
 *    工具却报成功 —— 最坏的一种错（不是失败，是"看起来成功"）。
 *
 * ⭐ 但**这个脚本做不了真 @**（原因见 tools/comment-mention-ui.mjs 顶部：
 *    API 直发时服务端会把 mention 的 sec_uid 剥掉，只有前端点选才认）。
 *    ⇒ 现在选择**明确拒绝**，不再静默降级。要真 @ 请用 comment-mention-ui.mjs。
 */
const MENTION = {
  name: String(argOf('--mention-name', '')).trim(),
  uid: String(argOf('--mention-uid', '')).trim(),
  secUid: String(argOf('--mention-secuid', '')).trim(),
}
const wantsMention = Boolean(MENTION.name || MENTION.uid || MENTION.secUid)

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }
if (!TEXT && !STICKER) { out({ ok: false, error: '正文是空的' }) }
if (TEXT.length > 500) { out({ ok: false, error: `正文太长（${TEXT.length} 字），抖音评论放不下` }) }

/**
 * ⭐⭐ 2026-10-25 重做「真 @」：不再直接拒绝。
 *
 *    以前这里拒绝的理由是「API 直发服务端会剥掉 sec_uid」，但那次**没带 text_extra**
 *    （body 里写死 `text_extra: '[]'`）——服务端看到的只是一串 "@昵称" 文字，当然没有实体，
 *    当然不发通知。前端点选 @ 时提交的正是 text_extra：
 *      [{ user_id, sec_uid, type: 0, start: 0, end: <"@昵称" 的长度> }]
 *    ⇒ 这里改成：只要给了 uid + sec_uid，且正文确实以 "@昵称" 开头，就把同样的 text_extra 带上。
 *    能不能被服务端保住，由**回读**（ins_ids 读回该条评论的 text_extra）来验证，不靠猜。
 */
/**
 * ⭐ 2026-10-29：正文没写「@昵称」就**自动补**上。
 *    这轮实测到一次「len=28 刚好等于正文长度、没有 mention_verified」—— 就是模型没自己写 @，
 *    而 mentionReady 要求 TEXT.startsWith('@') ⇒ 静默退化成普通评论。
 *    既然调用方已经把 sec_uid 给了、也说了要 @ 谁，前缀由脚本补齐更靠谱。
 */
let TEXTX = TEXT
if (wantsMention && MENTION.secUid && MENTION.name && !TEXTX.startsWith('@')) {
  TEXTX = '@' + MENTION.name + ' ' + TEXTX
}
TEXT = TEXTX
const mentionReady = Boolean(MENTION.secUid && TEXT.startsWith('@'))
if (wantsMention && !mentionReady) {
  out({
    ok: false,
    unsupported: 'mention',
    error: '要真 @ 必须给 --mention-secuid，且正文以「@昵称」开头（--mention-uid 可省，会按 sec_uid 反查）',
    hint: '例：--text 「@墨時秋  老大，这猫劈纸太认真了」 --mention-secuid MS4wLjABAAAA…',
  })
  process.exit(1)
}
const MENTION_END = mentionReady
  ? (TEXT.search(/\s/) > 0 ? TEXT.search(/\s/) : TEXT.length)
  : 0

/**
 * ⭐ 2026-10-26 老大：「回复的内容有些相似，需要注意不要一直重复」
 *    ⇒ 同一栋楼（楼根）最多回 2 次；新回复跟这楼里最近几条太像（字符 bigram 重合率 > 0.62）就拦。
 *    记录写 `<HOME>/reply-threads.json`，键 `aweme:楼根`。**放在这里**是因为宿主工具和 MCP 值班轮
 *    最终都走这个脚本 —— 一处上锁，两条路都受管。
 *    要强行覆盖：`DOUYIN_FORCE_REPLY=1`（宿主工具是 force:true）。
 */
const DUTY_HOME = process.env.DOUYIN_HOME || process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const threadsFile = join(DUTY_HOME, 'reply-threads.json')
const loadThreads = () => { try { return JSON.parse(readFileSync(threadsFile, 'utf8')) || {} } catch { return {} } }
const saveThreads = (o) => { try { writeFileSync(threadsFile, JSON.stringify(o, null, 1), 'utf8') } catch { /* 记不上不影响发 */ } }
const bigramsOf = (s) => {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '')
  const g = new Set()
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
  return g
}
const simOf = (a, b) => {
  const A = bigramsOf(a); const B = bigramsOf(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / Math.min(A.size, B.size)
}
const threadKeyOf = (root) => `${AWEME}:${root || REPLY}`

if (REPLY && !DRY && process.env.DOUYIN_FORCE_REPLY !== '1') {
  const th = loadThreads()[threadKeyOf(ROOT)]
  if (th) {
    const n = Number(th.n || 0)
    if (n >= 2) {
      out({
        ok: false, blocked: 'already_replied', aweme_id: AWEME, reply_to: REPLY, root: ROOT || undefined,
        times_in_thread: n,
        error: `这栋楼已经回过 ${n} 次了 —— 别追着同一条刷，他真想聊会再找你`,
        hint: '换别的视频、或等他再说话；确实要再补一句就设 DOUYIN_FORCE_REPLY=1。',
      })
      process.exit(1)
    }
    const near = (th.texts || []).slice(-4).find((t) => simOf(t, TEXT) > 0.62)
    if (near) {
      out({
        ok: false, blocked: 'too_similar', aweme_id: AWEME, reply_to: REPLY,
        similar_to: near,
        error: `这句跟你刚在这栋楼里说过的话太像了：「${String(near).slice(0, 40)}…」`,
        hint: '换个说法，或者干脆别再说 —— 没新话就停手才像人。',
      })
      process.exit(1)
    }
  }
}
const markThread = () => {
  if (!REPLY) return
  const all = loadThreads()
  const k = threadKeyOf(ROOT)
  const th = all[k] || { n: 0, texts: [] }
  th.n = Number(th.n || 0) + 1
  th.texts = [...(th.texts || []), String(TEXT || '').slice(0, 200)].slice(-6)
  th.at = new Date().toISOString()
  all[k] = th
  const keys = Object.keys(all)
  if (keys.length > 300) for (const kk of keys.slice(0, keys.length - 300)) delete all[kk]
  saveThreads(all)
}

try {
  const c = await openPage()
  const chromed = c.status

  // 必须站在 douyin.com 上，相对路径 fetch 才带得上 cookie / 页面签名器
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
  }

  /**
   * ⭐ 解析「楼根」和「具体回哪条」。
   *   判据来源只有权威数据：翻 `/comment/list/`（顶层）找这条 cid 到底在哪、`reply_id` 是什么。
   *   判不出来就返回 need_root，**不猜**。
   */
  const resolveJs = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var TARGET = ${JSON.stringify(REPLY)};
    var ROOTIN = ${JSON.stringify(ROOT)};
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    async function get(rel){
      var r = await fetch(rel, { credentials:'include', headers:{ accept:'application/json' } });
      var t = await r.text();
      try { return JSON.parse(t) } catch(e) { return null }
    }
    // 不给 --reply = 发顶层评论，不需要判楼
    if (!TARGET) return JSON.stringify({ ok:true, root:'', reply_to:'', how:'top-level' });

    // ① 调用方明确给了楼根 ⇒ 直接信
    if (ROOTIN) {
      var rp = (TARGET === ROOTIN) ? '' : TARGET;
      return JSON.stringify({ ok:true, root:ROOTIN, reply_to:rp, how:'explicit' });
    }

    // ② 翻顶层列表找 TARGET：确定它是 level1 还是 level2
    var cursor = 0, pages = 0;
    while (pages < 8) {
      var j = await get('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
        aweme_id: AWEME, count: '20', cursor: String(cursor), item_type: '0'
      })));
      if (!j) break;
      var cs = j.comments || [];
      for (var i = 0; i < cs.length; i++) {
        var x = cs[i];
        if (String(x.cid) === TARGET) {
          // 找到了，它是一条顶层评论 ⇒ root = 它自己
          return JSON.stringify({ ok:true, root:String(x.cid), reply_to:'', how:'found-level1' });
        }
        // 也在它的楼中楼里找（接口会带前几条）
        var rs = x.reply_comment || [];
        for (var k = 0; k < rs.length; k++) {
          if (String(rs[k].cid) === TARGET) {
            return JSON.stringify({ ok:true, root:String(x.cid), reply_to:TARGET, how:'found-in-thread' });
          }
        }
      }
      if (!j.has_more) break;
      var next = Number(j.cursor || 0);
      if (!next || next === cursor) break;
      cursor = next; pages++;
      await new Promise(function(r){ setTimeout(r, 700) });
    }

    // ③ 顶层翻不到 ⇒ 直接问接口"这条底下有没有楼中楼"：有 ⇒ 它自己就是楼根
    var rj = await get('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
      item_id: AWEME, comment_id: TARGET, cursor: '0', count: '1', item_type: '0'
    })));
    if (rj && Number(rj.total || 0) > 0) {
      return JSON.stringify({ ok:true, root:TARGET, reply_to:'', how:'has-replies' });
    }

    // ④ 判不出来 ⇒ 拒绝（不许瞎猜，猜错就变成一条悄悄冒出来的顶层评论）
    return JSON.stringify({ ok:false, need_root:true,
      hint:'判不出这条 cid 的楼根。请传 --root <顶层评论cid>（= 这条回复所在那栋楼的第一条）' });
  })()`

  let plan = null
  try { plan = JSON.parse(await c.ev(resolveJs)) } catch { plan = { ok: false, hint: '楼根解析没返回可解析结果' } }

  if (!plan.ok) {
    c.close()
    await sleep(200)
    out({
      ok: false,
      error: plan.hint || '判不出楼根，已中止（不瞎猜）',
      aweme_id: AWEME,
      reply_to: REPLY,
      why: 'reply_id 必须是"楼根"。给错了会变成一条冒出来的顶层评论，位置全错还看起来成功。',
      how_to: '传 --root <顶层评论 cid>；或先跑 tools/comment-read-dom.mjs 看这条属于哪栋楼',
    })
    process.exit(1)
  }

  if (DRY) {
    c.close()
    await sleep(200)
    out({
      ok: true, dry: true, aweme_id: AWEME,
      reply_to: plan.reply_to || '(顶层评论)',
      root: plan.root || '(无 — 发顶层)',
      resolved_by: plan.how,
      len: TEXT.length, chrome: chromed,
    })
    process.exit(0)
  }

  const js = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var ROOT = ${JSON.stringify(plan.root || '')};
    var REPLYTO = ${JSON.stringify(plan.reply_to || '')};
    var TEXT = ${JSON.stringify(TEXT)};
    // ⭐ 2026-10-25 修：STICKER 是 Node 侧的变量，没注入进页面 ⇒ 页面里 ReferenceError: STICKER is not defined
    //    （于是**每一次**发评论 / 回复都直接失败，看着像「评论区 @ 不了老大」）
    var STICKER = ${JSON.stringify(STICKER)};
    // ⭐ 真 @：uid 没给就按 sec_uid 反查一次（服务端要 user_id + sec_uid 都在 text_extra 里）
    var MUID = ${JSON.stringify(MENTION.uid)};
    var MSEC = ${JSON.stringify(MENTION.secUid)};
    var MEND = ${JSON.stringify(MENTION_END)};
    if (MSEC && !MUID) {
      try {
        var pu = '/aweme/v1/web/user/profile/other/?device_platform=webapp&aid=6383&sec_user_id=' + encodeURIComponent(MSEC);
        var pr = await fetch(pu, { credentials: 'include' });
        var pj = JSON.parse(await pr.text());
        MUID = String((pj && pj.user && pj.user.uid) || '');
      } catch (e) { /* 查不到就退回"只是文字" */ }
    }
    /* ⭐ 2026-10-27：对照服务端**真保住**的样本（{"start":4,"end":7,"user_id":"1994962122842643","type":0,
       "hashtag_name":"","hashtag_id":"","sec_uid":"MS4w…"}）—— user_id 必须是**字符串**，并且要带
       hashtag_name / hashtag_id 两个空字段。少一项服务端就把整条 @ 丢掉（实测回读 text_extra: []，
       评论里只剩纯文字「@墨時秋 …」，对方收不到任何通知 —— 老大反馈的"没艾特上"就是这个）。 */
    var TEXTRA = (MUID && MSEC)
      ? JSON.stringify([{ start: 0, end: MEND, user_id: String(MUID), type: 0, hashtag_name: '', hashtag_id: '', sec_uid: MSEC }])
      : '[]';
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    var url = '/aweme/v1/web/comment/publish/?' + qs(Object.assign({}, COMMON, { app_name:'aweme' }));
    var body = Object.assign({}, COMMON, {
      aweme_id: AWEME, text: TEXT, text_extra: TEXTRA,
      aweme_type: '0', channel_id: '0', city: '', sticker_id: STICKER || '', is_fold: '0'
    });
    // ⭐ 只有回复场景才带这两个字段；而且**分工不同**
    //    reply_id       = 楼根（level1 的 cid）—— 决定落进哪栋楼
    //    reply_to_reply_id = 具体回哪条（楼中楼才需要）—— 决定"回复 @谁"、通知谁
    if (ROOT) {
      body.reply_id = ROOT;
      if (REPLYTO) body.reply_to_reply_id = REPLYTO;
    }
    var o = { http: 0, cid: '', status_code: null, head: '' };
    try {
      var r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.douyin.com/' },
        body: new URLSearchParams(body).toString()
      });
      var txt = await r.text();
      o.http = r.status;
      o.head = txt.slice(0, 240);
      // ⚠️ 必须在页面里就解析：整包可能好几 KB，截断后 Node 那边 JSON.parse 会失败（踩过）
      try {
        var j = JSON.parse(txt);
        o.status_code = (j.status_code === undefined ? null : j.status_code);
        o.cid = (j.comment && j.comment.cid) ? String(j.comment.cid) : '';
        // 服务端有时会给这条自己认的位置……**有时不给**（2026-10-23 实测：
        // 同一台机器、同一个视频，前 5 条返回了 level，后 7 条 level 全是 undefined）
        // ⇒ 不能只靠这里，下面还会重读一次楼来核实。
        o.rt = j.comment ? String(j.comment.reply_id || '') : '';
        o.rtt = j.comment ? String(j.comment.reply_to_reply_id || '') : '';
        o.lv = (j.comment && j.comment.level !== undefined && j.comment.level !== null) ? j.comment.level : null;
        o.has_lv = Boolean(j.comment && j.comment.level !== undefined && j.comment.level !== null);
      } catch (e2) { o.parse_error = String(e2 && e2.message || e2); }
    } catch (e) { o.error = String((e && e.message) || e); }

    /**
     * ⭐⭐ 发完**重读那一楼**核实落位（2026-10-23 加的，这是唯一可靠的判据）。
     *   · 顶楼（ROOT）下能读到这条 ⇒ level=2、真的进了楼
     *   · 顶楼里读不到、但顶层列表里有它 ⇒ 它变成了一条独立顶层评论（**楼根填错了**）
     * 重读要等页面刷新一会儿，所以带 3 次重试。
     */
    /**
     * ⭐ 2026-10-25 加：**回读 mention 有没有被服务端保住**。
     *    发了 @ 却回读不到 text_extra ⇒ 那只是纯文字，对方收不到通知，必须如实告诉调用方。
     */
    if (o.cid && MEND) {
      for (var mAttempt = 1; mAttempt <= 3; mAttempt++) {
        await new Promise(function(z){ setTimeout(z, mAttempt === 1 ? 1000 : 1500) });
        var mj = await fetch('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
          aweme_id: AWEME, cursor: '0', count: '20', item_type: '0', insert_ids: o.cid
        })), { credentials: 'include', headers: { accept: 'application/json' } }).then(function(x){ return x.text() }).catch(function(){ return '' });
        var mjj = null; try { mjj = JSON.parse(mj) } catch(e) {}
        var hit = null;
        if (mjj && mjj.comments) {
          for (var mi = 0; mi < mjj.comments.length; mi++) {
            if (String(mjj.comments[mi].cid) === o.cid) { hit = mjj.comments[mi]; break; }
          }
        }
        if (hit) {
          var ex = hit.text_extra || [];
          o.mention_kept = ex.some(function(e){ return e && String(e.sec_uid || '') !== '' });
          o.mention_extra = JSON.stringify(ex).slice(0, 300);
          break;
        }
      }
    }
    if (o.cid && ROOT) {
      for (var attempt = 1; attempt <= 3; attempt++) {
        await new Promise(function(z){ setTimeout(z, attempt === 1 ? 1200 : 1800) });
        var rj = await fetch('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
          item_id: AWEME, comment_id: ROOT, cursor: '0', count: '20', item_type: '0'
        })), { credentials: 'include', headers: { accept: 'application/json' } }).then(function(x){ return x.text() }).catch(function(){ return '' });
        var rjj = null; try { rjj = JSON.parse(rj) } catch(e) {}
        if (rjj && rjj.comments) {
          for (var i2 = 0; i2 < rjj.comments.length; i2++) {
            if (String(rjj.comments[i2].cid) === o.cid) {
              o.verified = true;
              o.verified_level = rjj.comments[i2].level;
              o.verified_reply_id = String(rjj.comments[i2].reply_id || '');
              o.verified_reply_to = String(rjj.comments[i2].reply_to_reply_id || '');
              break;
            }
          }
        }
        if (o.verified) break;
      }
      if (!o.verified) {
        // 楼里没有 ⇒ 去看看它是不是跑到顶层列表去了
        var tl = await fetch('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
          aweme_id: AWEME, count: '20', cursor: '0', item_type: '0'
        })), { credentials: 'include', headers: { accept: 'application/json' } }).then(function(x){ return x.text() }).catch(function(){ return '' });
        var tjj = null; try { tjj = JSON.parse(tl) } catch(e) {}
        if (tjj && tjj.comments) {
          for (var k2 = 0; k2 < tjj.comments.length; k2++) {
            if (String(tjj.comments[k2].cid) === o.cid) { o.found_at_top = true; break; }
          }
        }
      }
    }
    return JSON.stringify(o);
  })()`

  const raw = await c.ev(js)
  c.close()
  await sleep(200)   // 等 WebSocket 真正关掉再退出，否则 libuv 会断言

  let res
  try { res = JSON.parse(raw) } catch { out({ ok: false, error: '页面没返回可解析结果', raw: String(raw).slice(0, 400), chrome: chromed }); process.exit(1) }

  const cid = String(res.cid || '')
  const ok = res.http === 200 && !!cid

  /**
   * ⭐⭐ 落位判据（2026-10-23 定稿）：
   *   ① 优先用**重读楼**拿到的 verified_*（唯一可靠 —— publish 的响应有时不带 level）
   *   ② 重读没读到、但顶层列表里出现了 ⇒ 它变成独立顶层评论了（楼根填错）
   *   ③ 两边都读不到 ⇒ unknown（评论列表按热度排，0 赞的可能够不着）**不许当成失败**
   */
  let placement = null
  if (plan.root) {
    if (res.verified) {
      const lv = Number(res.verified_level)
      placement = {
        verified: true, level: lv,
        reply_id: res.verified_reply_id || undefined,
        reply_to_reply_id: res.verified_reply_to || undefined,
        ok: lv === 2,
        warn: lv === 2 ? undefined
          : `⚠️ 已核实：它是 **level=${lv}** 的独立顶层评论，不是楼中楼回复 —— 楼根填错了`,
      }
    } else if (res.found_at_top) {
      placement = {
        verified: true, level: 1, ok: false, found_at_top: true,
        warn: '⚠️ 已核实：这条跑到了**顶层评论列表**里 —— 楼根填错，它没进楼。'
          + '虽然发出去了，但位置在评论区第一层，不是回在对方楼下。',
      }
    } else {
      placement = {
        verified: false, ok: null,
        note: '重读那栋楼没读到它（评论列表按热度排，0 赞的够不着）—— '
          + '**不等于没进楼**，也不等于进错了。想确认就过几分钟用 comment-read-dom.mjs 再读一次。',
      }
    }
  }

  /* ⭐ 2026-10-26：真的发出去了才记账（同一楼最多 2 次的计数在这里 +1） */
  if (ok) markThread()
  /* ⭐ 2026-10-27：这条视频走「评论区 @」渠道记一笔；如果之前私信分享过，只给提示不拦。
   *    ⚠️ 只有 @ 实体真保住了（mention_kept 不是 false）才算"通知到了他" ——
   *    被平台剥掉的那种只是文字提及，不能记，否则以后想私信推这条会被 already_mentioned 拦掉。 */
  let channelHint = ''
  if (ok && mentionReady && res.mention_kept !== false) {
    try { markChannel(AWEME, 'mention') } catch { /* 记不上不影响发 */ }
  }
  try {
    const ch = channelsOf(AWEME)
    if (mentionReady && ch.dm && !ch.mention) channelHint = '这条之前私信分享过 —— 一般不用再在评论区 @（老大说的：可以，但一般不这样做）；真有非说不可的再加。'
  } catch { /* 读不到就算了 */ }

  out({
    ok,
    http: res.http,
    cid: cid || undefined,
    reply_to: plan.reply_to || '(顶层评论)',
    root: plan.root || undefined,
    resolved_by: plan.how,
    /** ⭐ publish 响应里的位置（有时是 null —— 别只靠它） */
    server_level: res.has_lv ? res.lv : undefined,
    server_reply_id: res.rt || undefined,
    server_reply_to_reply_id: res.rtt || undefined,
    /** ⭐⭐ 真正的核实结果（重读楼拿到的） */
    placement,
    /** ⭐ 真 @ 的核实：true = 服务端保住了 sec_uid（对方能收到 @ 通知）；false = 只剩文字 */
    mention_kept: res.mention_kept === undefined ? undefined : Boolean(res.mention_kept),
    mention_extra: res.mention_extra || undefined,
    /**
     * ⭐ 2026-10-27：实测结论 —— **web 端发评论时，服务端会把 @ 实体整个丢掉**
     *    （三种目标都试过：老大 / 视频作者 / 普通网友；关注后再试也不行；text_extra 回读恒为 []，
     *     评论里只剩纯文字「@昵称 …」，对方收不到任何通知）。
     *    ⇒ 这条路只能当「文字里提到他」，**别指望通知**；真要他收到，用私信卡片。
     */
    mention_dropped: mentionReady && ok && res.mention_kept === false ? true : undefined,
    channel_hint: channelHint || undefined,
    hint: (mentionReady && ok && res.mention_kept === false)
      ? '平台这次没让 @ 生效（web 发评论时服务端把 mention 实体剥掉了）—— 他收不到 @ 通知；要让他看到就用 douyin_share_card 私信推一次。'
      : undefined,
    aweme_id: AWEME,
    len: TEXT.length,
    chrome: chromed,
    status_code: res.status_code === null ? undefined : res.status_code,
    error: ok ? undefined : (res.error || `没拿到 cid（status_code=${res.status_code}）`),
    head: ok ? undefined : String(res.head || '').slice(0, 300),
  })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
}
