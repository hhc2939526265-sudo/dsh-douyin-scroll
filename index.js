/**
 * dsh-douyin-scroll —— host 半端
 * ============================================================================
 * 它是一条**完整的值班链路**（架构参考 dsh-bili-scroll，判据层换成抖音的）：
 *   1. 采集/预筛直接调 `tools/*.py`（只读接口 tab/feed + hot/search），
 *      不再有内置 Python MCP / bb-browser / playwright 那一套。
 *   2. 谷时定时器：白天 08:00–23:55（默认开）、中午 12:00–14:00（默认关）—— 见 lib/state.mjs 的 WINDOWS。
 *   3. 「跑一轮」= 先在插件里抓好证据包 `round-evidence.json`，再起一个
 *      `dsh --profile headless --patch <overlay> <prompt>`，把 `duty.md` 交给它，
 *      报告写进 `<家>/out/<日期>.md`。
 *   4. 设置页（`client.js`）通过 `/api/douyin-duty/*` 读写配置、看状态、存 Cookie、测通知。
 *
 * 家里（`$DSH_HOME/douyin-duty/`）都有什么：
 *   `config.json` / `collector.json` / `forward-pick.json` / `round-evidence.json` /
 *   `duty.md` / `out/` / `inbox/` / `duty.log` / `health.json`
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因见 lib/hostdeps.mjs：它们是 optional peer，桌面版 profile 永远不装 ⇒ 裸 import 会整条不激活。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, minsUntilWindowEnd, dayKey, redactCookie } from './lib/state.mjs'
import { saveCookie, readCookie, hasCredential, credentialInfo, clearCredential, cookiePath } from './lib/credential.mjs'
import { sendWebhook, condense, maskUrl } from './lib/notify.mjs'
import { sendToast, toastSummary } from './lib/toast.mjs'
import { ensureUv } from './lib/uvfetch.mjs'
import {
  loadDmMemory, mergeDmMemory, noteSent, addFacts, dmContext,
  loadCommentMemory, noteMyComment, markSeen,
  memoryStats, forgetDm, forgetAll,
  loadNotes, saveNotes, notesPath, dmTimelineText,
} from './lib/memory.mjs'
// 主动互动额度账本（同人≤2、只回善意、每日上限）＋ 大肥鱼自己的口味画像
import {
  canReplyTo, countReply, canProactiveComment, countProactiveComment,
  canShare, countShare, classifyReply, noteSkipped,
} from './lib/engage.mjs'
import { tasteProfileText, summarizeTaste, appendTaste, resetTastes } from './lib/tastes.mjs'
/* ⭐ 情绪内核（2026-10-28）：双维度心情 + 离散情绪，事件驱动、有惯性和衰减，影响语气但不设开关。 */
import {
  ensureMood, moodGet, moodFeel, decayMood, moodPromptBlock, moodTrailText,
  todayMoodLine, MOOD_EVENTS,
} from './lib/mood.mjs'
// ⭐ v0.4.0 表情包库：收集 + 安全审核 + 只发 approved + 每日贴纸额度
import {
  ingestStickers, listStickers, reviewSticker, pickSticker, stickerStats,
  stickerSentToday, markStickerSent, nameBlocked,
} from './lib/stickers.mjs'
// ⭐ 降风险控（2026-10-24）：拟人节奏 / 抖动 / 每小时·每天上限 / 夜间静默 / 养号 / 熔断。host 与 MCP 共用。
import {
  awaitGate, checkGate, markAction, recordFailure, resetCircuit, rateStatus,
  loadRateState, nurtureQuota,
} from './lib/ratelimit.mjs'

export const name = 'douyin-scroll'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`），没有这个标记写设置时会抛 "Plugin entry … has no volatile fields"。
 *    另外两个条件：**loader entry 的 id 必须等于命名空间名**（patch 里就是 `douyin-scroll`）+ 本模块导出 Config。
 */
export const Config = !z ? undefined : z.object({
  /** 每天最多挑几条（0 = 不自动刷，但还能手动跑） */
  perDay: z.natural().default(100).extra('volatile', true),
  /** 每次最多筛选几个候选（送给模型判断的上限，省 token） */
  maxPerRun: z.natural().default(20).extra('volatile', true),
  /** ⭐ 同一时段内两轮之间至少隔几分钟（2026-10-26：以前一个时段一天只跑一轮） */
  roundGapMin: z.natural().default(15).extra('volatile', true),
  /** 峰谷自动刷（总开关） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 晚上（内置窗口，保留兼容） */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐ 自定义时段：`[{ start: '12:00', end: '14:00', label: '中午' }]`
   *    - 支持跨零点（`23:00`–`02:00`）
   *    - 和内置的中午/晚上**叠加**：只要有任意一个窗口命中就跑
   *    - 空数组 = 只用内置那两个开关
   *    - 每个时段每天只用一次（跟内置窗口同一套去重）
   */
  windows: z.array(z.object({
    start: z.string(),
    end: z.string(),
    // ⚠️ 2026-10-22：这里原来写 `z.string().optional()` —— 但这个 schemastery 版本
    //    的字符串**没有 .optional() 方法**，整个 index.js 在 import 阶段就抛
    //    `TypeError: z.string(...).optional is not a function` ⇒ 插件 fiber 建不起来
    //    ⇒ fiberPhase 永远是 null ⇒ 设置页没有面板、工具也不注册。
    //    改用 .default('') 代替（效果一样：可以不给，给了就用）。
    label: z.string().default(''),
  })).default([]).extra('volatile', true),
  /** 关注关键词（空了用 duty.md 里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** 推荐流分类（游戏 / 美食 / 搞笑 …） */
  channels: z.array(z.string()).default([]).extra('volatile', true),
  /** 指定作者（sec_uid 或主页链接） */
  authors: z.array(z.string()).default([]).extra('volatile', true),
  /** 文案太短（<N 字）**且**评论少 ⇒ 直接跳过 */
  minDescLen: z.natural().default(12).extra('volatile', true),
  /** 评论数 <N **且** 文案短 ⇒ 直接跳过 */
  minComments: z.natural().default(3).extra('volatile', true),
  /** 自动评论并 @（默认关 —— 会拿用户的号说话） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /**
   * ⭐ **自动发送总开关**（2026-10-22 用户要求）
   *
   * 含义：**插件自己在后台跑一轮时**，允不允许它往外发东西
   *      （私信 / 分享卡片 / 评论）。
   *
   * 🔴 2026-10-22 用户明确要求：**默认就是要发消息**。
   *    之前默认 false 是我理解错了 —— 用户说"默认状态，刚下载的时候，
   *    点了自己跑一轮，跟让它自己刷抖音，都不要确认，直接发送"。
   *    ⇒ 现在默认 **true**。
   *
   * 仍然是**可关**的：面板上有明确开关，不想让它自动发就关掉。
   */
  autoSend: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐⭐ **在评论区 @ 你**（2026-10-22 用户要求，加在「自动发送」下面）
   *
   * 含义：插件跑完一轮，挑到值得看的视频时，**去那个视频的评论区发一条评论 @ 你**，
   *      等于把"找到好东西"这件事直接推到你的抖音通知里。
   *
   * 为什么好用：抖音的 @ 通知比私信/Toast 都更容易被看见 —— 你刷抖音时自然就看到。
   *
   * 🔴 依赖两件事（缺一不可）：
   *   ① `autoSend` 开着（总闸）
   *   ② `commentSelfName` 填了（要 @ 的人 = 你自己）
   *   ③ 走的是 `comment-mention-ui.mjs`（真 UI 点选，sec_uid 才保得住）
   *
   * ⚠️ 默认 **false** —— 这个跟 autoSend 不一样：
   *    发私信是发给"你选的那个人"，而这个是**在别人的视频下面公开评论**，
   *    所有路人都看得到。默认开不合适，得你自己点开。
   */
  commentAtMe: z.boolean().default(false).extra('volatile', true),
  /**
   * ⭐ 「在评论区 @ 你」要 @ 谁 —— 填**你自己抖音昵称**。
   *    留空就用登录账号的昵称（account.json 里那个），所以一般不用填。
   *    只有当你的登录号跟"你想被 @ 的那个号"不是同一个时才需要。
   */
  commentSelfName: z.string().default('').extra('volatile', true),
  /** 评论执行器：off / builtin（不可用）/ browser / http */
  commentExecutor: z.string().default('off').extra('volatile', true),
  commentPerRun: z.natural().default(1).extra('volatile', true),
  commentPerDay: z.natural().default(0).extra('volatile', true),
  /** 要 @ 谁（抖音昵称）；留空 = 不发评论 */
  mentionName: z.string().default('').extra('volatile', true),
  /** http 执行器的地址 */
  httpCommentUrl: z.string().default('').extra('volatile', true),
  /**
   * ⭐⭐ 大肥鱼自主行为（2026-10-24 使用者定稿）：
   *   插件不是"替老大筛选的秘书"，而是让 DSH 自己刷、自己学、自己表达的拟人账号。
   *   登录的是"AI 小号"，老大主号是接收分享 / 被 @ 的对象（两账号，见 dmToId / commentSelfName）。
   */
  /** 自主学习：每轮把"为什么觉得好看"沉淀进口味画像，越刷越有自己的口味（默认开） */
  autonomousLearn: z.boolean().default(true).extra('volatile', true),
  /** 看到喜欢的视频，自动私信分享卡片给老大（dmToId）——私密、只发给老大，默认开 */
  shareToOwner: z.boolean().default(true).extra('volatile', true),
  /** 每天最多私信分享几条给老大 —— ⚠️ 2026-10-25 起**不再限制**：发几条由大肥鱼自己判断（保留字段只为兼容旧配置） */
  sharePerDay: z.natural().default(5).extra('volatile', true),
  /** 私信分享（卡片+理由）每天最多几条 —— **与评论区 @ 老大分开记额度**，0 = 不限 */
  shareDmPerDay: z.natural().default(20).extra('volatile', true),
  /** 评论区 @ 老大 每天最多几条 —— **与私信分享分开记额度**，0 = 不限 */
  shareMentionPerDay: z.natural().default(20).extra('volatile', true),
  /** 主动给刷到的视频发评论（顶层普通评论、不带 @）——公开行为，默认关，打开才发 */
  proactiveComment: z.boolean().default(false).extra('volatile', true),
  /** 每天最多主动评论几条（**0 = 不限**；2026-10-25 老大要求取消上限，发几条由大肥鱼自己判断） */
  proactiveCommentPerDay: z.natural().default(0).extra('volatile', true),
  /** 别人回复了我发的评论时，自动回复（默认关，打开才回） */
  autoReply: z.boolean().default(false).extra('volatile', true),
  /** 每天最多回复别人几条（**0 = 不限**；2026-10-25 老大要求取消上限） */
  replyPerDay: z.natural().default(0).extra('volatile', true),
  /**
   * 🔴 回复同一个人最多几次（**0 = 不限**；2026-10-25 老大要求不设上限）。
   * 想限制就填数字：按自然日计数、零点重置。
   */
  /** ⭐ 2026-10-27 老大：**每个人最多回 2 次**（可以回多个人，但不强制每个人都回） */
  replyPerPerson: z.natural().default(2).extra('volatile', true),
  /** 只回复善意 / 好回答的评论（恶意、抬杠、引战、引流、索要隐私一律不回；默认开） */
  replyKindOnly: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐⭐ 看视频画面（2026-10-24 使用者提出：要让 DSH 真的看到视频，才知道好不好、喜不喜欢）。
   * 开着时，入选候选会抓高清封面 + 关键帧（有 ffmpeg 时从视频抽开头/中间/结尾），
   * 写到 frames/<视频ID>/，值班那一轮用 Read 打开看，再结合数据判断。默认开；关掉只看文本。
   */
  watchFrames: z.boolean().default(true).extra('volatile', true),
  /** 时长未知时的兜底关键帧数（2–12，默认 3；正常视频按 frameTargetSec 自适应；封面始终抓） */
  frameCount: z.natural().default(8).extra('volatile', true),
  /** ⭐ v0.4.0 自适应抽帧：每多少秒一帧（2–8，默认 3）——长视频自然多抽、内容更完整 */
  frameTargetSec: z.number().default(3).extra('volatile', true),
  /** 每条视频关键帧硬上限（4–30，默认 30）——封顶控 token；约 90 秒以上的长视频才会到顶 */
  frameMax: z.natural().default(30).extra('volatile', true),
  /** 关键帧宽度（320/480/640/720，默认 720 看清细节；想省流量再调小） */
  frameWidth: z.natural().default(720).extra('volatile', true),
  /** ⭐ v0.4.0 语音识别：优先用抖音官方字幕（默认开，最省最稳） */
  useOfficialSubtitle: z.boolean().default(true).extra('volatile', true),
  /** 没官方字幕时，用本地 faster-whisper 转写（可选重依赖，默认关；装了且开了才跑） */
  useAsr: z.boolean().default(false).extra('volatile', true),
  /** 本地 Whisper 模型档位（tiny/base/small/medium，默认 small；模型越小越快越糙） */
  asrModel: z.string().default('small').extra('volatile', true),
  /** 每条台词文本截断字符数（默认 1500，够看完一整条口播；想省 token 再调小） */
  spokenMaxChars: z.natural().default(1500).extra('volatile', true),
  /** ⭐ v0.4.0 表情包：从评论/私信收集平台贴纸（只收集，默认开） */
  collectSticker: z.boolean().default(true).extra('volatile', true),
  /** 允许在评论/私信里发贴纸表情（默认关，保守；先收集审核再开） */
  useSticker: z.boolean().default(false).extra('volatile', true),
  /** 每天最多发几个贴纸表情（0 = 不限；2026-10-25 老大要求取消数量限制，默认改成不限） */
  stickerPerDay: z.natural().default(0).extra('volatile', true),
  /** 只发审核通过（可爱/抽象/大肥鱼/无不良）的贴纸，黄暴血腥一律不发（默认开） */
  stickerSafeOnly: z.boolean().default(true).extra('volatile', true),
  /** 值班轮自动用视觉审核新收集的贴纸（默认开；关了则全部待人工/模型审） */
  stickerAutoReview: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐⭐ 降风险控（2026-10-24 使用者提出：知道有封号风险，要一套降风险代码融进去）。
   * 拟人节奏（随机间隔/抖动/连做长休）、每小时/每日硬上限、夜间静默、新号养号、
   * 撞限流/验证码熔断，host 与 MCP 所有对外动作共用 lib/ratelimit.mjs 一道闸。
   */
  /** 拟人节奏：动作间隔随机抖动、连做几个后随机长休（默认开） */
  humanMode: z.boolean().default(true).extra('volatile', true),
  /** 夜间静默：深夜不主动对外发（默认开，时段见 quietStart/End） */
  safeQuiet: z.boolean().default(true).extra('volatile', true),
  /** 夜间静默开始（HH:MM，默认 23:00） */
  quietStart: z.string().default('23:00').extra('volatile', true),
  /** 夜间静默结束（HH:MM，默认 08:00，支持跨零点） */
  quietEnd: z.string().default('08:00').extra('volatile', true),
  /** 每小时对外动作硬上限（评论/回复/私信/分享/@ 合计，默认 8） */
  maxActionsPerHour: z.natural().default(100).extra('volatile', true),
  /** 每天对外动作硬上限（合计，默认 20；养号期自动下调） */
  maxActionsPerDay: z.natural().default(260).extra('volatile', true),
  /** 新号养号期：前 N 天自动降低配额、拉长间隔（默认开） */
  nurtureMode: z.boolean().default(true).extra('volatile', true),
  /** 养号期天数（默认 7） */
  nurtureDays: z.natural().default(3).extra('volatile', true),
  /** ⭐⭐ 聊天盯梢（2026-10-24）：后台每 N 秒读一次私信对象的会话，有新消息就通知。
   *  来源：使用者当天实测的「会话模式」——30 秒一读、看见就回（实测响应 ~12 秒）。
   *  间隔默认 30 秒；读取走 HTTP 快路径（im-http.py，~1.1 秒/次、不启浏览器、身份铁闸）。 */
  /**
   * ⭐ 聊天模式总开关（2026-10-24 定稿：使用者拍板「默认开启，要关就整个关掉」）。
   *    一个开关管全部：30 秒一读 + 新消息通知 + 状态屏。不再有单独的「自动回话」——
   *    回话由 AI 值班做（已活着的会话，~12 秒），插件只做眼睛。
   */
  chatWatch: z.boolean().default(true).extra('volatile', true),
  /** 盯梢间隔（秒），10–300，默认 30 */
  chatWatchSec: z.natural().default(30).extra('volatile', true),
  /**
   * ⭐ 2026-10-24 定稿（使用者：「我要的是迁移，不是开发新功能」）：
   *    聊天模式 = 今早实测那套的「读」半边（30 秒一读 + 通知 + 状态屏）。
   *    「回话」半边**不做在插件里**——今早的 12 秒来自**已活着的 AI 直接回**；
   *    插件里曾做过「每条消息现起一个会话」，实测 73 秒、还吞消息，已拆掉。
   *    回话 = AI 值班（常驻会话 + 定时器），插件的状态屏负责让它可见。
   */
  /** 通知：toast（Windows 通知，默认）/ file（不额外提醒）/ webhook / both */
  notifyMode: z.string().default('toast').extra('volatile', true),
  /** 私信发给谁：昵称（只用于显示/提醒） */
  dmTo: z.string().default('').extra('volatile', true),
  /**
   * ⭐ 发给谁：**稳定 id**（sec_uid 或 uid）。真正决定发给谁的是这个，不是昵称。
   * 抖音重名极其常见 ⇒ 昵称只当"人类可读的名字"，`dmToId` 才是身份。
   * 留空时：只有在会话列表里昵称**唯一**才允许发；重名会直接拒绝并列出候选。
   */
  dmToId: z.string().default('').extra('volatile', true),
  /**
   * ⭐ 对老大的称呼（2026-10-25 使用者要求：「不管是评论还是私信，前面加上老大的称呼再说正文」）。
   *    称呼要出现，但**位置自然**（开头/中间/结尾都行）—— 2026-10-25 老大改口径：以前硬钉开头太机械，工具不再补前缀。
   *    留空 = 不加前缀。
   */
  ownerTitle: z.string().default('老大').extra('volatile', true),
  /**
   * ⭐ 私信自动回话（2026-10-25 使用者反馈：「我回复它私信后它没回我」）。
   *    老大的新消息进来 ⇒ 自动起一轮去读会话、按人设回一句（带称呼）。
   *    关掉 = 只通知不回话。
   */
  chatAutoReply: z.boolean().default(true).extra('volatile', true),
  /** ⭐ 回话轮的推理强度（low / medium / high）。越低越快；刷视频那一轮不受影响 */
  chatReplyEffort: z.string().default('low').extra('volatile', true),
  /** ⭐ 评论区 @ 我 → 去评论区回（2026-10-26 老大要求） */
  atMeAutoReply: z.boolean().default(true).extra('volatile', true),
  /** ⭐ 老大的数字 uid：只有这个人的 @ 才自动回（别人的 @ 不自动回，防钓鱼/防乱回） */
  ownerUid: z.string().default('111604112919').extra('volatile', true),
  /** ⭐ 我自己的昵称（2026-10-28）：判断「这条是不是冲我来的」用 —— 正文里 @ 了它、或它被回复 ⇒ 才自动回 */
  selfNickname: z.string().default('不吃白饭小肥鱼').extra('volatile', true),
  /**
   * ⭐ 记忆整理（2026-10-27 老大要求「记忆点太差」）：
   *    把私信按天时间线浓缩成 `memory/notes-<sec>.md`，回话时一起塞给模型。
   *    `notesDigest=false` 关掉；`notesGapMin` 是最短间隔（小时，默认 6；收工后另有一次）。
   */
  notesDigest: z.boolean().default(true).extra('volatile', true),
  notesGapMin: z.natural().default(6).extra('volatile', true),
  /**
   * ⭐ 自主生活（2026-10-27 老大要求）：
   *    过一段时间给它一次"要不要主动说句话"的机会，**发不发由它自己判断**。
   *    `lifeGapMin` 最短间隔（分钟，默认 180）；`lifePerDay` 每天上限（默认 3，0 = 不限）。
   *    ⚠️ 这两个是"别刷屏"的护栏，不是任务指标 —— 它一条都不发也正常。
   */
  lifeTick: z.boolean().default(true).extra('volatile', true),
  lifeGapMin: z.natural().default(180).extra('volatile', true),
  lifePerDay: z.natural().default(3).extra('volatile', true),
  webhookUrl: z.string().default('').extra('volatile', true),
  webhookPreset: z.string().default('custom').extra('volatile', true),
  /**
   * ⭐ 检查更新的地址（可选）。留空 = 自动：
   *   ① npm registry 的 `/<包名>/latest`（包要是发到 npm 了才查得到）
   *   ② 包里 `repository` 指向 GitHub 时，读仓库根目录的 package.json
   * 填了就只查这一个（要返回 JSON，至少有 { "version": "x.y.z" }）。
   */
  updateUrl: z.string().default('').extra('volatile', true),
  /** 日报形态：full / brief / off */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** Python：指向 venv 里那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就试自动探测） */
  dshBin: z.string().default('').extra('volatile', true),
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  // ⚠️ 2026-10-21 删掉了 `workspace`：它原来是"读那个目录下的 AGENTS.md 当人设"，
  //    正是这个口子让插件能读到**别的插件**的设定（抖音口吻被搬到刷B站那边）。
  //    现在人设只来自插件自带的 `prompts/persona.md`，外面没有任何路径可读。
})

/** ⭐ 给所有 Python 子进程统一 UTF-8（Windows 默认 GBK，中文/emoji 一进管道就可能炸） */
const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  /**
   * ⭐ 版本号：**按 mtime 缓存**，文件一变就重读。
   * 🔴 2026-10-23 使用者指出「本地插件版本你是不是写错了」——
   *    原来 `if (myVer) return myVer` 读一次就永久记住：宿主启动后改了
   *    package.json 的版本号，面板/douyin_status 还一直报旧版本，
   *    看起来就像"版本写错了"。现在 statSync 的 mtimeMs 变了就重读。
   */
  let myVer = ''
  let myVerMtime = -1
  const myVersion = () => {
    const pkgFile = join(pluginDir, 'package.json')
    try {
      const mtime = statSync(pkgFile).mtimeMs
      if (myVer && mtime === myVerMtime) return myVer
      myVer = String(JSON.parse(readFileSync(pkgFile, 'utf8')).version || '')
      myVerMtime = mtime
      return myVer
    } catch {
      return myVer || ''
    }
  }
  const stateDir = stateDirOf(ctx)
  const cfgFile = join(stateDir, 'config.json')
  const collectorFile = join(stateDir, 'collector.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  const inboxDir = join(stateDir, 'inbox')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  /** ⭐ Toast 的 ps1 和临时 json 也放 D 盘家目录（用户要求所有东西装 D 盘，别往 C:\Temp 撒） */
  const toastDir = join(stateDir, 'toast')
  const toastSend = (o) => sendToast({ ...o, dir: toastDir })
  /**
   * ⭐ 2026-10-30（老大反馈「后台在跑，但我什么都看不到」）：
   *   **出不去的东西必须自己说出来**。同一类事最多 1 小时提醒一次，别刷屏。
   *   用在：被风控冷却拦住、验证码页挡住、这一轮一条都没发出去。
   */
  const notifyOnce = (key, ms, title, body) => {
    try {
      const f = join(stateDir, 'notify-throttle.json')
      let m = {}
      try { m = JSON.parse(readFileSync(f, 'utf8')) } catch { m = {} }
      const now = Date.now()
      if (Number(m[key]) && now - Number(m[key]) < ms) return false
      m[key] = now
      const ks = Object.keys(m).sort((a, b) => Number(m[b]) - Number(m[a])).slice(0, 30)
      const keep = {}
      for (const k of ks) keep[k] = m[k]
      writeJson(f, keep)
      toastSend({ title, body })
      return true
    } catch { /* 通知失败不影响正事 */ }
    return false
  }
  /** 把「现在被什么挡住」说成一句人话（给 Toast / 报告 / 面板用） */
  const blockedWhy = () => {
    try {
      const s = rateStatus(stateDir)
      const kb = s.kindBlocked || {}
      const names = { dm: '私信', comment: '评论', reply: '回复', mention: '@', share: '分享卡片' }
      const parts = Object.keys(kb).map((k) => `${names[k] || k}（到 ${new Date(kb[k]).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`)
      if (s.needsVerify) return `卡在抖音验证页（要先手动过一次验证）${parts.length ? '；冷却中：' + parts.join('、') : ''}`
      return parts.length ? `风控冷却中：${parts.join('、')}` : ''
    } catch { return '' }
  }

  /* ── 日志：别让模型输出把结构化行粘在一起（抄 bili-scroll 的教训） ── */
  let atLineStart = true
  const rawWrite = (s) => {
    try {
      appendFileSync(logFile, s, 'utf8')
      atLineStart = String(s).endsWith('\n')
    } catch { /* 日志写不进去也不致命 */ }
  }
  const log = (msg) => {
    rawWrite((atLineStart ? '' : '\n') + `${new Date().toISOString()}  ${msg}\n`)
    try { ctx.logger?.info?.(`[douyin-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  for (const n of hostDeps.notes) log(n)

  /* ── 配置：逐字段按默认值类型挑一遍（apply 传进来的值不保证是标量） ── */
  const DEFAULTS = {
    perDay: 100, maxPerRun: 20, roundGapMin: 15, peakValley: false, noon: false, night: true,
    windows: [],
    keywords: [], channels: [], authors: [],
    minDescLen: 12, minComments: 3,
    autoComment: false, autoSend: true, commentAtMe: false, commentSelfName: '',
    commentExecutor: 'off', commentPerRun: 1, commentPerDay: 0,
    mentionName: '', httpCommentUrl: '',
    // ⭐ 大肥鱼自主行为（2026-10-24）。⚠️ DEFAULTS / zod 必须同步（漏加过 ⇒ 开关点了没反应）。
    autonomousLearn: true, shareToOwner: true, sharePerDay: 5,
    shareDmPerDay: 20, shareMentionPerDay: 20,
    proactiveComment: false, proactiveCommentPerDay: 0,
    autoReply: false, replyPerDay: 0, replyPerPerson: 2, replyKindOnly: true,
    // ⭐ 看画面（2026-10-24）/ 自适应抽帧 + 台词（2026-10-25 v0.4.0）
    //    ⚠️ 2026-10-25 老大说"别为省 token 牺牲识别" ⇒ 默认值放宽（帧更多更宽、台词更长）
    watchFrames: true, frameCount: 8,
    frameTargetSec: 3, frameMax: 30, frameWidth: 720,
    useOfficialSubtitle: true, useAsr: false, asrModel: 'small', spokenMaxChars: 1500,
    // ⭐ 表情包（2026-10-25 v0.4.0）：收集 / 安全审核 / 使用（贴纸 id）
    collectSticker: true, useSticker: false, stickerPerDay: 0, stickerSafeOnly: true, stickerAutoReview: true,
    // ⭐ 降风险控（2026-10-24）：拟人节奏 / 夜间静默 / 每小时·每天上限 / 养号
    humanMode: true, safeQuiet: true, quietStart: '23:00', quietEnd: '08:00',
    maxActionsPerHour: 100, maxActionsPerDay: 260, nurtureMode: true, nurtureDays: 3,
    notifyMode: 'toast', webhookUrl: '', webhookPreset: 'custom',
    updateUrl: '',
    dmTo: '', dmToId: '',
    // ⭐ 称呼 + 私信自动回话（2026-10-25 使用者要求）
    ownerTitle: '老大', chatAutoReply: true, chatReplyEffort: 'low',
    notesDigest: true, notesGapMin: 6,
    lifeTick: true, lifeGapMin: 180, lifePerDay: 3,
    // ⭐ 评论区 @ 我 → 去评论区回（2026-10-26）；ownerUid = 老大的数字 uid
    atMeAutoReply: true, ownerUid: '111604112919',
    selfNickname: '不吃白饭小肥鱼',
    // ⭐ 聊天模式（2026-10-24 定稿：默认开启，使用者拍板；要关就整个关掉）。
    //    ⚠️ DEFAULTS / zod 必须同步（漏加过 ⇒ 开关点了没反应）。
    chatWatch: true, chatWatchSec: 30,
    reportLevel: 'full', pythonPath: 'python', dshBin: '', headlessProfile: 'headless',
    overlayMcp: true,
  }
  // ⭐ 哪些数组字段装的是**对象**（不能按字符串过滤）
  //    之前判断 `base[k].length && typeof base[k][0] === 'object'` —— 但 DEFAULTS 里
  //    `windows: []` 是空的，length=0，于是走了字符串分支，用户存的自定义时段全被吃掉。
  //    改成显式声明，别靠"数组里恰好有元素"来判断。
  const OBJECT_ARRAYS = new Set(['windows'])
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) {
        if (!Array.isArray(v)) continue
        out[k] = OBJECT_ARRAYS.has(k)
          ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
          : v.filter((x) => typeof x === 'string')
      }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  /**
   * ⭐ 「设置里能写什么范围」收在一处 —— HTTP 接口、douyin_config 工具、**读配置**三处都走它。
   *    原生设置页那条路我们钳不到写 ⇒ loadCfg 读回来也过一遍（写进去和读出来一个口径）。
   */
  const ENUMS = {
    commentExecutor: ['off', 'builtin', 'browser', 'http'],
    notifyMode: ['file', 'toast', 'webhook', 'both'],
    webhookPreset: ['custom', 'wecom', 'feishu', 'dingtalk'],
    reportLevel: ['full', 'brief', 'off'],
  }
  const clampPatch = (patch) => {
    // ⭐ 只认 schema 里真有的字段。
    //    2026-10-21 实测：外面塞进来一个未知键（比如 `dmMode`），DSH 那边会把**整批**拒掉，
    //    报 `Config field "dmMode" is not volatile`，连带着私信对象一起没同步上。
    const p = {}
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) p[k] = patch[k]
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 100000))
    if ('maxPerRun' in p) p.maxPerRun = Math.max(1, Math.min(Number(p.maxPerRun) || 1, 30))
    if ('minDescLen' in p) p.minDescLen = Math.max(0, Math.min(Number(p.minDescLen) || 0, 200))
    if ('minComments' in p) p.minComments = Math.max(0, Math.min(Number(p.minComments) || 0, 1000))
    if ('commentPerRun' in p) p.commentPerRun = Math.max(0, Math.min(Number(p.commentPerRun) || 0, 20))
    if ('commentPerDay' in p) p.commentPerDay = Math.max(0, Math.min(Number(p.commentPerDay) || 0, 50))
    // 大肥鱼自主行为上限（0 = 关掉该动作；上限给保守天花板，防误填成天文数字）
    if ('shareDmPerDay' in p) p.shareDmPerDay = Math.max(0, Math.min(Number(p.shareDmPerDay) || 0, 100))
  if ('shareMentionPerDay' in p) p.shareMentionPerDay = Math.max(0, Math.min(Number(p.shareMentionPerDay) || 0, 100))
    if ('proactiveCommentPerDay' in p) p.proactiveCommentPerDay = Math.max(0, Math.min(Number(p.proactiveCommentPerDay) || 0, 30))
    if ('replyPerDay' in p) p.replyPerDay = Math.max(0, Math.min(Number(p.replyPerDay) || 0, 60))
    if ('replyPerPerson' in p) p.replyPerPerson = Math.max(0, Math.min(Number(p.replyPerPerson) || 0, 10))
    // ⭐ 看画面 / 风控（2026-10-24）/ 自适应抽帧 + 台词 + 表情包（2026-10-25）
    if ('frameCount' in p) p.frameCount = Math.max(2, Math.min(Number(p.frameCount) || 3, 12))
    if ('frameTargetSec' in p) p.frameTargetSec = Math.max(2, Math.min(Number(p.frameTargetSec) || 3, 8))
    if ('frameMax' in p) p.frameMax = Math.max(4, Math.min(Number(p.frameMax) || 30, 30))
    if ('frameWidth' in p) {
      const w = Number(p.frameWidth) || 640
      p.frameWidth = [320, 480, 640, 720].includes(w) ? w : 640
    }
    if ('spokenMaxChars' in p) p.spokenMaxChars = Math.max(0, Math.min(Number(p.spokenMaxChars) || 600, 2000))
    if ('asrModel' in p) {
      const m = String(p.asrModel || 'small').trim().toLowerCase()
      p.asrModel = ['tiny', 'base', 'small', 'medium', 'large'].includes(m) ? m : 'small'
    }
    if ('stickerPerDay' in p) p.stickerPerDay = Math.max(0, Math.min(Number(p.stickerPerDay) || 0, 30))
    if ('maxActionsPerHour' in p) p.maxActionsPerHour = Math.max(1, Math.min(Number(p.maxActionsPerHour) || 100, 1000))
    if ('maxActionsPerDay' in p) p.maxActionsPerDay = Math.max(1, Math.min(Number(p.maxActionsPerDay) || 260, 2000))
    if ('nurtureDays' in p) p.nurtureDays = Math.max(0, Math.min(Number(p.nurtureDays) || 3, 30))
    const hmOk = /^([01]\d|2[0-3]):[0-5]\d$/
    if ('quietStart' in p && !hmOk.test(String(p.quietStart))) p.quietStart = DEFAULTS.quietStart
    if ('quietEnd' in p && !hmOk.test(String(p.quietEnd))) p.quietEnd = DEFAULTS.quietEnd
    for (const [k, vals] of Object.entries(ENUMS)) {
      if (k in p) p[k] = vals.includes(String(p[k])) ? String(p[k]) : DEFAULTS[k]
    }
    return p
  }

  const CFG_SIG = ['perDay', 'maxPerRun', 'mentionName', 'commentExecutor']
  let settingsRow = { at: 0, row: null }
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }
  const hostCfg = () => normalize(config, { ...DEFAULTS })
  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })
  const loadCfg = () => {
    const saved = savedCfg()
    const row = settingsDesc()
    if (!row) return clampPatch(saved)
    const user = row.user || {}
    const out = { ...hostCfg() }
    for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]
    // host 那层退回默认值、而 config.json 里有非默认值时，以 config.json 为准
    const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b } }
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] === undefined) continue
      if (same(out[k], DEFAULTS[k]) && !same(saved[k], DEFAULTS[k])) out[k] = saved[k]
    }
    return clampPatch(out)
  }
  const cfg = loadCfg()
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }
  /**
   * ⭐ 发出去之前的最后一道整理（2026-10-25 老大改了口径）。
   *    以前是把「老大，」硬钉在开头 —— 老大说太机械，要求**称呼按内容自然放置**
   *    （可以开头、可以中间、可以结尾，也可以隔一句再说）。
   *    所以这里**只做清理，不再补前缀**：
   *      ① 破折号「——」/「--」统一换成逗号（老大明确说过像 AI 写的）
   *      ② 去掉模型偶尔手贱重复写的前缀（如「老大，老大，」）
   *      ③ 称呼由模型自己按上下文放进句子里；prompt 里已经交代，这里不越权。
   */
  /**
   * ⭐ 2026-10-28：分享理由**去重**用 —— 老大说「对视频的评价都很单一相似，太像 AI 总结」。
   *    把最近发出去的理由记下来，写新的一句时先看一眼：别重复开头词、别重复同一个句式和比喻。
   */
  const reasonsFile = join(stateDir, 'reasons.json')
  const noteReason = (s) => {
    const body = String(s || '').trim()
    if (!body) return
    try {
      const prev = readJson(reasonsFile, { list: [] })
      const list = Array.isArray(prev?.list) ? prev.list : []
      list.push({ at: new Date().toISOString(), text: body.slice(0, 200) })
      writeJson(reasonsFile, { list: list.slice(-60) })
    } catch { /* 记不上不影响发 */ }
  }
  const recentReasonLines = (n = 6) => {
    try {
      const prev = readJson(reasonsFile, { list: [] })
      const list = (Array.isArray(prev?.list) ? prev.list : []).slice(-n).map((x) => String(x.text || '')).filter(Boolean)
      return list
    } catch { return [] }
  }

  const withTitle = (s) => {
    const name = String(cfg.ownerTitle ?? '老大').trim()
    let body = String(s || '').trim().replace(/\s*——\s*/g, '，').replace(/\s*--+\s*/g, '，').replace(/，{2,}/g, '，')
    if (!body) return body
    if (name) {
      // 只收拾「连写两遍称呼」这种明显手滑，不动位置
      const dup = new RegExp(`^${name}[，,、\\s]+${name}[，,、\\s]*`)
      body = body.replace(dup, `${name}，`)
    }
    return body
  }
  const saveCfg = (patch) => {
    Object.assign(cfg, normalize(patch, cfg))
    // ⭐ 2026-10-21 实测事故：`dmTo` / `dmToId` 被清空过 —— 日志里连着三条 `设置已更新：{}`，
    //    设置页一渲染就把空输入框 blur 出去一次。清空的后果是私信直接发不出去（还不知道为什么）。
    //    规矩：空值不许覆盖磁盘上已有的非空值。
    const onDisk = readJson(cfgFile, {})
    for (const k of ['dmTo', 'dmToId']) {
      if (!String(cfg[k] || '').trim() && String(onDisk[k] || '').trim()) {
        cfg[k] = onDisk[k]
        log(`配置：${k} 差点被空值覆盖 —— 已保住磁盘上的原值`)
      }
    }
    writeJson(cfgFile, cfg)
  }
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await ctx.settings.update(row.ns, patch, row.revision)
      return row.ns
    }
    try { return { ok: true, ns: await attempt(false) } }
    catch (e) {
      if (!e?.noForm) { try { return { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 } }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
  /** ⭐ 落配置的唯一入口：config.json + DSH 原生设置页，钳完范围一起写 */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    syncCollectorCfg()               // ⭐ Python 那头的 router 读 collector.json
    const host = await saveCfgHost(clean)
    return { clean, host }
  }

  /**
  /**
   * ⭐ 把判据相关的配置同步给 Python 脚本（forward-pick.py 读它当预筛门槛）。
   *    不再有「采集来源」这条 —— 2026-10-21 砍掉 MCP 后只有一条路：只读接口取候选。
   */
  const syncCollectorCfg = () => {
    try {
      writeJson(collectorFile, {
        minDescLen: Number(cfg.minDescLen) || 0,
        minComments: Number(cfg.minComments) || 0,
        updatedAt: new Date().toISOString(),
      })
    } catch (e) { log(`写 collector.json 失败：${e?.message ?? e}`) }
  }

  ensureHomeFiles(pluginDir, stateDir, log)
  ensureCharter(pluginDir, stateDir, log)
  syncCollectorCfg()

  /* ─────────────── 环境（venv / uv） ─────────────── */
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'python.exe')
    : join(stateDir, '.venv', 'bin', 'python')
  /** ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在 */
  const venvReadyNow = () => existsSync(venvPython()) && hasPkg(join(stateDir, '.venv'), 'httpx')

  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 算了 */ } }

  const spawnTo = (cmd, args, { sink = appendInstall, env = null, cwd = stateDir } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      c = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
  let uvOk = null
  const haveUv = async () => {
    if (uvOk) return true
    const ok = await probeCmd('uv')
    if (ok) uvOk = true
    return ok
  }
  const resolveUv = async () => {
    if (await haveUv()) return 'uv'
    const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    try {
      const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
      if (got) appendInstall('uv 已就位：' + got + '\n')
      return got
    } catch (e) { appendInstall(`下 uv 失败：${e?.message ?? e}\n`); return null }
  }
  const MIRRORS = [
    process.env.DOUYIN_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.ustc.edu.cn/pypi/simple',
    'https://mirrors.aliyun.com/pypi/simple',
  ]

  let installing = false
  /** 建 venv + 装主依赖 —— ⭐ **起完就返回，不等它装完**（否则会话会僵住几分钟） */
  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装主依赖 ===\n`)
    ;(async () => {
      try {
        const req = join(pluginDir, 'requirements.txt')
        const venvPy = venvPython()
        const uvCmd = await resolveUv()
        if (!existsSync(venvPy)) {
          if (uvCmd) await spawnTo(uvCmd, ['venv', '--seed', join(stateDir, '.venv')])
          if (!existsSync(venvPy)) await spawnTo(String(cfg.pythonPath || 'python'), ['-m', 'venv', join(stateDir, '.venv')])
        }
        if (!existsSync(venvPy)) {
          const msg = '建不了 Python 环境 —— 这台机器上既没有可用的 uv，也没有可用的 python。\n'
            + '装一个就行：uv（单文件 exe，https://docs.astral.sh/uv/）或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次。\n'
          appendInstall(msg); log('装依赖：建环境失败'); installing = false; return
        }
        let code = 1
        for (const m of MIRRORS) {
          if (code === 0) break
          if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', req])
          if (code !== 0) code = await spawnTo(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', req])
        }
        if (code === 0 && existsSync(venvPy)) {
          await persistCfg({ pythonPath: venvPy })
          appendInstall(`已把 pythonPath 设为 ${venvPy}\n`)
        }
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}）===\n`)
        log(`装主依赖结束：exit=${code} venvReady=${venvReadyNow()}`)
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖（走国内镜像，通常几十秒）' }
  }

  /* ─────────────── MCP（已移除） ───────────────
   * 2026-10-21：原来这里起一份内置 Python MCP（家里那份 mcp_server.py），
   * 把「搜 / 预筛 / 评论 / 状态」注册成工具。那套走 bb-browser / playwright / cookie 三个驱动，
   * 一个都没跑通过真数据，还要求开浏览器 —— 整包删掉，改用下面的 runPy() 直接调 tools/*.py。
   */

  /* ─────────────── 工具 ─────────────── */
  /* ─────────────── 顺序哨兵：先卡片，后文字 ───────────────
   * 🔴 使用者 2026-10-21 亲自立的规矩：既要发卡片又要发文字时，**永远先卡片、后文字**。
   *    反过来他先看到一句话，却不知道在说哪条视频。
   *    2026-10-21 真翻过车：Chrome 被 DSH 重启带走，卡片那步 ECONNREFUSED 崩掉，
   *    紧接着发理由的脚本却自己把 Chrome 拉起来发出了 —— 结果他先收到「这条一定要发你…」，
   *    过一会儿才收到卡片。这就是要防的形态。
   *    这里只做**软拦**（返回值里带 order_warning），不硬拒绝 —— 顺序错了也要发，但要说出来。
   */
  const recentDm = { at: 0, secUid: '', kind: '' }
  const noteDm = (kind, secUid) => { recentDm.at = Date.now(); recentDm.secUid = String(secUid || ''); recentDm.kind = String(kind || '') }
  /** 发卡片之前问一句：刚是不是已经给同一个人发过纯文字了？ */
  const orderWarning = (secUid) => {
    if (recentDm.kind !== 'text') return null
    const age = Date.now() - recentDm.at
    if (age > 180_000) return null
    if (secUid && recentDm.secUid && String(secUid) !== recentDm.secUid) return null
    return `⚠️ 规矩是「先卡片，后文字」—— ${Math.round(age / 1000)} 秒前刚给同一个人发过纯文字，卡片这次才到，顺序反了。下次用 share_card 的 reason 一次办完。`
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  /** 工具返回值一律过这里：宿主只吃"无损 JSON" */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  /**
   * 跑插件自带的 node 脚本（tools/*.mjs），返回 {status, stdout, stderr} —— 永不抛
   * ⚠️ 2026-10-22：这里以前写死 `IM_CDP_PORT: '9334'` —— 那等于把 lib/chrome.mjs 的
   *    端口自动探测**废掉**（强制 9334，撞上就死）。现在只注入家目录，端口交给 lib 自己找。
   */
  const runNodeTool = (script, args = [], { timeout = 240_000, extraEnv = null } = {}) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return { status: -1, stdout: '', stderr: `缺少 tools/${script}` }
    const r = spawnSync(process.execPath, [f, ...args], {
      encoding: 'utf8',
      timeout,
      env: pyEnv({ DOUYIN_HOME: stateDir, ...(extraEnv || {}) }),
      windowsHide: true,
    })
    return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error || '') }
  }
  /**
   * ⭐ 2026-10-30 新增：`runNodeTool` 的**异步版**。
   *    回话盯梢要读 DOM（HTTP 那条只回会话最早的 20 条，聊过 20 条之后永远看不到新消息 ——
   *    实测老大有 6 条未读，插件一条都没看见）。DOM 读要开浏览器、几十秒，
   *    用 spawnSync 会把整个宿主线程卡住（HTTP API / 定时器全停），所以这里必须异步。
   */
  const runNodeToolAsync = (script, args = [], { timeout = 240_000, extraEnv = null } = {}) => new Promise((resolve) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return resolve({ status: -1, stdout: '', stderr: `缺少 tools/${script}` })
    let done = false
    let tm = null
    const finish = (o) => { if (done) return; done = true; try { if (tm) clearTimeout(tm) } catch { /* 忽略 */ } resolve(o) }
    let child
    try {
      child = spawn(process.execPath, [f, ...args], {
        env: pyEnv({ DOUYIN_HOME: stateDir, ...(extraEnv || {}) }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) { return resolve({ status: -1, stdout: '', stderr: String(e?.message ?? e) }) }
    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { err += String(b) })
    child.on('error', (e) => finish({ status: -1, stdout: out, stderr: String(e?.message ?? e) }))
    child.on('close', (code) => finish({ status: code ?? -1, stdout: out, stderr: err }))
    tm = setTimeout(() => { try { child.kill() } catch { /* 已经没了 */ } finish({ status: -1, stdout: out, stderr: err || `超时 ${timeout}ms` }) }, timeout)
    tm.unref?.()
  })
  /**
   * 跑插件自带的 Python 脚本（tools/*.py），返回 {status, stdout, stderr} —— 永不抛
   * ⚠️ 2026-10-21：这里以前是一份内置 MCP server（vendor/douyin-mcp，33 个文件 / 506 KB）+
   *    5 个 bb-browser/cookie 驱动。那套东西一个都没跑通过真数据，还被「必须开浏览器」绑着；
   *    现在采集/发送全走「HTTP + 无头 Chrome」，那些全删了。
   */
  const runPy = (script, args = [], { timeout = 240_000 } = {}) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return { status: -1, stdout: '', stderr: `缺少 tools/${script}` }
    const py = existsSync(venvPython()) ? venvPython() : (cfg.pythonPath || 'python')
    const r = spawnSync(py, [f, ...args], {
      encoding: 'utf8',
      timeout,
      env: pyEnv({ DOUYIN_HOME: stateDir }),
      windowsHide: true,
    })
    return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error || '') }
  }

  /** 从脚本输出里抠出最后一个完整 JSON 对象 */
  const pickJson = (s) => {
    const t = String(s || '')
    const i = t.indexOf('{'), j = t.lastIndexOf('}')
    if (i < 0 || j <= i) return null
    try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
  }

  /**
   * ⭐ 2026-10-25 新增（本机补丁）：**评论兜底读取**
   *   签名接口（tools/api-comments.py）要 $DOUYIN_HOME/signer 下的 sdk 资产 + 改过版的 bdms，
   *   这些东西作者没随仓库发；缺了就 KeyError: 'signedUrl'，而调用方只看 cid= 行 ⇒ 永远"没拉到评论"。
   *   这里统一成：先用签名接口，拿不到就退回 DOM 读（tools/comment-read-dom.mjs，走无头 Chrome 的登录态）。
   *   返回 { ok, via:'api'|'dom'|'none', lines:['nick: text'], head, stderr }
   */
  const commentLines = (aweme, { limit = 5, timeout = 200_000, scroll = 3 } = {}) => {
    const c = runPy('api-comments.py', [String(aweme)], { timeout })
    const out = String(c.stdout || '')
    // ⭐ 2026-10-25：DOM 兜底会顺带吐出 VIDEO_JSON（视频文案/作者/话题）—— 需求④要用
    const grabVideo = (text) => {
      const m = /^VIDEO_JSON=(.+)$/m.exec(String(text || ''))
      if (!m) return null
      try { const v = JSON.parse(m[1]); return (v && (v.desc || v.title || v.author)) ? v : null } catch { return null }
    }
    const apiLines = out.split('\n')
      .filter((l) => /^\s{2}cid=/.test(l))
      .map((s) => s.replace(/^\s+/, '').replace(/^cid=\d+\s+/, '').slice(0, 160))
    if (c.status === 0 && apiLines.length) {
      return {
        ok: true, via: 'api', lines: apiLines.slice(0, limit),
        head: out.split('\n').find((l) => /status_code=/.test(l)) || '', stderr: '',
        video: grabVideo(out),
      }
    }
    try {
      const dr = runNodeTool('comment-read-dom.mjs',
        ['--aweme', String(aweme), '--scroll', String(scroll)],
        { timeout: Math.max(timeout, 200_000) })
      const j = pickJson(dr.stdout)
      const items = Array.isArray(j?.items) ? j.items : []
      const domLines = items
        .map((x) => `${String(x.nick || '').trim()}: ${String(x.text || '').replace(/^\.\.\.\s*/, '').trim()}`)
        .filter((s) => s && !/^(精选|搜索|充钻石|推荐|登录)\s*:/.test(s) && !/视频数据加载中/.test(s))
      return {
        ok: domLines.length > 0, via: 'dom', lines: domLines.slice(0, limit),
        head: domLines.length ? 'via=dom' : 'via=dom(空)',
        stderr: String(c.stderr || dr.stderr || '').slice(0, 300),
        video: grabVideo(out) || (j?.video && (j.video.desc || j.video.title || j.video.author) ? j.video : null),
      }
    } catch (e) {
      return { ok: false, via: 'none', lines: [], head: '', stderr: String(e?.message ?? e).slice(0, 300) }
    }
  }

  /**
   * ⭐⭐ 2026-10-23 新增：**发送闸 / 限流退避 / 三态回读**
   *    起因：使用者问「回评论用什么方案比较快」，一量才发现三个真问题 ——
   *    ① 连发 3 条评论后 API 直接 **403**（抖音限流），原来代码只会把 403 当普通失败返回，
   *       调用方一看失败就重试 ⇒ 越重试封得越久。
   *    ② 发完看不见：**不是"进审核"**（2026-10-23 实测推翻了这个说法）——
   *       真实原因是抖音评论列表**按热度排序**，刚发的 0 赞评论排在最后，
   *       而这个视频**不给切「最新」排序**（页面根本没有那个按钮）；
   *       按 cid 查详情的接口也是 404。⇒ "读不到"只说明**我够不着**，
   *       不说明它没发出去（能按 cid 删掉 = 服务端收下了，这是硬证据）。
   *    ③ 两条通道（api 快但假 @、ui 真 @ 但慢）混在一个工具里，调用方不知道自己在走哪条。
   *    ⇒ 这里给前三样补上：全局最小间隔、403 退避窗口、回读三态。
   */
  const sendGateFile = join(stateDir, 'send-gate.json')
  /** 两条通道的最小间隔（秒）—— api 快但更容易撞限流，给宽一点 */
  const MIN_GAP = { api: 45, ui: 20 }

  const sendGate = async (dir, mode) => {
    const st = readJson(sendGateFile, {}) || {}
    const now = Date.now()
    const blockedUntil = Number(st.blockedUntil) || 0
    if (now < blockedUntil) {
      return {
        ok: false, reason: 'cooldown',
        waitSec: Math.ceil((blockedUntil - now) / 1000),
        note: `上次撞了限流，冷却中（到 ${new Date(blockedUntil).toLocaleTimeString('zh-CN')}）`,
      }
    }
    /**
     * 🔴 闸按**两条通道各自的间隔**算，但也要算"另一条通道刚发过"——
     *    抖音的风控看的是**这个号在评论区发言的频率**，不分 api/ui。
     *    所以取 max(本通道间隔, 跨通道最小间隔 15 秒)。
     */
    const lastSame = Number(st[`last_${mode}`]) || 0
    const lastAny = Math.max(Number(st.last_api) || 0, Number(st.last_ui) || 0)
    const gapSame = (MIN_GAP[mode] || 30) * 1000
    const gapAny = 15_000
    const sinceSame = now - lastSame
    const sinceAny = now - lastAny
    if (lastSame && sinceSame < gapSame) {
      return {
        ok: false, reason: 'too-fast', mode,
        waitSec: Math.ceil((gapSame - sinceSame) / 1000),
        lastSec: Math.round(sinceSame / 1000),
        note: `mode=${mode} 的最小间隔是 ${MIN_GAP[mode]} 秒，上次才过 ${Math.round(sinceSame / 1000)} 秒`,
      }
    }
    if (lastAny && sinceAny < gapAny) {
      return {
        ok: false, reason: 'too-fast-any',
        waitSec: Math.ceil((gapAny - sinceAny) / 1000),
        lastSec: Math.round(sinceAny / 1000),
        note: `刚用另一条通道发过（${Math.round(sinceAny / 1000)} 秒前），跨通道也要隔 ${gapAny / 1000} 秒`,
      }
    }
    return { ok: true }
  }
  /** 记一条"刚发过" —— **只更新本通道的时间戳**（以前两个都写，等于把另一条通道的间隔也重置了） */
  const markSent = (dir, mode = 'api') => {
    try {
      const st = readJson(sendGateFile, {}) || {}
      st[`last_${mode}`] = Date.now()
      st.lastMode = mode
      st.lastAt = new Date().toISOString()
      writeFileSync(sendGateFile, JSON.stringify(st, null, 2), 'utf8')
    } catch { /* 记不上不影响发 */ }
  }
  /** 撞限流：设一个冷却窗口，期间所有发送都直接拒 */
  const bumpBlock = (dir, minutes = 10) => {
    try {
      const st = readJson(sendGateFile, {}) || {}
      st.blockedUntil = Date.now() + minutes * 60_000
      st.blockedAt = new Date().toISOString()
      writeFileSync(sendGateFile, JSON.stringify(st, null, 2), 'utf8')
    } catch { /* 记不上不影响 */ }
  }

  // ⭐⭐ v0.3.9 降风险控 + 私信铁闸（2026-10-24）========================================
  // host 与 MCP 所有对外动作都走 lib/ratelimit.mjs 这同一道闸，绕不过去。
  /**
   * ⭐ 2026-10-25 老大改的口径：
   *   ① 默认限额就是「每小时 100 / 每天 260」；
   *   ② 这俩上限**只在养号前 3 天**真的起作用；
   *   ③ 3 天之后**默认不限额**（想限就手动把数字改掉 —— 改过的值继续生效，没改过就放开）。
   *   判据：`nurtureQuota() < 1` 就是养号期；出养号期后，配置里还是默认值（100/260）⇒ 传 0 = 不限。
   */
  const capAfterNurture = () => {
    const H = 100, D = 260   // 与 DEFAULTS 里的默认值一致
    const h = Number(cfg.maxActionsPerHour) || H
    const d = Number(cfg.maxActionsPerDay) || D
    return { h: h === H ? 0 : h, d: d === D ? 0 : d }
  }
  const rateOpts = () => {
    let nurturing = true
    try { nurturing = nurtureQuota(loadRateState(stateDir), { nurtureMode: cfg.nurtureMode !== false, nurtureDays: Number(cfg.nurtureDays) || 3 }) < 1 } catch { nurturing = true }
    const late = nurturing ? null : capAfterNurture()
    return {
      humanMode: cfg.humanMode !== false,
      safeQuiet: cfg.safeQuiet !== false,
      quietStart: String(cfg.quietStart || '23:55'),
      quietEnd: String(cfg.quietEnd || '08:00'),
      maxActionsPerHour: late ? late.h : (Number(cfg.maxActionsPerHour) || 100),
      maxActionsPerDay: late ? late.d : (Number(cfg.maxActionsPerDay) || 260),
      nurtureMode: cfg.nurtureMode !== false,
      nurtureDays: Number(cfg.nurtureDays) || 3,
    }
  }
  const RATE_NOTE = {
    hard_circuit: '🔴 撞到登录失效/封号这类账号级信号，已硬熔断，一段时间内停止一切外发（设置页「恢复」可手动解除）',
    cooldown: '撞了账号级限流，冷却中，先停手别再发',
    kind_cooldown: '⭐ 只是**这一类动作**在冷却（比如回评论撞了 403）—— 分享 / 私信 / 评论 / @ 其它动作照常可以发，别把整轮都停了',
    quiet_hours: '现在是夜间静默时段，不主动对外发（默认 23:00–08:00，设置页可改）',
    day_cap: '今天对外动作已到上限，明天再发',
    hour_cap: '这一小时动作太密，过会儿再发',
    kind_day_cap: '这一类动作今天的额度用完了，别的动作照常',
  }
  const rateBlocked = (g) => {
    const nv = g.reason === 'kind_cooldown' && g.detail && g.detail.needs_verify
    // ⭐ 2026-10-30：被闸拦住时主动说一声（1 小时最多一次），别让老大只看到"什么都没发生"
    try {
      const kindName = (g.detail && g.detail.kind) || ''
      const when = g.detail && g.detail.until ? new Date(g.detail.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
      notifyOnce(`blocked:${g.reason}:${kindName}`, 60 * 60_000,
        nv ? '大肥鱼卡在抖音验证页了' : '大肥鱼被风控拦了一下（没发出去）',
        nv ? '要你手动过一次验证才能发出去；其余动作不受影响。' : `${kindName || '动作'}被冷却到 ${when || '稍后'}${blockedWhy() ? '；' + blockedWhy() : ''}`)
    } catch { /* 忽略 */ }
    return {
      ok: false, blocked: true, sent: false, reason: g.reason,
      detail: g.detail || {}, waitMs: g.waitMs || 0,
      note: nv
        ? '这一类动作卡在抖音的短信验证上（不是封号）—— 让老大跑一次 node tools/comment-verify.mjs --aweme <id> --request-code / --code <6位> 就能恢复；**分享/私信照常可以发**'
        : (RATE_NOTE[g.reason] || '风控闸拦住了，先别发'),
      ...(g.reason === 'kind_cooldown' ? { others_ok: true } : {}),
    }
  }
  /**
   * ⭐ 私信铁闸（使用者要求）：只和老大一人收发。
   * 目标 toId 必须等于设置里的 dmToId；没配置老大、或目标不是老大，一律拦下。
   * 返回 null 表示放行，否则返回一个 blocked 结果。
   */
  const ownerOnlyGate = (toId) => {
    const owner = String(cfg.dmToId || '').trim()
    const target = String(toId || '').trim()
    if (!owner) {
      return { ok: false, blocked: true, reason: 'owner_not_set', sent: false,
        error: '还没设置老大的稳定 ID（dmToId），不能给任何人发私信', hint: '在设置页填「老大的稳定 ID（sec_uid）」' }
    }
    if (!target) {
      return { ok: false, blocked: true, reason: 'owner_not_set', sent: false,
        error: '没有收件人，且未配置老大', hint: '在设置页填「老大的稳定 ID（sec_uid）」' }
    }
    if (target !== owner) {
      return { ok: false, blocked: true, reason: 'owner_only', sent: false,
        error: '私信锁死：只和老大一人收发，不发给其他任何人', detail: { target } }
    }
    return null
  }
  /** 发送器输出里识别 403/验证码/登录失效等信号，喂给风控（返回是否触发熔断） */
  const rateFailFromText = (kind, ...parts) => {
    const text = parts.map((p) => (typeof p === 'string' ? p : (p?.error || p?.stderr || (p == null ? '' : JSON.stringify(p))))).join(' ')
    return recordFailure(stateDir, kind, text, rateOpts())
  }

  /**
   * 三态回读：**别再只说 found / not found**。
   *   visible   —— 评论区里真的刷到了（按 cid 或正文片段）
   *   pending   —— 刷不到，但很可能只是审核/延迟（如实报，不谎报成功也不谎报失败）
   *   unknown   —— 回读本身失败了（工具挂了），更不能当成"没发出去"
   */
  const readbackAfter = async (dir, aweme, { text = '', cid = '' } = {}) => {
    const tries = 3
    for (let i = 0; i < tries; i++) {
      await new Promise((done) => setTimeout(done, 2000))
      try {
        // ① 有 cid 就按 cid 查（最准）
        if (cid) {
          const cr = runPy('api-comments.py', [aweme], { timeout: 300_000 })
          const out = String(cr.stdout || '')
          if (out.includes(cid)) return { state: 'visible', by: 'cid', cid, attempt: i + 1 }
        }
        // ② 没 cid（UI 路径）或 cid 没查到 ⇒ 按正文片段查 DOM（页面默认按最新渲染）
        if (text) {
          const dr = runNodeTool('comment-read-dom.mjs', ['--aweme', aweme, '--mine', '--scroll', '6'], { timeout: 200_000 })
          const j = pickJson(dr.stdout)
          const needle = String(text).slice(0, 12)
          const items = Array.isArray(j?.items) ? j.items : []
          if (items.some((x) => String(x.text || '').includes(needle))) {
            return { state: 'visible', by: 'dom', attempt: i + 1 }
          }
        }
      } catch { /* 这一轮回读挂了，继续试 */ }
    }
    return {
      state: 'pending', by: cid ? 'cid+dom' : 'dom',
      note: '读不到这条评论**不等于没发出去**：抖音评论按热度排序，刚发的 0 赞评论排最后，'
        + '这个视频也没有「最新」排序可切 ⇒ 回读够不着。有 cid 且能按 cid 删除 = 服务端收下了。'
        + '报告里写「已提交，未在评论区核实到（热度排序够不着）」，别写成"进审核了"（那是没根据的推测）',
    }
  }


  tool({
    name: 'douyin_doctor',
    description: '⭐ **环境体检**（换台设备 / 装完插件第一件事就跑它）：家目录、Python、venv、Cookie、'
      + 'Node、浏览器、CDP 端口、关键脚本 —— 八项逐个查，哪项红了直接给「怎么办」。'
      + '只读，什么都不改。',
    parameters: {},
    async execute() {
      // ⭐ 用纯 Node 版：第一次装的时候还没有 Python，不能让它依赖 Python
      const r = runNodeTool('doctor.mjs', ['--json'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return {
          ok: false, error: '体检脚本没返回可解析结果',
          stdout: String(r.stdout || '').slice(0, 400), stderr: String(r.stderr || '').slice(0, 300),
        }
      }
      const bad = j.must_fix || []
      const warn = j.warns || []
      if (bad.length) log(`doctor: ${bad.length} 项要修（${bad.map((x) => x.item).join('、')}）`)
      return {
        ok: j.ok !== false,
        items: j.items,
        must_fix: bad,
        todo: warn,
        hint: bad.length
          ? `先把这些修掉：${bad.map((x) => x.item).join('、')}`
          : (warn.length ? `没有硬伤，这些装完依赖/登录后会自己变绿：${warn.map((x) => x.item).join('、')}` : '全绿，可以跑值班了'),
      }
    },
  })

  tool({
    name: 'douyin_whoami',
    description: '看抖音这边的登录状态（会话还活着吗、nick 是谁）。不确定时先调它 —— **只读体检**，不影响登录态。',
    parameters: {},
    async execute() {
      if (!hasCredential(stateDir)) {
        return { ok: false, logged_in: false, hint: '还没有 Cookie —— 设置页「抖音 Cookie / 登录」扫码，或粘一条 Cookie' }
      }
      const r = runPy('session-guard.py', ['check'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检没返回结果', stderr: String(r.stderr || '').slice(0, 300) }
      return { ok: true, logged_in: j.alive === true, ...j }
    },
  })

  tool({
    name: 'douyin_backend',
    description: '看当前这套采集 / 发送分别是怎么走的、各自的限制是什么。',
    parameters: {},
    async execute() {
      return {
        ok: true,
        stack: [
          { part: '取候选（清单）', how: '不签名的只读接口 tab/feed + hot/search', tool: 'douyin_forward', risk: '不碰写接口 ⇒ 不影响登录态' },
          { part: '读评论 / 读通知', how: '签名只读（dy-signer.mjs 出 a_bogus）', tool: 'douyin_comments / douyin_notices', risk: '低' },
          { part: '发私信 / 发卡片 / 发评论', how: '无头 Chrome 里跑抖音自己的前端', tool: 'douyin_dm / douyin_share_card / douyin_comment_reply', risk: '≈0（页面自己签名），但发前必须先问用户' },
        ],
        removed_2026_10_21: '删掉了 vendor/douyin-mcp（33 个文件 / 506 KB）和 bb-browser 那套驱动 —— 一个真数据都没跑通过',
        browser_policy: '可见浏览器只在扫码登录时用一次（tools/qr-login.mjs）；其余全是无头 Chrome 或纯 HTTP',
        not_available: ['关键词搜索（抖音 web 没有可用搜索接口，只有推荐流）', '视频详情（web 详情接口被 ArgusSecurityPlugin 挡）'],
      }
    },
  })

  tool({
    name: 'douyin_prescreen',
    description: '⭐ 一轮的主入口：取候选 → 打分 →（可选）给前几条拉高赞评论 → 返回「判断用的证据包」。'
      + '**判断就基于返回的 list[].evidence，别自己再逐条搜。**',
    parameters: {
      top: { type: 'number', description: '返回前几条（默认 10，最多 30）' },
      with_comments: { type: 'number', description: '给前 N 条拉评论（默认 5；0 = 不拉）' },
    },
    async execute(args = {}) {
      const top = Math.max(1, Math.min(Number(args.top) || 10, 30))
      const wcRaw = args.with_comments === undefined ? 5 : Number(args.with_comments)
      const withComments = Math.max(0, Math.min(Number.isFinite(wcRaw) ? wcRaw : 5, 15))
      const r = runPy('forward-pick.py', (() => { const k = pickRoundKeywords(); return k.take.length ? ['--keywords', k.take.join(',')] : [] })(), { timeout: 600_000 })
      if (r.status !== 0) return { ok: false, error: '取候选失败', stderr: String(r.stderr || '').slice(0, 400) }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, top)
      if (!rows.length) return { ok: true, kept: 0, note: '推荐流这轮没返回候选，稍后再试' }
      const list = []
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i]
        const item = {
          aweme_id: x.aweme_id, desc: x.desc, author: x.author,
          duration_s: x.duration_s, age_h: x.age_h,
          digg: x.digg, comment: x.comment, collect: x.collect, share: x.share,
          ratios: {
            '评/赞': x.comment_ratio,
            '藏/赞': x.digg ? Number((x.collect / x.digg).toFixed(4)) : 0,
            '转/赞': x.digg ? Number((x.share / x.digg).toFixed(4)) : 0,
          },
          share_url: x.share_url, web_url: x.web_url,
          // ⭐ 从哪个关键词搜来的（空 = 推荐流/热榜）
          kw: x.kw || "",
        }
        if (i < withComments && Number(x.comment) > 0) {
          const c = commentLines(x.aweme_id, { limit: 5 })
          item.evidence = c.ok && c.lines.length ? c.lines : ['（没拉到评论）']
          if (c.via !== 'api') item.evidence_via = c.via
        }
        list.push(item)
      }
      return { ok: true, kept: list.length, sources: picked.meta || [], dropped: picked.dropped || {}, thresholds: picked.thresholds || {}, list }
    },
  })

  tool({
    name: 'douyin_forward',
    description: '⭐「转发视频给我」：拉推荐流候选 → 打分 → 出清单（含 douyin.com 分享链接），可同时弹 Windows 通知。'
      + '只用**不签名**的只读接口（tab/feed、hot/search），不碰写接口，因此**不会**影响登录态。',
    parameters: {
      toast: { type: 'boolean', description: '是否弹 Windows 通知（默认 true）' },
      top: { type: 'number', description: '通知里放几条（默认 3，最多 4）' },
    },
    async execute(args = {}) {
      const script = join(pluginDir, 'tools', 'forward-pick.py')
      if (!existsSync(script)) return { ok: false, error: '缺少 tools/forward-pick.py（插件包不完整）' }
      if (!existsSync(cookiePath(stateDir))) {
        return { ok: false, error: '还没有 Cookie', hint: '先扫码登录（tools/qr-login.mjs start），或设置页粘贴 Cookie' }
      }
      const venvPy = join(stateDir, '.venv', 'Scripts', 'python.exe')
      const py = existsSync(venvPy) ? venvPy : (cfg.pythonPath || 'python')
      // ⭐ 每轮筛选取多少条用「每轮最多刷几条」（maxPerRun）；抓帧开关由 py 读 config.json（watchFrames/frameCount）
      const limit = Math.max(1, Math.min(Number(cfg.maxPerRun) || 20, 30))
      const kwNow = pickRoundKeywords()
      const kwArgv = kwNow.take.length ? ['--keywords', kwNow.take.join(',')] : []
      const r = spawnSync(py, [script, '--limit', String(limit), ...kwArgv], {
        encoding: 'utf8',
        timeout: 420_000,
        env: pyEnv({ DOUYIN_HOME: stateDir }),
        windowsHide: true,
      })
      if (r.status !== 0) {
        return { ok: false, error: 'forward-pick.py 执行失败', stderr: String(r.stderr || r.error || '').slice(0, 400) }
      }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = Array.isArray(picked.rows) ? picked.rows : []
      if (!rows.length) return { ok: true, picked: 0, note: '这一轮没拉到候选（推荐流可能返回空），稍后再试' }

      const fm = (n) => {
        n = Number(n) || 0
        if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
        if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
        return String(n)
      }
      const wantToast = args.toast !== false
      let toastRes = { ok: true, sent: false, skipped: 'disabled' }
      if (wantToast) {
        const n = Math.max(1, Math.min(Number(args.top) || 3, 4))
        const head = rows.slice(0, n).map((x) => `· ${fm(x.digg)}赞｜${String(x.desc || '').replace(/\s+/g, ' ').slice(0, 34)}`)
        const more = rows.length > n ? `\n… 还有 ${rows.length - n} 条，见 out/` : ''
        toastRes = toastSend({ title: `刷抖音 · 挑到 ${rows.length} 条`, body: head.join('\n') + more })
      }
      log(`forward: 挑到 ${rows.length} 条，通知=${toastRes.ok && toastRes.sent ? '已弹' : (toastRes.error || toastRes.skipped || '未弹')}`)
      return {
        ok: true,
        picked: rows.length,
        sources: picked.meta || [],
        frames: picked.frames || { on: false },
        // ⭐ v0.4.0 台词来源统计（official_subtitle / asr / none）
        spoken: (picked.frames && picked.frames.spoken) || { official_subtitle: 0, asr: 0, none: 0 },
        toast: toastRes,
        list: rows.map((x) => ({
          aweme_id: x.aweme_id,
          desc: x.desc,
          author: x.author,
          duration_s: x.duration_s,
          digg: x.digg,
          comment: x.comment,
          collect: x.collect,
          share: x.share,
          share_url: x.share_url,
          share_desc: x.share_desc,
          web_url: x.web_url,
          // ⭐ 画面证据：相对插件家（值班轮工作区）的帧路径，模型用 Read 打开就能"看到"这条视频
          frames: Array.isArray(x.frames) ? x.frames : [],
          frames_kind: x.frames_kind || 'none',
          // ⭐ v0.4.0 台词证据：官方字幕或本地 Whisper 转写（无则空串，spoken_kind=none/off）
          spoken: typeof x.spoken === 'string' ? x.spoken : '',
          spoken_kind: x.spoken_kind || 'none',
          // ⭐ 内容类型（2026-10-27）：ai = AI 生成/合成，drama = 剧情/影视演绎，real = 真人真事
          kind: x.kind || 'real',
        })),
      }
    },
  })

  tool({
    name: 'douyin_dm',
    description: '通过**无头 Chrome**（屏幕上不出现任何窗口）把一条私信发给指定抖音好友。'
      + '消息由抖音自己的前端发出 —— 连接、签名、protobuf 编码都由它完成，'
      + '所以**不会像自己拼签名那样把登录态搞掉**。'
      + 'from_list=true 时自动取最近一轮清单当正文（用官方 share_url 分享链接）。'
      + '🔴 规矩：**先卡片，后文字** —— 这次如果还要把视频给他，先调 `douyin_share_card`'
      + '（它的 `reason` 就是那条文字），**不要**先用这里发文字再补卡片。',
    parameters: {
      to: { type: 'string', description: '发给谁（抖音昵称，只用于显示；leave空用配置 dmTo）' },
      to_id: { type: 'string', description: '⭐ 发给谁：**稳定 id**（sec_uid 或 uid）。重名时**必须**给这个；留空用配置 dmToId' },
      text: { type: 'string', description: '私信正文（与 from_list / sticker_key 三选一）' },
      sticker_key: { type: 'string', description: '⭐ 给老大发一张图片表情：表情库 key（必须已审核 approved）；走聊天框图片上传，受每日贴纸上限约束' },
      from_list: { type: 'boolean', description: '用最近一轮刷到的清单当正文（默认 false）' },
      top: { type: 'number', description: 'from_list 时放几条（默认 3，最多 5）' },
      dry: { type: 'boolean', description: '只验证通道，不真发（默认 false）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只返回草稿不发送' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或在设置里填「私信发给谁」+「稳定 ID」' }
      // ⭐ 私信铁闸（v0.3.9）：只允许发给老大，其它任何人一律拦（预览阶段就拦，趁早纠正）
      const ownerBlock = ownerOnlyGate(toId)
      if (ownerBlock) return ownerBlock
      let file = ''
      if (args.from_list) {
        // ⭐ 需求③：分享视频必须走官方分享卡片，不能再用文字链接清单（抖音里点不开、也不算分享）
        return {
          ok: false, blocked: true, reason: 'use_share_card',
          error: '要把视频给老大，请用 douyin_share_card（抖音官方分享卡片），不要再用 from_list 发文字链接清单',
          hint: 'douyin_share_card({ aweme_id, reason:"我为什么觉得这条值得看", confirm:true })',
        }
      }
      // ⭐ 2026-10-25：私信正文整理（破折号兜底 + 去重复称呼；不再补前缀，位置由模型定）
      const text = withTitle(String(args.text || '').trim())
      // ⭐ 发图片表情（sticker_key）：只发给老大，走聊天框图片上传
      const skey = String(args.sticker_key || '').trim()
      if (skey) {
        const st = listStickers(stateDir, { status: 'all', limit: 500 }).find((x) => x.key === skey)
        if (!st) return { ok: false, error: '表情库里没有这个 key（先 douyin_sticker_list 看）' }
        if (cfg.stickerSafeOnly !== false && st.status !== 'approved') {
          return {
            ok: false, blocked: 'not_approved', status: st.status,
            error: st.status === 'blocked' ? '这张表情审核没过（含不良/不适），不能发' : '这张表情还没审核：先 Read 它的 thumb，用 douyin_sticker_review 放行',
          }
        }
        const imgUrl = String(st.url || st.thumb || '').trim()
        if (!imgUrl) return { ok: false, unsupported: 'no_image_url', error: '这张表情没有可上传的图片地址' }
        const perDay = Math.max(0, Number(cfg.stickerPerDay) || 0)
        const usedToday = stickerSentToday(stateDir)
        // ⭐ 2026-10-25 老大要求「发几个表情不设上限」⇒ perDay=0 = 不限（以前 0 是"禁止"）
        if (perDay > 0 && usedToday >= perDay) return { ok: false, blocked: 'sticker_cap', used: usedToday, max: perDay, error: `今天发表情已到上限（${usedToday}/${perDay}），明天再发` }
        if (args.confirm !== true) {
          return {
            ok: true, sent: false, needsConfirm: true, kind: 'image', to, to_id: toId || undefined,
            sticker: { key: st.key, name: st.name, kind: st.kind, thumb: st.thumb, url: imgUrl },
            quota: { stickerToday: `${usedToday}/${perDay}` },
            note: '没发送 —— 确认这张表情合适后，用 confirm:true 再调一次（只发给老大）。',
          }
        }
        if (!args.dry) {
          const g = await awaitGate(stateDir, 'dm', rateOpts())
          if (!g.ok) return rateBlocked(g)
        }
        const argv = []
        if (to) argv.push('--to', to)
        if (toId) argv.push('--to-id', toId)
        argv.push('--image', imgUrl)
        if (args.dry) argv.push('--dry')
        const r = runNodeTool('im-send.mjs', argv, { timeout: 300_000 })
        const res = pickJson(r.stdout)
        if (!res) { if (!args.dry) rateFailFromText('dm', r.stdout, r.stderr); return { ok: false, error: '图片发送器没返回可解析结果', stdout: String(r.stdout || '').slice(0, 400), stderr: String(r.stderr || '').slice(0, 300) } }
        if (res.unavailable === 'image_uploader') {
          return { ok: false, sent: false, unavailable: 'image_uploader', error: res.error || '聊天框没有图片上传入口（该号/页面没私信图片能力）；评论区平台贴纸不受影响。' }
        }
        if (res.sent && !args.dry) {
          markAction(stateDir, 'dm', rateOpts())
          markStickerSent(stateDir, st.key)
          noteDm('image', res.to_sec_uid || toId)
          try {
            const secUid = String(res.to_sec_uid || toId || '').trim()
            if (secUid) noteSent(stateDir, secUid, res.to || to, `[图片表情]${st.name || ''}`, 'image')
          } catch { /* 记不上不影响 */ }
          log(`dm-image -> ${res.to || to}: 图片表情已发`)
        } else if (!res.ok && !res.sent && !args.dry) {
          rateFailFromText('dm', res, r.stdout, r.stderr)
        }
        return res
      }
      if (!file && !text) return { ok: false, error: '正文为空', hint: '传 text，或 from_list=true，或 sticker_key 发图片表情' }
      // ⭐ 视频链接拦截：正文里塞了抖音视频地址 ⇒ 必须改成卡片（卡片才可点、才算分享）
      if (/v\.douyin\.com|douyin\.com\/video|iesdouyin\.com\/share|\.iesdouyin\.net/i.test(text)) {
        return {
          ok: false, blocked: true, reason: 'use_share_card',
          error: '正文里有抖音视频链接 —— 视频请走 douyin_share_card 官方分享卡片；这条文字只留「你对视频的看法」',
          hint: '先 douyin_share_card({aweme_id, reason, confirm:true})，纯文字想法由它的 reason 带上',
        }
      }
      // 🔴 用户闸：没经本人当场同意，只回草稿，绝不发出
      if (args.confirm !== true) {
        let draft = text
        if (file) { try { draft = readFileSync(file, 'utf8') } catch { draft = '' } }
        return {
          ok: true, sent: false, needsConfirm: true, to, to_id: toId || undefined,
          draft: draft.slice(0, 1500), len: draft.length,
          note: '没发送 —— 先把这段草稿给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      // ⭐ 风控闸（v0.3.9）：拟人节奏 / 夜间静默 / 上限 / 熔断
      // ⭐ 2026-10-25：私信**只发给老大本人在回应他的消息**（有 owner_only 铁闸），
      //    ⇒ 夜间静默 + 每小时/每天上限都对"回话"豁免（老大半夜发消息，它得能回；
      //       实测被 hour_cap 3/3 卡到 04:40 才发得出去，等于"消息被吞"）。
      //       拟人间隔（humanGap）与熔断照旧，公开动作（评论 / @ / 分享）的上限一点没动。
      if (!args.dry) {
        const g = await awaitGate(stateDir, 'dm', {
          ...rateOpts(), safeQuiet: false, maxActionsPerHour: 999, maxActionsPerDay: 999,
        })
        if (!g.ok) return rateBlocked(g)
      }
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      if (file) argv.push('--file', file)
      else argv.push('--text', text)
      if (args.dry) argv.push('--dry')
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const res = pickJson(r.stdout)
      if (!res) { if (!args.dry) rateFailFromText('dm', r.stdout, r.stderr); return { ok: false, error: '发送器没返回可解析结果', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) } }
      if (res.sent && !args.dry) {
        markAction(stateDir, 'dm', rateOpts())
      } else if (!res.ok && !res.sent && !args.dry) {
        rateFailFromText('dm', res, r.stdout, r.stderr)
      }
      if (res.ok) log(`dm -> ${res.to || to}${res.to_sec_uid ? ' (' + res.to_sec_uid + ')' : ''}: ${res.sent ? '已发送' : res.dry ? 'dry-run' : '未发送'}（${res.len} 字）`)
      if (res.sent) noteDm('text', res.to_sec_uid || toId)
      // ⭐ 发出去的话要进记忆 —— 不然下次读私信会以为这句话是凭空出现的
      if (res.sent) {
        try {
          const secUid = String(res.to_sec_uid || toId || '').trim()
          if (secUid) noteSent(stateDir, secUid, res.to || to, text, 'text')
        } catch (e) { log(`记发送记忆失败（不影响已发出）：${e?.message ?? e}`) }
      }
      return res
    },
  })

  tool({
    name: 'douyin_share_card',
    description: '⭐ 把视频以**抖音分享卡片**发给好友 —— 不是文字链接。'
      + '（文字链接在抖音里点不开，卡片才是「分享→发送给好友」那种可点的预览图。）'
      + '走无头 Chrome 里抖音自己的「分享给朋友」面板，屏幕上无窗口。'
      + '发完会**回读核实**卡片真的出现在「我发的」消息里；核实通过后再隔几秒自动补发 `reason`（为什么值得看）。'
      + '🔴 规矩：**先卡片，后文字** —— 要给文字就用 `reason`（会自动排在卡片后面），'
      + '别再调一次 `douyin_dm`，那样顺序会反成「文字 → 卡片」。',
    parameters: {
      aweme_id: { type: 'string', description: '视频 ID（19 位）。不给就用最近一轮清单里的' },
      to: { type: 'string', description: '发给谁（昵称，只用于显示）；留空用配置 dmTo' },
      to_id: { type: 'string', description: '⭐ 发给谁：**稳定 id**（sec_uid）。重名时必须给这个；留空用配置 dmToId' },
      top: { type: 'number', description: '不给 aweme_id 时，发清单前 N 条（默认 1，最多 3）' },
      reason: { type: 'string', description: '⭐ 分享的理由（卡片之后单独发的一条正文，≤300 字）。'
        + '写"为什么值得你看"，不是操作台账；留空就只有一张光秃秃的卡片' },
      reason_delay_sec: { type: 'number', description: '卡片发出后隔几秒再发 reason（默认 5，0 = 立刻发）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只回预览不发送' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或在设置里填「私信发给谁」+「稳定 ID」' }
      // ⭐ 私信铁闸（v0.3.9）：分享卡片也只发给老大
      const ownerBlock = ownerOnlyGate(toId)
      if (ownerBlock) return ownerBlock
      // ⭐ 2026-10-25：分享理由同样是私信正文，做同一套整理
      const reasonText = withTitle(String(args.reason || '').trim())
      const gapSec = args.reason_delay_sec === undefined ? 5 : Math.max(0, Math.min(Number(args.reason_delay_sec) || 0, 60))
      const orderWarn = orderWarning(toId)
      let ids = []
      if (args.aweme_id) {
        ids = [String(args.aweme_id).trim()]
      } else {
        let rows = []
        const readRows = () => {
          try { return JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || [] } catch { return [] }
        }
        rows = readRows()
        if (!rows.length) {
          runNodeTool('forward-run.mjs', ['--no-toast'], { timeout: 300_000 })
          rows = readRows()
        }
        ids = rows.slice(0, Math.max(1, Math.min(Number(args.top) || 1, 3))).map((r) => String(r.aweme_id))
      }
      if (!ids.length) return { ok: false, error: '没有可用视频 ID', hint: '先 douyin_forward 拉一轮' }
      // 🔴 用户闸
      if (args.confirm !== true) {
        let rows = []
        try { rows = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || [] } catch { rows = [] }
        const preview = ids.map((id) => {
          const r = rows.find((x) => String(x.aweme_id) === id) || {}
          return { aweme_id: id, desc: String(r.desc || '').slice(0, 60), author: r.author || '', digg: r.digg || 0, share_url: r.share_url || '' }
        })
        return {
          ok: true, sent: false, needsConfirm: true, to, count: ids.length, preview,
          reason: reasonText || undefined,
          reason_delay_sec: reasonText ? gapSec : undefined,
          warn: reasonText ? undefined : '没给 reason —— 卡片后面会一句话都没有，建议补一条「为什么值得看」',
          order_warning: orderWarn || undefined,
          note: '没发送 —— 先把这几条给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      // ⭐ 需求⑥（v0.3.9）：分享必须带一句自己的看法 —— 卡片 + 理由才是一次完整分享，不发光秃秃的卡片
      if (!reasonText) {
        return {
          ok: false, blocked: true, reason: 'need_reason', sent: false,
          error: '分享给老大必须带一句你自己的看法（reason）：这条视频哪里好、为什么想给老大看',
          hint: '补一两句口语化的 reason（不是操作台账），再 confirm:true',
        }
      }
      // ⭐ 风控闸（v0.3.9）
      // ⭐ 私信分享额度与评论区 @ 老大**分开记**（kindDayCap；0 = 不限），互不挤占
      const gate = await awaitGate(stateDir, 'share', { ...rateOpts(), kindDayCap: Number(cfg.shareDmPerDay) || 0 })
      if (!gate.ok) return rateBlocked(gate)
      const results = []
      for (const id of ids) {
        const argv = [id, to]
        if (toId) argv.push('--to-id', toId)
        const r = runNodeTool('card-share.mjs', argv, { timeout: 200_000 })
        const j = pickJson(r.stdout)
        results.push(j || { ok: false, aweme_id: id, stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 200) })
        if (!(j && j.ok)) break
        await new Promise((res) => setTimeout(res, 2200))
      }
      const sentN = results.filter((x) => x && x.sent).length
      if (sentN && reasonText) noteReason(reasonText)
      // ⭐ 回读核实 —— 以前只验「分享面板关掉了」，那什么都证明不了。
      //    现在把会话读一遍，确认这张卡片真的出现在「我发的」消息里（aweType=800 + 同一个视频 id）。
      let readback = null
      if (sentN) {
        await new Promise((res) => setTimeout(res, 1500))
        const rArgs = ['--read']
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        const r2 = runNodeTool('im-send.mjs', rArgs, { timeout: 240_000 })
        const j2 = pickJson(r2.stdout)
        if (j2 && j2.ok) {
          const mineCards = (Array.isArray(j2.messages) ? j2.messages : []).filter((m) => m.from === 'me' && m.awe === 800)
          readback = {
            ok: true,
            sender_attribution: j2.sender_attribution,
            checked: ids.map((id) => ({
              aweme_id: id,
              in_my_messages: mineCards.some((m) => String(m.item) === String(id)),
            })),
            my_cards_in_view: mineCards.length,
          }
        } else {
          readback = { ok: false, error: '回读失败', detail: (j2 && j2.error) || String(r2.stderr || '').slice(0, 200) }
        }
      }
      const verified = !!(readback && readback.ok && readback.checked.every((c) => c.in_my_messages))
      if (sentN) noteDm('card', toId)

      // ⭐ 卡片之后隔几秒，补一句「为什么值得你看」。
      //    光一张卡片过去，对方只看到封面和标题，不知道你想让他注意哪儿 —— 理由才是分享这件事的一半。
      //    只在卡片**核实通过**之后才发：卡片都没落地就说"我为什么发给你"，对方会一头雾水。
      let reasonResult = null
      if (verified && reasonText) {
        if (gapSec > 0) await new Promise((res) => setTimeout(res, gapSec * 1000))
        const rArgs = []
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        rArgs.push('--text', reasonText)
        const r3 = runNodeTool('im-send.mjs', rArgs, { timeout: 240_000 })
        const j3 = pickJson(r3.stdout)
        reasonResult = j3
          ? {
            ok: !!j3.ok, sent: !!j3.sent, len: reasonText.length,
            readback: !!j3.readback, my_msg_before: j3.my_msg_before, my_msg_after: j3.my_msg_after,
            newest_from: j3.newest_from, error: j3.error,
          }
          : { ok: false, error: '理由那一条没返回可解析结果', stderr: String(r3.stderr || '').slice(0, 200) }
        if (reasonResult.ok) log(`share-card reason -> ${to || toId}: 已发送（卡片后隔 ${gapSec}s，${reasonText.length} 字）`)
        else log(`share-card reason 发送失败：${reasonResult.error || '未知'}`)
      }

      // ⭐ 分享卡片也要进记忆（同时记"发的是哪个视频"）—— 聊过什么、发过什么都要有据可查
      if (sentN) {
        try {
          const secUid = String(toId || '').trim()
          if (secUid) {
            for (const r of results) {
              if (!r || !r.sent) continue
              const row = (() => { try { return (JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || []).find((x) => String(x.aweme_id) === String(r.aweme_id)) || {} } catch { return {} } })()
              noteSent(stateDir, secUid, to, `[分享视频] ${String(row.desc || '').slice(0, 60) || r.aweme_id}`, 'card')
            }
            if (reasonResult && reasonResult.ok && reasonText) noteSent(stateDir, secUid, to, reasonText, 'text')
          }
        } catch (e) { log(`记分享记忆失败（不影响已发出）：${e?.message ?? e}`) }
      }

      const allOk = sentN === ids.length && verified && (!reasonResult || reasonResult.ok)
      // ⭐ 风控记账（v0.3.9）：卡片+回读+理由都落地才算一次成功分享；没落地/撞限流就记失败（保守冷却）
      if (sentN && allOk) {
        markAction(stateDir, 'share', rateOpts())
      } else if (sentN || results.some((x) => x && !x.ok)) {
        rateFailFromText('share', JSON.stringify(results), readback && !verified ? '回读未核实' : '', reasonResult && !reasonResult.ok ? reasonResult.error : '')
      }
      if (sentN) log(`share-card -> ${to}: 发出 ${sentN}/${ids.length} 张卡片，回读${verified ? '核实通过' : '未核实'}${reasonResult ? '，理由' + (reasonResult.ok ? '已发' : '失败') : ''}`)
      return {
        ok: allOk, sent: sentN, total: ids.length, to,
        readback,
        reason: reasonResult || undefined,
        reason_skipped: (verified && !reasonText) ? '没给 reason —— 只发了卡片，后面一句话都没跟上' : undefined,
        order_warning: orderWarn || undefined,
        results: results.map((x) => ({ aweme_id: x.aweme_id, ok: !!x.ok, sent: !!x.sent, error: x.error })),
        hint: verified ? undefined
          : (sentN ? '面板已经发出去点击了，但回读没在「我发的」消息里找到这张卡片 —— 别跟用户说发出去了，也没发理由' : undefined),
      }
    },
  })

  tool({
    name: 'douyin_notices',
    description: '读抖音互动通知：**谁 @ 了你**（含「别人评论区里的 @」）、'
      + '**谁回复了你的评论 / 在你评论下面说话**（type=31，2026-10-23 起才认出来 —— 以前这类全漏）、'
      + '谁关注/评论/点赞了你。'
      + '网页版没有通知中心页面，这个工具直接打通接口（只读，is_mark_read=0 不改变已读状态）。'
      + '返回里 at_n 是 @ 的条数，reply_n 是"回复类"的条数。'
      + '⭐ 每条都带 comment_id（要回就回这条）和 **root_comment_id**（楼根）—— '
      + '回复楼中楼里的人时，把这两个传给 douyin_comment_reply（mode:"api"）就行。',
    parameters: {
      raw: { type: 'boolean', description: '连原始条目一起返回（默认 false）' },
    },
    async execute(args = {}) {
      const venvPy = join(stateDir, '.venv', 'Scripts', 'python.exe')
      if (!existsSync(venvPy)) return { ok: false, error: '还没装运行环境', hint: '设置页点「装主依赖」' }
      if (!existsSync(cookiePath(stateDir))) return { ok: false, error: '还没有 Cookie', hint: '先扫码登录' }
      const argv = [join(pluginDir, 'tools', 'notice-read.py')]
      if (args.raw) argv.push('--raw')
      const r = spawnSync(venvPy, argv, {
        encoding: 'utf8', timeout: 150_000,
        env: pyEnv({ DOUYIN_HOME: stateDir }), windowsHide: true,
      })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
      /**
       * ⭐ 把"回复类"单拎出来（type=31/32）—— 这是**回评论的真正入口**：
       *    别人在我楼里说话，我该"直接回复"他，不是 @ 他。
       *    以前只统计 type 45/46（@ 我），于是"别人回了我"这件事完全看不见。
       */
      const items = Array.isArray(j.items) ? j.items : []
      const replies = items.filter((x) => x && (x.type === 31 || x.type === 32) && x.comment_id)
      j.reply_n = replies.length
      if (replies.length) {
        j.replies = replies.slice(0, 10).map((x) => ({
          nickname: x.nickname,
          content: String(x.content || '').slice(0, 200),
          aweme_id: x.aweme_id,
          comment_id: x.comment_id,
          root_comment_id: x.root_comment_id,
          reply_to_text: x.reply_to_text || undefined,
          created_at: x.create_time,
        }))
        j.reply_hint = '要回他们：douyin_comment_reply { aweme_id, comment_id, root_comment_id, text, mode:"api" } —— '
          + '用**直接回复**，不要用 @（对方会收到「回复了我的评论」通知）。'
      }
      if (j.n) log(`notices: ${j.n} 条（@ 我 ${j.at_n}，回复类 ${j.reply_n}）`)
      return j
    },
  })

  /**
   * ⭐ 2026-10-26 老大：「回复的内容有些相似，需要注意不要一直重复」
   *    ⇒ ①同一栋楼（楼根）最多回 2 次；②新回复跟这栋楼里最近几条太像（字符 bigram 重合率 > 0.62）就拦。
   *    记录在 `<HOME>/reply-threads.json`，键是 `aweme:楼根`。
   */
  const replyThreadFile = () => join(stateDir, 'reply-threads.json')
  const replyThreadLoad = () => { try { return JSON.parse(readFileSync(replyThreadFile(), 'utf8')) || {} } catch { return {} } }
  const replyThreadSave = (o) => { try { writeFileSync(replyThreadFile(), JSON.stringify(o, null, 1), 'utf8') } catch { /* 记不上不影响发 */ } }
  const textBigrams = (s) => {
    const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '')
    const g = new Set()
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
    return g
  }
  const textSim = (a, b) => {
    const A = textBigrams(a); const B = textBigrams(b)
    if (!A.size || !B.size) return 0
    let n = 0
    for (const x of A) if (B.has(x)) n++
    return n / Math.min(A.size, B.size)
  }
  const threadKey = (aweme, replyTo, rootCid) => `${aweme}:${rootCid || replyTo}`
  const replyThreadGuard = (aweme, replyTo, rootCid, text, force) => {
    if (!aweme || !replyTo || force) return null
    const th = replyThreadLoad()[threadKey(aweme, replyTo, rootCid)]
    if (!th) return null
    const n = Number(th.n || 0)
    if (n >= 2) {
      return {
        ok: false, blocked: 'already_replied',
        error: `这栋楼你已经回过 ${n} 次了（${threadKey(aweme, replyTo, rootCid)}）—— 别追着同一条刷，他真想聊会再找你`,
        hint: '换别的视频、或等他再说话；确实要再补一句就传 force:true。',
      }
    }
    const near = (th.texts || []).slice(-4).find((t) => textSim(t, text) > 0.62)
    if (near) {
      return {
        ok: false, blocked: 'too_similar', similar_to: near,
        error: `这句跟你刚在这栋楼里说过的话太像了：「${String(near).slice(0, 40)}…」—— 换个说法，或者干脆别再说`,
        hint: '换个角度/换句人话；实在没新话可讲就停手（这样才像人）。',
      }
    }
    return null
  }
  const replyThreadMark = (aweme, replyTo, rootCid, text) => {
    if (!aweme || !replyTo) return
    const all = replyThreadLoad()
    const k = threadKey(aweme, replyTo, rootCid)
    const th = all[k] || { n: 0, texts: [] }
    th.n = Number(th.n || 0) + 1
    th.texts = [...(th.texts || []), String(text || '').slice(0, 200)].slice(-6)
    th.at = new Date().toISOString()
    all[k] = th
    const keys = Object.keys(all)
    if (keys.length > 300) for (const kk of keys.slice(0, keys.length - 300)) delete all[kk]
    replyThreadSave(all)
  }

  /**
   * ⭐ 2026-10-27：**@ 这条通道被平台阉了**。
   *   三组对照实验（老大 / 视频作者 / 普通网友；关注后再试也一样）都证明：
   *   web 端发评论时服务端**无条件剥掉 mention 实体** —— 评论里只剩「@昵称」这串字，
   *   对方收不到任何通知（别人看到的就是"没艾特上"）。
   *   UI 点选那条路则根本发不出去（点了发布输入框不清空、响应 200 空 body）。
   *   ⇒ 要让他真的收到「这条视频想给你看」的信号，只能走私信卡片。
   *   所以：@ 发出去但被判为「实体被剥」时，自动补一张私信卡片（同一条视频两路只发一次，
   *   channel-log 已经保证不重复）。
   */
  const dmNotifyCard = (aweme, why, opt = {}) => {
    if (opt.skip) return { ok: false, skipped: opt.skip, error: '不需要补卡片（他已经会从别的通知里看到）' }
    const to = String(cfg.dmTo || '').trim()
    const toId = String(cfg.dmToId || '').trim()
    if (!to) return { ok: false, skipped: 'no_dm_to', error: '没设「私信发给谁」，没法补卡片通知' }
    const argv = [String(aweme), to]
    if (toId) argv.push('--to-id', toId)
    const r = runNodeTool('card-share.mjs', argv, { timeout: 200_000 })
    const j = pickJson(r.stdout)
    if (!j) return { ok: false, error: '补卡片没返回可解析结果', stdout: String(r.stdout || '').slice(0, 200) }
    log(`[通知] @ 没生效 ⇒ 补一张私信卡片给 ${to}（${j.ok ? '成功' : String(j.error || j.blocked || '失败').slice(0, 60)}）`)
    return { ...j, why }
  }

  tool({
    name: 'douyin_comment_reply',
    /**
     * ⭐⭐ 2026-10-23 **重新设计**（使用者：「回评论好像还有问题，要不要重新设计一下」）
     *
     * 老设计的三个坑（全部实测过）：
     *   ① 一个工具两副面孔：传了 mention_* 就偷偷走 UI 点选，不传就走 API ——
     *      调用方根本不知道自己走的是哪条、会不会真 @、要不要等 30 秒。
     *   ② 「真 @」依赖「先找到目标评论」：`--reply-cid` 遍历 React fiber
     *      （撞循环引用直接抛异常），改按正文找又要评论已渲染（80+ 条就找不到）。
     *      两条路一死，真 @ 就发不出去。
     *   ③ 发完看不见：评论列表按热度排、不给切最新 ⇒ 刚发的 0 赞评论读不到
 *      （注意：**不是"进审核"**，2026-10-23 实测推翻）。走 UI 那条路还拿不到 cid ⇒ 删不掉。
     *
     * 新设计：**把 mode 摆到明面上**，两条通道各司其职，谁也不偷偷降级。
     *   mode=api（默认）：回复楼层 / 发普通评论。**1 秒**，对方收到「回复了我的评论」通知，
     *                     正文里的 @昵称 只是文字（不是真 @）。
     *   mode=ui        ：**真 @**（名字可点）。只能发**顶层评论**，
     *                     因为顶层不需要先找到任何评论 —— 这样彻底躲开"找不到评论"的死锁。
     *                     慢（20-40 秒），要 Chrome。
     *                     ⚠️ 2026-10-27 实测：UI 点选这条老路现在**根本发不出去**
     *                     （点了发布输入框不清空、响应 200 空 body），且 API 路的 @ 也会被服务端剥掉
     *                     ⇒ 「评论区 @ 老大」这条通道实际上只剩"文字里提到他"，通知要靠私信卡片。
     *
     * ⭐⭐ 2026-10-23 **判断规则定稿**（使用者连着问了两次，我前两版都想错了）：
     *
     *   唯一判据 = **有没有"对话对象"**（对方留下过一条具体评论、我拿得到它的 cid）
     *
     *     有对话对象  ⇒ mode=api + comment_id（**直接回复**）
     *     没有对话对象 ⇒ mode=ui（@ 顶层，只能用于"我主动推东西给他"）
     *     楼中楼满 20 条 ⇒ **跳过，不管**（别换通道硬塞，那样既刷屏又把通知降级）
     *
     *   为什么"直接回复"更强（这是之前一直搞反的地方）：
     *     · 通知落「**回复我的**」流，绑定在那条评论上，点进去有上下文
     *     · @ 落「@我的」流，只是一句孤零零的话，对方不知道你在回他哪句
     *     · 楼中楼位置永久固定；@ 顶层热度 0，很快沉底（他自己都翻不到）
     *     · api 1 秒 + 拿得到 cid（可回读、可删除）；ui 20-40 秒 + 拿不到 cid（删不掉）
     *
     *   ⚠️ 曾经想过「顶层评论能让所有人看到，所以某些场景要用 ui」——
     *      **这个场景不存在**：本插件是给一个人用的（推视频/回话），"公开"不是目的，
     *      是抖音没有"只通知一个人"的顶层评论这一事实带来的副作用。
     */
    description: '在抖音评论区发言 / 回复某条评论。'
      + '⭐ **有 comment_id（要回某条评论）⇒ 用 mode:api，不要用 @**：'
      + '1 秒发出，对方收到「回复了我的评论」通知（比 @ 通知更强：绑定在那条评论上、有上下文、位置永久固定）。'
      + '⭐ **没有 comment_id（我主动推东西给使用者、他没留下可回的评论）⇒ 才用 mode:ui**：'
      + '真 @ 顶层评论，慢 20-40 秒、要 Chrome、拿不到 cid（删不掉）。'
      + '⚠️ 楼中楼满 20 条就跳过，别换通道硬塞。'
      + '⭐ **回复楼中楼里的人**（别人回了我的评论 / 回了我楼里的人）：'
      + '传那条 level-2 的 cid 当 comment_id 就行 —— 工具会自动判出"楼根"，'
      + '把 reply_id 填成楼根、reply_to_reply_id 填成对方那条（这是抖音的两个不同字段，'
      + '填错就变成一条冒出来的顶层评论）。也可以用 root_comment_id 显式指定楼根。'
      + '配合 douyin_notices / douyin_at_me 用：它们返回的 comment_id 就是 mode=api 的 comment_id，'
      + 'root_comment_id 就是可以直接传的楼根。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 id（douyin_notices 返回的 aweme_id）' },
      text: { type: 'string', description: '评论正文（≤500 字）。mode=ui 时**不要自己写 @昵称**，工具会自动加' },
      mode: {
        type: 'string',
        description: 'api = 快（回复/普通评论，1 秒）；给了 mention_name（且知道对方 sec_uid）时 mode=api 也能发**真 @**。'
          + 'ui = 真 @ 的老路子（UI 点选，慢 20-40 秒）—— 现在只在不知道 sec_uid 时才用。不传 = api',
      },
      comment_id: { type: 'string', description: '要回复的评论 cid（**只有 mode=api 支持**）；留空 = 发顶层评论。可以是顶层评论，也可以是楼中楼里的某条' },
      root_comment_id: {
        type: 'string',
        description: '【可选】楼根 cid（这栋楼的第一条顶层评论）。'
          + '回复**楼中楼**时用：不给就自动判（翻顶层列表找这条属于哪栋楼）；'
          + '判不出来工具会拒绝发送，不会瞎猜。回复顶层评论时不用传。',
      },
      mention_name: { type: 'string', description: '【mode=ui 必填】要真 @ 的昵称（必须和对方昵称完全一致）' },
      mention_uid: { type: 'string', description: '【可选】被 @ 人的 uid，用于拦「@ 自己」；不给就不拦（sec_uid 反查不出来时也可只给这个）' },
      mention_sec_uid: { type: 'string', description: '【可选】被 @ 人的 sec_uid —— 给了它就能用 mode:"api" 发**真 @**（评论 1 秒发出、拿得到 cid）。@ 老大时可以不给，会自动用「私信发给谁」那位的 sec_uid' },
      /**
       * ⭐ 自动回复（mode=api + comment_id）时带上，用来落实硬规则：
       *   reply_to_uid  = 对方 uid（douyin_at_me 返回的 uid）⇒ replyPerPerson 按人卡次数（默认 2：同一个人最多回 2 次）。
       *   reply_to_text = 对方那条评论原文 ⇒ 只回善意/好回答的，恶意/抬杠/引流/索要隐私的直接拦（replyKindOnly）。
       */
      reply_to_uid: { type: 'string', description: '【回复别人时建议带】对方 uid（douyin_at_me 返回）；用于「同一人每天最多回 2 次」硬计数' },
      reply_to_text: { type: 'string', description: '【回复别人时建议带】对方那条评论原文；用于「只回善意/好回答的」硬兜底' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只回草稿不发送' },
    },
    async execute(args = {}) {
      const aweme = String(args.aweme_id || '').trim()
      // ⭐ 2026-10-25：评论正文整理（同上）
      const text = withTitle(String(args.text || '').trim())
      const replyTo = String(args.comment_id || '').trim()
      const rootCid = String(args.root_comment_id || '').trim()
      const mentionName = String(args.mention_name || '').trim()
      const mentionUid = String(args.mention_uid || '').trim()
      /**
       * ⭐ 2026-10-25：真 @ 的 sec_uid。给了就能走 API（带 text_extra），1 秒发出、有 cid；
       *    @ 的正是"私信发给谁"那位（老大）时不用调用方给，自动用配置里的 dmToId。
       */
      const mentionSec = String(args.mention_sec_uid || '').trim()
        || (mentionName && String(cfg.dmTo || '').trim() === mentionName ? String(cfg.dmToId || '').trim() : '')
      const replyToUid = String(args.reply_to_uid || '').trim()
      const replyToText = String(args.reply_to_text || '').trim()
      const mode = String(args.mode || 'api').trim().toLowerCase()
      if (!aweme) return { ok: false, error: '缺 aweme_id', hint: '先 douyin_notices 拿到 aweme_id' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字），抖音评论放不下` }
      if (mode !== 'api' && mode !== 'ui') return { ok: false, error: `mode 只能是 api 或 ui（收到 ${mode}）` }

      /**
       * 🔴 2026-10-25 重写：API **能**发真 @ —— 关键是 text_extra。
       *    以前这里说"API 直发服务端会剥掉 sec_uid"，那是因为当年压根没带 text_extra
       *    （body 里写死 text_extra:'[]'），服务端只看到一串 "@昵称" 文字。
       *    现在 comment-api.mjs 会带 [{user_id, sec_uid, type:0, start, end}]，
       *    实测发完用 insert_ids 回读，text_extra 原样保住了 ⇒ 对方能收到 @ 通知。
       *    ⇒ 只要知道 sec_uid 就走 API；不知道才退回 UI 点选。
       */
      if (mode === 'api' && mentionName && !mentionSec) {
        return {
          ok: false, unsupported: 'mention-in-api-mode',
          error: '要真 @ 得知道对方的 sec_uid（这次没给、也不是「私信发给谁」那位）—— 没有 sec_uid 就只能走 mode:"ui" 的 UI 点选',
          fix: replyTo
            ? '⭐ 你已经有 comment_id 了 ⇒ **不需要 @**：去掉 mention_name、直接用 mode:"api" + comment_id 回复他，'
              + '对方会收到「回复了我的评论」通知（绑定在那条评论上、有上下文、比 @ 通知更强）'
            : '没有 comment_id 才需要 @：改用 mode:"ui"（慢 20-40 秒，只能发顶层评论），或者把 mention_sec_uid 一并给我',
        }
      }
      if (mode === 'ui' && replyTo) {
        return {
          ok: false, unsupported: 'reply-in-ui-mode',
          error: 'mode=ui 不能指定 comment_id（真 @ 只能发顶层评论）',
          fix: '⭐ 有 comment_id 就直接回复，**不要用 @**：改成 mode:"api" + comment_id，'
            + '对方收到「回复了我的评论」通知，1 秒发出、位置永久固定在楼里、还拿得到 cid 可以回读和删除。'
            + '只有"我主动推东西、他没有评论可回"时才用 mode:"ui"。',
        }
      }
      if (mode === 'ui' && !mentionName) return { ok: false, error: 'mode=ui 必须给 mention_name（要 @ 谁）' }
      // ⭐ 需求⑥（v0.3.9）：@ 老大看视频必须带一句自己的看法，不能只 @ 不说话
      if (mode === 'ui' && String(text || '').trim().length < 4) {
        return {
          ok: false, blocked: true, reason: 'need_reason',
          error: '@ 老大时必须带上一两句你自己的看法（这条视频哪里好、为什么值得看），不能只 @ 不说话',
          hint: 'text 写一两句口语化表达（不是操作台账），再 confirm:true',
        }
      }
      /**
       * ⭐ 主动提醒（不拦）：有 comment_id 却选了 ui —— 上面已经拦了；
       *    这里反过来：**没有 comment_id 却想"回复"** —— 提醒他 mode=api 会发成顶层普通评论，
       *    不会通知任何人。别让他以为"发出去就有人收到"。
       */
      if (mode === 'api' && !replyTo) {
        // 顶层普通评论：没人会收到通知。只在草稿/结果里标注，不拦（有时就是要发顶层）。
      }
      // root_comment_id 只在"回复"时才讲得通
      if (mode === 'ui' && rootCid) {
        return { ok: false, error: 'mode=ui 不需要 root_comment_id（真 @ 只发顶层评论）' }
      }

      // 🔴 用户闸
      if (args.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, mode,
          aweme_id: aweme, comment_id: replyTo || '(顶层评论)',
          root_comment_id: rootCid || '(自动判)',
          mention: mentionName || undefined,
          draft: mode === 'ui' ? `@${mentionName} ${text}` : text, len: text.length,
          eta: mode === 'ui' ? '约 20-40 秒（要起无头 Chrome 点选）' : '约 1 秒',
          /**
           * ⭐ 把"回复方式"讲清楚 —— 这是使用者反复问的那个点：
           *    回顶层评论的人 vs 回楼中楼里的人，抖音用的是**两个不同字段**。
           */
          how: mode !== 'api' ? undefined
            : (!replyTo
              ? '顶层普通评论：落在评论区第一层，**不会通知任何人**'
              : (rootCid
                ? `楼中楼回复：reply_id=${rootCid}（楼根）、reply_to_reply_id=${replyTo}（对方那条）`
                : `楼中楼回复：reply_id=<自动判出的楼根>、reply_to_reply_id=${replyTo}（对方那条）`)),
          note: '没发送 —— 先把这段给用户看，他点头后再用 confirm:true 调一次',
        }
      }

      /* ── ⓪′ 同一楼别刷屏（2026-10-26 老大：别反复回同一条、别内容雷同） ── */
      if (mode === 'api' && replyTo && aweme) {
        const tg = replyThreadGuard(aweme, replyTo, rootCid, text, args.force === true)
        if (tg) {
          try { markSeen(stateDir, aweme, [replyTo]) } catch { /* 记不上不影响 */ }
          log(`comment_reply 拦下：${tg.blocked} ${aweme}`)
          return tg
        }
      }

      /* ── ⓪ 大肥鱼自主行为硬规则（2026-10-24，host 与 MCP 共用 lib/engage.mjs） ── */
      if (mode === 'api' && !replyTo) {
        // 顶层主动评论：不是每条都评，受「每日主动评论上限」
        const cap = canProactiveComment(stateDir, cfg.proactiveCommentPerDay)
        if (!cap.ok) {
          noteSkipped(stateDir, 'proactive_cap')
          return {
            ok: false, blocked: 'proactive_cap',
            error: `今天主动评论已到上限（${cap.used}/${cap.max} 条）—— 不是每条视频都要评，明天再继续`,
            hint: '想多发就去设置里把「每天最多主动评论几条」调大；这条视频这轮先只看看。',
          }
        }
      }
      if (mode === 'api' && replyTo) {
        // 回复别人：① 只回善意 / 好回答（对对方原文做硬兜底）
        if (cfg.replyKindOnly !== false && replyToText) {
          const c = classifyReply(replyToText)
          if (!c.ok) {
            noteSkipped(stateDir, c.reason, replyToUid)
            try { if (replyTo && aweme) markSeen(stateDir, aweme, [replyTo]) } catch { /* 记不上不影响 */ }
            return {
              ok: false, blocked: 'unfriendly', skipped: c.reason,
              error: `对方这条属于「${c.label}」，按规矩不回（只回善意、好回答的评论）`,
              hint: '这条已标记为处理过，不会再反复弹出来。继续看下一条善意的。',
            }
          }
        }
        // ② 同一人每天最多回 N 次（默认 2）＋ 每日回复总上限
        const rc = canReplyTo(stateDir, replyToUid, { perPerson: cfg.replyPerPerson, perDay: cfg.replyPerDay })
        if (!rc.ok) {
          noteSkipped(stateDir, rc.reason, replyToUid)
          try { if (replyTo && aweme) markSeen(stateDir, aweme, [replyTo]) } catch { /* 记不上不影响 */ }
          if (rc.reason === 'person_cap') {
            return {
              ok: false, blocked: 'person_cap', person_used: rc.personUsed, per_person: rc.perPerson,
              error: `今天已经回过这个人 ${rc.personUsed} 次（上限 ${rc.perPerson} 次/人/天）—— 不再回，避免在评论区拉锯/招黑`,
              hint: '这是硬规矩：同一人每天最多回复两次。明天额度会重置。',
            }
          }
          return {
            ok: false, blocked: 'daily_cap', used: rc.used, max: rc.max,
            error: `今天回复别人已到上限（${rc.used}/${rc.max} 条），明天再回`,
          }
        }
      }

      /* ── ① 风控闸（v0.3.9，取代旧 sendGate）：拟人节奏 / 夜间静默 / 上限 / 熔断 ──
         kind：真 @ = mention；回复别人 = reply；顶层主动评论 = comment（各自有不同间隔） */
      const rlKind = mode === 'ui' ? 'mention' : (replyTo ? 'reply' : 'comment')
      // ⭐ 评论区 @ 老大 与私信分享**分开记额度**（各走各的计数，互不挤占；0 = 不限）
      const rlGate = await awaitGate(stateDir, rlKind, { ...rateOpts(), ...(rlKind === 'mention' ? { kindDayCap: Number(cfg.shareMentionPerDay) || 0 } : {}) })
      if (!rlGate.ok) return rateBlocked(rlGate)

      /* ── ② mode=ui：真 @（顶层评论，不找任何目标 ⇒ 没有死锁） ── */
      if (mode === 'ui') {
        if (!selfUidCache) {
          const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
          const j = pickJson(g.stdout)
          if (j?.uid) selfUidCache = String(j.uid)
        }
        if (mentionUid && selfUidCache && String(mentionUid) === selfUidCache) {
          return { ok: false, error: `mention_uid=${mentionUid} 是登录号自己的 uid —— 这是 @ 自己` }
        }
        /**
         * ⭐ 2026-10-27（查到真因后重排顺序）：**UI 点选是唯一能真 @ 的路**。
         *    真因：评论区发布被风控要求过一次短信验证（弹「接收短信验证码」）—— 没过之前
         *    `/comment/publish` 只回 200 空 body、输入框不清空，看起来像"没发出去"；
         *    过了之后 UI 点选能发布、服务端**保住 mention 实体**（实测 cid 7701038612288750351，
         *    text_extra 原样保留、老大确实收到「@ 了我」通知）。
         *    而 API 直发虽然 1 秒、有 cid，但服务端会把 mention 实体剥掉（三组对照实测）。
         *    ⇒ 要真 @ 就先走 UI；它报 verification_required 时把「要过一次短信验证」透传上去，
         *      再把 API 当兜底（发得出去但 @ 会被剥，工具会自动补私信卡片）。
         */
        let uiVerifyNeeded = false
        if (mentionName) {
          const mArgs0 = ['--aweme', aweme, '--name', mentionName, '--text', text]
          let mr0 = runNodeTool('comment-mention-ui.mjs', mArgs0, { timeout: 300_000 })
          let mres0 = pickJson(mr0.stdout)
          /** 2026-10-28：@ 时好时坏 ⇒ 非验证类失败**重试一次**（网络/渲染抖动可自愈） */
          if (mres0 && !mres0.ok && !mres0.verification_required) {
            log(`真 @ 第一次没成（${String(mres0.error || '').slice(0, 60)}）⇒ 3 秒后重试一次`)
            await sleep(3000)
            mr0 = runNodeTool('comment-mention-ui.mjs', mArgs0, { timeout: 300_000 })
            mres0 = pickJson(mr0.stdout)
          }
          if (mres0?.ok) {
            markAction(stateDir, 'mention', rateOpts())
            log(`comment-mention-ui -> ${aweme}: 真 @${mentionName} 已发布（UI 点选，mention 保住了）`)
            try {
              noteMyComment(stateDir, aweme, { text, mention: mentionName })
              if (replyTo) markSeen(stateDir, aweme, [replyTo])
            } catch { /* 记不上不影响发 */ }
            const readback0 = await readbackAfter(stateDir, aweme, { text, cid: '' })
            return {
              ok: true, mode, via: 'ui-mention', aweme_id: aweme,
              mention: mentionName, text, mention_verified: true, readback: readback0,
              note: '真 @ 走的是 UI 点选 —— mention 实体保住了，对方会收到「@ 了我」通知。⚠️ UI 路径拿不到 cid（删不掉也查不到），回读只能按正文片段找。',
            }
          }
          if (mres0?.verification_required) {
            uiVerifyNeeded = true
            log(`comment-mention-ui -> ${aweme}: 要过短信验证（${mres0.phone_hint || '手机号未知'}）—— 先用 API 兜底`)
          } else if (mres0) {
            rateFailFromText('mention', mres0, mr0.stdout, mr0.stderr)
            log(`comment-mention-ui 没成（${String(mres0.error || '').slice(0, 80)}）⇒ 退回 API 兜底`)
          }
        }
        if (uiVerifyNeeded) {
          /**
           * 🔴 2026-10-28：验证没过就**不再用 API 假装发出去** ——
           *    那样只会留下一条纯文字「@墨時秋 …」的评论，老大收不到通知，
           *    正是他反馈的「叫了称呼却没 @ 上」。宁可这一条不发，也不能发假 @。
           */
          return {
            ok: false, mode, aweme_id: aweme, verification_required: true,
            mention: mentionName, text,
            error: '要真 @ 得先过一次抖音短信验证（评论区发布风控）：验证没过之前发布的评论会被静默丢弃',
            hint: '让老大跑：node tools/comment-verify.mjs --aweme ' + aweme + ' --request-code（短信发到他手机），'
              + '拿到 6 位码后 --code <码>；过了之后 UI 点选就能真 @ 上（已实测收到 @ 通知）。',
            when_verified: 'douyin_comment_reply({ aweme_id, mode:"ui", mention_name, text, confirm:true }) —— 就会走 UI 点选真 @',
          }
        }
        if (mentionSec) {
          const body = text.startsWith('@') ? text : `@${mentionName}  ${text}`
          const ma = ['--aweme', aweme, '--text', body, '--mention-secuid', mentionSec]
          if (mentionUid) ma.push('--mention-uid', mentionUid)
          const mar = runNodeTool('comment-api.mjs', ma, { timeout: 180_000 })
          const mares = pickJson(mar.stdout)
          if (mares?.ok) {
            markAction(stateDir, 'mention', rateOpts())
            /**
             * ⭐ 2026-10-27：**发出去 ≠ @ 成功**。
             *    服务端会把 mention 实体剥掉（三组对照实测），脚本会用 insert_ids 回读告诉我们
             *    `mention_kept:false`。这时候对方**收不到通知** —— 必须立刻补一张私信卡片，
             *    不然就是"评论发了、老大什么都没收到"（老大这几天遇到的就是这个）。
             */
            const dropped = mares.mention_dropped === true || mares.mention_kept === false
            log(`comment-api(@${mentionName}) -> ${aweme}: cid ${mares.cid}${dropped ? '（⚠️ 平台把 @ 剥了）' : '（@ 保住了）'}`)
            try { noteMyComment(stateDir, aweme, { cid: mares.cid || '', text: body, mention: mentionName }) } catch { /* 记不上不影响发 */ }
            try { if (replyTo) markSeen(stateDir, aweme, [replyTo]) } catch { /* 同上 */ }
            const readback = await readbackAfter(stateDir, aweme, { text: body, cid: String(mares.cid || '') })
            if (dropped) {
              /**
               * 如果他本来就是被回复的人（这条是回他的评论），"回复了我的评论"那条通知已经会到他手上，
               * 再补一张私信卡片就是重复打扰 ⇒ 这种情况下不补。
               */
              const ownerU = String(cfg.ownerUid || '').trim()
              const replyingToOwner = Boolean(replyTo) && Boolean(ownerU) && String(replyToUid) === ownerU
              const fb = dmNotifyCard(aweme, 'mention_dropped', { skip: replyingToOwner ? 'reply_notification' : '' })
              return {
                ok: true, mode, via: 'api-mention', aweme_id: aweme, cid: mares.cid || undefined,
                mention: mentionName, text: body, mention_verified: false, mention_dropped: true, readback,
                fallback_dm: { ok: Boolean(fb.ok), sent: Boolean(fb.sent), blocked: fb.blocked, error: fb.error, to: cfg.dmTo },
                note: '评论发出去了，但**平台把 @ 实体剥掉**了（web 端发评论服务端无条件剥 mention）—— 老大收不到 @ 通知。'
                  + (fb.ok ? '已自动补一张私信卡片通知他。' : `补卡片没成（${String(fb.error || fb.blocked || '未知')}）—— 需要手动告诉他。`),
                ...(uiVerifyNeeded ? {
                  verification_required: true,
                  hint: '要真 @ 上得先过一次抖音短信验证（评论区发布风控）—— 老大手机收码后跑：node tools/comment-verify.mjs --aweme <id> --code <6位>（先 --request-code 要码）。过了之后 UI 点选就能真 @（已实测收到通知）。',
                } : {}),
              }
            }
            return {
              ok: true, mode, via: 'api-mention', aweme_id: aweme, cid: mares.cid || undefined,
              mention: mentionName, text: body, mention_verified: true, readback,
              note: '真 @ 走 API + text_extra，回读确认 sec_uid 保住了（对方能收到 @ 通知）；有 cid，可回读、可删。',
            }
          }
          rateFailFromText('mention', mares, mar.stdout, mar.stderr)
          log(`comment-api(@${mentionName}) 没成（${String(mares?.error || mares?.head || '').slice(0, 80)}）⇒ 退回 UI 点选`)
        }
        if (uiVerifyNeeded && !mentionSec) {
          return {
            ok: false, mode, verification_required: true, aweme_id: aweme,
            error: '要真 @ 得先过一次抖音的短信验证（评论区发布风控会弹「接收短信验证码」）—— 这一步只能老大本人配合',
            hint: '让老大跑一次：node tools/comment-verify.mjs --aweme <id> --request-code（短信发到他手机），拿到 6 位码后 --code <码>；过了之后 UI 点选就能真 @ 上（已实测收到 @ 通知）。',
          }
        }
        const mArgs = ['--aweme', aweme, '--name', mentionName, '--text', text]
        const mr = runNodeTool('comment-mention-ui.mjs', mArgs, { timeout: 300_000 })
        const mres = pickJson(mr.stdout)
        if (!mres) {
          rateFailFromText('mention', mr.stdout, mr.stderr)
          return { ok: false, mode, error: '真 @ 执行器没返回可解析结果', stdout: String(mr.stdout || '').slice(0, 400), stderr: String(mr.stderr || '').slice(0, 300) }
        }
        if (mres.ok) {
          markAction(stateDir, 'mention', rateOpts())
          log(`comment-mention-ui -> ${aweme}: 真 @${mentionName} 已发布（UI 点选）`)
          try {
            noteMyComment(stateDir, aweme, { text, mention: mentionName })
            if (replyTo) markSeen(stateDir, aweme, [replyTo])
          } catch { /* 记不上不影响发 */ }
        } else {
          rateFailFromText('mention', mres, mr.stdout, mr.stderr)
        }
        const readback = await readbackAfter(stateDir, aweme, { text, cid: '' })
        return {
          ...mres, mode, mention_verified: Boolean(mres.ok), readback,
          note: mres.ok
            ? '真 @ 走的是 UI 点选，sec_uid 保住了（对方会收到通知）。⚠️ UI 路径的 cid 是发完回查评论列表找回的（能删、能回读）'
            : undefined,
        }
      }

      /* ── ③ mode=api：回复楼层 / 普通评论（带 sec_uid 时也能真 @） ── */
      const apiText = (mentionName && mentionSec)
        ? (text.startsWith('@') ? text : `@${mentionName}  ${text}`)
        : text
      const argv = ['--aweme', aweme, '--text', apiText]
      if (mentionName && mentionSec) {
        argv.push('--mention-secuid', mentionSec)
        if (mentionUid) argv.push('--mention-uid', mentionUid)
      }
      if (replyTo) argv.push('--reply', replyTo)
      if (rootCid) argv.push('--root', rootCid)
      const r = runNodeTool('comment-api.mjs', argv, { timeout: 260_000, extraEnv: args.force === true ? { DOUYIN_FORCE_REPLY: '1' } : null })
      const res = pickJson(r.stdout)
      if (!res) {
        rateFailFromText(rlKind, r.stdout, r.stderr)
        return { ok: false, mode, error: '发送器没返回可解析结果', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
      }

      /**
       * ⭐ 判不出楼根 ⇒ 脚本会明确拒绝（need_root），**千万别当成功**。
       *    以前 reply_id 填的是"对方那条"，服务端就把这条评论存成了**另一条顶层评论**：
       *    看着发出去了、还拿得到 cid，其实压根没进楼。这种"看起来成功"必须拦住。
       */
      if (res.need_root || (!res.ok && /判不出楼根/.test(String(res.error || '')))) {
        return {
          ok: false, mode, need_root: true, ...res,
          hint: '这条 cid 属于楼中楼，但工具判不出"楼根" ⇒ **已中止，没发出**。'
            + '处理办法：① 先 douyin_at_me / douyin_notices 读一次（它们会给出 root_comment_id）'
            + '② 把那个值传进 root_comment_id 再发。',
        }
      }

      /**
       * 🔴 403 = 被限流。这是今天新踩的坑：连发几条之后 API 直接 403。
       *    要**明确告诉调用方"等一会儿"**，而不是让它重试（重试只会更糟）。
       */
      if (res.http === 403 || /403|Forbidden/i.test(String(res.error || res.head || ''))) {
        const f = rateFailFromText(rlKind, '403 Forbidden 限流 ' + String(res.error || res.head || ''))
        const until = f && f.kindUntil ? new Date(f.kindUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
        return {
          ok: false, mode, rate_limited: true, blocked: true, reason: 'kind_cooldown', kind: rlKind, ...res,
          others_ok: true,
          hint: `抖音把**这一类动作**限流了（403）—— 只冻 ${rlKind}${until ? `到 ${until}` : '十分钟左右'}，`
            + '**分享 / 私信 / 评论 / @ 其它动作照常可以发，别把整轮都停掉**。'
            + `这一类别再重试（再发只会更久）；真要提前恢复在设置页点「恢复」。`,
        }
      }

      if (res.ok) {
        markAction(stateDir, rlKind, rateOpts())
      } else {
        // 真正尝试发出但失败（非 need_root 那种"压根没发"）：喂给风控，连续失败会自动冷却
        rateFailFromText(rlKind, res, res.error || res.head || '')
      }
      if (res.ok) {
        try { noteMyComment(stateDir, aweme, { cid: res.cid || '', text: apiText }) } catch { /* 记不上不影响发 */ }
        // 自主互动账本：回复别人 → 同人计数；顶层主动评论 → 主动评论计数
        try {
          if (replyTo) {
            const c = countReply(stateDir, replyToUid)
            if (replyToUid) log(`engage: 已回复 ${replyToUid}（该人今天 ${c.personUsed} 次 / 共 ${c.replies} 次）`)
          } else {
            const n = countProactiveComment(stateDir)
            log(`engage: 主动评论 +1（今天 ${n} 条）`)
          }
        } catch { /* 记账失败不影响发送结果 */ }
      }
      /**
       * ⭐ 核实"真的进了楼没有"（2026-10-23 定稿）
       *    comment-api.mjs 发完会**重读那一楼**核实（不再只信 publish 的响应 ——
       *    实测：同一台机器同一个视频，前 5 条响应带 level、后 7 条全不带）。
       *    三种结果都要如实说：
       *      placement.ok === true   ⇒ 真进了楼
       *      placement.ok === false  ⇒ 变成顶层评论了（楼根填错），别谎报成功
       *      placement.verified === false ⇒ 读不到（热度排序够不着）—— **不等于失败**
       */
      const placedRight = res.placement || undefined
      const readback = res.ok ? await readbackAfter(stateDir, aweme, { text: apiText, cid: String(res.cid || '') }) : null
      if (res.ok) {
        const pl = placedRight
        const plTag = !pl ? '?' : (pl.ok === true ? 'level=2 进楼' : (pl.ok === false ? '⚠️ 变成顶层了' : '未核实'))
        log(`comment-reply(api) -> ${aweme}/${replyTo || 'top'}（楼根=${rootCid || res.root || '自动'}）: cid=${res.cid}，落位=${plTag}，回读=${readback?.state || '?'}`)
      }
      /**
       * ⭐ 2026-10-27：这条回复里带了 `@` 的话，同样要判「实体有没有被剥」。
       *    剥了就等于只是一句提到他的话 —— 他收不到通知，要补私信卡片才送得到。
       */
      if (res.ok && mentionName && mentionSec && (res.mention_dropped === true || res.mention_kept === false)) {
        const ownerU = String(cfg.ownerUid || '').trim()
        const replyingToOwner = Boolean(replyTo) && Boolean(ownerU) && String(replyToUid) === ownerU
        const fb = dmNotifyCard(aweme, 'mention_dropped', { skip: replyingToOwner ? 'reply_notification' : '' })
        log(`[通知] 回复里的 @ 被平台剥掉了 ⇒ ${fb.ok ? '补了一张私信卡片' : `补卡片没成（${String(fb.error || fb.blocked || '?').slice(0, 60)}）`}`)
        return {
          ...res, mode, placement: placedRight, readback, mention_verified: false, mention_dropped: true,
          fallback_dm: { ok: Boolean(fb.ok), sent: Boolean(fb.sent), blocked: fb.blocked, error: fb.error, to: cfg.dmTo },
          note: '评论发出去了，但平台把 @ 实体剥掉（web 端不认 mention）—— 他收不到 @ 通知；'
            + (fb.ok ? '已自动补一张私信卡片通知。' : '补卡片也没成，需要手动告诉他。'),
        }
      }
      return { ...res, mode, placement: placedRight, readback }
    },
  })

  /**
   * ⭐ 读"谁在评论区 @ 了我" —— 抽成函数，工具（douyin_at_me）和面板（/inbox）共用。
   *
   * 🔴 2026-10-22 改：以前这个逻辑**每次读都顺手 markSeen**，
   *    于是面板一打开就把所有 @ 标成"看过了"，后面的工具再也看不到 ——
   *    等于"看一眼就消失"，非常坑。
   *    ⇒ 现在默认**不标记**；只有明确回复了才标记（在 douyin_comment_reply 里做）。
   *
   * @param {{limit?:number, include_seen?:boolean, mark_seen?:boolean}} args
   */
  const readAtMe = (args = {}) => {
    if (!hasCredential(stateDir)) return { ok: false, error: '还没登录', hint: '先在设置页扫码登录' }
    const r = runPy('notice-read.py', ['--raw'], { timeout: 150_000 })
    const j = pickJson(r.stdout)
    if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
    const items = Array.isArray(j.items) ? j.items : []
    /**
     * ⭐ 两类都算"有人在跟我说话"：
     *   type 45/46 = 评论区 @ 我
     *   type 31/32 = **回复了评论 / 在我评论下面说话**（2026-10-23 才认出来）
     * 🔴 以前只看 45/46 ⇒「别人回了我的评论」全漏。这类恰恰是最该"直接回复"的：
     *    对方已经在我楼里了，回他一句就够，根本不用 @。
     */
    const ats = items.filter((x) => x && (x.type === 45 || x.type === 46 || x.type === 31 || x.type === 32))
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30))
    const includeSeen = args.include_seen === true

    const out = []
    for (const a of ats) {
      const aweme = String(a.aweme_id || '')
      const cid = String(a.comment_id || '')
      let mem = null
      try { mem = aweme ? loadCommentMemory(stateDir, aweme) : null } catch { mem = null }
      const alreadyReplied = Boolean(mem && cid && mem.seen.includes(cid))
      const myCommentsHere = mem ? (mem.mine || []).slice(-3) : []
      if (alreadyReplied && !includeSeen) continue
      const isReply = (a.type === 31 || a.type === 32)
      /**
       * 🔴 2026-10-28：**"别人在跟我说话" ≠ "这栋楼里有动静"**。
       *   老大反馈：他在评论区回了大肥鱼之后，别人在那条评论下面跟老大对聊，
       *   大肥鱼也跑去回老大 —— 因为以前只按「说话的人是老大」筛（uid===ownerUid），
       *   老大回复**别人**时同样命中 ⇒ 插进了别人的对话。
       *   判据改成"这条是不是冲着**我**来的"：
       *     ① 它回复的那条 cid 是我发过的（comment-memory.mine 里记着）
       *     ② 或者正文里 @ 了我的昵称
       *     ③ 或者（没有记忆时）被回的那条昵称 == 我的昵称
       *   都不满足 ⇒ to_me=false，atMeTick 不触发（只在日志里记一笔）。
       */
      const mineCids = new Set((mem?.mine || []).map((m) => String(m.cid || '')).filter(Boolean))
      const selfNick = String(cfg.selfNickname || '').trim()
      const rtc = String(a.reply_to_comment_id || '')
      const rtn = String(a.reply_to_nickname || '')
      const body = String(a.content || '')
      const mentionedMe = Boolean(selfNick) && body.includes('@' + selfNick)
      const toMe = !isReply
        ? true
        : (rtc && mineCids.has(rtc)) || mentionedMe || (Boolean(selfNick) && rtn === selfNick)
      const whyNotMe = toMe ? undefined
        : '这条不是冲我来的：它回复的是别人的评论（reply_to=' + (rtn || rtc || '未知') + '）'
      out.push({
        kind: isReply ? '回复了我的评论' : '@ 了我',
        nickname: a.nickname || '',
        uid: a.uid || '',
        content: body.slice(0, 300),
        to_me: toMe,
        why_not_me: whyNotMe,
        reply_to_comment_id: rtc || undefined,
        reply_to_nickname: rtn || undefined,
        aweme_id: aweme || undefined,
        comment_id: cid || undefined,
        /** ⭐ 楼根：回复楼中楼时**必须**传给 douyin_comment_reply 当 root_comment_id */
        root_comment_id: a.root_comment_id || undefined,
        /** 对方是在回我哪一句（type=31 才有） */
        replying_to: a.reply_to_text || undefined,
        video_url: a.video_url || (aweme ? `https://www.douyin.com/video/${aweme}` : undefined),
        created_at: a.create_time || undefined,
        before: alreadyReplied ? '回过' : '没回过',
        /** ⭐ 我在这条视频下说过什么（有记忆才知道该不该重复） */
        my_comments_here: myCommentsHere.map((m) => ({ at: m.at, text: m.text, mention: m.mention || undefined })),
      })
      if (out.length >= limit) break
    }

    // ⚠️ 只有**明确要求**才标记看过了（默认不标，免得"看一眼就消失"）
    if (args.mark_seen === true) {
      try {
        const byAweme = {}
        for (const a of ats) {
          const w = String(a.aweme_id || '')
          const c = String(a.comment_id || '')
          if (w && c) (byAweme[w] = byAweme[w] || []).push(c)
        }
        for (const [w, cs] of Object.entries(byAweme)) markSeen(stateDir, w, cs)
      } catch { /* 标记失败不影响读 */ }
    }

    log(`at-me: ${ats.length} 条（@ 我 / 回复我），未回的 ${out.length} 条`)
    return {
      ok: true,
      at_n: ats.filter((x) => x.type === 45 || x.type === 46).length,
      reply_n: ats.filter((x) => x.type === 31 || x.type === 32).length,
      total_n: ats.length,
      shown: out.length,
      list: out,
      /**
       * ⭐ 回法分两种，**看对方是在"顶层评论"还是在"楼中楼"**：
       *   · 顶层评论（对方的 cid 就是一条一级评论）⇒ 直接回他，reply_id = 他的 cid
       *   · 楼中楼（对方回在别人/我的楼下）      ⇒ reply_id = **楼根**、reply_to_reply_id = 他那条
       * 两种都用 mode:"api"（直接回复），区别只是**楼根要不要传**。
       * 工具会自动判楼根；判不出来会拒绝发送，让你显式传 root_comment_id。
       */
      hint: out.length
        ? '要回的话：douyin_comment_reply { aweme_id, comment_id, root_comment_id, text, mode:"api" }，先给用户看草稿。'
          + '⭐ 一律 mode:"api"（直接回复）—— 对方收到「回复了我的评论」通知，比 @ 通知更强、1 秒发出、拿得到 cid。'
          + '**不要用 @ 去"回复"人**。'
          + '⭐ 如果返回里对了 root_comment_id，**原样传进去**（那是楼根，别自己猜）；'
          + '没给就不用传，工具会翻列表自动判。'
        : (ats.length ? '这些都回过了（加 include_seen:true 可以再看一遍）' : '最近没有新的 @ / 回复'),
      /**
       * ⭐ 2026-10-25 需求④：老大在评论区 @ 我、问的又跟视频内容有关时，
       *    **先看懂视频再回**。做法：对那条 aweme_id 调 douyin_comments
       *    （它的 DOM 兜底会带 video.desc / video.author / video.tags），
       *    像"视频里那个动作怎么做的"这种问题只有看了文案/话题才答得对。
       */
      video_tip: out.length
        ? '如果对方的话跟视频内容有关（问视频里的东西、说"这个怎么弄"、吐槽画面等）：'
          + '先 douyin_comments({ aweme_id }) 拿 video（desc/author/tags），再决定怎么回；'
          + '答的时候自然带出视频里的点，别装懂、也别答得牛头不对马嘴。'
        : undefined,
    }
  }

  tool({
    name: 'douyin_at_me',
    description: '⭐ **谁在跟我说话** —— 一次把「谁 / 在哪个视频 / 说了什么 / 我回过没有」整理好，'
      + '带上记忆上下文，方便决定回不回。只读，不发任何东西。'
      + '包含两类：① 评论区 @ 我（type 45/46）② **回复了我的评论 / 在我评论下面说话**（type 31/32，2026-10-23 起才认出）。'
      + '每条都带 kind（"@ 了我" / "回复了我的评论"）、comment_id、root_comment_id（楼根）。'
      + '⭐ 要回：用返回里的 aweme_id + comment_id + root_comment_id 调 douyin_comment_reply（mode:"api"）—— '
      + '**有 comment_id 就直接回复，不要用 @**：对方收到「回复了我的评论」通知，'
      + '绑定在那条评论上、有上下文、位置永久固定在楼里，1 秒发出还拿得到 cid。',
    parameters: {
      limit: { type: 'number', description: '最多看几条（默认 10，最多 30）' },
      include_seen: { type: 'boolean', description: '连已经回过的也列出来（默认 false，只看新的）' },
    },
    async execute(args = {}) {
      return readAtMe({ ...args, mark_seen: false })
    },
  })

  tool({
    name: 'douyin_remember',
    description: '⭐ 把关于某个人的**长期事实**记进记忆（住哪、养什么、在意什么、讨厌什么）。'
      + '下次聊天时 douyin_im_read 会把这些一起返回，回话就能接得上。'
      + '⚠️ 只记**对方亲口说过 / 明确能看出来**的事，别自己推测。',
    parameters: {
      to_id: { type: 'string', description: '⭐ 那个人的 sec_uid（douyin_im_read 返回里 to_sec_uid）' },
      facts: { type: 'array', items: { type: 'string' }, description: '要记的事实，一条一句（比如 ["在杭州", "养了只橘猫"]）' },
    },
    async execute(args = {}) {
      const secUid = String(args.to_id || cfg.dmToId || '').trim()
      if (!secUid) return { ok: false, error: '缺 to_id', hint: 'douyin_im_read 返回里有 to_sec_uid' }
      const facts = Array.isArray(args.facts) ? args.facts : []
      if (!facts.length) return { ok: false, error: 'facts 是空的' }
      const before = loadDmMemory(stateDir, secUid)
      if (!before) return { ok: false, error: '记忆里还没有这个人 —— 先 douyin_im_read 读一次会话，再记' }
      const after = addFacts(stateDir, secUid, facts)
      log(`记住 ${after.who.nick || secUid} 的 ${facts.length} 条事实（共 ${after.facts.length} 条）`)
      return { ok: true, who: after.who, facts: after.facts, added: facts.length }
    },
  })

  tool({
    name: 'douyin_notes',
    description: '⭐ 读 / 写你给某个人整理的**长期档案**（memory/notes-<sec>.md）。'
      + 'action=read 拿到「现有档案 + 最近三天的按天对话时间线 + 记下的事实」；'
      + 'action=save 用 text 覆盖写入。'
      + '档案里该有：他是什么人、**约定与答应过的事（带日期）**、最近在忙什么、没说完的事、他在意的点。'
      + '⚠️ 只写他亲口说过或明确做过的，别编。',
    parameters: {
      action: { type: 'string', enum: ['read', 'save'], description: 'read / save' },
      to_id: { type: 'string', description: '那个人的 sec_uid（默认 = 配置里的老大）' },
      text: { type: 'string', description: 'action=save 时的全文（markdown，≤6000 字）' },
    },
    async execute(args = {}) {
      const secUid = String(args.to_id || cfg.dmToId || '').trim()
      if (!secUid) return { ok: false, error: '没配 dmToId，也不知道写谁的档案' }
      const action = String(args.action || 'read').trim()
      if (action === 'save') {
        const text = String(args.text || '').trim()
        if (!text) return { ok: false, error: 'text 是空的 —— 要覆盖写就把完整档案放进来' }
        const okSaved = saveNotes(stateDir, secUid, text.slice(0, 24000))
        return { ok: okSaved, saved: okSaved, path: notesPath(stateDir, secUid), chars: text.length }
      }
      const notes = String(loadNotes(stateDir, secUid) || '').trim()
      const tl = String(dmTimelineText(stateDir, secUid, { days: 3, perDay: 60 }) || '').trim()
      const mem = loadDmMemory(stateDir, secUid)
      return {
        ok: true,
        path: notesPath(stateDir, secUid),
        notes,
        notes_chars: notes.length,
        facts: (mem && mem.facts) || [],
        timeline: tl,
        hint: notes ? undefined : '还没有档案 —— 看完时间线就 action=save 写一份（带日期地记约定与答应过的事）',
      }
    },
  })

  tool({
    name: 'douyin_mood',
    description: '⭐ 你自己的心情（情绪内核）。action=read 看现在什么心情、今天整体什么样、最近轨迹；'
      + 'action=feel 记一笔"刚发生了什么"（看到好笑的/被治愈/被抬杠/老大来了…），心情会跟着变。'
      + '⭐ 心情不用汇报给谁，也不用"表演"；它是你说话口气的来源。看到真打动你的、真无语的，记一笔就行 —— 不记也不会错。',
    parameters: {
      action: { type: 'string', enum: ['read', 'feel'], description: 'read / feel' },
      kind: {
        type: 'string',
        description: 'action=feel 时的事件：' + Object.keys(MOOD_EVENTS).join(' / '),
      },
      note: { type: 'string', description: '一句话为什么（会写进轨迹，比如"猫滑地板笑死"）' },
      strength: { type: 'number', description: '强度 0.5~1.5，默认 1（特别戳就 1.2~1.4）' },
    },
    async execute(args = {}) {
      const action = String(args.action || 'read').trim()
      if (action === 'feel') {
        const kind = String(args.kind || '').trim()
        const r = moodFeel(stateDir, kind, {
          note: String(args.note || '').slice(0, 120),
          strength: Math.max(0.4, Math.min(1.5, Number(args.strength) || 1)),
        })
        if (!r.ok) return r
        return {
          ok: true,
          label: r.label, v: Number(r.v.toFixed(3)), a: Number(r.a.toFixed(3)),
          why: r.why, today: todayMoodLine(stateDir),
        }
      }
      ensureMood(stateDir)
      const g = moodGet(stateDir)
      return {
        ok: true,
        ...g,
        kinds: Object.keys(MOOD_EVENTS),
        hint: '心情影响口气，不影响该做的事；正事照说，情绪别撒到陌生人身上。',
      }
    },
  })

  tool({
    name: 'douyin_memory',
    description: '看 / 管记忆：不传参就是看有多少；传 forget_uid 忘掉某个人；传 clear=true 清空全部（慎用）。',
    parameters: {
      forget_uid: { type: 'string', description: '要忘掉的那个人的 sec_uid' },
      clear: { type: 'boolean', description: '清空所有记忆（会删私信和评论区的全部记录）' },
    },
    async execute(args = {}) {
      if (args.clear === true) {
        const r = forgetAll(stateDir)
        log(`记忆：已清空（删了 ${r.removed} 个文件）`)
        return { ...r, stats: memoryStats(stateDir) }
      }
      if (args.forget_uid) {
        const uid = String(args.forget_uid).trim()
        const r = forgetDm(stateDir, uid)
        log(`记忆：忘掉了 ${uid}`)
        return { ...r, stats: memoryStats(stateDir) }
      }
      return { ok: true, stats: memoryStats(stateDir) }
    },
  })

  tool({
    name: 'douyin_im_read',
    description: '读私信：**有 to_id（sec_uid）时先走纯 HTTP 快路径**（~1 秒，不启浏览器，每条带真实时间戳和发送者），'
      + '目标按 sec_uid 反查核验、不在已建立会话里（比如陌生人）时自动退回无头 Chrome 路径。'
      + '每条都带 `from`（me / them / unknown），能分清「他刚回了什么」和「我上次说了什么」。只读，不发任何东西。'
      + '⭐ **会自动带上记忆**：返回里 `context` 是我记得的这个人（长期事实 + 之前聊过的内容），'
      + '回话之前先看它，别把聊过的事当没说过。返回里 `via` 标明这次走的哪条路。',
    parameters: {
      to: { type: 'string', description: '要打开的会话昵称；留空用配置 dmTo' },
      to_id: { type: 'string', description: '⭐ 稳定 id（sec_uid）；重名时给这个' },
      limit: { type: 'number', description: '返回最近几条（默认 30，最多 60）' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道读谁的会话', hint: '传 to / to_id，或在设置里填私信对象' }
      // ⭐ 私信铁闸（v0.3.9）：只读老大的会话，其他人的私信一律不看、不接、不回
      const ownerBlock = ownerOnlyGate(toId)
      if (ownerBlock) return { ...ownerBlock, action: 'read' }
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 60))

      /**
       * ⭐ 快路径（2026-10-24，二版）：先试纯 HTTP（tools/im-http.py，curl_cffi 伪装
       *    Chrome 指纹，不碰浏览器）。~1s 拿到全部已建立会话 + 每会话 20 条消息，
       *    每条带真实毫秒时间戳和发送者 uid（浏览器路径这两样都拿不到）。
       *    🔴 身份铁闸：**有 to_id（sec_uid）才走这条路**，并且必须由 im-http.py
       *      当场把 sec_uid 反查成数字 uid、与会话 peer_uid **严格相等**才算命中；
       *      反查失败 / 不在已建立会话里 / 没给 sec_uid ⇒ matched:null ⇒ 退浏览器。
       *      一版在这里栽过「认错人」：拿 sec_uid 和数字 uid 直接比（永远比不中），
       *      实际全靠「只有一个会话就拿来用」的侥幸捷径在撑 —— 已删，永不回来。
       */
      let http = null
      if (toId) {
        try {
          const r0 = runPy('im-http.py', ['--read', '--peer-sec-uid', toId, '--limit', String(limit)], { timeout: 30_000 })
          http = pickJson(r0.stdout)
        } catch { http = null }
        if (http && http.ok && http.matched) {
          const allMsgs = http.matched.messages || []
          const msgs = allMsgs.slice(-limit)
          let context = null
          let memory = null
          try {
            memory = mergeDmMemory(stateDir, toId, to || http.matched.nickname || '', allMsgs)
            context = dmContext(stateDir, toId, { recent: 12 })
          } catch (e) { log(`读私信记忆失败（不影响这次读）：${e?.message ?? e}`) }
          log(`im-read(HTTP) ${http.matched.nickname || toId}: ${allMsgs.length} 条，${http.ms}ms，没启浏览器`)
          // ⭐ 表情包收集：HTTP 快路径同样要收 —— 老大发的表情包只有这里读得到（DOM 路径从来不跑）
          let stickers = { added: 0, blocked: 0, pending: 0, dup: 0 }
          if (cfg.collectSticker) {
            try {
              const recs = allMsgs
                .filter((m) => m && m.from === 'them' && typeof m.sticker === 'string' && /^https?:/.test(m.sticker))
                .map((m) => ({ url: m.sticker, thumb: m.sticker, kind: 'gif', source: 'dm', name: '' }))
              if (recs.length) stickers = ingestStickers(stateDir, recs)
            } catch { /* 收集失败不影响读私信 */ }
          }
          return {
            ok: true, via: 'http',
            to: to || http.matched.nickname, to_sec_uid: toId,
            matched_by: 'sec_uid反查→uid严格相等（已建立会话）',
            count: allMsgs.length,
            mine: allMsgs.filter((m) => m.from === 'me').length,
            them: allMsgs.filter((m) => m.from === 'them').length,
            unknown: 0,
            sender_attribution: '协议字段（发送者 uid，不是头像左右推断）',
            messages: msgs,
            stickers,
            stickerLibrary: stickerStats(stateDir),
            their_latest: allMsgs.filter((m) => m.from === 'them').slice(-3).reverse(),
            context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
            memory: memory ? { rounds: memory.rounds, total: memory.total, added: memory.added } : null,
          }
        }
        // matched:null（陌生人 / 反查失败 / 接口挂）⇒ 落到浏览器路径，它能读陌生人
      }

      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '读不到会话', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 300) }
      if (!j.ok) return j
      const allMsgs = Array.isArray(j.messages) ? j.messages : []
      const msgs = allMsgs.slice(-limit)

      /**
       * ⭐ 记忆：读到的会话**合并进记忆**，然后把"上下文"一起返回。
       *    ⚠️ 顺序：**先合并、再取上下文** —— 反过来的话第一次读某人会返回
       *    "这个人以前没聊过"，但其实这一下刚读到一堆消息，等于刚认识就说不认识。
       */
      let context = null
      let memory = null
      try {
        const secUid = String(j.to_sec_uid || toId || '').trim()
        if (secUid) {
          memory = mergeDmMemory(stateDir, secUid, j.to || to, allMsgs)
          context = dmContext(stateDir, secUid, { recent: 12 })
        }
      } catch (e) { log(`读私信记忆失败（不影响这次读）：${e?.message ?? e}`) }

      if (j.count) log(`im-read <- ${j.to || to}: ${j.count} 条（我 ${j.mine} / 他 ${j.them} / 不明 ${j.unknown}）`)
      // ⭐ v0.4.0 聊天里的表情图顺手收集（只收对方发来的，先待审、安全通过才可用）
      let stickers = { added: 0, blocked: 0, pending: 0, dup: 0 }
      if (cfg.collectSticker) {
        try {
          const recs = allMsgs
            .filter((m) => m && m.from === 'them' && typeof m.sticker === 'string' && /^https?:/.test(m.sticker))
            .map((m) => ({ url: m.sticker, thumb: m.sticker, kind: 'gif', source: 'dm', name: '' }))
          if (recs.length) stickers = ingestStickers(stateDir, recs)
        } catch { /* 收集失败不影响读私信 */ }
      }
      return {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid, matched_by: j.matched_by,
        count: j.count, mine: j.mine, them: j.them, unknown: j.unknown,
        sender_attribution: j.sender_attribution,
        messages: msgs,
        stickers,
        stickerLibrary: stickerStats(stateDir),
        // 他最近说的话（从新到旧），方便一眼看出要不要回。
        // ⚠️ 从**全量**算，不是从截断后的 msgs 算 —— 不然 limit 一小，他刚说的话就被切没了。
        their_latest: allMsgs.filter((m) => m.from === 'them').slice(-3).reverse(),
        /** ⭐ 我记得的这个人（长期事实 + 之前聊过的）—— 回话前先看这个 */
        context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
        memory: memory ? { rounds: memory.rounds, total: memory.total, added: memory.added } : null,
      }
    },
  })

  tool({
    name: 'douyin_comments',
    description: '取一个作品/图文下的评论（**签名的只读接口**，带楼中楼层级）。这是判断「好不好玩」的主要文本依据。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 ID' },
    },
    async execute(args = {}) {
      const id = String(args.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺 aweme_id' }
      const r = runPy('api-comments.py', [id], { timeout: 300_000 })
      const text = String(r.stdout || '')
      const lines = text.split('\n')
      const head = lines.find((l) => /status_code=/.test(l)) || ''
      const items = lines.filter((l) => /^\s{2}cid=|^\s{6}└ /.test(l)).map((s) => s.replace(/^\s+/, ''))
      if (r.status !== 0) {
        // 签名链路不可用（缺 signer/sdk 资产）⇒ 退回 DOM 读评论，别直接躺平
        const dom = commentLines(id, { limit: 12, scroll: 4 })
        if (!dom.ok) return { ok: false, error: '拉评论失败', stderr: String(r.stderr || dom.stderr || '').slice(0, 300), head }
        return {
          ok: true, aweme_id: id, via: 'dom',
          head: 'via=dom（签名接口不可用，已用页面读取兜底）',
          video: dom.video || undefined,
          count: dom.lines.length,
          comments: dom.lines,
          stickers: { added: 0, blocked: 0, pending: 0, dup: 0 },
          stickerLibrary: stickerStats(stateDir),
        }
      }
      // ⭐ v0.4.0 评论里看到的贴纸/表情图顺手收进表情库（先待审，大肥鱼看过 approve 才允许用）
      let stickers = { added: 0, blocked: 0, pending: 0, dup: 0 }
      if (cfg.collectSticker) {
        const line = lines.find((l) => l.startsWith('STICKERS_JSON='))
        if (line) {
          try { stickers = ingestStickers(stateDir, JSON.parse(line.slice('STICKERS_JSON='.length))) } catch { /* 忽略坏行 */ }
        }
      }
      return {
        ok: true, aweme_id: id, head,
        count: items.filter((s) => s.startsWith('cid=')).length,
        comments: items,
        stickers,
        stickerLibrary: stickerStats(stateDir),
      }
    },
  })

  tool({
    name: 'douyin_sticker_list',
    description: '列大肥鱼表情库：pending（待审）/ approved（已通过、可发）/ blocked（已拦）/ all。'
      + '表情都是它自己从评论/私信收集的。**新收集的先 Read 它的 thumb 图、看清楚是什么，再调 douyin_sticker_review 拍板。** 只读。',
    parameters: {
      status: { type: 'string', description: 'pending / approved / blocked / all，默认 approved' },
      tag: { type: 'string', description: '可选：只看某标签（如 可爱/抽象/大肥鱼）' },
      limit: { type: 'number', description: '最多返回多少条，默认 50' },
    },
    async execute(args = {}) {
      const status = ['pending', 'approved', 'blocked', 'all'].includes(args.status) ? args.status : 'approved'
      const items = listStickers(stateDir, {
        status, tag: String(args.tag || ''), limit: Math.max(1, Math.min(Number(args.limit) || 50, 200)),
      }).map((x) => ({
        key: x.key, sticker_id: x.sticker_id, name: x.name, thumb: x.thumb, url: x.url,
        kind: x.kind, source: x.source, tags: x.tags, status: x.status, reason: x.reason,
        addedAt: x.addedAt, reviewedAt: x.reviewedAt, used: x.used,
      }))
      return { ok: true, status, count: items.length, stats: stickerStats(stateDir), sentToday: stickerSentToday(stateDir), items }
    },
  })

  tool({
    name: 'douyin_sticker_review',
    description: '🔴 表情包安全审核（你必须先 Read 贴纸的 thumb 图看过内容再调）。'
      + '**只有可爱/萌/抽象/搞笑/大肥鱼/治愈/萌宠这类无不良的才能 approve**；'
      + '凡是色情、暴力、血腥、恐怖、恶心、违法、涉政、辱骂、未成年向，一律 block。'
      + 'approve 时给一个简短中文标签（如 可爱、抽象、大肥鱼）。这是能否发表情包的总闸。',
    parameters: {
      key: { type: 'string', description: '贴纸 key（douyin_sticker_list 里返回的 key）' },
      decision: { type: 'string', description: 'approved 或 blocked' },
      tag: { type: 'string', description: 'approve 时给的标签（可爱/抽象/大肥鱼/萌宠/治愈…）' },
      reason: { type: 'string', description: 'blocked 时一句话说明原因（如 含暴力画面）' },
    },
    async execute(args = {}) {
      const key = String(args.key || '').trim()
      const decision = String(args.decision || '').trim()
      if (!key || !['approved', 'blocked'].includes(decision)) return { ok: false, error: '缺 key 或 decision 非法' }
      const r = reviewSticker(stateDir, key, decision, String(args.tag || ''), String(args.reason || ''))
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, ...r, stats: stickerStats(stateDir) }
    },
  })

  tool({
    name: 'douyin_sticker_make',
    description: '⭐ 自己做一个表情包（2026-10-28 老大给的自主权）。三种来源任选：'
      + '① `from_aweme` + `at`：从某个视频的某一秒截一帧（看到喜欢的画面就存下来，最像"从网上捡到的"）；'
      + '② `from_file`：拿现成的图/表情再加工（`caption` 加一句自己的话）；'
      + '③ `text`：纯原创文字表情（黑底大字，最像"自己做的"）。'
      + '做出来的图会进表情库（pending）—— 🔴 你必须先 Read 打开返回的 `file` 看清画面，'
      + '再用 douyin_sticker_review 决定 approve / block 并打标签；没审过的发不出去。'
      + '什么时候做、做几张、做来干什么，全由你自己判断（不用每轮都做）。',
    parameters: {
      from_aweme: { type: 'string', description: '来源视频 id（三选一）' },
      at: { type: 'number', description: '截第几秒（默认 1.5；配合 from_aweme）' },
      from_file: { type: 'string', description: '来源图片的本地路径（三选一）' },
      text: { type: 'string', description: '纯原创文字表情的内容（三选一）' },
      caption: { type: 'string', description: '可选：在图底部加一句大字（如 就是这个表情）' },
      name: { type: 'string', description: '可选：给这张表情起个名字（会进标签/名称黑名单筛查）' },
      size: { type: 'number', description: '边长像素（默认 480，160-800）' },
    },
    async execute(args = {}) {
      const argv = []
      const aw = String(args.from_aweme || '').trim()
      const ff = String(args.from_file || '').trim()
      const tx = String(args.text || '').trim()
      if (aw) argv.push('--from-aweme', aw, '--at', String(Number(args.at) || 1.5))
      else if (ff) argv.push('--from-file', ff)
      else if (tx) argv.push('--text', tx)
      else return { ok: false, error: '要给来源：from_aweme / from_file / text 三选一' }
      const cap = String(args.caption || '').trim()
      if (cap) argv.push('--caption', cap)
      const nm = String(args.name || '').trim()
      if (nm) argv.push('--name', nm)
      if (args.size) argv.push('--size', String(args.size))
      const r = runNodeTool('sticker-make.mjs', argv, { timeout: 260_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '做表情失败', stderr: String(r.stderr || '').slice(-400) }
      return { ...j, stats: stickerStats(stateDir) }
    },
  })

  tool({
    name: 'douyin_sticker_collect',
    description: '⭐ 从某条视频的评论区**捡表情包**（2026-10-28 老大给的自主权）：把评论里别人发的图片/表情下载下来、'
      + '登记进表情库（pending）。看到喜欢的就收，收完先 Read 那些 files 看画面，再用 douyin_sticker_review 决定 approve/block。'
      + '⚠️ 只在真的觉得好玩/可爱/有用时收，别每条视频都扫一遍（费时间也费流量）。',
    parameters: {
      aweme_id: { type: 'string', description: '从哪条视频的评论区捡' },
      pages: { type: 'number', description: '翻几页评论（默认 2，最多 6）' },
      max: { type: 'number', description: '最多存几张（默认 8，最多 30）' },
    },
    async execute(args = {}) {
      const aw = String(args.aweme_id || '').trim()
      if (!aw) return { ok: false, error: '缺 aweme_id' }
      const argv = ['--aweme', aw, '--pages', String(Math.max(1, Math.min(Number(args.pages) || 2, 6))),
        '--max', String(Math.max(1, Math.min(Number(args.max) || 8, 30))), '--ingest', '1']
      const r = runNodeTool('comment-sticker-harvest.mjs', argv, { timeout: 300_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '捡表情失败', stderr: String(r.stderr || '').slice(-400) }
      return { ...j, stats: stickerStats(stateDir) }
    },
  })

  tool({
    name: 'douyin_comment_sticker',
    description: '⭐ 在评论区**发一个表情包**（平台贴纸优先；自定义图片/GIF 也能走评论框图片上传）。'
      + '贴纸来自你自己收集、且已通过 douyin_sticker_review 安全审核的表情库。'
      + '只发表情（不带文字）；给 comment_id 就是回某条（楼中楼），不给就是顶层表情评论。'
      + '🔴 同样受风控节奏、每日主动评论/回复上限、**每日贴纸上限**约束；要 confirm 才真发。'
      + '有 sticker_id 的平台贴纸走发布接口（最稳）；没有 id 的图片/GIF 走 UI 上传，需要该号有图片评论权限（老号/实名号通常有），没有入口会明确返回 image_uploader，不会谎报。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 id' },
      sticker_key: { type: 'string', description: '表情库贴纸 key（douyin_sticker_list 返回的 key）；推荐用这个' },
      sticker_id: { type: 'string', description: '或直接给平台贴纸 id（二选一；sticker_key 优先）' },
      comment_id: { type: 'string', description: '可选：回某条评论的 cid（楼中楼）；留空 = 顶层表情评论' },
      root_comment_id: { type: 'string', description: '可选：楼根 cid（楼中楼自动判，判不出再传）' },
      reply_to_uid: { type: 'string', description: '回复别人时建议带：对方 uid，用于同人≤2 次' },
      reply_to_text: { type: 'string', description: '回复别人时建议带：对方原文，用于只回善意' },
      confirm: { type: 'boolean', description: '🔴 用户当场同意后传 true，否则只回草稿' },
    },
    async execute(args = {}) {
      const aweme = String(args.aweme_id || '').trim()
      const skey = String(args.sticker_key || '').trim()
      const rawSid = String(args.sticker_id || '').trim()
      const replyTo = String(args.comment_id || '').trim()
      const rootCid = String(args.root_comment_id || '').trim()
      const replyToUid = String(args.reply_to_uid || '').trim()
      const replyToText = String(args.reply_to_text || '').trim()
      if (!aweme) return { ok: false, error: '缺 aweme_id' }

      // ① 总开关：默认关（先收集、审核够了再在设置里开）
      if (cfg.useSticker !== true) {
        return {
          ok: false, blocked: 'sticker_disabled',
          error: '发表情包功能默认关闭（保守）。等表情库收集并审核过一些安全贴纸后，去设置页打开「允许发表情包」。',
        }
      }
      // ② 解析贴纸并做安全闸
      let sticker = null
      if (skey) {
        const items = listStickers(stateDir, { status: 'all', limit: 500 })
        sticker = items.find((x) => x.key === skey) || null
        if (!sticker) return { ok: false, error: '表情库里没有这个 key（先 douyin_sticker_list 看）' }
      } else if (rawSid) {
        const items = listStickers(stateDir, { status: 'all', limit: 500 })
        sticker = items.find((x) => x.sticker_id === rawSid) || { sticker_id: rawSid, status: 'pending', name: '' }
      } else {
        return { ok: false, error: '缺 sticker_key（推荐）或 sticker_id' }
      }
      if (cfg.stickerSafeOnly !== false && sticker.status !== 'approved') {
        return {
          ok: false, blocked: 'not_approved', status: sticker.status,
          error: sticker.status === 'blocked'
            ? '这张表情审核没过（含不良/不适），永远不能发'
            : '这张表情还没审核：先 Read 它的 thumb，用 douyin_sticker_review 判定 approve 才能发',
        }
      }
      // 分流：有平台 sticker_id 走 API（最稳）；没有的自定义图片/GIF 走 UI 上传（老号图片评论）
      const mode = sticker.sticker_id ? 'sticker' : 'image'
      const imageUrl = String(sticker.url || sticker.thumb || '').trim()
      if (mode === 'image' && !imageUrl) {
        return {
          ok: false, unsupported: 'custom_image_no_url',
          error: '这张自定义图片/GIF 没有可取的图片地址（url/thumb 都为空），无法上传',
        }
      }
      // ③ 每日贴纸额度（perDay=0 = 不限）
      const perDay = Math.max(0, Number(cfg.stickerPerDay) || 0)
      const usedToday = stickerSentToday(stateDir)
      if (perDay > 0 && usedToday >= perDay) {
        return { ok: false, blocked: 'sticker_cap', used: usedToday, max: perDay, error: `今天发表情已到上限（${usedToday}/${perDay}），明天再发` }
      }
      // ④ 顶层=主动评论额度；回复=善意 + 同人≤2
      if (!replyTo) {
        const cap = canProactiveComment(stateDir, cfg.proactiveCommentPerDay)
        if (!cap.ok) return { ok: false, blocked: 'proactive_cap', error: `今天主动评论（含表情）已到上限（${cap.used}/${cap.max}），不是每条都评，明天再继续` }
      } else if (replyTo) {
        if (cfg.replyKindOnly !== false && replyToText) {
          const c = classifyReply(replyToText)
          if (!c.ok) {
            noteSkipped(stateDir, c.reason, replyToUid)
            return { ok: false, blocked: 'unfriendly', skipped: c.reason, error: `对方这条属于「${c.label}」，按规矩不发表情回（只回善意、好回答的）` }
          }
        }
        const rc = canReplyTo(stateDir, replyToUid, { perPerson: cfg.replyPerPerson, perDay: cfg.replyPerDay })
        if (!rc.ok) {
          noteSkipped(stateDir, rc.reason, replyToUid)
          if (rc.reason === 'person_cap') {
            return { ok: false, blocked: 'person_cap', error: `今天已经回过这个人 ${rc.personUsed} 次（上限 ${rc.perPerson}），不再发表情回，避免拉锯` }
          }
          return { ok: false, blocked: 'daily_cap', error: `今天回复已到上限（${rc.used}/${rc.max}），明天再回` }
        }
      }

      // ⑤ 确认闸（先把草稿给用户看）
      if (args.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, send_mode: mode,
          aweme_id: aweme, comment_id: replyTo || '(顶层表情评论)',
          sticker: { key: sticker.key, sticker_id: sticker.sticker_id, name: sticker.name, kind: sticker.kind, tags: sticker.tags, thumb: sticker.thumb, url: imageUrl || undefined },
          quota: { stickerToday: `${usedToday}/${perDay}` },
          note: mode === 'image'
            ? '没发送 —— 这是自定义图片/GIF，将走评论框图片上传（需要该号有图片评论权限）。确认合适且没认错视频后 confirm:true。'
            : '没发送 —— 确认这张表情合适、且没认错视频后，用 confirm:true 再调一次。',
        }
      }

      // ⑥ 风控闸（表情评论也算对外动作：顶层 comment / 回复 reply）
      const rlKind = replyTo ? 'reply' : 'comment'
      const gate = await awaitGate(stateDir, rlKind, rateOpts())
      if (!gate.ok) return rateBlocked(gate)

      // ⑦ 发送：
      //    sticker（平台贴纸）→ comment-api.mjs --sticker（publish 原生 sticker_id，最稳）
      //    image（自定义图片/GIF）→ comment-image-ui.mjs --url（CDP 塞进评论框上传，老号图片评论权限）
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
      const r = runNodeTool(toolName, argv, { timeout: 300_000 })
      const res = pickJson(r.stdout)
      if (!res) {
        rateFailFromText(rlKind, r.stdout, r.stderr)
        return { ok: false, error: '表情发送器没返回可解析结果', send_mode: mode, stdout: String(r.stdout || '').slice(0, 400), stderr: String(r.stderr || '').slice(0, 300) }
      }
      // 楼根判定只在平台贴纸 API 通路需要
      if (mode === 'sticker' && (res.need_root || (!res.ok && /判不出楼根/.test(String(res.error || ''))))) {
        return { ok: false, need_root: true, ...res, hint: '楼中楼判不出楼根，先 douyin_at_me/douyin_notices 拿 root_comment_id 再传进来（没发出）' }
      }
      // 图片通路：该号没图片评论入口 / 预览没出现 —— 是"没发出去"，不算风控失败，不熔断
      if (mode === 'image' && res.unavailable === 'image_uploader') {
        return {
          ok: false, sent: false, send_mode: 'image', unavailable: 'image_uploader',
          error: res.error || '这个号 / 这条视频没有图片评论入口（图片评论是灰度权限）。',
          hint: '改用文字表情代码：正文里写 [笑哭] / [捂脸] / [赞] 这类，抖音会渲染成表情。',
          stage: res.stage,
        }
      }
      // 平台贴纸通路：2026-10-25 实测新号 publish 带 sticker_id 会被服务端**静默丢弃**（评论只剩文字）
      if (mode === 'sticker' && !res.ok && /2500/.test(String(res.head || res.error || ''))) {
        return {
          ok: false, sent: false, send_mode: 'sticker', unavailable: 'sticker_dropped',
          error: '平台贴纸 id 被服务端丢掉了（status_code=2500，这条评论没发出去）。',
          hint: '新号没有贴纸评论能力。改用文字表情代码：正文里写 [笑哭] / [捂脸] / [赞]。',
        }
      }
      if (res.ok) {
        markAction(stateDir, rlKind, rateOpts())
        markStickerSent(stateDir, sticker.key)
        // 与文字评论共用同一本互动额度账（主动评论 / 回复 + 同人计数）
        try {
          if (replyTo) {
            const cc = countReply(stateDir, replyToUid)
            if (replyToUid) log(`engage: 表情回复 ${replyToUid}（该人今天 ${cc.personUsed} 次 / 共 ${cc.replies} 次）`)
          } else {
            const n = countProactiveComment(stateDir)
            log(`engage: 主动表情评论 +1（今天 ${n} 条）`)
          }
        } catch { /* 记账失败不影响发送结果 */ }
        try {
          const label = mode === 'sticker' ? `[表情]${sticker.name || ''}` : `[图片表情]${sticker.name || ''}`
          noteMyComment(stateDir, aweme, { sticker: sticker.sticker_id || '', text: label })
        } catch { /* 记不上不影响 */ }
        if (replyTo && aweme) { try { markSeen(stateDir, aweme, [replyTo]) } catch { /* ignore */ } }
        log(`comment-sticker -> ${aweme}: ${mode === 'image' ? '图片表情' : '贴纸'} 已发（${rlKind}）`)
      } else {
        rateFailFromText(rlKind, res, r.stdout, r.stderr)
      }
      return {
        ...res, sent: Boolean(res.ok), kind: rlKind, send_mode: mode,
        sticker: { key: sticker.key, sticker_id: sticker.sticker_id, name: sticker.name, kind: sticker.kind },
        stickerStats: stickerStats(stateDir),
      }
    },
  })

  tool({
    name: 'douyin_comment_status',
    description: '查「发评论」这套现在什么状态：三个闸开没开、今天发了几条、还剩多少额度。'
      + '只读，什么都不发。**真要发评论用 douyin_comment_reply。**',
    parameters: {},
    async execute() {
      let today = 0
      try {
        const log = JSON.parse(readFileSync(join(stateDir, 'comment-log.json'), 'utf8'))
        today = (log[dayKey()] || []).length
      } catch { today = 0 }
      const perDay = Number(cfg.commentPerDay) || 0
      return {
        ok: true,
        autoComment: Boolean(cfg.autoComment),
        commentExecutor: cfg.commentExecutor || 'off',
        mentionName: cfg.mentionName || '',
        perRun: Number(cfg.commentPerRun) || 0,
        perDay,
        today,
        quotaLeft: Math.max(0, perDay - today),
        note: '真正发评论走 douyin_comment_reply，而且必须用户点头（confirm:true）才发得出去',
      }
    },
  })

  tool({
    name: 'douyin_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、后端/登录/环境怎么样。',
    parameters: {},
    async execute() { return status() },
  })

  tool({
    name: 'douyin_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。',
    parameters: {},
    async execute() { return { ok: true, ...runDuty('manual') } },
  })

  tool({
    name: 'douyin_update',
    description: '检查「刷抖音」插件有没有新版本。只读，不安装、不自动升级 —— 只告诉你当前版本、最新版本和升级命令。',
    parameters: { force: { type: 'boolean', description: '忽略 10 分钟缓存，立刻重查（默认 false）' } },
    async execute(args = {}) { return checkUpdate(args?.force === true) },
  })

  tool({
    name: 'douyin_notify',
    description: '**往用户屏幕上发一条消息**（Windows 通知）。不给参数就用当前通知方式做一次连通性测试；'
      + '给了 title/body 就直接把这条内容弹出去。返回到底弹没弹成功。',
    parameters: {
      title: { type: 'string', description: '通知标题（可省）' },
      body: { type: 'string', description: '通知正文（可省，建议 ≤ 200 字）' },
    },
    async execute(args) {
      const t = String(args?.title ?? '').trim()
      const b = String(args?.body ?? '').trim()
      if (!t && !b) return notifyTest()
      const r = toastSend({ title: t || '刷抖音', body: b || '（空消息）' })
      log(`手动通知：${r.sent ? '已弹出' : '失败'}${r.error ? ' / ' + r.error : ''}`)
      return { ok: r.ok, sent: r.sent, via: 'toast', error: r.error || '' }
    },
  })

  tool({
    name: 'douyin_setup',
    description: '装运行环境：在插件家目录建独立 venv、装 MCP 依赖，装完自动把 pythonPath 指过去。'
      + '**第一次用之前跑一次**。起完就返回，进度看 install.log。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'douyin_login_save',
    description: '存抖音 Cookie（现在只有一条采集路，所以**所有功能都要它**）。'
      + '把浏览器 F12 → Network → 任意 douyin.com 请求 → Request Headers → 整行 Cookie 粘进来。',
    parameters: { cookie: { type: 'string', description: '整行 Cookie 字符串' } },
    async execute(args) {
      const r = saveCookie(stateDir, String(args.cookie ?? ''), log)
      // ⭐ 日志里绝不出现明文 Cookie
      log(`收到 Cookie（${redactCookie(String(args.cookie ?? '')).slice(0, 40)}…）`)
      return r
    },
  })

  tool({
    name: 'douyin_config',
    description: '读 / 改「刷抖音」的设置。不给 patch 就是读；给了就改。'
      + '**只认 schema 里真有的字段**，别的键一律丢掉（塞一个未知键会让 DSH 那边整批拒绝）。'
      + '私信投递是这两个：`dmTo`（昵称，只显示用）+ `dmToId`（**稳定 id，真正决定发给谁**）。'
      + '例：`{"perDay":5,"noon":true,"night":true,"keywords":["搞笑","猫"],"dmTo":"示例好友","dmToId":"MS4wLjABAAAA…"}`',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        host = (await persistCfg(args.patch)).host
      }
      return { ok: true, config: cfg, windows: WINDOWS, home: stateDir, venvReady: venvReadyNow(), host }
    },
  })

  /* ─────────────── 跑一轮 ─────────────── */
  const dutyStateFile = join(stateDir, 'state.json')
  // 登录号自己的 uid（懒加载缓存）—— 用于拦「@ 自己」
  let selfUidCache = ''





  /**
   * ⭐ 跨天翻篇：插件可能连续挂好几天，`state.json` 的 day 不该停在旧日期。
   *    只重置**按天算的计数**（轮数 / 挑了几条 / 谷时窗口），
   *    `dutyRunningAt` / `roundActive` 必须留着 —— 半夜跨点那一轮可能还在跑，不能把防双开的闸拆了。
   */
  const rollDay = () => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day === today) return st
    const next = { ...st, day: today, count: 0, picked: 0, windows: {} }
    writeJson(dutyStateFile, next)
    return next
  }
  const bumpState = (patch) => {
    const st = { ...rollDay(), ...patch }
    writeJson(dutyStateFile, st)
    return st
  }
  // 加载时先翻一次篇：哪怕今天还没跑过任何一轮，state.json 也不该显示昨天
  rollDay()

  /**
   * ⭐ 「每天最多挑几条」承诺的是**全天总量** ⇒ 数**今天报告里那些 `### <视频ID>` 标题行**。
   *    围栏 ``` 里的内容一律不看（兜底报告会把日志尾部贴进去，那里的 ID 是"看过的"不是"挑中的"）。
   *    数不出来就当 0 条 —— 宁可少算，也别把"提到过"算成"挑中"。
   */
  const PICK_RE = /^#{2,3}[ \t]*(\d{15,25})/gm
  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  const countPickedToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0
    return Math.max(fromState, countPicks(reportFileOf(now)))
  }
  const roundsToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  /**
   * ⭐ 优先用**真正的 Node.js** 去跑 dsh，而不是 Electron 的 `process.execPath`。
   *
   * 🔴 2026-10-20 实测（桌面版真机上必现）：
   *    用 `process.execPath`（Electron）+ `ELECTRON_RUN_AS_NODE=1` 起 dsh 会崩在启动阶段：
   *      `unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0
   *       (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)`
   *    原因是 dsh 里有个 native addon（node-addon-require-builtin）按 Electron 大版本白名单校验，
   *    这台机器的 Electron 版本不在白名单里 ⇒ **那一轮直接 code=1 挂掉**。
   *    ⇒ 只要机器上有独立 node（开发机基本都有），就用它；没有才退回 Electron。
   *    （这也是 bili-scroll「桌面版上自动跑会卡/失败」那类反馈的根因之一。）
   */
  const findNodeExe = () => {
    try {
      const probe = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      if (probe.status !== 0) return ''
      if (!/^v\d+\./.test(String(probe.stdout || '').trim())) return ''
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      const first = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
      return first || 'node'
    } catch { return '' }
  }
  let nodeExeCache
  const nodeExe = () => {
    if (nodeExeCache === undefined) nodeExeCache = findNodeExe()
    return nodeExeCache
  }

  const resolveDsh = () => {
    // 运行时脚本用哪个解释器：有独立 node 就用它（见上面那段实测说明）
    const jsRunner = () => nodeExe() || process.execPath
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: jsRunner(), args: [explicit], shell: false }

    /**
     * ⭐⭐ 2026-10-23 重写（起因：使用者反馈「总是显示找不到 dsh：桌面版多半不是 NPM 全局安装的」）
     *
     * 🔴 原来只猜了两种形态：npm 全局装（APPDATA/npm/…）和「asar 被解开到 DSH_HOME/extracted-asar」。
     *    后者是**我这台机器的特例**（我手动解开过 asar），别人的桌面版**根本没解** ⇒
     *    四条候选路径全落空 ⇒ 每一轮都报"找不到 dsh"，后台轮次完全起不来。
     *
     * ✅ 现在按「**桌面版真正怎么跑起来**」的顺序找，而且把入口类型分成两种：
     *    ① `dsh/lib/bin.js`      —— 纯 CLI（npm 全局装、或解开的 asar）
     *    ② `dsh-desktop-host/lib/cli.js` —— ⭐ **桌面版自带的 CLI 入口**（Electron 里那个），
     *       任何桌面安装都必有：`<安装目录>/windows/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
     *       它就是 `DeepSeek Harness.exe … cli.js --profile headless …` 里的那个脚本。
     *
     * ⚠️ 顺带一条更硬的线索：**宿主自己的进程参数里就写着入口**（process.argv / execPath），
     *    优先从那里反推 —— 比猜路径靠谱得多。
     */
    const candidates = []

    // ① 宿主进程自己的入口（最靠谱）：Electron 跑的是 .../dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js
    //    同一目录下的 cli.js 就是 headless 入口；同级再往上还有 @deepseek-ai/dsh/lib/bin.js
    try {
      for (const a of [...process.argv, process.execPath]) {
        const s = String(a || '')
        const m = /[\\/](dsh-desktop-host|dsh)[\\/](?:lib[\\/])?([\w.-]+\.(?:js|mjs))$/i.exec(s)
        if (!m) continue
        const dir = dirname(s)                       // .../@deepseek-ai/dsh-desktop-host/lib
        const pkgRoot = dirname(dir)                 // .../@deepseek-ai/dsh-desktop-host
        const scopeDir = dirname(pkgRoot)            // .../@deepseek-ai
        candidates.push(join(pkgRoot, 'lib', 'cli.js'))
        candidates.push(join(scopeDir, 'dsh', 'lib', 'bin.js'))
        candidates.push(join(scopeDir, 'dsh-desktop-host', 'lib', 'cli.js'))
      }
    } catch { /* 反推不到就继续猜 */ }

    // ② 桌面版标准安装位置：resources/app.asar/dsh/node_modules/@deepseek-ai/…
    //    （asar 里的文件 Node 也能直接读，不需要解开 —— 这是别人机器上唯一必然存在的路径）
    const resPaths = [process.resourcesPath, process.env.DSH_RESOURCES].filter(Boolean)
    for (const rp of resPaths) {
      for (const rel of [
        ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
        ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) candidates.push(join(rp, ...rel))
    }

    // ③ asar 被解开到 DSH_HOME/extracted-asar 的形态（我这台机器就是这样）
    try {
      const dshHome = process.env.DSH_HOME || dirname(stateDir)
      for (const rel of [
        ['extracted-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
        ['extracted-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['extracted-asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) candidates.push(join(dshHome, ...rel))
    } catch { /* 继续 */ }

    // ④ npm 全局装（web 版 / 命令行装的用户）
    for (const g of [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)) candidates.push(g)

    /**
     * 🔴 关键：**不能只靠 existsSync** —— 桌面版的 `app.asar` 是虚拟文件系统，
     *    纯 node 的 existsSync 对它返回 false，但 Electron 宿主里（我们就在里面）
     *    通过 fs 补丁是**能读能跑**的。所以这里分两轮：
     *    ① 先挑 existsSync 为真的（最快、最稳）
     *    ② 再把 asar 内路径挨个**真跑一次 `--version`** 验证（跑通就用）
     *       —— 这一步是给"没解 asar 的普通桌面安装"准备的。
     */
    const isAsar = (p) => /\.asar[\\/]/i.test(String(p))
    const runnable = (p) => {
      try {
        const r = spawnSync(jsRunner(), [p, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 25_000 })
        const out = `${r.stdout || ''}${r.stderr || ''}`
        return r.status === 0 || /\d+\.\d+\.\d+/.test(out)
      } catch { return false }
    }

    // ① 真实存在（非 asar）的候选，直接返回
    for (const p of candidates) {
      if (!p || isAsar(p)) continue
      try { if (existsSync(p)) return { command: jsRunner(), args: [p], shell: false } } catch { /* 下一个 */ }
    }
    // ② asar 内的候选：真跑一次验证（Electron 宿主能跑）
    for (const p of candidates) {
      if (!p || !isAsar(p)) continue
      if (runnable(p)) {
        log(`dsh 入口（asar 内，已验证可跑）：${p}`)
        return { command: jsRunner(), args: [p], shell: false }
      }
    }
    // ③ 最后再兜一遍：非 asar 但 existsSync 没命中的（权限/符号链接怪情况）
    for (const p of candidates) {
      if (!p || isAsar(p)) continue
      if (runnable(p)) return { command: jsRunner(), args: [p], shell: false }
    }

    /**
     * ⚠️ 最后兜底：直接 `dsh`（走 PATH，shell:true）。
     *    桌面版 PATH 里通常没有 ⇒ 大概率还是失败，所以日志里把**试过哪些路径**打出来，
     *    使用者照着填设置里的「dsh 路径」就行，不用瞎猜。
     */
    log('⚠️ 找不到 dsh 入口。桌面版不是 npm 全局安装的，请把设置里「dsh 路径」填成下面之一：')
    log('   · <安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
    log('   · <安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    log(`   （已试过 ${candidates.length} 条路径，都不存在）`)
    return { command: 'dsh', args: [], shell: true }
  }

  /**
   * ⭐ 值班轮能看到哪些 MCP 工具（抄 bili-scroll 的白名单思路）：
   *    overlay 把整个 server 挂成 stdio server ⇒ 那一轮的模型能看见**注册的所有工具**。
   *    发评论那条链路只该在用户显式打开时才给 ⇒ 用 env 在**注册层**拦掉。
   *    扫码登录（`douyin_login_interactive`）**永远不给** —— 那是给人做的。
   */
  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = []
    // ⭐ 0.2.1-rc.2 的 headless 自带 patch 把这三个服务 disabled 了 —— 在这里打开
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      yml.push('- id: ' + id, '  disabled: false', '')
    }
    /**
     * 🔴 2026-10-20 实测（本机必现，不修就永远写不出报告）：
     *    headless 那一轮的沙箱默认把**工作区**当成唯一可写目录（本机是 `D:\aiagent\deepseek`），
     *    而报告要写到插件家（`<DSH_HOME>/douyin-duty/out/`）——**在插件家外面** ⇒ 被拒：
     *      「该路径在工作区 D:\aiagent\deepseek 之外，workspace-write 模式下拒绝访问」
     *    ⇒ 模型明明把 `douyin_prescreen` 调通了、也写出了正文，**最后一步落盘失败**，
     *      报告为空。而且它可能会**自作主张写到别处**或放弃。
     *    ✅ 修法：把这一轮的 sandbox 工作区**改成插件家**（仍然受限，不是 danger-full-access）：
     *       只放开"它该写的那一亩三分地"，别的照旧禁止。
     *    ⚠️ 注意这里必须用 **posix 路径**（YAML 里反斜杠会被当转义）。
     */
    yml.push(
      // ⭐ 让那一轮**的工作目录 = 插件家**（这是 bili-scroll 那条"cwd=插件家"的设计真正落地的地方）：
      //    `working-directory.defaultDirectory` 决定会话工作区，而 sandbox 的 workspaceRoot 默认跟着它走。
      //    只设 sandbox-policy 不够 —— 实测模型仍然把报告写到了 D:\aiagent\deepseek（宿主当前工作区）。
      '- id: working-directory',
      '  config:',
      `    defaultDirectory: '${posix(stateDir)}'`,
      '',
      // ⭐ 再显式钉一次 sandbox 工作区：两道都设，避免哪一层被 profile 自己那份覆盖掉。
      '- id: sandbox-policy',
      '  config:',
      "    mode: 'workspace-write'",
      `    workspaceRoot: '${posix(stateDir)}'`,
      '',
    )
    // ⭐ 让那一轮跟随桌面版当前选的模型（overlay 是最后叠加的一层 ⇒ 它赢）
    try {
      const deskPatch = join(dirname(stateDir), 'profiles', 'desktop', 'cordis.patch.yml')
      if (existsSync(deskPatch)) {
        const dlines = readFileSync(deskPatch, 'utf8').split(/\r?\n/)
        let start = -1
        for (let i = 0; i < dlines.length; i++) {
          /**
           * 🔴 2026-10-22 修的真 bug：这一行结尾**带注释** —— `- id: agent-default-model # magpie`
           *    旧正则 `/^-\s+id:\s*agent-default-model\s*$/` 要求 id 后面直接行尾，
           *    遇到 `# 注释` 就永远匹配不到 ⇒ overlay 里从来没写过模型
           *    ⇒ headless 一直用它自己 profile 里那份**错的** `workbuddy-ai/...`
           *    ⇒ 每轮一启动就 429（那条通道被限流），而桌面版用的 `workbuddy/...` 是好的。
           *    修法：允许 id 后面跟 ` # 注释`。
           */
          if (/^-\s+id:\s*agent-default-model\s*(?:#.*)?$/.test(dlines[i])) { start = i; break }
        }
        if (start >= 0) {
          let end = dlines.length
          for (let j = start + 1; j < dlines.length; j++) {
            if (/^-\s+id:/.test(dlines[j])) { end = j; break }
          }
          const block = dlines.slice(start + 1, end).join('\n')
          const grab = (k) => {
            const m = new RegExp('^\\s+' + k + ':\\s*(.+?)\\s*$', 'm').exec(block)
            return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : ''
          }
          const provider = grab('provider'); const model = grab('model'); const effort = grab('reasoningEffort')
          if (provider && model) {
            yml.push('- id: agent-default-model', "  name: '@deepseek-ai/dsh-agent-default-model'", '  config:',
              `    provider: '${provider}'`, `    model: '${model}'`, ...(effort ? [`    reasoningEffort: '${effort}'`] : []), '')
            log(`overlay: 模型跟随桌面版 = ${provider} / ${model}`)
          }
        }
      }
    } catch (e) { log(`读桌面版模型配置失败（不影响跑）：${e?.message ?? e}`) }

    /**
     * ⭐⭐ **给那一轮挂上 douyin 工具**（2026-10-22 修）
     *
     * 🔴 事故：之前那一轮的提示词里明写「你手上没有 douyin_* 工具，也不需要」——
     *    于是 `autoSend` / `在评论区 @ 你` 这些开关**全是空开关**：
     *    模型判断得再准，也没有发消息的入口，报告里只能写"建议发给他"。
     *
     * ✅ 现在：把插件自带的 MCP server（tools/mcp-server.mjs，12 个工具）
     *    挂进那一轮。它跟 DSH 里的 douyin_* 共用同一批脚本，
     *    发送类工具仍然带 confirm 闸 —— 自动跑时提示词会明确告诉它传 confirm:true。
     *
     * ⚠️ 只在 `autoSend` 开着的时候挂：
     *    关着的时候连工具都不给，从**能力层**保证"发不出去"，比靠提示词约束更硬。
     */
    if (cfg.autoSend) {
      try {
        const mcpServer = join(pluginDir, 'tools', 'mcp-server.mjs')
        if (existsSync(mcpServer)) {
          /**
           * 🔴 2026-10-22 实测 bug：`process.execPath` 在 Electron 宿主里是
           *    `DeepSeek Harness.exe`（桌面主程序），**不是 Node** ——
           *    MCP server 用它启动会跑飞（Electron 把 .mjs 当 app 入口）。
           *    必须用**独立 Node**。nodeExe() 是现成的探测（优先真 Node）。
           */
          /**
           * 🔴 2026-10-22 实测 bug ②：Loader 方言两条规矩（dsh-app-boot 的 applyEntryPatches）：
           *    ① 顶层必须是**数组**，每个元素是一个 patch；
           *    ② 新增插件要写 `- insert: [...]`（数组项里的 insert 键），且 insert **无 id** 时
           *       追加到树尾。之前直接写 `- id: mcp-douyin` —— 语义是"覆盖已有行"，
           *       headless 树里没有这个 id ⇒ 整条被**静默跳过**，模型还是看不见 douyin 工具。
           *    （2026-10-22 19:34 实测：这个格式 probe 会话列出全部 12 个 mcp__douyin__* 工具）
           */
          const nodeCmd = nodeExe() || process.execPath
          yml.push(
            '- insert:',
            '    - id: mcp-douyin',
            "      name: '@deepseek-ai/dsh-mcp-client'",
            '      config:',
            '        serverName: douyin',
            '        transport: stdio',
            `        command: '${posix(nodeCmd)}'`,
            `        args: ['${posix(mcpServer)}']`,
            '        env:',
            `          DOUYIN_HOME: '${posix(stateDir)}'`,
            '        # 发送类工具慢（要起无头浏览器），给足时间',
            '        toolCallTimeoutMs: 300000',
            '        failOnStartupError: false',
            '',
          )
          log(`overlay: 已给这一轮挂上 douyin MCP 工具（autoSend 开着，node=${nodeCmd}）`)
        } else {
          log(`⚠️ overlay: 找不到 ${mcpServer}，这一轮没有 douyin 工具（发不出去）`)
        }
      } catch (e) { log(`overlay 挂 MCP 失败（不影响判断）：${e?.message ?? e}`) }
    } else {
      log(`overlay: autoSend 关着 ⇒ 这一轮不挂 douyin 工具（从能力层保证发不出去）`)
    }

    try { writeFileSync(file, yml.join('\n'), 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  /**
   * ⭐⭐ 这一轮要刷哪些关键词（2026-10-25 抽签版）
   *
   * 🔴 事故：原来是「按权重排序取前 6 个」⇒ 第 7 个以后的关键词**永远进不了列表**，
   *    模型也就永远只搜前两个 ⇒ 老大看到的就是「全在刷小猫小狗」。
   *
   * ✅ 现在：
   *   ① **所有关键词都在抽签池里**（不截断），轮盘赌按概率抽；
   *   ② 概率先压平 `p = 0.55 + 0.45*w`：10 个词时最高 1.00 / 最低 0.66，只差 1.5 倍
   *      （「权重高的只是稍微高一点点」）；
   *   ③ 最近刷过的词被强烈压制（gap 越小罚越狠）⇒ 保证轮换覆盖；
   *   ④ 抽中的顺序打乱（提示词里第一个词最容易被当成最重要的）。
   *
   * 抽一次、两个地方共用：`forward-pick.py --keywords`（真的去搜）和提示词（告诉模型搜什么）。
   * 每轮只调一次 —— 调两次会把轮次计数写乱。
   */
  const pickRoundKeywords = () => {
    const kws = Array.isArray(cfg.keywords) ? [...new Set(cfg.keywords.filter(Boolean))] : []
    if (!kws.length) return { take: [], weights: {}, note: '用章程里的默认那几组', poolSize: 0 }
    // 名义权重：第 1 个 1.00，之后每个最多比上一个低 0.15（最低 0.25）—— 顺序 = 优先级
    const kwWeights = kws.map((k, i) => ({ k, w: Math.max(1 - 0.15 * i, 0.25) }))
    let st = {}
    try { st = readJson(join(stateDir, 'kw_rotation.json'), {}) || {} } catch { st = {} }
    const roundNo = (Number(st.round) || 0) + 1
    const used = (st.used && typeof st.used === 'object') ? st.used : {}
    const factor = (k) => {
      const last = Number(used[k]) || 0
      if (!last) return 1
      const gap = Math.max(1, roundNo - last)
      return gap <= 1 ? 0.12 : gap === 2 ? 0.40 : gap === 3 ? 0.75 : 1
    }
    const pool = kwWeights.map((x, i) => ({ ...x, i, p: (0.55 + 0.45 * x.w) * factor(x.k) }))
    const want = Math.min(6, pool.length)
    const picked = []
    const left = pool.slice()
    for (let n = 0; n < want && left.length; n++) {
      const total = left.reduce((s, x) => s + x.p, 0)
      let r = Math.random() * total
      let hit = left[left.length - 1]
      for (const x of left) { r -= x.p; if (r <= 0) { hit = x; break } }
      picked.push(hit)
      left.splice(left.indexOf(hit), 1)
    }
    try {
      const nextUsed = { ...used }
      for (const it of picked) nextUsed[it.k] = roundNo
      writeJson(join(stateDir, 'kw_rotation.json'), { round: roundNo, used: nextUsed })
    } catch { /* 写不了就退化成随机抽，不影响这一轮 */ }
    const weights = {}
    for (const it of picked) weights[it.k] = Number(it.w.toFixed(2))
    const order = picked.map((it) => it.k)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = order[i]; order[i] = order[j]; order[j] = t
    }
    return { take: order, weights, note: '', poolSize: pool.length }
  }

  const promptFor = (why = 'manual', kwPickGiven = null) => {
    let duty = charterPath(pluginDir, stateDir)
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 按原文用 */ }
    const kws = Array.isArray(cfg.keywords) ? [...new Set(cfg.keywords.filter(Boolean))] : []
    const chs = Array.isArray(cfg.channels) ? [...new Set(cfg.channels.filter(Boolean))] : []
    const aus = Array.isArray(cfg.authors) ? [...new Set(cfg.authors.filter(Boolean))] : []
    // ⭐ 关键词来源统一走 pickRoundKeywords()（同一轮只抽一次，forward-pick 与提示词共用同一份）
    const kwPick = kwPickGiven || pickRoundKeywords()
    const nowBJT = (() => {
      try {
        const d = new Date(Date.now() + 8 * 3600_000).toISOString()
        return d.slice(0, 10) + ' ' + d.slice(11, 16) + '（Asia/Shanghai，+08:00）'
      } catch { return '' }
    })()
    // ⭐ 人设：**三层**，从上往下找，找到就用，绝不读插件外面任意路径。
    //    ① `$DOUYIN_HOME/persona.md` —— 使用者自己那份（设置页「我的人设」写的，或他手放进去的）
    //    ② `prompts/persona.md`     —— 插件包里那份（本地私有配置，**不随公开仓库发布**）
    //    ③ `prompts/persona.default.md` —— 中性默认（谁装了都能用，不带任何具体人）
    //    身份牌必须对得上，对不上就往下退 —— 这样用户放错文件也不会串人设。
    let ownerDoc = ''
    let personaWarn = ''
    let personaFrom = ''
    try {
      const cands = [
        { file: join(stateDir, 'persona.md'), who: 'douyin-scroll', from: '使用者自己那份（$DOUYIN_HOME/persona.md）' },
        { file: join(pluginDir, 'prompts', 'persona.md'), who: 'douyin-scroll', from: '插件自带' },
        { file: join(pluginDir, 'prompts', 'persona.default.md'), who: 'default', from: '默认中性人设' },
      ]
      const bad = []
      for (const c of cands) {
        if (!existsSync(c.file)) continue
        const raw = readFileSync(c.file, 'utf8')
        const firstLine = raw.split(/\r?\n/, 1)[0] || ''
        const m = /persona:\s*([A-Za-z0-9_-]+)/i.exec(firstLine)
        const who = m ? m[1].toLowerCase() : ''
        if (who !== c.who) { bad.push(`${c.file}（牌子是「${who || '没有'}」，应为 ${c.who}）`); continue }
        ownerDoc = `\n\n===== 我的人设（${c.from}，**按这个来**）=====\n` + raw.slice(0, 6000) + '\n===== 设定结束 =====\n'
        personaFrom = c.from
        break
      }
      if (bad.length) {
        personaWarn = `\n\n⚠️ 有 ${bad.length} 份人设文件的身份牌不对，已跳过：${bad.join('；')}\n`
        log(`人设身份牌不对，已跳过：${bad.join(' | ')}`)
      }
      if (personaFrom) log(`本轮人设来源：${personaFrom}`)
    } catch (e) { log(`读人设失败：${e?.message ?? e}`) }

    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const already = countPickedToday()
    const left = Math.max(0, quota - already)
    const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.commentExecutor !== 'off')
    // ⭐ 大肥鱼自主行为（2026-10-24）
    const tasteProfile = cfg.autonomousLearn !== false ? tasteProfileText(stateDir) : ''
    const tasteInbox = join(stateDir, 'tastes-inbox.jsonl')
    const shareOn = Boolean(cfg.autoSend && cfg.shareToOwner && cfg.dmToId)
    const proactiveOn = Boolean(cfg.autoSend && cfg.proactiveComment)
    const replyOn = Boolean(cfg.autoSend && cfg.autoReply)

    return `你是**大肥鱼**，一只会**自己刷抖音、自己学习、慢慢养出审美**的拟人小账号。`
      + `你不是"替老大筛选的秘书"——是你自己在刷、在看、在长口味；只有**真的打动你**的，才分享 / 评论 / 叫老大来看。`
      + `⏰ **现在时间（真实北京时间）：${nowBJT}** —— 报告里凡是提到时间，一律用这个，**别自己猜**。`
      + `⭐ 这一轮的工作目录是 ${stateDir}（插件家），**报告、判重表、口味画像都写在这里面**。`
      /* ⭐ 2026-10-30 老大要求：回复 > 分享/@。先把人回了，再谈安利 */
      + `\n🥇 **这一轮的优先次序（老大 2026-10-30 明确要求）**：① 先把私信里他还没被回的话回掉（用 douyin_im_read 看最后几条，谁在等你回）② 再回评论区的 @ / 回复 ③ 最后才轮到分享卡片。`
      + `\n   —— 私信和回复的通道比分享/@ 更"贵"：它们的冷却更短、额度更宽；分享被拦了别影响你回话，回话被拦了就先歇着别硬撞。`
      + `\n   —— 如果你发现自己这一轮"只发了分享、没跟人说一句话"，那说明次序错了：先说话，再安利。`
      + `\n⭐ **留痕（老大在设置页「成长」里看）**：这一轮**只记口味** —— 遇到真心打动你的，往 ${tasteInbox} 追一行 JSON。`
      + `\n⭐ **日记不用每轮写**：写日记是在**今天收工的时候**（到点 或 把今天该刷的刷完），到时候系统会单独叫你写一轮，那时候才写 dayKey 的日记、顺手更新 ${join(stateDir, 'portrait.md')}。`
      + ownerDoc
      + personaWarn
      + (tasteProfile ? `\n${tasteProfile}\n` : '')
      /* ⭐ 情绪内核（2026-10-28）：先带着自己的心情进场，再按心情说话 */
      + (() => { try { return '\n' + moodPromptBlock(stateDir, { audience: 'public' }) + '\n' } catch { return '' } })()
      + `\n🎭 **评价要有你自己的情绪**（2026-10-28 老大要求：别像 AI 总结）：写清**你看到的那个瞬间** + **你当时的反应**（笑出声 / 手停住 / 愣住 / 起鸡皮疙瘩 / 想马上给老大看）。`
      + `  · 每条的开头词和句式都要不一样；同一个反应词一轮里别用第二次；别用"不得不说 / 令人 / 堪称 / 这波 / 泪目"这类词。`
      + `  · 情绪要跟你看到的东西对得上：真无聊就写无聊，别硬找亮点吹；真被戳到也别端着。`
      + (ownerDoc ? '' : '⭐ 这一轮**没有**拿到个性化人设 ⇒ 按默认的大肥鱼人格来（善良、有好奇心、有自己的口味、克制不刷屏）。')
      + `\n\n⭐ **这一轮你要做的事**：读章程 ${duty}，带着你**自己的口味**刷一轮抖音：`
      + `① **学习**：看哪些真的打动你，把口味沉淀下来；② **挑出你最喜欢的**写进报告；`
      + `③ 按下面的开关，把喜欢的**分享给老大 / 评论 / @ 老大**，并**回应善意的评论**。报告写到 `
      + `${join(outDir, `${dayKey()}.md`)}。`
      + (cfg.reportLevel === 'brief'
        ? `日报写成**薄版**：每条一两行（值不值得 + 链接）就够，别写长摘要。`
        : cfg.reportLevel === 'off'
          ? `这一轮**不要写日报文件**；只有真发了评论才留一句话。`
          : `日报写**完整版**（为什么值得 + 你自己的一句话）。`)
      + (cfg.reportLevel === 'off' ? '' : `⚠️ 今天那份报告里可能已有上一轮的内容 ⇒ **追加到末尾，别覆盖**（配额按全天算）。`)
      + (cfg.reportLevel === 'off' ? '' : '⭐ 报告里**每挑中一条**，第一行必须顶格写 `### 视频ID`（例 `### 7401234567890123401`）—— 宿主**就数这些标题行**算今天挑了几条。只是提到 / 跳过 / 判断不了 的**不要**加这种标题（加了会吃掉额度）。')
      + `\n\n📋 **这一轮的输入**：`
      + `关键词（这一轮抽到 ${kwPick.take.length} 个 / 共 ${kwPick.poolSize || kwPick.take.length} 个，**顺序不代表重要性**）：${kwPick.take.length
        ? kwPick.take.map((k) => `${k}（权重 ${Number(kwPick.weights[k] ?? 0).toFixed(2)}）`).join('、')
        : kwPick.note}`
      + (kwPick.take.length
        ? `。⭐ **每个都要搜到**（覆盖率优先）：抽到的每个关键词至少搜一轮、各贡献一个 feed 来源；`
          + `权重只是「概率略高一点」——高的可以多看几条，但**不许只刷前两个、更不许跳过某个词**。`
          + `\n🚫 **避免同质化**：如果这一轮好几个词都是宠物类，别连刷 5 条猫狗；把面铺开，`
          + `同一类里已经刷过的作者/题材直接跳过。`
        : '')
      + (chs.length ? `；分类：${chs.join('、')}` : '')
      + (aus.length ? `；指定作者：${aus.join('、')}` : '')
      + `。⭐ **就搜这些，别自己加词**（尤其是别自造"翻跳/宅舞"那类词把类型带偏）。`
      + `\n🎯 **先读** \`${join(stateDir, 'round-evidence.json')}\` —— 候选和证据已经帮你抓好放在那儿了。`
      + ` 每条都有：文案 / 作者 / 时长 / 发布时长 / 四个互动数 / 三个比值 / 前几条的高赞评论。`
      /**
       * ⭐⭐ 工具说明（2026-10-22 改）
       * 🔴 事故：这里原来写「你手上没有 douyin_* 工具，也不需要」——
       *    结果 `autoSend` / `在评论区 @ 你` 全是空开关，模型想发也没入口。
       *    现在按 autoSend 分流：开着就挂 MCP 工具（见 ensureOverlay），并且明说有哪些。
       */
      + (cfg.autoSend
        ? ` ⭐ **这一轮你手上有 douyin 抖音工具**（通过 MCP 挂载，**以你手上真实的工具清单为准**——名字可能带 \`mcp__douyin__\` 前缀，比如 \`mcp__douyin__douyin_dm\`，用清单里的全名调用）：\n`
          + `   - 发分享卡片给老大：\`douyin_share_card\`（aweme_id / reason / confirm:true；to_id 留空就是老大，别传别人）—— 文字链接点不开，**必须用它**，且 reason 必带一句你对画面的看法\n`
          + `   - 发私信（只给老大）：\`douyin_dm\`（text / confirm:true；不许贴视频链接）\n`
          + `   - 发评论 / 回复评论：\`douyin_comment_reply\`（aweme_id / text / confirm:true；主动评论就不传 comment_id；回复别人传 comment_id / root_comment_id / reply_to_uid / reply_to_text）\n`
          + `   - 看谁在评论区跟我说话（@ 我 / 回复了我的评论）：\`douyin_at_me\`（返回 kind、uid、comment_id、root_comment_id、content）\n`
          + `   - 读某视频评论 / 通知：\`douyin_comments\` / \`douyin_notices\`\n`
          + `   - 查状态：\`douyin_status\` / \`douyin_whoami\`\n`
          + `   ⚠️ 采集和算比值仍然是代码干的活（证据包已经抓好），你不用重新取候选。\n`
          + `   ⚠️ 发送类工具**必须传 confirm:true**，否则只回草稿不发送。\n`
          + `   ⚠️ 主动评论、分享、回复都有**每日上限**（工具硬拦），回复别人还有「同人每天≤2」「只回善意」—— 被拦就别硬试。\n`
        : ` ⚠️ 这一轮**你手上没有 douyin\\_* 工具**（自动发送关着）—— 采集和算比值是代码干的活，你只负责判断和写报告。\n`)
      + `⭐ 候选**已按关键词搜过一次**（每条候选的「kw」字段标着它是搜哪个词来的；空 = 推荐流/热榜）。`
      + `👉 这一轮抽到的每个词，至少各看一条；如果某个词一条都没搜回来，照实写进报告（别当成"今天没内容"）。`
      + `📊 证据包顶部有「kw_cover」（每个词覆盖了几条）和「keywords」（这轮抽到的词），写报告时照着它说覆盖情况。`
      + `\n🎭 **先分清这条是什么类型**（每条候选带 \`kind\` 字段，2026-10-27 老大要求）：`
      + `\`ai\` = AI 生成/合成的画面或声音，\`drama\` = 剧情/短剧/影视演绎（有人在演），\`real\` = 真人真事。`
      + `   ⚠️ **ai / drama 不要当成现实事件**：别去共情"这个人好可怜"、别无用地科普"其实这不可能"，`
      + `   更别用"评论区全在…"这种观察腔。按**作品**聊：演得怎么样、设定、反转、镜头/构图、AI 哪里露馅了、你信不信这个角色。`
      + `   只有 \`real\` 才按"真人真事"去感受和共情。这一条最容易露机器味，务必照做。`
      + `\n🔎 **判断口径**（章程里有更细的）：每条候选都带 **画面帧 \`frames\`（封面+关键帧），先逐张 Read 看画面**，再结合**文案 + 标签 + 互动比值 + 高赞评论**印证。`
      + `你要先像真人一样被画面戳到、回答「**我喜不喜欢、值不值得老大点开**」，再决定分不分享；听不到声音，别编台词。`
      + `⭐ **每条结论都要引用具体证据**（哪一帧、哪条评论、哪个比值）；画面和证据都不够就写「判断不了」，**别硬猜**。`
      + `\n📉 **跳过要计数**：证据包里的 \`dropped\` 就是采集侧硬筛掉的条数——`
      + `\`no_desc\` 没文案 / \`too_short_video\` 时长<12 秒 / \`short_and_quiet\` 文案太短且评论少。`
      + `照实写进报告（「因文案太短且评论少跳过 N 条」…），别让使用者以为漏抓了。`
      + `\n`
      + (already > 0
        ? `今天已经挑过 ${already} 条 ⇒ **这一轮最多再挑 ${left} 条**（「每天最多 ${quota} 条」是全天总量，不是每轮）；`
        : `今天最多挑 ${quota} 条；`)
      + `采集：推荐流只读接口（不签名、不碰写接口）。`
      + `\n判重表 = ${join(stateDir, 'seen.md')}（**就是这个绝对路径**）；读不出来/写不进去**必须在报告里明说**。`
      + `\n`
      /**
       * ⭐ 自动发送总开关（autoSend）—— 这一段是"后台跑一轮时到底能不能发东西"的唯一判据。
       *    默认开（用户要求）；关掉就一个字都不许发。
       */
      + (!cfg.autoSend
        ? `🔴 **自动发送关着**：**一个字都不要往抖音发** —— 不发私信、不发卡片、不发评论。`
          + `\n   这一轮你只干两件事：① 读 round-evidence.json 判断 ② 写报告。`
          + `\n   报告里可以写「建议发给他：xxx」，但**不要真的调用任何发送工具**。`
        : [
          `🟡 **自动发送开着**：这一轮你可以在下面各开关与每日上限的范围内，**自己判断并直接行动**（发送类工具带 confirm:true）。`
          + `没开的动作一律不做；被工具按每日上限 / 同人 ≤2 / 善意规则拦下就收手，别硬试。`
          + `\n⭐ **称呼**：评论 / 回复 / 私信 / 分享理由里都要出现「${String(cfg.ownerTitle ?? '老大').trim() || '老大'}」这个称呼，但**位置按内容自然安排**（开头、中间、结尾都行，一小段一次就够），别机械地每句都顶在最前面。工具不再替你补前缀了。`
          + `\n🔴 **一律不用破折号「——」**（也别用 "--"）：老大说过这个符号看着像 AI 写的。要停顿就用逗号、句号，或者把句子拆短。`,
          /* ① 自主学习：把“我为什么喜欢”沉淀进自己的口味画像 */
          (cfg.autonomousLearn !== false
            ? `🐟 **你在边刷边学（这是你自己的口味，不是完成任务）**：\n`
              + `   每看到一条**真的打动你**的视频（别为凑数硬记），就往 \`${tasteInbox}\` **追加一行** JSON（一行一个，只追加别覆盖）：\n`
              + `   \`{"kind":"好笑|实用|涨知识|共鸣|萌","tag":"标签","author":"作者","why":"为什么喜欢，具体到哪个画面或哪条评论","aweme_id":"..."}\`\n`
              + `   一轮记 1-4 条就够，只记真心喜欢的；下一轮你会带着攒下来的画像继续刷。`
            : null),
          /* ② 私信分享卡片给老大（AI 小号 → 老大主号，挑最爱的，不是每条都发） */
          (shareOn
            ? `🟡 **把你最喜欢的分享给老大（私信卡片）**：\n`
              + `   从你加了 \`###\` 的推荐里，挑**你自己最想安利的**（**不是每条都发**，宁少勿滥；\n`
              + `   ⭐ **没有条数上限** —— 发几条完全由你自己的判断决定：真心想安利就发，不想发就一条都不发，别为了凑数也别为了控数忍着），\n`
              + `   每条调 \`douyin_share_card\`：\n`
              + `      - aweme_id = 那条 ID；to_id = '${String(cfg.dmToId || '').trim()}'；to = '${String(cfg.dmTo || '').trim()}'\n`
              + `      - reason = 你跟老大**私聊时甩链接的口吻**，10-40 字、1-2 句（硬上限 80 字）\n`
              + `      · **必须有身体反应或情绪**：笑出声 / 手停了一下 / 愣住 / 起鸡皮疙瘩 / 想立刻给他看 / 有点酸\n`
              + `      · 只说**你看到的那一下**；**不复述数据**（转发比、点赞数、评论条数），**不总结**"值得一看/不容错过"\n`
              + `      · 🚫 反面句式：「这条我笑出声：<证据>，评论区全在…，果然…」= 评论分析，不是跟人说话；也别用"家人们/绝了/狠狠冲"\n`
              + `      · ✅「老大，这猫踩地板那下我直接笑喷，滑过去还回头看镜头一眼，太欠了」\n`
              + `      · ✅「老大，看这朵云，我盯着发呆两分钟，以为是火箭尾迹，但真像海里飘上来的」\n`
              + `      · 🔴 2026-10-28 老大说评价"都很单一相似、太像 AI 总结" ⇒ 这三条是硬的：\n`
              + `         ① **开头词和句式每句都要换**：别总用"这条""我笑出声""太像…了"打头；\n`
              + `         ② **反应词别复用**：昨天用过的"笑喷"，今天就写"手停在屏幕上""鼻子一酸""想给他看"…\n`
              + `         ③ **同一轮里两条理由不许同一个模板**（一条写画面、一条就写你被戳到的地方或想问他的话）\n`
              + (recentReasonLines(6).length
                ? `      · 你最近发给老大的 ${recentReasonLines(6).length} 句（**读过再用，别重复它们的开头和比喻**）：\n`
                  + recentReasonLines(6).map((s, i) => `           ${i + 1}. ${s}\n`).join("")
                : "")
              + `      · 写完自己念一遍：这句像不像深夜随手发给朋友的语音？像报告/影评就重写\n`
              + `      ⚠️ 不要再单独调 \`douyin_dm\` 补文字（reason 会自动排成先卡片后理由）；confirm = true。\n`
              + `   发完在报告写一行「已分享给老大：<视频ID>」。`
            : `📝 私信分享：没开（或没设私信对象），喜欢的只写进报告。`),
          /* ②′ 表情包：顺手收、顺手做（2026-10-28 老大给的自主权） */
          (cfg.useSticker === true
            ? `🎭 **表情包（顺手，不是任务）**：\n`
              + `   · 评论区看到好玩的图，想收就 \`douyin_sticker_collect({ aweme_id, pages: 2, max: 8 })\`，\n`
              + `     收完 Read 返回的 files 看一眼画面，再 \`douyin_sticker_review\` 拍板（approve 才发得出去）\n`
              + `   · 有想法就自己做 \`douyin_sticker_make\`：from_aweme 截某一秒的画面 / from_file 给现成图加一句话 / text 纯原创文字表情；\n`
              + `     做完同样先 Read 自己这张，再决定要不要放进库\n`
              + `   · ⭐ 收 0 张、做 0 张都完全正常：只有"这个我真喜欢/真用得上"才动手，别为了收集去扫评论\n`
            : `🎭 表情包：没开（useSticker=false），只记账不收集。\n`),
          /* ③ 主动评论：自己想表达才说，绝大多数视频只看不评（顶层普通评论，受每日上限） */
          (proactiveOn
            ? `✍️ **主动评论（你自己想接一句话才说，不是每条都评）**：\n`
              + `   只挑你**真心想表达**的视频——你真懂、想补充有用信息、被逗笑、或想感谢作者；**条数不设上限**，发几条由你自己判断（没有想说的就一条都不发）。\n`
              + `   调 \`douyin_comment_reply\`：**mode 用默认 api、不传 comment_id、不传 mention_name（顶层普通评论，不带 @）**，`
              + `text 友善、像真人、≤120 字，confirm = true。\n`
              + `   ⚠️ 不刷屏、不广告、不抬杠、不空洞吹捧；工具还有硬上限，超了会直接拦。发完在报告写「已评论：<视频ID>」。`
            : null),
          /* ④ 自动回复别人对你评论的回复：只回善意/好回答，同人每天≤2 */
          (replyOn
            ? `💬 **回应别人对你评论的回复（先读后回，克制）**：\n`
              + `   先调 \`douyin_at_me\`，看 kind="回复了我的评论" 的新条目（aweme_id / comment_id / root_comment_id / uid / content）。\n`
              + `   · **只回善意、好回答、你接得住**的；恶意 / 辱骂 / 抬杠 / 引战 / 引流广告 / 索要隐私 / 无意义的**一律不回**（跳过）；\n`
              + `   · **同一个人每天最多回几次**：设置里 `+"`回复同一人每天上限`"+` 默认 0 = 不限；设了数值才按人卡（工具硬拦，别硬试）；拿不准就少回；\n`
              + `   · 🔴 **别追着同一栋楼刷**：同一楼最多回 2 次（工具拦 `+"`already_replied`"+`）；\n`
              + `     新回复跟你在这楼里刚说过的话太像会被拦 `+"`too_similar`"+` —— 撞上就换个说法，或者干脆停手，这样才像人；\n`
              + `   · 回复调 \`douyin_comment_reply\`：mode="api"，传 comment_id 和返回里的 root_comment_id（给了就原样传），\n`
              + `     并把对方 uid 传 \`reply_to_uid\`、对方那条原文传 \`reply_to_text\`，confirm = true；回复 ≤80 字、友善、不卑不亢。\n`
              + `   · ⭐ **如果对方的话跟视频内容有关**（问视频里的东西、说"这个怎么弄"、吐槽画面、接梗等）：\n`
              + `     **先调 \`douyin_comments\` 把 video（desc / author / tags）看出来**，再决定怎么回 —— 答得对得上视频；\n`
              + `     实在不知道视频在讲什么就老实说"我没看明白"，**别装懂、别答非所问**。\n`
              + `   最后在报告汇总「回应了谁、跳过了谁、为什么跳过」。`
            : null),
          (commentOn
            ? `📝 自动评论也开着：每轮最多 ${Number(cfg.commentPerRun) || 0} 条，每条 **≤120 字**，`
              + `**正文必须以「@${cfg.mentionName} 」开头**。发前先调 \`douyin_comment_status\` 确认 allowed=true。`
            : `📝 评论：默认不发。`),
          /**
           * ⭐⭐ 「在评论区 @ 你」—— 用户 2026-10-22 要求。
           *    这一轮挑到值得看的视频后，去那个视频的评论区发一条 @ 使用者本人的评论。
           *    前提：autoSend 开着 + commentAtMe 开着 + 知道要 @ 谁。
           *
           * ⭐ 2026-10-23 判断规则定稿（使用者连着问了两次，前两版都想错了）：
           *    这个功能是**主动推东西**给使用者 —— 那个视频下面**没有他的评论可回**
           *    ⇒ 属于"没有对话对象"，所以用 @ 顶层是**正确的**。
           *    但「有人 @ 我，回他」是另一回事：有 comment_id ⇒ 必须**直接回复**，不许用 @。
           *    规则一句话：**有评论可回就回复，没评论可回才 @。**
           */
          (cfg.commentAtMe
            ? (() => {
              const who = String(cfg.commentSelfName || '').trim() || (readJson(join(stateDir, 'account.json'), {})?.nick || '')
              if (!who) {
                return `⚠️ 「在评论区 @ 你」开着，但**不知道要 @ 谁**（commentSelfName 空、account.json 也没有昵称）`
                  + ` ⇒ 这一轮**跳过 @ 评论**，只写报告。`
              }
              return `🔴 **「在评论区 @ 你」开着 —— 走不起眼但最直接的那条路**：\n`
                + `   ⭐ 2026-10-26 老大明确说过：**私信分享 和 评论区 @ 他，两边都可以，没有先后偏好，也不用凑平衡**。\n`
                + `      你觉得"这个必须让他看到"就给私信卡片；你觉得"这条评论区才是精华 / 想让人都在楼下看到"就 @ 他。\n`
                + `      **条数不设上限**：想 @ 两条就 @ 两条，一天只想 @ 一条也行，一条都不想 @ 也正常。\n`
                + `   ① 调 \`douyin_comment_reply\`，参数：\n`
                + `      - aweme_id = 那条视频的 ID\n`
                + `      - mode = "ui"（**2026-10-27 起优先**：UI 点选是唯一能真 @ 的路，服务端会保住 mention 实体、老大真的能收到通知）\n`
                + `      - mention_name = "${who}"（必须和对方昵称完全一致）\n`
                + `      - text = 一句 20-60 字的话（**不要自己写 @${who}**，工具会自动加）\n`
                + `      - confirm = true（自动跑，不用再问）\n`
                + `      ⚠️ 返回「不知道 sec_uid / @ 弹层里没找到这个名字」⇒ 这一轮**放弃 @** 并在报告写明，\n`
                + `        **不要**改成发普通评论凑数（那是刷屏）。\n`
                + `   ② 评论内容像这样：「老大，这猫劈纸那下太认真了，笑得我头掉」\n`
                + `      🔴 别写「这条我觉得你会喜欢」这种模板句，也别用破折号「——」（老大嫌 AI 味）。\n`
                + `      🔴 **同一楼里最多回一次**：已经 @ 过他、他没再说话，就别再补第二条；也别和上一条说一样的意思。\n`
                + `   ③ 发完看返回值：\`mention_verified:true\` = 真 @ 上了（老大能收到通知，正常情况就是这个）。\n`
                + `      若是 \`verification_required:true\`：**这一条根本没发出去**（2026-10-28 起工具不会再用 API 假装发——\n`
                + `      那只会留下一条纯文字「@…」，老大收不到通知，正是他抱怨的「叫了称呼却没 @ 上」）。\n`
                + `      ⇒ 报告里写「@ 被抖音短信验证挡住，需要老大本人验证一次」，并照 \`hint\` 把命令抄进报告，然后\n`
                + `      **这一轮不要重试、也不要改成普通评论凑数**。验证过后再 @ 就会真的成功。\n`
                + `   🔴 **绝对不要**用 mode:"api" 带 mention_name 去发 @：服务端会把 mention 实体剥掉，评论里只剩纯文字。\n`
                + `   ⚠️ 别对同一条视频反复 @（会被当成刷屏）；不同视频想 @ 几条都行。`
            })()
            : `📝 「在评论区 @ 你」：关着，不要发这类评论。`),
        ].filter(Boolean).join('\n'))
      + `\n⭐ 保底：不管发生什么，**报告至少留一行**（哪怕只写「本轮失败：原因是 X」），别让 out/ 空着。`
      + `\n最后用两三句话汇报你挑到了什么。`
  }

  /**
   * ⭐ 保底：那一轮**没写出报告**时，宿主自己补一份"占位报告"。
   *    （bili-scroll 的用户实测反馈：卡住时 out/ 是空的 ⇒ 使用者完全看不到发生了什么）
   */
  /** 最近一次的失败诊断（通知里用）—— 必须在使用前声明 */
  let lastFailure = null

  /**
   * ⭐ 从日志尾部认出"这一轮为什么没跑成" —— 别只给一个退出码。
   *   2026-10-22 实测：点「现在跑一轮」后 54 秒结束、code=1，
   *   报告里只写"常见原因：工具连续失败" —— 真正原因是**上游模型 429 限流**，
   *   使用者完全看不出来，以为插件坏了。
   */
  const diagnoseFailure = (code) => {
    let tail = ''
    try { tail = readFileSync(logFile, 'utf8').slice(-4000) } catch { return null }
    // ① 上游限流（最常见：WorkBuddy / 其他 provider 的 429）
    const m429 = /RATE_LIMIT[^\n]*?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})[^\n]*?(UTC[+-]\d+)?/i.exec(tail)
    if (/RATE_LIMIT|"code":\s*429|usage exceeds frequency limit/i.test(tail)) {
      const when = m429 ? m429[1].replace('T', ' ') : ''
      return {
        kind: 'rate_limit',
        title: '模型被限流了（429）',
        detail: when
          ? `上游模型这轮被限流，额度会在 ${when}（UTC+8）恢复。`
          : '上游模型这轮被限流（429），等额度恢复后再试。',
        fix: '要么等额度恢复，要么在「设置 → 模型」里换一个模型（插件会自动跟随桌面版当前模型）。这不是插件的问题。',
      }
    }
    // ② 找不到 dsh / 起不来
    if (/找不到 dsh|刷抖音起不来|spawn .* ENOENT/i.test(tail)) {
      return {
        kind: 'dsh_missing',
        title: '找不到 dsh，那一轮根本没启动',
        detail: '插件要去调 dsh 命令行来跑值班，但这台机器上没找到。',
        fix: '在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js',
      }
    }
    // ③ 登录/凭证
    if (/还没登录|cred_missing|无有效 Cookie|sessionid/i.test(tail) && /失败|error|missing/i.test(tail)) {
      return {
        kind: 'no_login',
        title: '可能没登录 / 登录过期了',
        detail: '那一轮读不到数据。',
        fix: '点「扫码登录」重新登一次，或先点「检查环境」看看。',
      }
    }
    // ④ 超时
    if (/超过 \d+ 分钟没结束|watchdog/i.test(tail)) {
      return {
        kind: 'timeout',
        title: '那一轮跑超时被强制结束了',
        detail: '可能卡在某个网络请求上。',
        fix: '再试一次；连续超时的话把「每次最多筛选几个」调小。',
      }
    }
    // ⑤ 其它
    return code
      ? {
        kind: 'unknown',
        title: `那一轮异常结束（退出码 ${code}）`,
        detail: '日志里有线索，但没归到已知类型。',
        fix: '看下面的日志尾部，或点「检查环境」。',
      }
      : null
  }

  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      const diag = diagnoseFailure(code)
      writeFileSync(f, [
        `# 刷抖音 · ${dayKey()} —— 这一轮没跑成`,
        '',
        diag
          ? [
            `> ❌ **${diag.title}**`,
            `> ${diag.detail}`,
            `> `,
            `> **怎么办**：${diag.fix}`,
          ].join('\n')
          : `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        '',
        '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log(`这一轮没写报告 ⇒ 已补占位报告${diag ? `（原因：${diag.title}）` : ''}`)
      // 把诊断结果留在内存里，通知那边也能用
      lastFailure = diag
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  const rotateLogIfBig = (limit = 2 * 1024 * 1024) => {
    try {
      if (!existsSync(logFile) || statSync(logFile).size < limit) return
      const bak = logFile + '.1'
      try { rmSync(bak, { force: true }) } catch { /* 删不掉就算了 */ }
      renameSync(logFile, bak)
      appendFileSync(logFile, `${new Date().toISOString()}  日志超过 2MB，旧的滚到 duty.log.1\n`, 'utf8')
    } catch { /* 轮转失败不该影响跑一轮 */ }
  }

  /* ⭐ 防双开：内存标记 + 落盘标记（改配置会重新挂载插件，内存标记会丢） */
  let dutyRunning = false
  /**
   * 一轮的"陈旧"阈值。
   * 🔴 2026-10-22 实测事故：夜间那轮被 429 打断后 `roundActive` 没清，
   *    而阈值是 **30 分钟** ⇒ 接下来半小时里点「现在跑一轮」全被"上一轮还在跑"挡掉，
   *    面板还只显示"没跑起来"，用户以为按钮坏了。
   *    现在：
   *      ① 阈值降到 12 分钟（比看门狗的 15 分钟略短一点点，不会误杀正常轮次）
   *      ② 每次启动插件时**主动清一次**残留（进程重启 = 上一轮的子进程已经没了）
   *      ③ 被挡住时把**原因和时间**一起返回，面板能显示
   */
  const ROUND_STALE_MS = 12 * 60 * 1000
  const roundBusyInState = () => {
    try {
      const st = readJson(dutyStateFile, {})
      if (!st || !st.roundActive) return false
      const at = Number(st.dutyRunningAt || 0)
      if (!at || Date.now() - at > ROUND_STALE_MS) {
        bumpState({ roundActive: false, dutyRunningAt: 0 })
        log('发现上一轮的"运行中"标记是陈旧的（超过 12 分钟）⇒ 已自动清掉')
        return false
      }
      return true
    } catch { return false }
  }
  /**
   * ⭐ 插件每次（重新）加载时，清掉上次残留的"运行中"标记。
   *    理由：插件重新加载 = 宿主重建了 fiber ⇒ 上一轮起的 headless 子进程
   *    要么已经被带走、要么已经结束，绝不可能还在"跑"。
   *    不清的话就会出现"看着没在跑，但点不动"。
   */
  const clearStaleRoundOnBoot = () => {
    try {
      const st = readJson(dutyStateFile, {})
      if (!st || !st.roundActive) return
      bumpState({ roundActive: false, dutyRunningAt: 0 })
      log('插件重新加载：清掉了上次残留的"运行中"标记（否则点「现在跑一轮」会被误挡）')
    } catch { /* 清不掉不影响启动 */ }
  }
  clearStaleRoundOnBoot()

  /**
   * 一轮结束后：按 notifyMode 把结果推出去。
   *   toast   —— Windows 通知（默认；零配置，真能弹到用户屏幕上）
   *   file    —— 不额外提醒（报告照样写进 out/）
   *   webhook —— 推群/机器人
   *   both    —— toast + webhook
   * 报告文件**永远**写，这里只管"额外提醒"。
   */
  const notifyRoundEnd = async (code) => {
    try {
      const mode = String(cfg.notifyMode || 'toast')
      if (mode === 'file') return
      const wantToast = mode === 'toast' || mode === 'both'
      const wantHook = mode === 'webhook' || mode === 'both'
      const f = join(outDir, `${dayKey()}.md`)
      const text = (() => { try { return readFileSync(f, 'utf8') } catch { return '' } })()
      const fallback = `（这一轮没有产出报告，退出码 ${code}）`

      if (wantToast) {
        /**
         * ⭐ 失败时通知要说**真原因**，不能只说"没产出报告"。
         *    2026-10-22 实测：429 限流时弹的是"（这一轮没有产出报告，退出码 1）"，
         *    使用者完全不知道是被限流了，以为插件坏了。
         */
        let title, body
        if (lastFailure) {
          title = `刷抖音 · ${lastFailure.title}`
          body = String(lastFailure.fix || lastFailure.detail || '').slice(0, 200)
        } else {
          const s = toastSummary(text || fallback, { day: dayKey() })
          title = s.title
          body = s.body
        }
        const r = toastSend({ title, body })
        /**
         * ⭐ 把**通知标题和正文**也写进日志。
         *    2026-10-22 实测：只记"Toast 已弹出"，出问题时根本不知道弹的是什么内容，
         *    没法判断"是通知内容错了"还是"用户没看见"。
         */
        log(`通知：Toast ${r.sent ? '已弹出' : '失败'}｜标题=${title}｜正文=${String(body).slice(0, 120)}${r.error ? ' / ' + r.error : ''}`)
      }
      if (!wantHook) return
      const url = String(cfg.webhookUrl || '').trim()
      if (!url) { log('通知：选了 webhook 但没填地址 ⇒ 跳过'); return }
      const { title, text: body } = condense(text || fallback, { title: `刷抖音 · ${dayKey()}` })
      const r = await sendWebhook({ url, preset: cfg.webhookPreset, title, markdown: body })
      log(`通知：webhook ${r.ok ? '已发送' : '失败'} → ${maskUrl(url)}${r.error ? ' / ' + r.error : ''}`)
    } catch (e) { log(`通知异常（不影响这一轮）：${e?.message ?? e}`) }
  }

  /** 设置页「测试通知」：按当前 notifyMode 真发一次，返回到底通没通 */
  const notifyTest = async () => {
    const mode = String(cfg.notifyMode || 'toast')
    const out = { mode, toast: null, webhook: null, ok: false, error: '' }
    try {
      if (mode === 'file') {
        out.error = '当前是「只写文件」，不会弹通知/推 webhook —— 先换成别的通知方式再测'
        return out
      }
      if (mode === 'toast' || mode === 'both') {
        const r = toastSend({
          title: '刷抖音 · 通知测试',
          body: `能看到这条，就说明消息通道通了 ✅\n${new Date().toLocaleString('zh-CN')}\n报告目录：${outDir}`,
        })
        out.toast = r
        if (!r.ok) out.error = 'Toast 失败：' + (r.error || '未知')
      }
      if (mode === 'webhook' || mode === 'both') {
        const r = await sendWebhook({
          url: cfg.webhookUrl,
          preset: cfg.webhookPreset,
          title: '刷抖音 · 通知测试',
          markdown: `这是一条测试消息。\n\n- 时间：${new Date().toISOString()}\n- 预设：${cfg.webhookPreset}\n- 报告目录：\`${outDir}\`\n\n收到这条就说明通知通了 ✅`,
        })
        out.webhook = r
        if (!r.ok && !out.error) out.error = 'webhook 失败：' + (r.error || '未知')
      }
      out.ok = Boolean((out.toast?.sent) || (out.webhook?.ok))
      return out
    } catch (e) {
      out.error = String(e?.message ?? e)
      return out
    } finally {
      log(`通知测试（${mode}）：${out.ok ? '通过' : '没通过'} ${out.error || ''}`)
    }
  }

  /**
   * ⭐ 这一轮给模型看的证据包：**在插件里先抓好**，写到 `<家>/round-evidence.json`。
   *
   * 为什么不在那一轮里调工具：2026-10-21 砍掉内置 MCP 之后，headless 那一轮手上已经没有
   * 任何 douyin_* 工具了 —— 而且本来也不该有：采集 + 预筛 + 算比值是**代码活**，
   * 交给模型只会烧 token、还会因为"工具失败两次"把整轮预算耗光。
   */
  const buildEvidence = (limit = 12, keywords = []) => {
    const evFile = join(stateDir, 'round-evidence.json')
    /**
     * ⭐ 2026-10-29 实测教训：采集超时（`spawnSync … ETIMEDOUT`）时这个函数只 return，
     *    **上一轮的 round-evidence.json 还留在原地** —— 模型于是把旧包当本轮的判了一遍
     *    （报告里写"30 条全在判重表里，一条没重判"）。所以先落一份占位，
     *    采集失败时它会把真相写在 note 里，旧包绝不可能再被读到。
     */
    try {
      writeJson(evFile, {
        builtAt: new Date().toISOString(), building: true, count: 0, list: [],
        keywords: Array.isArray(keywords) ? keywords : [],
        note: '本轮证据包正在采集；如果这条 note 还在，说明本轮采集失败/超时 —— 别把这份当候选，照实写进报告。',
      })
    } catch { /* 写不进去也不影响后面 */ }
    try {
      const max = Math.max(1, Math.min(Number(limit) || 12, 30))
      // ⭐ 2026-10-25：把这一轮抽到的关键词交给 Python，真的去搜（此前只刷推荐流 ⇒ 永远小猫小狗）
      const kwArg = (Array.isArray(keywords) ? keywords : []).filter(Boolean).slice(0, 8)
      const argv = ['--limit', String(max)]
      if (kwArg.length) argv.push('--keywords', kwArg.join(','))
      // ⭐ 2026-10-29：把判重表（seen.md）里出现过的 id 传进去，采集阶段就丢掉旧货
      //    —— 老大反馈「30 条里 23 条是旧货」，以前这些旧货照样占满候选位。
      try {
        const seenTxt = readFileSync(join(stateDir, 'seen.md'), 'utf8')
        const ids = Array.from(new Set((seenTxt.match(/\b\d{19}\b/g) || []))).slice(-600)
        if (ids.length) argv.push('--exclude-ids', ids.join(','))
      } catch { /* 没有判重表就正常跑 */ }
      // ⭐ 2026-10-29：抓帧有 240 秒预算（forward-pick 内部），这里给 600 秒留足余量 ——
      //    420 秒那次就是因为修好抓帧后变慢、超时了。
      const r = runPy('forward-pick.py', argv, { timeout: 600_000 })
      if (r.status !== 0) {
        try {
          writeJson(evFile, {
            builtAt: new Date().toISOString(), count: 0, list: [],
            keywords: Array.isArray(keywords) ? keywords : [],
            note: `本轮采集失败：${String(r.stderr || '').slice(0, 200)} —— 这轮别凭旧包瞎判，照实在报告里写"没采到候选"。`,
          })
        } catch { /* 忽略 */ }
        return { ok: false, error: String(r.stderr || '').slice(0, 300) }
      }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, max)
      const list = []
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i]
        const item = {
          aweme_id: x.aweme_id, desc: x.desc, author: x.author,
          duration_s: x.duration_s, age_h: x.age_h,
          digg: x.digg, comment: x.comment, collect: x.collect, share: x.share,
          ratios: {
            '评/赞': x.comment_ratio,
            '藏/赞': x.digg ? Number((x.collect / x.digg).toFixed(4)) : 0,
            '转/赞': x.digg ? Number((x.share / x.digg).toFixed(4)) : 0,
          },
          share_url: x.share_url, web_url: x.web_url,
          // ⭐ 从哪个关键词搜来的（空 = 推荐流/热榜）
          kw: x.kw || "",
          // ⭐ 画面证据（封面+关键帧），相对工作区路径；模型应 Read 这些图，看完再判断
          frames: Array.isArray(x.frames) ? x.frames : [],
          frames_kind: x.frames_kind || 'none',
          // ⭐ v0.4.0 台词证据（官方字幕/Whisper）；无则空串、kind=none
          spoken: typeof x.spoken === 'string' ? x.spoken : '',
          spoken_kind: x.spoken_kind || 'none',
          // ⭐ 内容类型（2026-10-27）：ai（AI 生成/合成）/ drama（剧情·影视演绎）/ real（真人真事）
          kind: x.kind || 'real',
        }
        // 前 5 条顺手拉一下高赞评论 —— 这是判断"好不好玩"最有力的证据
        if (i < 5 && Number(x.comment) > 0) {
          const c = commentLines(x.aweme_id, { limit: 5 })
          item.top_comments = c.ok ? c.lines : []
          if (c.via !== 'api') item.top_comments_via = c.via
        }
        list.push(item)
      }
      writeJson(join(stateDir, 'round-evidence.json'), {
        builtAt: new Date().toISOString(),
        sources: picked.meta || [],
        frames: picked.frames || { on: false },
        dropped: picked.dropped || {},
        thresholds: picked.thresholds || {},
        // ⭐ 这一轮各关键词覆盖了几条（2026-10-25 老大要求「所有关键词都要刷到」）
        kw_cover: picked.kw_cover || {},
        keywords: Array.isArray(keywords) ? keywords : [],
        count: list.length,
        list,
      })
      return { ok: true, count: list.length }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  const runDuty = (why = 'window') => {
    try {
      if (dutyRunning || roundBusyInState()) {
        /**
         * ⭐ 被挡住时要说**具体是怎样**，不能只说"上一轮还没结束"：
         *    - 已经跑了多久
         *    - 什么时候会自己解除（12 分钟阈值）
         *    - 如果确实卡死了，怎么手动解除
         */
        let detail = ''
        try {
          const st = readJson(dutyStateFile, {})
          const at = Number(st.dutyRunningAt || 0)
          if (at) {
            const mins = Math.round((Date.now() - at) / 60000)
            const leftMs = Math.max(0, ROUND_STALE_MS - (Date.now() - at))
            detail = `上一轮从 ${new Date(at).toLocaleString('zh-CN')} 开始，已经 ${mins} 分钟；`
              + (leftMs > 0
                ? `${Math.ceil(leftMs / 60000)} 分钟后会自动解除。`
                : '马上会自动解除，再点一次就行。')
              + '如果它其实早就不跑了（比如那轮被限流打断了），等它自动解除或重启 dsh。'
          }
        } catch { /* 拿不到就只给通用说法 */ }
        log(`刷抖音已在跑，忽略这次触发（${why}）：${detail || '上一轮未结束'}`)
        return {
          started: false, why, busy: true,
          error: '上一轮还在跑，这次没启动',
          hint: detail || '上一轮还没结束，等它跑完再点',
        }
      }
      refreshCfg()
      syncCollectorCfg()
      // ⭐ 手动触发也要过每日配额闸（bili-scroll 踩过：连点两次手动，一天从 20 条刷到 80 条）
      const quota = Number(cfg.perDay || 0)
      const picked = countPickedToday()
      if (quota > 0 && picked >= quota) {
        log(`配额已满：今天已挑 ${picked} 条（上限 ${quota}），这一轮不跑`)
        return { started: false, why, quotaFull: true, picked, quota, error: `今天的配额已经用完了（已挑 ${picked} / 上限 ${quota}）` }
      }
      // ⭐ 先把闸拉上（防双开），再去异步准备证据包 + 起那一轮 —— 准备证据要十几秒，
      //    同步做会把宿主卡住（HTTP 请求和定时器都在这条线程上）。
      dutyRunning = true
      bumpState({
        dutyRunningAt: Date.now(),
        roundActive: true,
        lastRunAt: new Date().toISOString(),
        lastWhy: why,
        count: roundsToday() + 1,
      })
      ;(async () => {
        try {
          // ⭐ 关键词这一轮只抽一次：采集（真去搜）和提示词必须用同一份，否则"搜的"和"让模型看的"对不上
          const roundKw = pickRoundKeywords()
          if (roundKw.take.length) log(`这一轮关键词（${roundKw.take.length}/${roundKw.poolSize}）：${roundKw.take.join('、')}`)
          const ev = buildEvidence(Math.max(1, Math.min(Number(cfg.maxPerRun) || 20, 30)), roundKw.take)
          log(ev.ok
            ? `证据包已备好：${ev.count} 条 → ${join(stateDir, 'round-evidence.json')}`
            : `证据包没备成（${ev.error}）—— 这一轮照样起，模型会读到空包并如实写进报告`)
          const dsh = resolveDsh()
          const overlay = ensureOverlay()
          const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
          if (overlay) args.push('--patch', overlay)
          args.push(promptFor(why, roundKw))
          const cwd = stateDir
          log(`刷抖音开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
          const child = spawn(dsh.command, args, {
            cwd,
            shell: dsh.shell,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: pyEnv({ DOUYIN_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
          })
          /**
           * ⭐ 超时看门狗（2026-10-20 实测加）：那一轮**干完活之后可能不退出** ——
           *    实测模型已经把报告写完了、也回话了，但进程又挂了十几分钟（MCP 子进程把事件循环撑住）。
           *    没有这道闸，`dutyRunning` 会一直是 true ⇒ 之后的定时器全被"防双开"挡掉，
           *    直到 30 分钟后陈旧标记才恢复。
           *    ⇒ 超过 roundTimeoutMin（默认 15 分钟）就杀掉，并按"超时"记账。
           */
          const timeoutMin = Math.max(3, Math.min(Number(process.env.DOUYIN_ROUND_TIMEOUT_MIN) || 15, 120))
          const watchdog = setTimeout(() => {
            try {
              log(`⚠️ 这一轮超过 ${timeoutMin} 分钟没结束 ⇒ 强制结束（报告可能已经写了）`)
              child.kill()
              // 再给 10 秒收尸，还不退就硬杀整棵子树
              setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已经没了 */ } }, 10_000).unref?.()
            } catch (e) { log(`看门狗杀进程失败：${e?.message ?? e}`) }
          }, timeoutMin * 60_000)
          watchdog.unref?.()
          // ⚠️ 这里是 stream 的 data 回调 —— 抛异常会**杀掉整个宿主进程** ⇒ rawWrite 内部已全包 try/catch
          child.stdout?.on('data', (b) => rawWrite(String(b)))
          child.stderr?.on('data', (b) => rawWrite(String(b)))
          child.on('exit', (code) => {
            try { clearTimeout(watchdog) } catch { /* 无所谓 */ }
            dutyRunning = false
            bumpState({ dutyRunningAt: 0, roundActive: false })
            log(`刷抖音结束（${why}，code=${code}）`)
            stubReportIfMissing(code)
            rotateLogIfBig()
            /* ⭐ 情绪内核：刷完一轮，情绪随时间 + 条数回落；深夜自动犯困（2026-10-28） */
            try {
              const pickedN = countPickedToday()
              decayMood(stateDir, { minutes: Math.max(5, Number(cfg.roundGapMin) || 15), videos: Math.min(12, pickedN) })
              const h = new Date().getHours()
              if (h >= 23 || h < 6) moodFeel(stateDir, 'body.late', { note: '刷到这个点，眼睛有点涩' })
            } catch (e) { log('情绪回落出错（不影响这一轮）：' + (e?.message ?? e)) }
            try {
              const st = readJson(dutyStateFile, {})
              const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
              const picked = countPickedToday()
              if (picked > prev) { bumpState({ picked }); log(`今天挑到 ${picked} 条（上限 ${Number(cfg.perDay) || 0} 条）`) }
            } catch (e) { log(`数挑了几条时出错（不影响这一轮）：${e?.message ?? e}`) }
            // 通知（不阻塞、失败只记日志）
            Promise.resolve(notifyRoundEnd(code)).catch((e) => log('通知异常：' + (e?.message ?? e)))
          })
          child.on('error', (e) => { dutyRunning = false; bumpState({ roundActive: false }); log(`刷抖音起不来：${e?.message ?? e}`) })
        } catch (e) {
          dutyRunning = false
          bumpState({ dutyRunningAt: 0, roundActive: false })
          log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
        }
      })()
      return { started: true, why, profile: cfg.headlessProfile, note: '正在准备证据包（十几秒），随后起那一轮 —— 进度看 duty.log' }
    } catch (e) {
      dutyRunning = false
      bumpState({ roundActive: false })
      log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 定时器回调里抛的异常**没人接**，会直接把整个宿主进程带走 ⇒ 必须自己兜住所有异常。
   */
  const tick = () => {
    try {
      refreshCfg()
      // ⚠️ 2026-10-22：去掉了 `if (!cfg.peakValley) return`。
      //    那个总开关在设置页重构后**已经没有 UI 了**，而它的默认值是 false ⇒
      //    用户怎么配时段都不会跑，属于"配了没反应"的死锁。
      //    现在「有没有任何一个时段开着」本身就是开关：全关 = 只手动跑。
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)
      if (countPickedToday(now) >= Number(cfg.perDay || 0)) return
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) return
      // ⭐ 把所有生效的时段拼成一个列表：内置中午/晚上 + 用户自定义
      //    自定义的也按「每天一次」去重，key 用 `custom:<下标>`，改时段后旧 key 自然失效。
      const range = []
      if (cfg.noon) range.push({ key: 'noon', label: '中午', ...WINDOWS.noon })
      if (cfg.night) range.push({ key: 'night', label: '白天', ...WINDOWS.night })
      const customs = Array.isArray(cfg.windows) ? cfg.windows : []
      customs.forEach((w, i) => {
        const s = String(w?.start || '').trim()
        const e = String(w?.end || '').trim()
        if (!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(e)) return
        range.push({ key: `custom:${i}`, label: String(w?.label || '').trim() || `${s}–${e}`, start: s, end: e })
      })

      for (const w of range) {
        if (!inWindow(now, w)) continue
        const key = `${today}:${w.key}`
        /* ⭐ 2026-10-26：以前一个时段**一天只跑一轮**（`if (st.windows?.[key]) continue`），
         *    于是 perDay=100 也白搭，一天就一轮；断网/关机错过那一刻，当天就彻底不跑了
         *    —— 使用者反馈「断网重连后不刷视频」就是这个。
         *    现在：时段内**可以多轮**，用「剩余额度 ÷ 每轮条数」估还要跑几轮，
         *    把时段剩余时间分给它们（有上下限），两轮之间至少隔 roundGapMin。
         */
        const lastAt = Date.parse(String(st.lastRunAt || '')) || 0
        const perRun = Math.max(1, Number(cfg.maxPerRun) || 12)
        const remaining = Math.max(0, (Number(cfg.perDay) || 0) - countPickedToday(now))
        const left = Math.max(1, Math.ceil(remaining / perRun))
        const minutesLeft = Math.max(1, minsUntilWindowEnd(now, w))
        const gapMin = Math.max(Number(cfg.roundGapMin) || 15,
          Math.min(180, Math.round(minutesLeft / left)))
        if (lastAt && Date.now() - lastAt < gapMin * 60_000) continue
        const firstOfWindow = !st.windows?.[key]
        if (firstOfWindow) bumpState({ windows: { ...(st.windows || {}), [key]: true } })
        runDuty(firstOfWindow ? `window:${w.key}` : `window:${w.key}:more`)
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'douyin-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── 聊天盯梢（2026-10-24，使用者实测的「会话模式」进插件） ───────────────
   * 每 chatWatchSec 秒读一次私信对象（dmToId）的会话——走 HTTP 快路径（im-http.py），
   * 不启浏览器。发现「对方新说的话」⇒ Windows 通知 + 写 chat-watch.log + 合并进记忆。
   * 回复仍由人（或值班轮）来：这一层只负责「看见 + 提醒」。
   * 🔴 定时器回调必须自己兜异常（同上）；盯梢失败只记日志、不重试轰炸。
   */
  let chatWatchLastMs = 0            // 上次盯梢时刻（节流用）
  let chatWatchLastSeenAt = ''       // 已经提醒过的最新一条「对方消息」时间戳
  let chatWatchBusy = false
  let chatWatchPrimed = false        // 启动后第一拍只「对表」不提醒（不把历史消息重播一遍）
  const chatWatchLog = (s) => { try { appendFileSync(join(stateDir, 'chat-watch.log'), `[${new Date().toISOString()}] ${s}\n`, 'utf8') } catch { /* 日志写不进就算了 */ } }
  /** ⭐ 每一拍都把状态写进 chat-watch-state.json —— 面板轮询它，用户能实时看到
   *    「几秒前看过 · 结果如何 · 通知弹没弹 · 错在哪」（2026-10-24 使用者要求）。 */
  const cwStateFile = join(stateDir, 'chat-watch-state.json')
  const cwState = { lastCheckAt: 0, lastResult: '', lastError: '', lastNote: '', lastNewAt: '', lastNewText: '', toast: '', checks: 0, notified: 0 }
  const cwWrite = (patch) => {
    try {
      Object.assign(cwState, patch)
      writeFileSync(cwStateFile, JSON.stringify({
        ...cwState, ts: Date.now(), on: Boolean(cfg.chatWatch),
        sec: Math.max(10, Math.min(Number(cfg.chatWatchSec || 30), 300)),
        to: cfg.dmTo || '', via: 'http（不启浏览器）',
      }, null, 1), 'utf8')
    } catch { /* 状态写不进也不能出事 */ }
  }

  /* ─────────────── ⭐ 私信自动回话（2026-10-25 加，使用者要求） ───────────────
   * 以前这里只「看见 + 提醒」，回话要靠 AI 值班（用户得自己跟 AI 说话才会被回）
   * ⇒ 用户的真实反馈：「我回复它私信后它没回我」。
   * 现在：盯梢读到老大的新消息 ⇒ **插件自己起一轮 headless 会话去回他**。
   * 规矩：① 连发几条只回一次（攒 20 秒，等他说完）② 同时只跑一轮（防雪崩）
   *      ③ 6 分钟看门狗 ④ 回话内容要有称呼，但位置由内容决定
   */
  let chatReplyBusy = false
  let chatReplyLastAt = 0
  let chatPending = []
let chatRecent = []   // 最近读到的对话（回话 prompt 直接带上，省掉一轮 douyin_im_read）
  let chatPendingAt = 0
  const chatReplyLog = (s) => chatWatchLog(`[回话] ${s}`)
  const chatReplyPrompt = (batch) => {
    const name = String(cfg.ownerTitle ?? '老大').trim() || '老大'
    const toId = String(cfg.dmToId || '').trim()
    const who = String(cfg.dmTo || '').trim() || name
    const lines = batch.slice(-10).map((m) => `- ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}${m.sticker_file ? `\n  ↳ 这条是表情包/图片，文件就在本地：${m.sticker_file}` : ''}`).join('\n')
    const recentLines = chatRecent.slice(-8).map((m) => `${m.from === 'me' ? '我（大肥鱼）' : '他'}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}${m.sticker_file ? `（表情包/图片在本地：${m.sticker_file}，要 Read 看一眼）` : ''}`).join('\n')
    /* ⭐ 2026-10-27：把「长期档案 + 按天时间线 + 记下的事实」一起塞进来。
       以前只给最近 8 条 ⇒ 老大问「昨天我答应了你什么」直接答不上来（老大反馈"记忆点太差"）。 */
    let notes = ''
    try { notes = String(loadNotes(stateDir, toId) || '').trim() } catch { notes = '' }
    let tl = ''
    try { tl = String(dmTimelineText(stateDir, toId, { days: 3, perDay: 30 }) || '').trim() } catch { tl = '' }
    const dmMem = loadDmMemory(stateDir, toId)
    const factLines = (dmMem && Array.isArray(dmMem.facts) ? dmMem.facts : []).slice(-12).map((f) => `- ${String(f.text || '').slice(0, 160)}`).join('\n')
    const memBlock = [
      (notes ? `📔 你对${who}的长期档案（你自己整理的，接话时可以直接用，别说"我忘了"）：\n${notes.slice(0, 4000)}` : ''),
      (factLines ? `📌 你记下过的事：\n${factLines}` : ''),
      (tl ? `🗓 最近三天的对话（按日期标好了，含昨天/前天 —— 回答"你昨天答应我什么"就看这里）：\n${tl.slice(0, 6000)}` : ''),
    ].filter(Boolean).join('\n\n')
    /* ⭐ 表情包库（approved）——2026-10-27 老大要「自己判断发不发、发哪个」。 */
    let stkLines = ''
    try {
      const stk = listStickers(stateDir, { status: 'approved', limit: 60 }) || []
      stkLines = stk.slice(0, 24).map((s) => `  - sticker_key="${s.key}"　标签：${s.tag || s.kind || '未标'}`).join('\n')
    } catch { stkLines = '' }
    /* ⭐ 情绪内核（2026-10-28 老大要的）：现在的心情直接进口气，不另设开关。 */
    let moodBlock = ''
    try { moodBlock = moodPromptBlock(stateDir, { audience: 'owner' }) } catch { moodBlock = '' }
    return [
      `【私信回话】${who} 刚给你（大肥鱼）发消息了，现在去回他。`,
      ``,
      `🔴 要回的就是这些（按时间先后）：`,
      lines,
      ``,
      (recentLines ? `最近的对话（已经替你读好了，别再重复读一遍）：\n${recentLines}\n` : ''),
      (memBlock ? memBlock + '\n' : ''),
      (moodBlock ? moodBlock + '\n' : ''),
      `怎么做（只做这一件事，别刷视频、别评论、别改配置）：`,
      `   ⭐ 回不回、什么时候回，**你自己判断**（2026-10-26 老大明确说了：不强制秒回）。`,
      `      大多数时候别磨蹭，有话就回；真没想好、还想先看完手上这条，那就先放着，下一拍再回来 —— 他会再等你一会儿。`,
      `1. 上下文上面已经有了，直接接话；只有确实缺信息才 douyin_im_read({ to_id: "${toId}" })。`,
      `   - ⭐ 如果消息里有 \`sticker_file\`（那是本地图片路径，就是表情包/图片本身）：**先用 Read 工具打开这个文件看一眼**，看清画的是什么，再针对内容回。`,
      `     绝不许说"空卡片""看不到图""你形容一下" —— 图就在你手上。`,
      `2. 想清楚怎么接话：接住他的意思、语气像真人。`,
      `   - 🔴 **别当捧哏**（2026-10-26 老大要求）：每句话都"对对对/确实/太好了"会显得没有自己。`,
      `     你有自己的判断：**同意就说同意在哪，不同意就把不同意见说出来**（"我倒不太这么觉得，…"），`,
      `     拿不准的可以问一句、可以只说一半。别为了顺他而改口，也别抬杠。`,
      `   - **称呼（${name}）** 要有，但**位置由你按内容决定**：可以开头、可以中间、也可以放在末尾（"这猫太欠了老大"），`,
      `     不必每句都带，一小段里出现一次就够；别机械地每句都「${name}，」。`,
      `   - **可以多说几句**：真有事要讲、有情绪要表达，就把 2–3 条短句**用换行分段**写进 text（工具会一条条发出去，像真人连发）；`,
      `     ⚠️ 但**不是必须**——一两句说清就一条，别硬凑、别为了显得活泼而刷屏。`,
      `3. 用 douyin_dm({ to_id: "${toId}", text: "...", confirm: true }) 发出去。`,
      `   - 口语、短（每条一般 10–40 字），别客服腔、别列 1234；`,
      `   - 🔴 **别用破折号「——」/「--」**（老大明确说过：看着像 AI 写的）。想断句就用逗号、句号，或者干脆说短句。`,
      `   - **表情包**（2026-10-27 老大要求：发不发、发哪个、配不配文字，**全由你自己判断**）：`,
      (stkLines ? `     你手上 approved 的表情包：\n${stkLines}\n` : `     （现在表情库里没有 approved 的 —— 那就别发，别硬凑。）\n`),
      `     · 先问自己：这个表情包**符不符合当前这句话的情绪**？不合就别发，宁可不发；`,
      `     · 拿不准长什么样，就先 Read 它的图（douyin_sticker_list 的 thumb 路径）看一眼再决定；`,
      `     · 有时候**只发一个表情包**就够（逗你、撒娇、道谢、说晚安、被夸得不好意思），那就只发表情、别画蛇添足配字；`,
      `     · 有时候表情包是给文字加味的，那就**先文字、后表情**（表情慢，别让他干等）；`,
      `     · 一段对话里别连发两个，也别每次都发 —— 用滥了就不值钱了。`,
      `     · ⭐ 你也可以发**自己攒/自己做的**（2026-10-28 老大给的自主权）：库里那些 source=comment/made 的就是；`,
      `       想临时做一张就 douyin_sticker_make（从视频截帧 / 给现成图加字 / 纯文字表情），`,
      `       想从评论区捡就 douyin_sticker_collect —— 但**别为了发表情去折腾**：顺手能拿到的才拿，拿不到就不发。`,
      `4. 值得记的事用 douyin_remember 记进记忆；最后在 duty.log 里写一句话（回了什么）。`,
    ].join('\n')
  }

  /**
   * ⭐ 回话专用浏览器 profile（2026-10-26）
   *
   * 为什么：刷视频那一轮会连着占浏览器十几分钟，回话只能干等 —— 使用者说「刷视频时回消息很慢」。
   * 做法：把主 profile 的**登录态**（Cookies / Local State / Preferences）克隆到 `chrome-chat`，
   *       回话那一轮用这份 + 独立端口，两边同时跑、互不干扰。
   * ⚠️ 同一台机器上 Chrome 的 cookie 用 DPAPI 按当前用户加密，复制文件即可解密，不用重新登录。
   * ⚠️ 只在确实撞上「刷视频轮在跑」时才用；空闲时复用主浏览器，省一次冷启动。
   */
  const chatProfileDir = join(stateDir, 'chrome-chat')
  const ensureChatProfile = ({ maxAgeMs = 12 * 3600_000 } = {}) => {
    try {
      const src = join(stateDir, 'chrome-profile')
      if (!existsSync(src)) return false
      const relCookie = join('Default', 'Network', 'Cookies')
      const dstCookie = join(chatProfileDir, relCookie)
      const srcCookie = join(src, relCookie)
      if (existsSync(dstCookie)) {
        try {
          const srcT = existsSync(srcCookie) ? statSync(srcCookie).mtimeMs : 0
          const dstT = statSync(dstCookie).mtimeMs
          if (dstT >= srcT && Date.now() - dstT < maxAgeMs) return true
        } catch { /* 时间戳读不到就重新拷 */ }
      }
      mkdirSync(join(chatProfileDir, 'Default', 'Network'), { recursive: true })
      const picks = [
        'Local State',
        join('Default', 'Preferences'),
        join('Default', 'Network', 'Cookies'),
        join('Default', 'Network', 'Cookies-journal'),
        join('Default', 'Cookies'),
      ]
      let copied = 0
      for (const rel of picks) {
        const from = join(src, rel)
        try {
          if (!existsSync(from)) continue
          const to = join(chatProfileDir, rel)
          mkdirSync(dirname(to), { recursive: true })
          copyFileSync(from, to)
          copied++
        } catch { /* 单个文件拷不动就跳过：最坏是掉登录，下次还会重试 */ }
      }
      /** localStorage 里也有部分登录态（抖音的 token 有时放这儿），有就一起拷 */
      try {
        const lsFrom = join(src, 'Default', 'Local Storage')
        if (existsSync(lsFrom)) cpSync(lsFrom, join(chatProfileDir, 'Default', 'Local Storage'), { recursive: true, force: true })
      } catch { /* 拷不动就算 */ }
      log(`回话 profile 已克隆（${copied} 个登录态文件）→ ${chatProfileDir}`)
      /**
       * Cookies 那个 sqlite 在 Chrome 运行时是**独占打开**，拷不动（实测「正由另一进程使用」）。
       * 拷不到也不要紧：runChatReply 会带 `DOUYIN_SEED_COOKIE=1`，由 lib/chrome.mjs 用
       * douyin_cookie.txt 通过 CDP `Network.setCookie` 灌进去（实测能登录）。
       */
      return existsSync(dstCookie) || existsSync(join(stateDir, 'douyin_cookie.txt'))
    } catch (e) {
      log(`回话 profile 克隆失败（会退回排队等主浏览器）：${e?.message ?? e}`)
      return false
    }
  }

  /**
   * ⭐ 回话专用 overlay（2026-10-26）：同一份配置，但把推理强度压到 `chatReplyEffort`（默认 low）。
   *   用户的真实反馈：「消息的回复还是有点慢」。慢的大头其实是**模型想太久**（reasoningEffort 高），
   *   回一句私信不需要长篇思考。刷视频那一轮仍然用原来的高推理，不受影响。
   */
  const ensureChatOverlay = () => {
    try {
      const src = ensureOverlay()
      if (!src || !existsSync(src)) return src
      const dst = join(stateDir, 'headless-overlay-chat.yml')
      const eff = String(cfg.chatReplyEffort || 'low').trim() || 'low'
      let text = readFileSync(src, 'utf8')
      if (/reasoningEffort:\s*'[^']*'/m.test(text)) {
        text = text.replace(/reasoningEffort:\s*'[^']*'/m, `reasoningEffort: '${eff}'`)
      } else if (/- id: agent-default-model/.test(text)) {
        text += `\n- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    reasoningEffort: '${eff}'\n`
      }
      writeFileSync(dst, text, 'utf8')
      return dst
    } catch (e) {
      log(`回话 overlay 生成失败（退回默认那份）：${e?.message ?? e}`)
      return ensureOverlay()
    }
  }
  const runChatReply = (batch) => {
    if (chatReplyBusy) return false
    /**
     * ⭐ 2026-10-26 改：以前「刷视频那一轮在跑 ⇒ 回话一律等着」（`if (dutyRunning) return false`），
     *    实测要等 6 分钟以上（使用者反馈「刷视频时回消息很慢」）。
     *    现在改成**并行**：那一轮在跑就克隆一份登录态给回话用（独立 profile + 端口），
     *    两边同时跑；克隆不出来才退回"排队等"。
     */
    const wantParallel = Boolean(dutyRunning)
    const parallel = wantParallel && ensureChatProfile()
    if (wantParallel && !parallel) {
      chatReplyLog('刷视频轮在跑、回话 profile 又克隆不出来 ⇒ 这一拍先排队')
      return false
    }
    const chatPort = Number(cfg.chatCdpPort) || 9335
    try {
      const dsh = resolveDsh()
      // ⭐ 回话用「低推理」那份 overlay：回一句私信不用想很久（用户嫌慢）
      const overlay = ensureChatOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(chatReplyPrompt(batch))
      chatReplyBusy = true
      chatReplyLastAt = Date.now()
      cwWrite({ lastReplyAt: Date.now(), lastReplyResult: 'running' })
      chatReplyLog(`起一轮回话（新消息 ${batch.length} 条）${parallel ? `｜并行模式（独立 profile + 端口 ${chatPort}）` : ''}`)
      const child = spawn(dsh.command, args, {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({
          DOUYIN_DUTY_HOME: stateDir,
          DOUYIN_HOME: stateDir,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...(parallel ? { DOUYIN_PROFILE_KIND: 'chat', DOUYIN_RUNTIME_KIND: 'chat', IM_CDP_PORT: String(chatPort), DOUYIN_SEED_COOKIE: '1' } : {}),
        }),
      })
      const replyLogFile = join(stateDir, 'chat-reply.log')
      const wd = setTimeout(() => {
        try { chatReplyLog('回话超过 6 分钟 ⇒ 强制结束'); child.kill() } catch { /* 已经没了 */ }
      }, 6 * 60_000)
      wd.unref?.()
      const sink = (b) => { try { appendFileSync(replyLogFile, String(b), 'utf8') } catch { /* 日志写不进就算了 */ } }
      child.stdout?.on('data', sink)
      child.stderr?.on('data', sink)
      child.on('exit', (code) => {
        try { clearTimeout(wd) } catch { /* 无所谓 */ }
        chatReplyBusy = false
        chatReplyLog(`回话结束（code=${code}）`)
        cwWrite({ lastReplyAt: Date.now(), lastReplyResult: code === 0 ? 'done' : `exit_${code}` })
      })
      child.on('error', (e) => {
        chatReplyBusy = false
        chatReplyLog(`起不来：${e?.message ?? e}`)
        cwWrite({ lastReplyResult: 'error', lastError: String(e?.message ?? e).slice(0, 160) })
      })
      return true
    } catch (e) {
      chatReplyBusy = false
      chatReplyLog(`起不来：${e?.message ?? e}`)
      return false
    }
  }

  /**
   * ⭐ 「收工写日记」—— 2026-10-25 老大指定：日记写在**当天刷视频结束**的时候，
   *    什么算结束？下面两条**满足其一**：
   *      ① 规定的时间段结束（到收工时间，默认 quietStart = 23:55）
   *      ② 今天该刷的数量刷完了（挑中条数 >= perDay）
   *    一天只写一次（diary-state.json 记住 day）。跨过零点还没写的，第二天开工前补上。
   */
  const diaryStateFile = join(stateDir, 'diary-state.json')
  let diaryBusy = false
  const diaryLog = (s) => chatWatchLog(`[收工] ${s}`)
  const hm2min = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
    return m ? ((Number(m[1]) % 24) * 60 + Math.min(59, Number(m[2]))) : -1
  }
  const dayBack = (n) => dayKey(new Date(Date.now() - n * 86400_000))
  const diaryPromptFor = (day, reason) => [
    `【收工写日记】今天（${day}）的刷视频结束了：${reason}。`,
    '现在只做一件事：把今天看到的、学到的、口味的变化写下来。',
    '',
    '🔴 不许：刷抖音 / 发任何消息 / 调 douyin_dm / douyin_comment_reply / douyin_share_card / douyin_run / douyin_im_read。',
    '✅ 只用 Read 读、用 Write 写本地文件。不要问问题，直接写。',
    '',
    '先读这些（有就读，没有就跳过）：',
    `  - ${join(stateDir, 'diary', day + '.md')}（今天已经写过就往下追加，别覆盖）`,
    `  - ${join(outDir, day + '.md')}（这一天的报告，挑中什么、分享了什么都在里面）`,
    `  - ${join(stateDir, 'tastes-inbox.jsonl')}（这一天的口味观察）`,
    `  - ${join(stateDir, 'portrait.md')}（现在的画像，可能还不存在）`,
    '',
    '⭐ 你现在的心情（写的时候别抹掉它，日记是你给自己看的）：',
    (() => { try { return moodPromptBlock(stateDir, { audience: 'solo' }) } catch { return '' } })(),
    '',
    '然后写：',
    `1) 日记写进 ${join(stateDir, 'diary', day + '.md')}：第一人称，3-8 行，像晚上躺下随手记的。写今天什么让你停住了、学到什么（知识 / 梗 / 手法都算）、口味有没有变、有没有哪条现在还想再看一眼。不复述数据（赞数、转发比），不写"今天完成了…"这种腔，不用破折号。开头一行写 # ${day}。
🔴 2026-10-28 老大说「画像和日记要总结的是**我自己的想法**，从**第一人称**的角度」⇒ 三条硬规矩：① 全篇用「我」，**不许出现「大肥鱼」「它」「该号」当主语**（第三人称一律改写成我）；② 不写「今天完成了/这一轮/总结如下」这种工作日志腔，只写当时的手感、心里那句话；③ 至少写一件**具体到某一帧、某一句评论**的事，并写出你当时的身体反应或情绪（手停住/鼻子一酸/想笑又有点难受）。`,
    `2) 画像：如果 ${join(stateDir, 'portrait.md')} 还不存在，或者今天你明显变了，就整篇重写它（第一人称，≤1500 字，小标题：我是谁 / 我喜欢什么 / 我看不上的 / 我最近在琢磨的 / 我看人的眼光 / 我跟老大相处的方式）。没变化就别动。  「⭐ 2026-10-28 老大要求」这是你写给自己的自述，不是别人给你写的介绍：每段都用「我」开头；别用「大肥鱼喜欢…」「该账号倾向于…」这种第三人称；别罗列标签（萌宠/搞笑/治愈），要写成「我一看就停住的是…」「我看不下去的是…」；可以写你怕的、烦的、还没想通的，别写成简历。`,
    '',
    '写完回一行：【收工】<日记的一句话概括>',
  ].join('\n')
  const runDayClose = (day, reason) => {
    if (diaryBusy || dutyRunning) return false
    try {
      const dsh = resolveDsh()
      const overlay = ensureOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(diaryPromptFor(day, reason))
      diaryBusy = true
      writeJson(diaryStateFile, { day, at: Date.now(), why: reason, status: 'running' })
      diaryLog(`收工写日记（${day}：${reason}）`)
      const child = spawn(dsh.command, args, {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({ DOUYIN_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
      })
      const logFile = join(stateDir, 'diary.log')
      const wd = setTimeout(() => {
        try { diaryLog('写日记超过 8 分钟 ⇒ 强制结束'); child.kill() } catch { /* 已经没了 */ }
      }, 8 * 60_000)
      wd.unref?.()
      const sink = (b) => { try { appendFileSync(logFile, String(b), 'utf8') } catch { /* 写不进就算了 */ } }
      child.stdout?.on('data', sink)
      child.stderr?.on('data', sink)
      child.on('exit', (code) => {
        try { clearTimeout(wd) } catch { /* 无所谓 */ }
        diaryBusy = false
        const prev = readJson(diaryStateFile, {})
        writeJson(diaryStateFile, { ...prev, day, at: Date.now(), why: reason, status: code === 0 ? 'done' : `exit_${code}` })
        diaryLog(`收工写完（code=${code}）`)
      })
      child.on('error', (e) => {
        diaryBusy = false
        writeJson(diaryStateFile, {})
        diaryLog(`起不来：${e?.message ?? e}`)
      })
      return true
    } catch (e) {
      diaryBusy = false
      try { writeJson(diaryStateFile, {}) } catch { /* 无所谓 */ }
      diaryLog(`起不来：${e?.message ?? e}`)
      return false
    }
  }
  const dayCloseTick = () => {
    if (diaryBusy || dutyRunning) return
    refreshCfg()
    const today = dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const qs = hm2min(cfg.quietStart ?? '23:55')
    const qe = hm2min(cfg.quietEnd ?? '08:00')
    const st = readJson(diaryStateFile, {})
    if (st.day === today) return
    const quota = Math.max(0, Number(cfg.perDay ?? 0) || 0)
    const picked = countPickedToday()
    const quotaDone = quota > 0 && picked >= quota
    const windowDone = qs > 0 && mins >= qs
    if (quotaDone || windowDone) {
      runDayClose(today, quotaDone ? '今天该刷的刷完了' : '到收工时间了，今天的窗口结束')
      return
    }
    // 昨天没写：零点之后、开工之前补一次
    if (qe > 0 && mins < qe) {
      const y = dayBack(1)
      if (st.day === y) return
      const ySt = readJson(dutyStateFile, {})
      const yRounds = ySt.day === y ? Number(ySt.count || 0) : 0
      if (yRounds > 0 && !existsSync(join(stateDir, 'diary', y + '.md'))) runDayClose(y, '昨天收工时没来得及写，补上')
    }
  }

  /**
   * ⭐ 记忆整理（2026-10-27 老大要求：「记忆点太差，问它昨天我答应了什么答不上来」）
   *
   * 原始消息迟早会被平台翻页吃掉（`im-http --read` 一次只回最近 20 条），
   * 所以每天让模型把「按天时间线」浓缩成一份长期档案 `memory/notes-<sec>.md`：
   *   他是什么人 / 约定与答应过的事（带日期）/ 最近在忙什么 / 没说完的事。
   * 回话时 chatReplyPrompt 会把这份档案 + 最近三天时间线一起塞进去。
   */
  const notesStateFile = join(stateDir, 'notes-state.json')
  let notesBusy = false
  const notesLog = (s) => chatWatchLog(`[记忆] ${s}`)
  const notesPromptFor = (secUid, who, why) => {
    const np = notesPath(stateDir, secUid)
    return [
      `【整理记忆】现在把跟${who}的记忆收拾一下（${why}）。只做这一件事。`,
      '',
      '🔴 不许：刷抖音 / 发任何消息 / 调 douyin_dm / douyin_comment_reply / douyin_share_card / douyin_run。',
      '✅ 只用 douyin_notes({ action: "read" }) 读，读完用 douyin_notes({ action: "save", text: "..." }) 写回整份档案。',
      '',
      `档案文件：${np}`,
      '',
      '怎么写：',
      '1) 先把 read 拿到的三样看完：现有档案（notes）、最近三天按天时间线（timeline）、记下的事实（facts）。',
      '2) 在**旧档案基础上**重写整份（旧内容没被推翻的就留着，别整段丢掉）。',
      '3) 必须有的小节（没有内容的小节可以省略）：',
      '   - `## 他是谁`：身份、习惯、在意什么、讨厌什么（只写他说过或明确做过的）。',
      '   - `## 约定与答应过的事`：⭐ 一行一件，**必须带日期**（如 `2026-10-26：他答应周末带我去看海`），',
      '     他答应我的、我答应他的都记；已经兑现的标 `（已兑现）`。这一节是老大最在意的。',
      '   - `## 最近在忙什么`：在工作/生活上的近况（带粗略日期）。',
      '   - `## 没说完的事 / 下次接着聊`：悬着的话题、他问过但我还没答的。',
      '4) 全文 ≤1200 字，短句，不要破折号「——」，不要总结腔（"总之""综上所述"）。',
      '5) 时间线里同一件事被他反复说，合并成一条，别重复记。',
      '',
      '写完回一行：【记忆】<这次最大的变化，一句话>',
    ].join('\n')
  }
  const runNotesDigest = (why) => {
    const secUid = String(cfg.dmToId || '').trim()
    if (!secUid) return false
    if (notesBusy || dutyRunning || chatReplyBusy) return false
    try {
      const dsh = resolveDsh()
      const overlay = ensureOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      const who = String(cfg.dmTo || '').trim() || String(cfg.ownerTitle ?? '老大').trim() || '老大'
      args.push(notesPromptFor(secUid, who, why))
      notesBusy = true
      writeJson(notesStateFile, { day: dayKey(), at: Date.now(), why, status: 'running' })
      notesLog(`开始整理（${why}）`)
      const child = spawn(dsh.command, args, {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({ DOUYIN_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
      })
      const logFile = join(stateDir, 'notes.log')
      const wd = setTimeout(() => {
        try { notesLog('整理超 6 分钟 ⇒ 强制结束'); child.kill() } catch { /* 已经没了 */ }
      }, 6 * 60_000)
      wd.unref?.()
      const sink = (b) => { try { appendFileSync(logFile, String(b), 'utf8') } catch { /* 写不进就算了 */ } }
      child.stdout?.on('data', sink)
      child.stderr?.on('data', sink)
      child.on('exit', (code) => {
        try { clearTimeout(wd) } catch { /* 无所谓 */ }
        notesBusy = false
        writeJson(notesStateFile, { day: dayKey(), at: Date.now(), why, status: code === 0 ? 'done' : `exit_${code}` })
        notesLog(`整理完（code=${code}）`)
      })
      child.on('error', (e) => {
        notesBusy = false
        writeJson(notesStateFile, {})
        notesLog(`起不来：${e?.message ?? e}`)
      })
      return true
    } catch (e) {
      notesBusy = false
      notesLog(`起不来：${e?.message ?? e}`)
      return false
    }
  }
  const notesTick = () => {
    if (notesBusy || dutyRunning || chatReplyBusy) return
    refreshCfg()
    if (cfg.notesDigest === false) return
    const secUid = String(cfg.dmToId || '').trim()
    if (!secUid) return
    const mem = loadDmMemory(stateDir, secUid)
    if (!mem || !Array.isArray(mem.messages) || !mem.messages.length) return
    const st = readJson(notesStateFile, {})
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const qs = hm2min(cfg.quietStart ?? '23:55')
    const today = dayKey()
    if (qs > 0 && mins >= qs && st.day !== today) { runNotesDigest('收工后整理今天的对话'); return }
    const last = Number(st.at || 0)
    const gap = Math.max(6, Number(cfg.notesGapMin || 0) || 0) * 3600_000
    if (!last || Date.now() - last >= gap) runNotesDigest('距上次整理已经很久了')
  }

  /**
   * ⭐ 自主生活（2026-10-27 老大要求）
   *
   * 原话：「我希望大肥鱼也有自己的生活逻辑，会觉得自己想休息、会在我不在或者我很久不回消息的时候想我，
   *        发出对应情况的情感语言，这一点一定是在大肥鱼自主的情况下进行，不能限制它做不做」。
   *
   * 做法：平时隔一段时间（默认 3 小时起）给它一次机会，**由它自己决定发不发、发什么**：
   *   - 想休息 / 想他 / 今天刷到什么想起他 / 单纯想找他说句话 —— 都可以发；
   *   - 也可以什么都不发（回【无事】）—— 那也算合格。
   * 只守两条底线：① 不打扰（刚聊过、夜间、正在刷视频同一时刻不插话）② 不发链接/不求互动。
   */
  const lifeStateFile = join(stateDir, 'life-state.json')
  let lifeBusy = false
  const lifeLog = (s) => chatWatchLog(`[生活] ${s}`)
  const lifePromptFor = (ctxLines) => {
    const name = String(cfg.ownerTitle ?? '老大').trim() || '老大'
    const who = String(cfg.dmTo || '').trim() || name
    return [
      `【你自己的时间】现在没人在跟你说话。这是你自己的一段生活，不是任务。`,
      '',
      // ⭐ 情绪内核（2026-10-28）：主动说话本来就是情绪驱动的，这里必须带上现在的心情
      (() => { try { return moodPromptBlock(stateDir, { audience: 'owner' }) } catch { return '' } })(),
      '',
      `刚过去的这些（只给你做个参照，别当成必须回的消息）：`,
      ctxLines || '（没什么特别的：他最后一条消息已经是很久以前了）',
      '',
      `现在**你来决定**：要不要主动跟${who}说句话？`,
      `   - 想说就说：想他了、刚看到个东西想起他、今天累/想休息、突然想撒个娇、想问他在干嘛。`,
      `   - 不想说就别说 —— 回一行【无事】就结束，这也是合格的选择（不是每次都得说话）。`,
      '',
      `如果决定说：`,
      `1. 用 douyin_dm({ to_id: "${String(cfg.dmToId || '').trim()}", text: "...", confirm: true }) 发一条（可以换行分 1-3 段短句）。`,
      `2. 语气是你自己，不是客服：短、口语、有情绪。🔴 不用破折号「——」，别写"提醒一下""顺便问下"这种机器句式。`,
      `3. **别发链接、别推视频、别求他回复** —— 这次是生活，不是工作。`,
      `4. 想配个表情包就配（sticker_key，approve 过的），但只在真合适时；不确定就不发。`,
      `5. 发完在 duty.log 记一句你说了什么、为什么想发。`,
      '',
      `最后回一行：【生活】<你干了什么 / 或者"无事">`,
    ].join('\n')
  }
  const runLifeTick = (ctxLines) => {
    if (lifeBusy || dutyRunning || chatReplyBusy || atMeBusy) return false
    const parallel = Boolean(dutyRunning) && ensureChatProfile()
    const chatPort = Number(cfg.chatCdpPort) || 9335
    try {
      const dsh = resolveDsh()
      const overlay = ensureChatOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(lifePromptFor(ctxLines))
      lifeBusy = true
      writeJson(lifeStateFile, { at: Date.now(), status: 'running' })
      lifeLog('给自己一次说话的机会（由它自己决定发不发）')
      const child = spawn(dsh.command, args, {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({
          DOUYIN_DUTY_HOME: stateDir,
          DOUYIN_HOME: stateDir,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...(parallel ? { DOUYIN_PROFILE_KIND: 'chat', DOUYIN_RUNTIME_KIND: 'chat', IM_CDP_PORT: String(chatPort), DOUYIN_SEED_COOKIE: '1' } : {}),
        }),
      })
      const logFile = join(stateDir, 'life.log')
      const wd = setTimeout(() => {
        try { lifeLog('超过 6 分钟 ⇒ 强制结束'); child.kill() } catch { /* 已经没了 */ }
      }, 6 * 60_000)
      wd.unref?.()
      const sink = (b) => { try { appendFileSync(logFile, String(b), 'utf8') } catch { /* 写不进就算了 */ } }
      child.stdout?.on('data', sink)
      child.stderr?.on('data', sink)
      child.on('exit', (code) => {
        try { clearTimeout(wd) } catch { /* 无所谓 */ }
        lifeBusy = false
        const prev = readJson(lifeStateFile, {})
        const today = dayKey()
        const sameDay = prev.day === today
        writeJson(lifeStateFile, {
          at: Date.now(), day: today,
          count: (sameDay ? Number(prev.count || 0) : 0) + 1,
          status: code === 0 ? 'done' : `exit_${code}`,
        })
        lifeLog(`结束（code=${code}）`)
      })
      child.on('error', (e) => { lifeBusy = false; lifeLog(`起不来：${e?.message ?? e}`) })
      return true
    } catch (e) {
      lifeBusy = false
      lifeLog(`起不来：${e?.message ?? e}`)
      return false
    }
  }
  const lifeTick = () => {
    if (lifeBusy || dutyRunning || chatReplyBusy || notesBusy) return
    refreshCfg()
    if (cfg.lifeTick === false) return
    const st = readJson(lifeStateFile, {})
    const today = dayKey()
    const maxPerDay = Math.max(0, Number(cfg.lifePerDay ?? 3) || 0)   // 0 = 不限
    if (maxPerDay > 0 && st.day === today && Number(st.count || 0) >= maxPerDay) return
    const gap = Math.max(30, Number(cfg.lifeGapMin ?? 180) || 180) * 60_000
    if (Date.now() - Number(st.at || 0) < gap) return
    // 不打扰：夜间 + 刚聊过（30 分钟内）
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const qs = hm2min(cfg.quietStart ?? '23:55')
    const qe = hm2min(cfg.quietEnd ?? '08:00')
    const inQuiet = qs > qe ? (mins >= qs || mins < qe) : (mins >= qs && mins < qe)
    if (inQuiet) return
    const toId = String(cfg.dmToId || '').trim()
    const mem = toId ? loadDmMemory(stateDir, toId) : null
    const lastMsg = mem && Array.isArray(mem.messages) && mem.messages.length ? mem.messages[mem.messages.length - 1] : null
    if (lastMsg) {
      const t = Date.parse(lastMsg.at)
      if (Number.isFinite(t) && Date.now() - t < 30 * 60_000) return   // 刚聊过，别插话
    }
    const ctx = []
    if (lastMsg) {
      const t = Date.parse(lastMsg.at)
      const hrs = Number.isFinite(t) ? Math.floor((Date.now() - t) / 3600_000) : null
      ctx.push(`他最后一条（${lastMsg.from === 'me' ? '我说的' : '他说的'}）：${String(lastMsg.text || '').slice(0, 120)}`)
      if (hrs !== null) ctx.push(hrs >= 1 ? `那是 ${hrs} 小时前了。` : '刚才还在聊。')
    }
    ctx.push('你现在没在刷视频，也没人在等你回话。')
    runLifeTick(ctx.join('\n'))
  }

  /**
   * ⭐ 2026-10-30 新增：**DOM 补读**。
   *    实测发现：`im-http.py` 的 IM 接口只回会话里最早那一页（20 条），
   *    一旦聊过 20 条，它永远返回同一批老消息 —— 老大今天早上发的 6 条，插件一条都没看见，
   *    所以"消息不回"根本不是它不想回，是**它没读到**。
   *    ⇒ 每隔 2 分钟用浏览器 DOM 补读一次（走 chrome-chat 独立 profile，不和刷视频抢），
   *      读到的新消息照样进回话队列。
   */
  let chatDomLastMs = 0
  let chatDomBusy = false
  const chatDomSync = async () => {
    if (chatDomBusy) return
    const now = Date.now()
    if (now - chatDomLastMs < 120_000) return
    chatDomLastMs = now
    chatDomBusy = true
    try {
      const to = String(cfg.dmTo || '').trim()
      if (!to) return
      const r = await runNodeToolAsync('im-send.mjs', ['--to', to, '--read'], {
        timeout: 240_000,
        extraEnv: {
          DOUYIN_PROFILE_KIND: 'chat', DOUYIN_RUNTIME_KIND: 'chat',
          IM_CDP_PORT: String(cfg.chatCdpPort || 9335), DOUYIN_SEED_COOKIE: '1',
        },
      })
      const j = pickJson(r.stdout)
      const msgs = Array.isArray(j && j.messages) ? j.messages : []
      if (!msgs.length) { chatWatchLog(`DOM 补读没拿到消息（${String(r.stderr || '').slice(0, 80)}）`); return }
      try { mergeDmMemory(stateDir, String(cfg.dmToId || ''), to, msgs) } catch { /* 记忆失败不影响 */ }
      chatRecent = msgs.slice(-10)
      const theirs = msgs.filter((m) => m.from === 'them' && m.at && m.at > (chatWatchLastSeenAt || ''))
      if (!theirs.length) return
      chatWatchLastSeenAt = theirs[theirs.length - 1].at
      if (cfg.chatAutoReply !== false) {
        chatPending.push(...theirs)
        chatPendingAt = Date.now()
        chatReplyLog(`DOM 补读到老大 ${theirs.length} 条新消息（最后一条：${String(theirs[theirs.length - 1].text || '').slice(0, 20)}）`)
      }
    } catch { /* 读不到就算了，下一拍再来 */ } finally { chatDomBusy = false }
  }

  const chatWatchTick = async () => {
    const nowMs = Date.now()
    const sec = Math.max(3, Math.min(Number(cfg.chatWatchSec || 30), 300))
    if (chatWatchBusy) return
    if (nowMs - chatWatchLastMs < sec * 1000) return
    chatWatchLastMs = nowMs
    chatWatchBusy = true
    try {
      refreshCfg()
      // ⭐ 回话队列：攒着的消息等 8 秒没有新的 ⇒ 起一轮去回（他连发好几条也只回一次；2026-10-25 从 20 秒压到 8 秒，老大嫌慢）
      if (cfg.chatAutoReply !== false && !chatReplyBusy && !dutyRunning && chatPending.length && Date.now() - chatPendingAt >= 4_000) {
        // ⚠️ 只有真的起成功才从队列里摘掉（起不来就留着，下一拍再试）
        const batch = chatPending.slice(0, 20)
        if (runChatReply(batch)) chatPending = chatPending.slice(batch.length)
      }
      if (!cfg.chatWatch) { cwWrite({ lastResult: 'off' }); return }
      const toId = String(cfg.dmToId || '').trim()
      if (!toId) { cwWrite({ lastResult: 'skip_no_to' }); return } // 身份铁闸要 sec_uid
      if (!hasCredential(stateDir)) { cwWrite({ lastResult: 'skip_no_login' }); return }
      const r = runPy('im-http.py', ['--read', '--peer-sec-uid', toId, '--limit', '8'], { timeout: 30_000 })
      const j = pickJson(r.stdout)
      cwState.checks += 1
      if (!j || !j.ok) {
        // 限流 / 接口挂 / Cookie 失效：记下来给面板看，静默等下一拍
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'error', lastError: String((j && j.error) || r.stderr || '没返回可解析结果').slice(0, 160) })
        return
      }
      if (!j.matched) {
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'no_match', lastNote: String(j.match_note || ''), lastError: '' })
        return
      }
      const msgs = Array.isArray(j.matched.messages) ? j.matched.messages : []
      chatRecent = msgs.slice(-10)
      // 合并进记忆（这样面板/值班轮打开就能看到，不会"刚读到却说没聊过"）
      try { mergeDmMemory(stateDir, toId, cfg.dmTo || j.matched.nickname || '', msgs) } catch { /* 记忆失败不影响盯梢 */ }
      const theirs = msgs.filter((m) => m.from === 'them' && m.at && m.at > chatWatchLastSeenAt)
      // 第一拍只「对表」：以最新一条为基准，不把历史消息重播一遍
      if (!chatWatchPrimed) {
        chatWatchPrimed = true
        const newestTheirs = msgs.filter((m) => m.from === 'them' && m.at)
        chatWatchLastSeenAt = newestTheirs.length ? newestTheirs[newestTheirs.length - 1].at : ''
        // ⭐ 2026-10-25：接上班时如果**最后一条是老大、而且我们还没回过**，别静默丢掉。
        //    实测踩过：老大 05:12 发「我刚睡醒」，宿主 05:43 重启后 prime 直接把基准推过去，
        //    那条永远没人回 —— 用户第二天问"为什么不回我私信"。
        const last = msgs[msgs.length - 1]
        const myLastAt = (msgs.filter((m) => m.from === 'me' && m.at).pop() || {}).at || ''
        const fresh = last && last.at && Date.now() - Date.parse(last.at) < 12 * 3600_000
        if (cfg.chatAutoReply !== false && last && last.from === 'them' && last.at > myLastAt && fresh) {
          chatPending.push(last)
          chatPendingAt = Date.now()
          chatReplyLog(`接上班发现老大最后一条还没回（${String(last.text || '').slice(0, 20)}），进回话队列`)
        }
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'ok_prime', lastError: '' })
        chatWatchLog(`已接上班（基准 = ${chatWatchLastSeenAt || '无对方消息'}，之前的不重播）`)
        return
      }
      if (!theirs.length) {
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'ok', lastError: '' })
        // ⭐ HTTP 那条读到的是会话最早一页，聊过 20 条之后永远看不到新消息 ⇒ 顺手用 DOM 补读
        try { void chatDomSync() } catch { /* 忽略 */ }
        return
      }
      // 基准推进：插件只负责「看见 + 提醒」；回话由 AI 值班（常驻会话）做，
      // 它有自己的读取基准，不和这里的混淆。
      chatWatchLastSeenAt = theirs[theirs.length - 1].at
      // ⭐ 自动回话（2026-10-25）：把新消息放进队列，20 秒后没新的就起一轮去回
      if (cfg.chatAutoReply !== false) {
        chatPending.push(...theirs)
        chatPendingAt = Date.now()
        chatReplyLog(`收到 ${theirs.length} 条新消息，进回话队列（${chatPending.length} 条待回）`)
      }
      /* ⭐ 情绪内核（2026-10-28）：老大来了 —— 最能改心情的事件，先记上 */
      try {
        const lastTxt = String(theirs[theirs.length - 1].text || '').slice(0, 20)
        moodFeel(stateDir, 'owner.came', {
          note: theirs.length > 1 ? `一下来了 ${theirs.length} 条` : `「${lastTxt}」`,
          strength: Math.min(1.4, 0.9 + theirs.length * 0.1),
        })
      } catch (e) { chatReplyLog('情绪记录失败（不影响回话）：' + (e?.message ?? e)) }
      cwState.notified += theirs.length
      const head = theirs[0].text.slice(0, 60)
      chatWatchLog(`新消息 ${theirs.length} 条（${cfg.dmTo || toId}）：${head}`)
      // 通知：2026-10-24 使用者要求「不用弹这种通知」⇒ 聊天模式**不弹** Windows 通知，
      //    只写日志 + 状态屏（回话由 AI 值班做，本来也不需要桌面通知提醒人）。
      //    webhook 仍按配置走（有人拿它接手机推送，不在这条指令范围内）。
      let toastState = 'off（使用者 2026-10-24 关的：聊天模式不弹通知）'
      const mode = String(cfg.notifyMode || 'toast')
      if (mode === 'webhook' || mode === 'both') {
        sendWebhook({ url: cfg.webhookUrl, preset: cfg.webhookPreset, title: `${cfg.dmTo || '私信'} 来消息了`, markdown: theirs.map((m) => `- ${m.text.slice(0, 100)}`).join('\n') }).catch(() => { /* webhook 失败不影响 */ })
      }
      cwWrite({ lastCheckAt: Date.now(), lastResult: 'ok_new', lastError: '', lastNewAt: theirs[theirs.length - 1].at, lastNewText: theirs[theirs.length - 1].text.slice(0, 40), toast: toastState })
    } catch (e) {
      chatWatchLog(`这一拍出错（已兜住）：${e?.message ?? e}`)
      cwWrite({ lastCheckAt: Date.now(), lastResult: 'error', lastError: String(e?.message ?? e).slice(0, 160) })
    } finally {
      chatWatchBusy = false
    }
  }

  /* ─────────────── 评论区 @ 我 → 去评论区回（2026-10-26 老大要求）───────────────
   *
   * 老大的原话（2026-10-26）：「我在评论区@大肥鱼时她也要来评论区回复我」
   *
   * 为什么单独做一套：私信那套（chatWatchTick）只读**私信**；评论区的 @ 走的是通知接口
   * （tools/notice-read.py，type 45/46 = @ 我，31/32 = 回复了我），两批数据完全不相干。
   *
   * 🔴 只在**老大本人的 @** 上自动回：评论区的陌生人可能是钓鱼/引流，自动回会给自己惹事；
   *    而且在养号期，对外动作额度比回一句话值钱。老大想放开再说。
   */
  const atmeStateFile = join(stateDir, 'atme-state.json')
  const atMeLog = (s) => {
    try { appendFileSync(join(stateDir, 'at-me.log'), `[${new Date().toISOString()}] ${s}\n`, 'utf8') } catch { /* 日志失败不影响主流程 */ }
  }
  let atMeBusy = false
  let atMeLastAt = 0
  const atMeLoad = () => {
    try { return readJson(atmeStateFile, {}) || {} } catch { return {} }
  }
  const atMeMark = (cid) => {
    try {
      const st = atMeLoad()
      const handled = Array.isArray(st.handled) ? st.handled : []
      if (!handled.includes(String(cid))) handled.push(String(cid))
      writeFileSync(atmeStateFile, JSON.stringify({ ...st, handled: handled.slice(-500), updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* 记不下来最多回两遍，不致命 */ }
  }

  const atMePrompt = (it) => {
    const name = String(cfg.ownerTitle ?? '老大').trim() || '老大'
    const lines = []
    lines.push(`【评论区回话】${name}在评论区 @ 你了（你是大肥鱼，正在用这个小号刷抖音）。`)
    if (it.content) lines.push(`他那条说的是：「${it.content}」`)
    if (it.aweme_id) lines.push(`视频：https://www.douyin.com/video/${it.aweme_id}`)
    lines.push('')
    // ⭐ 情绪内核（2026-10-28）：公开场合要收着，但仍有自己的心情
    try { lines.push(moodPromptBlock(stateDir, { audience: 'public' })) } catch { /* 情绪读不出来不影响回话 */ }
    lines.push('')
    lines.push('做法：')
    lines.push(`1. 先 douyin_comments({ aweme_id: "${it.aweme_id}" }) 看这条视频的 video.desc / author / tags，`)
    lines.push('   以及他这句话在楼里的上下文。**跟视频内容有关就顺着视频说**，别装懂、也别答非所问。')
    lines.push('2. 想清楚怎么回：像真人刷到被 @ 时那样接话，有态度、有自己的看法，别客套、别客服腔。')
    lines.push('   🔴 **别当捧哏**：同意就说同意在哪；不同意就把不同意见说出来；拿不准就问一句。别为了顺他改口，也别抬杠。')
    lines.push('3. 用 douyin_comment_reply 直接回他（**有 comment_id 就用 mode:"api"**，别用 @ 回人）：')
    lines.push(`   douyin_comment_reply({ aweme_id: "${it.aweme_id}", comment_id: "${it.comment_id}",${it.root_comment_id ? ` root_comment_id: "${it.root_comment_id}",` : ''} mode: "api", text: "...", confirm: true })`)
    lines.push(`   - ≤80 字，一两句就够；称呼「${name}」可有可无（这是他自己评论区，别每句都喊）。`)
    lines.push('   - 🔴 别用破折号；别连着追第二条；别加话题标签。')
    lines.push('4. 最后在 duty.log 里写一句「在评论区回了谁、回了什么」。')
    lines.push('')
    lines.push('⚠️ 只回这一条，别刷视频、别分享、别改配置。')
    return lines.join('\n')
  }

  const runAtMeReply = (it) => {
    if (atMeBusy) return false
    if (chatReplyBusy) return false
    try {
      const dsh = resolveDsh()
      const overlay = ensureChatOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(atMePrompt(it))
      /**
       * ⭐ 2026-10-26：刷视频轮在跑时也用**回话专用 profile**（chrome-chat + 独立端口），
       *    否则两边抢同一个 chrome-profile ⇒ 回评论也要排到那一轮结束（老大嫌慢）。
       */
      const parallel = Boolean(dutyRunning) && ensureChatProfile()
      const chatPort = Number(cfg.chatCdpPort) || 9335
      atMeBusy = true
      atMeLastAt = Date.now()
      const child = spawn(dsh.command, args, {
        cwd: stateDir,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv({
          DOUYIN_DUTY_HOME: stateDir,
          DOUYIN_HOME: stateDir,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
          ...(parallel ? { DOUYIN_PROFILE_KIND: 'chat', DOUYIN_RUNTIME_KIND: 'chat', IM_CDP_PORT: String(chatPort), DOUYIN_SEED_COOKIE: '1' } : {}),
        }),
      })
      let buf = ''
      child.stdout.on('data', (d) => { buf += String(d) })
      child.stderr.on('data', (d) => { buf += String(d) })
      const keep = setTimeout(() => { try { child.kill() } catch { /* 已经退出 */ } }, 6 * 60_000)
      keep.unref?.()
      child.on('close', (code) => {
        clearTimeout(keep)
        atMeBusy = false
        atMeMark(it.comment_id)
        atMeLog(`回完（exit ${code}）cid=${it.comment_id}：${buf.trim().split('\n').slice(-4).join(' / ').slice(0, 400)}`)
        try { appendFileSync(join(stateDir, 'duty.log'), `[${new Date().toISOString()}] 评论区回话 cid=${it.comment_id} exit=${code}\n`, 'utf8') } catch { /* 日志失败不影响 */ }
      })
      child.on('error', (e) => { clearTimeout(keep); atMeBusy = false; atMeLog(`起不来：${e?.message ?? e}`) })
      atMeLog(`开始回：${it.nickname || it.uid || ''}「${String(it.content || '').slice(0, 40)}」cid=${it.comment_id}`)
      return true
    } catch (e) {
      atMeBusy = false
      atMeLog(`出错：${e?.message ?? e}`)
      return false
    }
  }

  const atMeTick = () => {
    try { refreshCfg() } catch { /* 读配置失败就沿用旧的 */ }
    if (cfg.atMeAutoReply === false) return
    if (atMeBusy || dutyRunning || chatReplyBusy) return
    // 读通知本身也要 30-60 秒，别太勤
    if (Date.now() - atMeLastAt < 90_000) return
    atMeLastAt = Date.now()
    let r = null
    try { r = readAtMe({ limit: 8, include_seen: false }) } catch (e) { atMeLog(`读通知失败：${e?.message ?? e}`); return }
    if (!r || !r.ok || !Array.isArray(r.list) || !r.list.length) return
    const ownerUid = String(cfg.ownerUid || '').trim()
    const st = atMeLoad()
    const handled = Array.isArray(st.handled) ? st.handled : []
    /**
     * 🔴 2026-10-26 实测踩到的坑：第一次挂载时，通知接口会把**历史 @ / 回复**照样返回
     *    （比如 10-25 老大那句「哈哈哈」，其实当天早上已经回过 cid 7700760049551229715）。
     *    如果直接按「没在 handled 里就回」的规则，就会**重复回一遍**。
     *    ⇒ 首次运行先把现有通知全部登记为已处理（bootstrap），只回**之后新来的**。
     */
    if (!st.bootstrapped) {
      const seed = r.list.map((x) => String(x.comment_id || '')).filter(Boolean)
      try {
        writeFileSync(atmeStateFile, JSON.stringify({
          handled: seed.slice(-500), bootstrapped: true, bootstrappedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, null, 2), 'utf8')
      } catch { /* 写不进去就靠下面 12 小时的新鲜度判断兜底 */ }
      atMeLog(`首次挂载：现有 ${seed.length} 条通知登记为已处理，只回之后新来的`)
      return
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const fresh = r.list.filter((x) => {
      const t = Number(x && x.created_at) || 0
      return !t || nowSec - t < 12 * 3600        // 超过 12 小时的老通知不回（早过时了，回了反而怪）
    })
    const mine = fresh.find((x) => x && x.comment_id && !handled.includes(String(x.comment_id))
      && (!ownerUid || String(x.uid || '') === ownerUid)
      /**
       * 🔴 2026-10-28：必须确认「这条是冲我来的」（to_me）。
       *   否则老大在楼里回复别人时也会命中原规则 ⇒ 大肥鱼插进别人的对话。
       */
      && (x.to_me !== false))
    if (!mine) {
      const skipped = fresh.filter((x) => x && x.to_me === false).length
      atMeLog(`这次 ${r.list.length} 条（12 小时内 ${fresh.length} 条），没有该回的老大的 @（ownerUid=${ownerUid || '未设'}${skipped ? `；其中 ${skipped} 条是在跟别人说话，不插嘴` : ''}）`)
      return
    }
    if (!mine.aweme_id) { atMeLog(`缺 aweme_id，跳过 cid=${mine.comment_id}`); return }
    runAtMeReply(mine)
  }
  try {
    const cw = setInterval(() => { chatWatchTick() }, 5_000)   // 5 秒醒一次看「到没到点」，真正读的频率由 chatWatchSec 决定
  // 收工写日记：一分钟查一次「今天收工了没」（到点 / 额度刷完），一天只写一次
  const dc = setInterval(() => { try { dayCloseTick() } catch (e) { diaryLog(`收工检查出错：${e?.message ?? e}`) } }, 60_000)
    const at = setInterval(() => { try { atMeTick() } catch (e) { atMeLog(`这一拍出错（已兜住）：${e?.message ?? e}`) } }, 90_000)
  // 记忆整理：半小时查一次「该不该把对话浓缩成长期档案（notes-<sec>.md）」
  const nt = setInterval(() => { try { notesTick() } catch (e) { notesLog(`整理检查出错：${e?.message ?? e}`) } }, 30 * 60_000)
  // 自主生活：10 分钟看一次「它这会儿想不想说话」——发不发、发什么由它自己定（老大要求不限制）
  const lt = setInterval(() => { try { lifeTick() } catch (e) { lifeLog(`这一拍出错（已兜住）：${e?.message ?? e}`) } }, 10 * 60_000)
    cw.unref?.()
    at.unref?.()
    nt.unref?.()
    lt.unref?.()
    ctx.effect(() => () => clearInterval(cw), 'douyin-duty: 聊天盯梢')
  ctx.effect(() => () => clearInterval(dc), 'douyin-duty: 收工写日记')
    ctx.effect(() => () => clearInterval(at), 'douyin-duty: 评论区 @ 盯梢')
  ctx.effect(() => () => clearInterval(nt), 'douyin-duty: 记忆整理')
  ctx.effect(() => () => clearInterval(lt), 'douyin-duty: 自主生活')
  } catch (e) { log(`聊天盯梢没起来：${e?.message ?? e}`) }

  /* ─────────────── 健康信号 ─────────────── */
  const healthFile = join(stateDir, 'health.json')
  const writeHealth = () => {
    try {
      const st = rollDay()
      const alerts = []
      if (!venvReadyNow()) alerts.push('venv_missing: 没装运行环境（设置页点「装主依赖」）')
      if (!hasCredential(stateDir)) alerts.push('cred_missing: 还没登录（设置页扫码，或粘一条 Cookie）')
      if (dutyRunning && st.dutyRunningAt && Date.now() - Number(st.dutyRunningAt) > 20 * 60_000) {
        alerts.push(`duty_slow: 当前轮已经跑了 ${Math.round((Date.now() - Number(st.dutyRunningAt)) / 60_000)} 分钟还没结束`)
      }
      writeFileSync(healthFile, JSON.stringify({
        ts: new Date().toISOString(),
        plugin: myVersion(),
        peakValley: cfg.peakValley,
        dutyRunning,
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        pickedToday: countPickedToday(),
        perDay: Number(cfg.perDay || 0),
        loggedIn: hasCredential(stateDir),
        venvReady: venvReadyNow(),
        alerts,
      }, null, 2), 'utf8')
    } catch { /* 健康文件写不进去也不能出事 */ }
  }
  writeHealth()
  try {
    const ht = setInterval(writeHealth, 90_000)
    ht.unref?.()
    ctx.effect(() => () => clearInterval(ht), 'douyin-duty: 健康信号')
  } catch { /* 起不来就算了 */ }

  /* ─────────────── HTTP（设置页用） ─────────────── */
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  /* ─────────────── 检查更新 ───────────────
   * 🔴 三条设计约束：
   *   ① **不能拖慢面板**：走异步 fetch + 3 秒超时，查不到就报"查不到"，绝不让设置页转圈。
   *   ② **不写死仓库地址**：发布者可能换 GitHub 用户名、也可能只发 npm ⇒ 按下面顺序自己找。
   *   ③ **不自动升级**：只告诉有没有新版本 + 怎么升。装插件是使用者的事（改 profile 是他的机器）。
   *   查过的结果落 `<家>/update.json`，10 分钟内不重复打网络（面板会反复渲染）。
   */
  const updateFile = join(stateDir, 'update.json')
  let updateCache = null
  const cmpVer = (a, b) => {
    const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
    const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x !== y) return x > y ? 1 : -1
    }
    return 0
  }
  const pkgMeta = () => {
    try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) } catch { return {} }
  }
  /** 从 package.json 的 repository 里掏出 owner/repo（支持字符串和对象两种写法） */
  const repoSlug = () => {
    const r = pkgMeta().repository
    const url = typeof r === 'string' ? r : (r && r.url) || ''
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(String(url))
    return m ? `${m[1]}/${m[2]}` : ''
  }
  const fetchJson = async (url, timeoutMs = 3000) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, json: await res.json() }
    } catch (e) {
      return { ok: false, error: String(e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? e)).slice(0, 160) }
    } finally { clearTimeout(timer) }
  }
  /**
   * 查一次最新版本。没网/没发布都不算错，返回 checked:false + 为什么。
   * @param {boolean} force 忽略 10 分钟缓存
   */
  const checkUpdate = async (force = false) => {
    const cur = myVersion()
    const explicit = String(cfg.updateUrl || '').trim()
    // ⚠️ 缓存必须带**来源指纹**：改了「更新地址」还拿旧缓存，用户会以为新地址没生效
    //    （2026-10-22 实测踩过：把 updateUrl 指到本地假服务，面板还显示旧结果）
    const sig = `${cur}|${explicit}`
    const cached = readJson(updateFile, null)
    const fresh = (o) => o && Date.now() - Number(o.at || 0) < 600_000 && o.sig === sig
    if (!force && fresh(updateCache)) return { ...updateCache, cached: true }
    if (!force && fresh(cached)) return { ...cached, cached: true }
    const meta = pkgMeta()
    const name = String(meta.name || 'dsh-douyin-scroll')
    const sources = []
    if (explicit) sources.push({ kind: 'url', name: '自定义地址', url: explicit })
    sources.push({ kind: 'npm', name: 'npm registry', url: `https://registry.npmjs.org/${encodeURIComponent(name)}/latest` })
    const slug = repoSlug()
    if (slug) {
      for (const br of ['main', 'master']) {
        sources.push({ kind: 'github', name: `GitHub ${slug}@${br}`, url: `https://raw.githubusercontent.com/${slug}/${br}/package.json` })
      }
    }
    const tried = []
    let latest = ''
    let from = ''
    for (const s of sources) {
      const r = await fetchJson(s.url)
      if (r.ok && r.json && r.json.version) {
        latest = String(r.json.version)
        from = s.name
        tried.push({ source: s.name, ok: true, version: latest })
        break
      }
      tried.push({ source: s.name, ok: false, error: r.error || '没有 version 字段' })
    }
    const out = {
      ok: true,
      current: cur,
      latest: latest || '',
      source: from,
      checked: Boolean(latest),
      hasUpdate: Boolean(latest) && cmpVer(latest, cur) > 0,
      tried,
      sig,
      at: Date.now(),
      // 升级怎么做——别让使用者猜
      how: latest && cmpVer(latest, cur) > 0
        ? `dsh plugin --profile <你的profile> add ${name}@${latest}  然后重启 dsh`
        : '',
      note: latest ? '' : `查不到最新版本（试了 ${sources.length} 个来源）。插件可能还没发布到 npm / GitHub，或者这台机器连不上外网 —— 可以在设置里填「更新地址」。`,
    }
    updateCache = out
    try { writeJson(updateFile, out) } catch { /* 写不进去不影响 */ }
    log(`检查更新：当前 ${cur} / 最新 ${latest || '(查不到)'}${from ? '（' + from + '）' : ''}`)
    return out
  }

  const status = () => {
    refreshCfg()
    const st = rollDay()
    const today = dayKey()
    const tail = (f) => { try { return readFileSync(f, 'utf8').slice(-1400) } catch { return '' } }
    const cred = credentialInfo(stateDir)
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      windows: WINDOWS,
      today,
      ranToday: st.day === today ? Number(st.count || 0) : 0,
      pickedToday: countPickedToday(),
      perDay: Number(cfg.perDay || 0),
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: cred.hasCredential,
      hasCredential: cred.hasCredential,
      keys: cred.important.length ? cred.important : cred.keys.slice(0, 8),
      /** ⭐ 登录的是哪个号（扫码/体检时记下来的；没有就 null） */
      account: readJson(join(stateDir, 'account.json'), null),
      venvReady: venvReadyNow(),
      installing,
      installLog: installLogFile,
      installTail: tail(installLogFile),
      report: reportFileOf(new Date()),
      version: myVersion(),
      cookieFile: cookiePath(stateDir),
      /** ⭐ v0.3.9 降风险控当前状态（熔断/夜间/配额/养号），面板据此显示并提供「恢复」按钮 */
      ratelimit: rateStatus(stateDir, rateOpts()),
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/douyin-duty/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && path === '/api/douyin-duty/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home: stateDir })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of Object.keys(DEFAULTS)) if (k in body) patch[k] = body[k]
      const { clean, host } = await persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: cfg, host })
    }
    /**
     * ⭐ 「现在跑一轮」
     * 🔴 2026-10-22 修：以前不管有没有真跑起来都返回 `ok: true`。
     *    runDuty 可能因为「配额满了 / 上一轮还在跑 / 别的」直接拒绝，
     *    面板却显示"已经开跑了" —— 使用者等半天没消息，以为点了没反应。
     *    现在：**只有真的起来了才 ok:true**，否则把原因原样带回去。
     */
    if (req.method === 'POST' && path === '/api/douyin-duty/run') {
      const r = runDuty('manual')
      const started = r && r.started === true
      return sendJson(res, 200, {
        ...r,
        ok: started,
        // 给面板一句人话
        message: started
          ? (r.note || '已经开跑了，跑完会弹通知')
          : (r.error || r.hint || '这次没跑起来'),
      })
    }

    /* ── 检查更新 ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/update') {
      const force = String(url.searchParams.get('force') || '') === '1'
      return sendJson(res, 200, await checkUpdate(force))
    }

    /* ── 当前账号：面板显示"登录的哪个号" ──
     * 先给缓存（account.json），再后台刷新一次（慢，但准）。
     * 拿不到就说拿不到，别编一个昵称出来。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/account') {
      const cached = readJson(join(stateDir, 'account.json'), null)
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: true, logged_in: false, account: null })
      const force = String(url.searchParams.get('refresh') || '') === '1'
      // 有缓存且不超过 1 小时、又不是强制刷新 ⇒ 直接给缓存（面板打开时别卡 10 秒）
      if (!force && cached && Date.now() - Number(new Date(cached.at).getTime() || 0) < 3600_000) {
        return sendJson(res, 200, { ok: true, logged_in: true, account: cached, cached: true })
      }
      try {
        const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
        const j = pickJson(g.stdout)
        if (!j) return sendJson(res, 200, { ok: false, logged_in: true, account: cached, error: '体检脚本没返回结果' })
        const acc = { nick: j.nick || '', uid: j.uid || '', alive: j.alive === true, at: new Date().toISOString() }
        try { writeJson(join(stateDir, 'account.json'), acc) } catch { /* 写不进去也能用 */ }
        return sendJson(res, 200, { ok: true, logged_in: true, account: acc, cached: false })
      } catch (e) {
        return sendJson(res, 200, { ok: false, logged_in: true, account: cached, error: String(e?.message ?? e) })
      }
    }

    /* ── ⭐ 聊天模式：实时状态（面板每 15 秒拉一次，显示「它现在在干嘛」） ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/chat/watch') {
      const s = readJson(join(stateDir, 'chat-watch-state.json'), {})
      return sendJson(res, 200, { ok: true, ...s, now: Date.now() })
    }

    /* ── ⭐ 收件箱：评论区 @ 我 + 谁私信我（面板「消息」用的） ──
     * 一次把两件事都读了，面板只调一次。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/inbox') {
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: false, error: '还没登录', at: [], dm: [] })
      const out = { ok: true, at: [], dm: [], at_n: 0, dm_n: 0, errors: [] }

      // ① 评论区 @ 我
      try {
        const r = readAtMe({ limit: 20, include_seen: false })
        if (r && r.ok) { out.at = r.list || []; out.at_n = r.at_n || 0 }
        else out.errors.push('评论区 @：' + ((r && (r.error || r.hint)) || '读不到'))
      } catch (e) { out.errors.push('评论区 @：' + String(e?.message ?? e)) }

      /**
       * ② "谁私信我"：读**会话列表**（不是打开某个会话）。
       *    抖音的会话列表只有「最近聊过的人 + 最后一句话」，没有"未读"标记可用，
       *    所以这里如实说：列出最近跟我聊过的人 + 他最后说了什么 + 是不是他说的。
       */
      try {
        const r = runNodeTool('im-send.mjs', ['--list'], { timeout: 180_000 })
        const j = pickJson(r.stdout)
        if (j && j.ok) {
          const list = Array.isArray(j.people) ? j.people : []
          // 给每个人补上"最后一句是谁说的"（有记忆才知道）
          out.dm = list.map((p) => {
            let mem = null
            try { mem = p.sec_uid ? loadDmMemory(stateDir, p.sec_uid) : null } catch { mem = null }
            const last = mem && mem.messages.length ? mem.messages[mem.messages.length - 1] : null
            const lastTheirs = mem ? [...mem.messages].reverse().find((m) => m.from === 'them') : null
            return {
              nick: p.nick,
              sec_uid: p.sec_uid,
              preview: p.preview,
              duplicate: p.duplicate,
              /** 我们以前聊过几条（没聊过 = 0） */
              remembered: mem ? mem.messages.length : 0,
              /** 他最后说的一句（记忆里能找到的话） */
              their_last: lastTheirs ? { text: lastTheirs.text, at: lastTheirs.at } : null,
              /** 最后一条是谁说的 —— 判断"是不是该我回了" */
              last_from: last ? last.from : null,
              /** ⭐ 要不要回：他最后说的，比我说得晚 ⇒ 该回了 */
              needs_reply: Boolean(lastTheirs && (!last || last.from === 'them')),
            }
          })
          out.dm_n = out.dm.filter((x) => x.needs_reply).length
        } else out.errors.push('私信列表：' + ((j && (j.error || j.hint)) || '读不到'))
      } catch (e) { out.errors.push('私信列表：' + String(e?.message ?? e)) }

      return sendJson(res, 200, out)
    }

    /* ── ⭐ 聊天模式：读某个人的完整上下文（面板「跟他聊」用） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/chat/read') {
      const body = await readBody(req)
      const toId = String(body?.to_id || cfg.dmToId || '').trim()
      const to = String(body?.to || cfg.dmTo || '').trim()
      if (!toId && !to) return sendJson(res, 200, { ok: false, error: '不知道读谁的会话' })
      /**
       * ⭐ 快路径（2026-10-24）：有 to_id 就先走 HTTP（im-http.py，~1.1 秒、不启浏览器、
       *    身份铁闸=sec_uid 反查核验）。命不中（陌生人/接口挂）再退回浏览器路径。
       *    和 douyin_im_read 工具同一套双路径。
       */
      if (toId) {
        try {
          const r0 = runPy('im-http.py', ['--read', '--peer-sec-uid', toId, '--limit', '40'], { timeout: 30_000 })
          const h = pickJson(r0.stdout)
          if (h && h.ok && h.matched) {
            const msgs = Array.isArray(h.matched.messages) ? h.matched.messages : []
            let context = null
            try {
              mergeDmMemory(stateDir, toId, to || h.matched.nickname || '', msgs)
              context = dmContext(stateDir, toId, { recent: 20 })
            } catch { /* 记忆失败不影响读 */ }
            log(`chat/read(HTTP) ${h.matched.nickname || toId}: ${msgs.length} 条，${h.ms}ms`)
            return sendJson(res, 200, {
              ok: true, via: 'http', to: to || h.matched.nickname, to_sec_uid: toId,
              count: msgs.length,
              mine: msgs.filter((m) => m.from === 'me').length,
              them: msgs.filter((m) => m.from === 'them').length,
              unknown: 0,
              messages: msgs.slice(-40),
              context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
            })
          }
        } catch { /* 快路径失败 → 下面走浏览器 */ }
      }
      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return sendJson(res, 200, { ok: false, error: '读不到会话', detail: String(r.stderr || r.stdout || '').slice(-400) })
      if (!j.ok) return sendJson(res, 200, j)
      // 合并进记忆 + 取上下文
      let context = null
      try {
        const secUid = String(j.to_sec_uid || toId || '').trim()
        if (secUid) {
          /**
           * ⚠️ 顺序很重要：**先合并、再取上下文**。
           *    以前是先取 context 再 merge ⇒ 第一次读某个人的会话时，
           *    context 永远是空的（"这个人以前没聊过"），
           *    但其实这一下刚读到 11 条 —— 等于刚认识就说"我不认识你"。
           */
          mergeDmMemory(stateDir, secUid, j.to || to, Array.isArray(j.messages) ? j.messages : [])
          context = dmContext(stateDir, secUid, { recent: 20 })
        }
      } catch { /* 记忆失败不影响读 */ }
      return sendJson(res, 200, {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid,
        count: j.count, mine: j.mine, them: j.them, unknown: j.unknown,
        messages: Array.isArray(j.messages) ? j.messages.slice(-40) : [],
        context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
      })
    }

    /* ── ⭐ 聊天模式：发一条（带记忆，确认后才发） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/chat/send') {
      const body = await readBody(req)
      const toId = String(body?.to_id || cfg.dmToId || '').trim()
      const to = String(body?.to || cfg.dmTo || '').trim()
      const text = String(body?.text || '').trim()
      if (!text) return sendJson(res, 200, { ok: false, error: '正文是空的' })
      // 🔴 用户闸：面板点「发送」= 当场同意，所以这里直接放行（前端已经二次确认过）
      if (body?.confirm !== true) return sendJson(res, 200, { ok: false, needsConfirm: true, draft: text })
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      argv.push('--text', text)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return sendJson(res, 200, { ok: false, error: '发送器没返回可解析结果', detail: String(r.stderr || r.stdout || '').slice(-400) })
      if (j.ok && j.sent) {
        try {
          const secUid = String(j.to_sec_uid || toId || '').trim()
          if (secUid) noteSent(stateDir, secUid, j.to || to, text, 'text')
        } catch { /* 记忆失败不影响已发出 */ }
        log(`chat -> ${j.to || to}: 已发送（${text.length} 字）`)
      }
      return sendJson(res, 200, j)
    }

    /* ── 最近一轮发生了什么（面板「看日志」用） ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/log') {
      const tail = (() => { try { return readFileSync(logFile, 'utf8').slice(-8000) } catch { return '' } })()
      const st = readJson(dutyStateFile, {})
      return sendJson(res, 200, {
        ok: true,
        logFile,
        tail,
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        roundActive: Boolean(st.roundActive),
        // ⭐ 现在能不能跑（把"为什么不能"提前说清楚，别等点了才说）
        canRun: !dutyRunning && !roundBusyInState() && countPickedToday() < Number(cfg.perDay || 0),
        pickedToday: countPickedToday(),
        perDay: Number(cfg.perDay || 0),
      })
    }

    /* ── 记忆：看有多少 / 清掉 ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/memory') {
      return sendJson(res, 200, { ok: true, stats: memoryStats(stateDir) })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/memory/clear') {
      const r = forgetAll(stateDir)
      log(`记忆：用户从面板清空了全部记忆（删了 ${r.removed} 个文件）`)
      return sendJson(res, 200, { ...r, stats: memoryStats(stateDir) })
    }

    /* ── 新手流程说明（面板上「怎么用？」拿这份）── */
    if (req.method === 'GET' && path === '/api/douyin-duty/guide') {
      let text = ''
      let err = ''
      try { text = readFileSync(join(pluginDir, 'GUIDE.md'), 'utf8') } catch (e) { err = String(e?.message ?? e) }
      return sendJson(res, 200, { ok: true, text, file: join(pluginDir, 'GUIDE.md'), error: err || undefined })
    }

    /* ── 给别的 AI 用：MCP 配置 + 使用说明 ──
     * 面板上「复制这段配置」拿的就是这里生成的东西 —— 路径按**这台机器**算好，
     * 不写盘符（不然别人抄过去一定错）。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/ai-usage') {
      const serverPath = join(pluginDir, 'tools', 'mcp-server.mjs')
      const mcpConfig = {
        mcpServers: {
          douyin: {
            command: 'node',
            args: [serverPath],
            env: { DOUYIN_HOME: stateDir },
          },
        },
      }
      let doc = ''
      let docError = ''
      try { doc = readFileSync(join(pluginDir, 'AI-USAGE.md'), 'utf8') } catch (e) { docError = String(e?.message ?? e) }
      return sendJson(res, 200, {
        ok: true,
        doc,
        doc_error: docError || undefined,
        file: join(pluginDir, 'AI-USAGE.md'),
        mcp: {
          server: serverPath,
          exists: existsSync(serverPath),
          selfTest: `node "${serverPath}" --selftest`,
          home: stateDir,
          config: mcpConfig,
          configText: JSON.stringify(mcpConfig, null, 2),
          note: '任何支持 MCP 的工具（Claude Code / Cursor / Cline / 另一个 DSH）把这段填进它的 MCP 配置即可。',
        },
        // DSH 自己也能把这份 server 挂成 MCP —— 给一段可以直接抄的 patch
        dshPatch: [
          '- id: mcp-douyin',
          "  name: '@deepseek-ai/dsh-mcp-client'",
          '  config:',
          '    serverName: douyin',
          '    transport: stdio',
          `    command: 'node'`,
          `    args: ['${serverPath.replace(/\\/g, '/')}']`,
          '    env:',
          `      DOUYIN_HOME: '${stateDir.replace(/\\/g, '/')}'`,
          '',
        ].join('\n'),
      })
    }

    /* ── 环境体检（纯 Node，不需要 Python —— 用户第一次点它时还没有 venv） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/doctor') {
      const r = runNodeTool('doctor.mjs', ['--json'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return sendJson(res, 200, {
          ok: false, items: [], must_fix: [],
          error: '体检脚本没返回可解析结果',
          stderr: String(r.stderr || '').slice(0, 300),
        })
      }
      log(`doctor: ${(j.must_fix || []).length} 项必须修 / ${(j.warns || []).length} 项待办`)
      return sendJson(res, 200, j)
    }

    /* ── ⭐ v0.3.9 风控：手动解除熔断（撞验证码/限流后，确认账号没问题了再点） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/ratelimit/reset') {
      resetCircuit(stateDir)
      log('ratelimit: 手动解除熔断')
      return sendJson(res, 200, { ok: true, ratelimit: rateStatus(stateDir, rateOpts()) })
    }

    /* ── 人设：读 / 写使用者自己那份（$DOUYIN_HOME/persona.md）──
     * 优先级：使用者自己那份 > 插件自带 > 默认中性。
     * 这里只让写使用者那份 —— 插件包里那两份是随包发布的，不该被页面改。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/persona') {
      const mine = join(stateDir, 'persona.md')
      const has = existsSync(mine)
      let text = ''
      try { if (has) text = readFileSync(mine, 'utf8') } catch { text = '' }
      let defText = ''
      try { defText = readFileSync(join(pluginDir, 'prompts', 'persona.default.md'), 'utf8') } catch { defText = '' }
      return sendJson(res, 200, {
        ok: true, custom: has, text, default_text: defText,
        file: mine,
        hint: has ? '正在用你这份' : '还没写自己的 —— 现在用的是插件自带 / 默认人设',
      })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/persona') {
      const body = await readBody(req)
      const text = String(body.text ?? '')
      const mine = join(stateDir, 'persona.md')
      if (!text.trim()) {
        // 空 = 删掉自己那份，退回默认
        try { if (existsSync(mine)) rmSync(mine) } catch { /* 已经没了 */ }
        log('人设：已清空自定义，退回默认')
        return sendJson(res, 200, { ok: true, custom: false })
      }
      // ⭐ 身份牌必须有，否则下一轮会被跳过 —— 帮用户补上，别让他踩坑
      let out = text
      if (!/^<!--\s*persona:/i.test(out.trimStart())) {
        out = '<!-- persona: douyin-scroll -->\n' + out
      }
      try {
        writeFileSync(mine, out, 'utf8')
        log(`人设：已保存自定义（${out.length} 字）→ ${mine}`)
        return sendJson(res, 200, { ok: true, custom: true, file: mine })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/install') return sendJson(res, 200, runInstall())
    if (req.method === 'POST' && path === '/api/douyin-duty/install-browser') {
      return sendJson(res, 200, { ok: false, gone: true, hint: '2026-10-21 起不再需要浏览器依赖 —— bb-browser / playwright 那套已经整个删掉了' })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/check') {
      const out = { ok: false, steps: [] }
      if (!venvReadyNow()) { out.error = '环境还没装好 —— 点「装主依赖」'; return sendJson(res, 200, out) }
      if (!hasCredential(stateDir)) { out.error = '还没登录 —— 先扫码，或粘一条 Cookie'; return sendJson(res, 200, out) }
      try {
        const r = runPy('session-guard.py', ['check'], { timeout: 90_000 })
        const j = pickJson(r.stdout) || {}
        out.session = { alive: j.alive === true, nick: j.nick || null, code: j.code ?? null }
        if (j.alive === true) out.steps.push(`登录有效${j.nick ? '（' + j.nick + '）' : ''}`)
        else { out.error = `会话不健康：code=${j.code ?? '?'} ${j.why || ''}`; return sendJson(res, 200, out) }
      } catch (e) { out.error = '体检失败：' + (e?.message ?? e); return sendJson(res, 200, out) }
      try {
        runPy('forward-pick.py', [], { timeout: 300_000 })
        let picked = {}
        try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
        const rows = Array.isArray(picked.rows) ? picked.rows : []
        out.sample = JSON.stringify(rows.slice(0, 2).map((x) => String(x.desc || '').slice(0, 40))).slice(0, 300)
        out.ok = rows.length > 0
        if (out.ok) out.steps.push(`能拿到候选（${rows.length} 条）`)
        else out.error = '拿不到候选 —— 推荐流这轮可能返回空，过会儿再试'
      } catch (e) { out.error = '取候选失败：' + (e?.message ?? e) }
      return sendJson(res, 200, out)
    }
    /* ── 成长页（2026-10-25 老大要求）：它自己的画像 + 每天学到什么的日记 ──
     * 数据全在本机，模型自己写：
     *   · `$DOUYIN_HOME/portrait.md`      —— 长期画像（审美 / 喜欢什么 / 怎么看人 / 最近在琢磨什么）
     *   · `$DOUYIN_HOME/diary/<日期>.md`   —— 每天一篇，追加写
     *   · `$DOUYIN_HOME/tastes-inbox.jsonl`—— 口味观察（已有，这里顺手聚合给它看）
     */
    if (req.method === 'POST' && path === '/api/douyin-duty/growth/write') {
      /* 手动补写某天的日记（老大在「成长」页点「补写今天」时用） */
      let body = {}
      try { body = await readBody(req) } catch { body = {} }
      const day = String(body.day || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      if (dutyRunning) return sendJson(res, 409, { ok: false, error: '正在刷一轮，等这轮结束再写（同一时间只跑一个会话）' })
      if (diaryBusy) return sendJson(res, 409, { ok: false, error: '已经在写了，等它写完' })
      const started = runDayClose(day, '老大在面板里手动让它写的')
      return sendJson(res, started ? 200 : 500, { ok: started, day, error: started ? undefined : '起不来，看 diary.log' })
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/growth') {
      const diaryDir = join(stateDir, 'diary')
      try { mkdirSync(diaryDir, { recursive: true }) } catch { /* 已经在了 */ }
      /**
       * ⭐ 2026-10-27：默认落在**最近写过的那天**，不是"今天"。
       *    以前默认 today ⇒ 凌晨打开一片空白（今天的日记要等 23:55 收工才写），
       *    老大看到的就是"日记/画像没更新"。现在没指定 day 时，先看最新那篇。
       */
      let days = []
      try {
        days = readdirSync(diaryDir)
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .map((f) => f.slice(0, 10))
          .sort()
          .reverse()
      } catch { days = [] }
      const dayParam = String(url.searchParams.get('day') || '').replace(/[^0-9-]/g, '')
      const day = dayParam || days[0] || dayKey()
      if (days.indexOf(day) < 0) days.unshift(day)
      const readText = (p, cap = 300000) => {
        try { return existsSync(p) ? readFileSync(p, 'utf8').slice(0, cap) : '' } catch { return '' }
      }
      const diaryFile = join(diaryDir, day + '.md')
      const portraitFile = join(stateDir, 'portrait.md')
      const diary = readText(diaryFile)
      const portrait = readText(portraitFile)
      let tastes = null
      let tasteText = ''
      try { tastes = summarizeTaste(stateDir) } catch { tastes = null }
      try { tasteText = tasteProfileText(stateDir) } catch { tasteText = '' }
      return sendJson(res, 200, {
        ok: true,
        day, days: days.slice(0, 60),
        diary, diary_exists: Boolean(diary), diary_file: diaryFile,
        portrait, portrait_exists: Boolean(portrait), portrait_file: portraitFile,
        tastes, taste_text: tasteText,
        hint: portrait
          ? ''
          : '画像还没长出来 —— 跑几轮之后它自己会写进 portrait.md（在插件家目录里）',
      })
    }

    /* ⭐ 情绪内核（2026-10-28）：面板「情绪」页读这个 —— 现在的心情、今天整体、最近轨迹。 */
    if (req.method === 'GET' && path === '/api/douyin-duty/mood') {
      try {
        ensureMood(stateDir)
        const g = moodGet(stateDir)
        return sendJson(res, 200, {
          ok: true,
          ...g,
          trail_text: moodTrailText(stateDir, 12),
          kinds: Object.keys(MOOD_EVENTS),
          file: join(stateDir, 'mood.json'),
          note: '这里不设档位：外放多少由大肥鱼自己按场合决定；它只记录自己养出来的倾向。',
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'GET' && path === '/api/douyin-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 200000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/open') {
      const body = await readBody(req)
      const dir = String(body?.what || 'out') === 'home' ? stateDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) return sendJson(res, 200, { ok: true, opened: dir, via: cmd })
        lastErr = err
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }
    // ── Cookie ──
    if (req.method === 'GET' && path === '/api/douyin-duty/login/status') {
      const info = credentialInfo(stateDir)
      return sendJson(res, 200, {
        ok: true, hasCredential: info.hasCredential, keys: info.keys,
        who: info.important.join(', '), at: info.at, bytes: info.bytes,
        backend: 'feed（只读推荐流接口）',
      })
    }

    /* ⭐ 扫码登录（2026-10-22 加）—— 以前只写在文档里让人敲命令行，新手根本走不到。
     *   现在面板一键：出二维码 → 手机扫 → 点「我扫完了」。
     *
     *   QR 是**有头** Chrome 截的图，存 $DOUYIN_HOME/login-qr.png；
     *   面板拿 `qr_url` 直接 <img> 显示（同一个 webServer 下加了一条静态路由）。
     */
    if (req.method === 'POST' && path === '/api/douyin-duty/login/qr') {
      const force = String((await readBody(req))?.force || '') === '1'
      // 先确保后台无头浏览器不占着 profile —— 它和扫码窗口共用一个 user-data-dir
      if (force) {
        runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 })
        await new Promise((r) => setTimeout(r, 1200))
      }
      const r = runNodeTool('qr-login.mjs', ['start'], { timeout: 120_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        log(`扫码登录：出码失败（exit=${r.status}）${String(r.stderr || '').slice(0, 160)}`)
        return sendJson(res, 200, {
          ok: false,
          error: '出二维码失败',
          detail: String(r.stderr || r.stdout || '').slice(-600),
          hint: '常见原因：没装浏览器 / Chrome 被别的进程锁住。点「关掉后台浏览器重试」再试一次',
        })
      }
      if (!j.ok) {
        log(`扫码登录：${j.conflict || '失败'} ${j.error || ''}`)
        return sendJson(res, 200, j)
      }
      // 转成浏览器能直接 <img src> 的地址
      const qrName = String(j.qr || '').split(/[\\/]/).pop() || 'login-qr.png'
      log(`扫码登录：二维码已出（${qrName}，端口 ${j.port}）`)
      return sendJson(res, 200, {
        ...j,
        qr_url: `/api/douyin-duty/login/qr.png?v=${Date.now()}`,
      })
    }
    // 二维码图片本身（面板 <img src> 用）
    if (req.method === 'GET' && path === '/api/douyin-duty/login/qr.png') {
      const f = join(stateDir, 'login-qr.png')
      if (!existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('还没有二维码 —— 先点「扫码登录」') }
      try {
        const buf = readFileSync(f)
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(String(e?.message ?? e))
      }
    }
    // 「我扫完了」：轮询到登录成功（最多 ~120 秒）
    if (req.method === 'POST' && path === '/api/douyin-duty/login/wait') {
      const body = await readBody(req)
      const sec = Math.max(10, Math.min(Number(body?.seconds) || 120, 300))
      const r = runNodeTool('qr-login.mjs', ['watch', String(sec)], { timeout: (sec + 30) * 1000 })
      // watch 会打多行 JSON，取最后一个完整对象
      const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      let last = null
      for (let i = lines.length - 1; i >= 0 && !last; i--) {
        try { last = JSON.parse(lines[i]) } catch { /* 继续往上找 */ }
      }
      if (!last) {
        return sendJson(res, 200, { ok: false, error: '没等到结果', detail: String(r.stderr || r.stdout || '').slice(-400) })
      }
      if (last.ok) {
        log(`扫码登录：成功，凭证已保存（${last.cookies || '?'} 条 Cookie）`)
        // ⭐ 记下"登录的是哪个号" —— 面板要显示昵称（用户要知道自己在给谁刷）
        try {
          const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
          const j = pickJson(g.stdout)
          if (j && (j.nick || j.uid)) {
            writeJson(join(stateDir, 'account.json'), {
              nick: j.nick || '', uid: j.uid || '', alive: j.alive === true,
              at: new Date().toISOString(),
            })
            log(`扫码登录：账号 = ${j.nick || '(无昵称)'} (uid=${j.uid || '?'})`)
          }
        } catch { /* 拿不到昵称不影响登录本身 */ }
        // 登完把有头浏览器收掉，别让它一直占着 profile（不然发私信会起不来）
        try { runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 }) } catch { /* 关不掉也不致命 */ }
        refreshCfg()
      }
      return sendJson(res, 200, last)
    }
    // 关掉登录用的浏览器（用户嫌窗口碍事 / 出码失败要重来时）
    if (req.method === 'POST' && path === '/api/douyin-duty/login/close') {
      const r = runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 })
      return sendJson(res, 200, pickJson(r.stdout) || { ok: true })
    }

    /* ⭐ 列出会话里的人（昵称 + sec_uid）—— 让用户点选"私信发给谁"，
     *    别再让他手填 sec_uid（新手根本不知道那是什么，也找不到）。只读。 */
    if (req.method === 'POST' && path === '/api/douyin-duty/dm/people') {
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: false, error: '还没登录', hint: '先在上面扫码登录' })
      // 后台无头浏览器可能正在跑；先让它别占着（跟登录窗口同一个 profile）
      const r = runNodeTool('im-send.mjs', ['--list'], { timeout: 180_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return sendJson(res, 200, {
          ok: false, error: '没读到会话列表',
          detail: String(r.stderr || r.stdout || '').slice(-500),
          hint: '确认已登录；如果一直读不到，点「检查环境」看看浏览器那一项',
        })
      }
      if (j.ok) log(`会话列表：${j.count} 个人${j.no_id_count ? `（${j.no_id_count} 个没拿到稳定 id）` : ''}`)
      return sendJson(res, 200, j)
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/login/save') {
      const body = await readBody(req)
      const r = saveCookie(stateDir, String(body?.cookie ?? ''), log)
      log(`Cookie 已保存（${redactCookie(String(body?.cookie ?? '')).slice(0, 40)}…）`)
      return sendJson(res, 200, r)
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/login/clear') {
      return sendJson(res, 200, clearCredential(stateDir))
    }
    // ── 通知测试 ──
    if (req.method === 'POST' && path === '/api/douyin-duty/notify/test') {
      const result = await notifyTest()
      return sendJson(res, 200, result)
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'douyin-duty: /api/douyin-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'douyin-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，采集=推荐流只读接口，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
