/**
 * tools/panel-render-check.mjs —— 在 Node 里把 client.js 真**渲染**一遍（不装 DSH）
 * ============================================================================
 * 为什么要有它：
 *   面板整块的消失，过去全是"某个组件在渲染时抛错"引起的（TDZ / undefined / 拼错字段）。
 *   `node --check` 只能查语法，查不出这类运行时错误 —— 2026-10-22 那次「重启多少次都看不见面板」
 *   就是 import 阶段炸的，语法检查照样通过。
 *   这里用一套**极小的 React 替身**（createElement / useState / useEffect / class）
 *   把 Panel 真的执行一遍，然后走一遍元素树，确认每块卡片都在。
 *
 * 用法：node tools/panel-render-check.mjs      （selfcheck 4j 段会调它）
 * 退出码 0 = 渲染通过。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/* ── 极简 React 替身 ── */
let hooks = []
let hookIdx = 0
let rerender = null

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length ? (children.length === 1 ? children[0] : children) : undefined } }
  },
  useState(init) {
    const i = hookIdx++
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(hooks[i]) : v
      if (JSON.stringify(next) !== JSON.stringify(hooks[i])) { hooks[i] = next; rerender?.() }
    }
    return [hooks[i], set]
  },
  useEffect(fn) {
    const i = hookIdx++
    if (!(i in hooks)) { hooks[i] = true; fn() }
  },
  useRef(init) {
    const i = hookIdx++
    if (!(i in hooks)) hooks[i] = { current: init }
    return hooks[i]
  },
  Component: class { constructor(props) { this.props = props; this.state = {} } setState(p) { Object.assign(this.state, p); rerender?.() } },
}

/* ── DOM 替身 ── */
const made = []
globalThis.document = {
  createElement: (tag) => { const el = { tag, style: {}, setAttribute() {}, appendChild() {}, remove() {} }; made.push(el); return el },
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  querySelector: () => null,
  execCommand: () => true,
}

/* ── fetch 替身：接口返回写死 ──
 * ⭐ 登录状态做成**可切换**的：先按"没登录"渲染一遍（这是新手的真实起点），
 *    再切成"已登录"渲染一遍 —— 两条路都得能画出来。
 */
const state = { loggedIn: false, venvReady: false }
const MOCK = {
  '/api/douyin-duty/status': () => ({
    ok: true, version: '9.9.9', home: 'H:/dy', loggedIn: state.loggedIn, venvReady: state.venvReady,
    pickedToday: 2, report: 'H:/dy/out/2026-10-22.md', installing: false,
  }),
  '/api/douyin-duty/config': () => ({
    ok: true,
    config: {
      perDay: 5, maxPerRun: 12, noon: true, night: true, keywords: ['猫', '搞笑'],
      windows: [{ start: '09:00', end: '11:00', label: '上午' }],
      autoSend: true, commentAtMe: false, commentSelfName: '',
    },
  }),
  '/api/douyin-duty/update': () => ({
    ok: true, current: '9.9.9', latest: '9.9.9', checked: true, hasUpdate: false, source: 'npm registry', tried: [],
  }),
  '/api/douyin-duty/ai-usage': () => ({
    ok: true, doc: '# 使用说明',
    mcp: { server: 'H:/dy/tools/mcp-server.mjs', exists: true, selfTest: 'node ".../mcp-server.mjs" --selftest', configText: '{\n  "mcpServers": {}\n}' },
  }),
  '/api/douyin-duty/report': () => ({ ok: true, text: '# 报告\n### 7401234567890123401' }),
  '/api/douyin-duty/guide': () => ({ ok: true, text: '# 新手流程\n\n① 装环境\n② 扫码登录\n③ 用' }),
  '/api/douyin-duty/account': () => ({
    ok: true, logged_in: state.loggedIn,
    account: state.loggedIn ? { nick: '测试账号昵称', uid: '9999000011112222', alive: true, at: new Date().toISOString() } : null,
  }),
  '/api/douyin-duty/persona': () => ({
    ok: true, custom: false, text: '', default_text: '# 默认人设\n\n中性、不扮演任何人。', hint: '还没写自己的 —— 现在用的是默认人设',
  }),
  '/api/douyin-duty/memory': () => ({
    ok: true, stats: { dir: 'H:/dy/memory', dm: 2, comment: 1, bytes: 4096 },
  }),
  '/api/douyin-duty/inbox': () => ({
    ok: true,
    at_n: 2,
    dm_n: 1,
    at: [
      { nickname: '测试好友', content: '@测试账号昵称 出来一下', before: '没回过',
        aweme_id: '7693806860863802662', comment_id: '7699090731688952613',
        video_url: 'https://www.douyin.com/video/7693806860863802662',
        my_comments_here: [{ at: '2026-10-22', text: '我之前在这说过一句', mention: '' }] },
      { nickname: '另一个朋友', content: '@测试账号昵称 出来见人', before: '回过',
        aweme_id: '7694192415963368730', comment_id: '7699009624113152825',
        video_url: 'https://www.douyin.com/video/7694192415963368730', my_comments_here: [] },
    ],
    dm: [
      { nick: '测试好友', sec_uid: 'MS4wLjABAAAA_test1', preview: '我也爱你', duplicate: false,
        remembered: 11, their_last: { text: '我也爱你', at: '2026-10-22' }, last_from: 'them', needs_reply: true },
    ],
    errors: [],
  }),
  '/api/douyin-duty/chat/read': () => ({
    ok: true, to: '测试好友', to_sec_uid: 'MS4wLjABAAAA_test1',
    count: 3, mine: 2, them: 1, unknown: 0,
    messages: [
      { from: 'me', text: '爱你哟。', awe: 700 },
      { from: 'them', text: '我也爱你', awe: 700 },
      { from: 'me', text: '这条想让你看看', awe: 800 },
    ],
    context: { who: { nick: '测试好友' }, facts: ['喜欢猫', '在杭州'], recent: [], total_remembered: 11 },
  }),
  '/api/douyin-duty/chat/send': () => ({ ok: true, sent: true, to: '测试好友', len: 5 }),
  '/api/douyin-duty/log': () => ({
    ok: true, tail: '[示例日志]\n证据包已备好：12 条\n刷抖音开跑（manual）…',
    lastRunAt: '2026-10-22T09:27:07.645Z', lastWhy: 'manual',
    roundActive: false, canRun: true, pickedToday: 0, perDay: 5,
  }),
  // 扫码登录：默认成功给出 qr_url
  '/api/douyin-duty/login/qr': () => ({ ok: true, qr_url: '/api/douyin-duty/login/qr.png?v=1', port: 9374 }),
  // 登录成功会真的把登录态翻过来 —— 面板随后 refresh() 必须看到 true
  '/api/douyin-duty/login/wait': () => { state.loggedIn = true; return { ok: true, logged_in: true, cookies: 9, hint: '登录成功' } },
  '/api/douyin-duty/login/close': () => ({ ok: true, closed: true }),
  '/api/douyin-duty/login/clear': () => { state.loggedIn = false; return { ok: true } },
  '/api/douyin-duty/dm/people': () => ({
    ok: true, count: 2,
    people: [
      { nick: '测试好友', sec_uid: 'MS4wLjABAAAA_test1', preview: '30分钟内在线', has_id: true, duplicate: false },
      { nick: '另一个朋友', sec_uid: 'MS4wLjABAAAA_test2', preview: '好的', has_id: true, duplicate: true },
    ],
    no_id_count: 0,
    hint: '有同名的人 —— 选的时候看「最近一条消息」区分，别选错',
  }),
}
globalThis.fetch = async (url) => {
  const path = String(url).split('?')[0]
  const make = MOCK[path]
  if (!make) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => make() }
}
const fakeNavigator = { clipboard: { writeText: async () => {} } }
globalThis.window = { __ModuleLoader__: {}, navigator: fakeNavigator }

/* ── 加载 client.js（它是给浏览器写的自注册脚本）── */
let mod = null
globalThis.window.__ModuleLoader__.load = (def) => {
  mod = def.factory((name) => {
    if (name === 'react') return React
    throw new Error('未知依赖：' + name)
  })
}
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'navigator', 'fetch', src)(
  globalThis.window, globalThis.document, fakeNavigator, globalThis.fetch,
)
if (!mod) throw new Error('client.js 没有调用 __ModuleLoader__.load')

/* ── 把注册到 settings.section 的组件抓出来 ── */
let Registered = null
const ctx = {
  effect: (fn) => { try { fn() } catch { /* 清理函数 */ } },
  get: (k) => (k === 'slots' ? {
    inject: (slot, fn) => fn(),
    register: (_meta, comp) => { Registered = comp; return () => {} },
  } : undefined),
}
mod.apply(ctx)
if (!Registered) throw new Error('apply() 没有往 settings.section 注册组件')

/* ── 迷你渲染器 ── */
const isClass = (t) => typeof t === 'function' && t.prototype && typeof t.prototype.render === 'function'

function render(el) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(render)
  const { type, props } = el
  if (typeof type === 'function') {
    if (isClass(type)) {
      const inst = new type(props || {})
      const out = inst.render()
      return render(out)
    }
    return render(type(props || {}))
  }
  const kids = props?.children
  return { tag: String(type), props: props || {}, children: kids === undefined ? [] : [].concat(render(kids)).flat(Infinity).filter((x) => x !== null) }
}

/** 把元素树拍平成 [tag, text] 便于检查 */
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out }
  if (typeof node === 'string') { out.push({ tag: '#text', text: node }); return out }
  out.push({ tag: node.tag, text: '', props: node.props })
  for (const c of node.children || []) walk(c, out)
  return out
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) }

let tree = null
let renders = 0
rerender = () => { renders++ }

/**
 * 渲染一遍并取元素树。
 * ⚠️ hook 游标（hookIdx）必须在**每次渲染开始时**归零，让 useState 按调用顺序重新对齐；
 *    hooks 数组本身**不能清**（那是状态存储）。
 *    之前的 bug：renderNow() 里清了 hooks，导致点按钮 setState 写进去的值，
 *    下一次渲染读到的是初始值（聊天界面就是这么"测不出来"的）。
 */
const renderNow = async () => {
  hookIdx = 0
  const t = render(React.createElement(Registered, {}))
  await flush()
  return t
}

// 第一遍：会显示"读设置中…"
hooks = []
tree = render(React.createElement(Registered, {}))
await flush()

/**
 * ⭐ 关键：先按**新手真实起点**渲染 —— 没登录。
 *    以前这里只测"已登录"那条路，结果登录 UI 崩了也发现不了。
 */
state.loggedIn = false
tree = await renderNow()
await renderNow()
let flat = walk(tree)
let allText = flat.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')

let fail = 0

console.log('【没登录时】—— 新手看到的第一屏')
const firstRunMust = [
  ['开始使用', /开始使用/],
  ['进度：还差两步', /还差\s*两步/],
  ['第①步：装环境', /装运行环境/],
  ['第②步：扫码登录按钮', /扫码登录/],
  ['扫码提示（手机抖音 → 扫一扫）', /扫一扫|扫码/],
  ['出问题？体检入口', /出问题了？/],
]
for (const [label, re] of firstRunMust) {
  if (re.test(allText)) console.log(`  ✅ ${label}`)
  else { console.log(`  ❌ ${label} —— 找不到 ${re}`); fail++ }
}
if (/node tools\/qr-login\.mjs/.test(allText)) {
  console.log('  ❌ 面板里还在让用户敲命令行 —— 新手走不到')
  fail++
} else console.log('  ✅ 面板里没有"自己去敲命令行"的登录指引')

/* ── 点「扫码登录」：应该出二维码 ── */
const findBtnIn = (f, label) => f.find((n) => n.tag === 'button' &&
  String([].concat(n.props?.children ?? []).flat(Infinity).join('')).includes(label))

const clickIn = async (f, label) => {
  const btn = findBtnIn(f, label)
  if (!btn) { console.log(`  ❌ 找不到按钮「${label}」`); fail++; return null }
  try {
    await btn.props.onClick({ target: { value: '' } })
  } catch (e) { console.log(`  ❌ 点「${label}」抛错：${e?.message ?? e}`); fail++; return null }
  await flush()
  const t = await renderNow()
  return walk(t)
}

console.log('\n【点「扫码登录」】')
flat = await clickIn(flat, '扫码登录')
if (flat) {
  const txt = flat.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
  const img = flat.find((n) => n.tag === 'img' && n.props && n.props['data-dy-qr'] !== undefined)
  if (img) console.log('  ✅ 二维码图片出来了')
  else { console.log('  ❌ 点完没有二维码图片'); fail++ }
  if (/我扫完了/.test(txt)) console.log('  ✅ 有「我扫完了」按钮')
  else { console.log('  ❌ 没有「我扫完了」'); fail++ }
  if (/重新出码/.test(txt)) console.log('  ✅ 有「重新出码」')
  else { console.log('  ❌ 没有「重新出码」'); fail++ }
  if (/短信验证码/.test(txt) && /滑块/.test(txt)) console.log('  ✅ 提前说明了可能要过短信/滑块')
  else { console.log('  ❌ 没提短信/滑块验证 —— 新手会以为扫失败'); fail++ }
}

/* ── 点「我扫完了」：登录成功 → 面板切成已登录 ── */
console.log('\n【点「我扫完了」】')
flat = await clickIn(flat, '我扫完了')
if (flat) {
  const txt = flat.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
  if (/登录成功/.test(txt)) console.log('  ✅ 提示登录成功')
  else { console.log('  ❌ 没说登录成功'); fail++ }
}

/* ── 已登录状态：确认另一条路也画得出来 ── */
state.loggedIn = true
state.venvReady = true
/**
 * ⭐ 这里必须**重新挂载**（清空 hooks）而不是只重渲染：
 *    面板的 st/cfg 是 useState 里的状态，只换 mock 数据不会自己变。
 *    清空 hooks ⇒ 重新跑 useEffect ⇒ 重新 fetch ⇒ 拿到新状态。
 *    （真实场景里对应"关掉设置页再打开"或 login 成功后的 refresh()）
 */
hooks = []
tree = render(React.createElement(Registered, {}))
// useEffect 里的 fetch 是异步的：多冲几次让 Promise 链走完，否则只看到"读设置中…"
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 0))
  tree = await renderNow()
}
flat = walk(tree)
allText = flat.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')

console.log('\n【已登录时】')
if (/已登录，可以刷了/.test(allText)) console.log('  ✅ 显示"已登录，可以刷了"')
else { console.log('  ❌ 已登录状态没显示'); fail++ }
if (/都装好了/.test(allText)) console.log('  ✅ 显示"都装好了"')
else { console.log('  ❌ 没显示就绪'); fail++ }
if (flat.find((n) => n.tag === 'img' && n.props && n.props['data-dy-qr'] !== undefined)) {
  console.log('  ❌ 已登录了还在显示二维码'); fail++
} else console.log('  ✅ 已登录时不显示二维码')

const must = [
  ['状态卡：刷抖音标题', /刷抖音/],
  ['现在跑一轮按钮', /现在跑一轮/],
  ['刷什么（关键词）', /刷什么/],
  ['什么时候自己跑', /什么时候自己跑/],
  ['中午谷时', /中午谷时/],
  ['晚上谷时', /晚上谷时/],
  ['自定义时段', /自定义时段/],
  ['自定义时段里的时间输入框', /09:00/],
  ['+ 加一个时段', /\+ 加一个时段/],
  ['保存时段', /保存时段/],
  ['给别的 AI 用', /给别的 AI 用/],
  ['MCP 配置说明', /MCP server/],
  ['关于 / 检查更新', /检查更新/],
  ['版本号', /v9\.9\.9/],
]

console.log(`\n渲染了 ${renders} 次状态更新，元素树 ${flat.length} 个节点\n`)
for (const [label, re] of must) {
  if (re.test(allText)) console.log(`  ✅ ${label}`)
  else { console.log(`  ❌ ${label} —— 渲染结果里找不到 ${re}`); fail++ }
}

// 结构检查：卡片数量、时间输入框数量
const cards = flat.filter((n) => n.props && 'data-dy-card' in n.props)
const timeInputs = flat.filter((n) => n.tag === 'input' && n.props && n.props.type === 'time')
console.log(`\n卡片 ${cards.length} 个 / 时间输入框 ${timeInputs.length} 个`)
if (cards.length < 6) { console.log('  ❌ 卡片少于 6 块，可能有一块没渲染出来'); fail++ }
else console.log('  ✅ 卡片齐全')
if (timeInputs.length !== 2) { console.log(`  ❌ 时间输入框应为 2 个（一个时段），实际 ${timeInputs.length}`); fail++ }
else console.log('  ✅ 一个自定义时段 = 两个时间输入框')

// 事件处理器检查：所有 onClick 必须是函数（写错成 onClick: foo() 会立刻执行）
const badHandlers = flat.filter((n) => n.props && 'onClick' in n.props && typeof n.props.onClick !== 'function')
if (badHandlers.length) { console.log(`  ❌ ${badHandlers.length} 个 onClick 不是函数`); fail++ }
else console.log('  ✅ 所有 onClick 都是函数')

/* ── 点一遍按钮：光"能显示"不够，按钮真跑起来也得不出错 ──
 * 这一段把三个异步动作真的 await 一遍：
 *   ① 检查更新  ② 看接入方式（MCP）  ③ 看报告
 * 每个按钮的 onClick 直接调，不用模拟事件 —— 我们要验的是**数据回来之后能不能渲染**。
 */
const findBtn = (label) => flat.find((n) => n.tag === 'button' &&
  String(([].concat(n.props?.children ?? []).flat(Infinity).join(''))).includes(label))

const clickAndRender = async (label) => {
  const btn = findBtn(label)
  if (!btn) { console.log(`  ❌ 找不到按钮「${label}」`); fail++; return }  try {
    await btn.props.onClick({ target: { value: '' } })
  } catch (e) {
    console.log(`  ❌ 点「${label}」抛错：${e?.message ?? e}`); fail++; return
  }
  await flush()
  hookIdx = 0
  const t = render(React.createElement(Registered, {}))
  await flush()
  const f = walk(t)
  const txt = f.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
  console.log(`  ✅ 点「${label}」没抛错，渲染 ${f.length} 节点`)
  return { tree: t, flat: f, text: txt }
}

console.log('\n点按钮实测：')
const rUpdate = await clickAndRender('检查更新')
if (rUpdate) {
  if (/已是最新版|有新版本|查不到最新版本/.test(rUpdate.text)) console.log('  ✅ 检查更新结果渲染出来了')
  else { console.log('  ❌ 检查更新后没有结果文案'); fail++ }
}
const rAi = await clickAndRender('看接入方式')
if (rAi) {
  if (/mcpServers/.test(rAi.text)) console.log('  ✅ MCP 配置渲染出来了')
  else { console.log('  ❌ 看接入方式后没有 MCP 配置'); fail++ }
  if (/复制 MCP 配置/.test(rAi.text)) console.log('  ✅ 有复制按钮')
  else { console.log('  ❌ 没有复制按钮'); fail++ }
}
const rRep = await clickAndRender('看今天的报告')
if (rRep) {
  if (/7401234567890123401/.test(rRep.text)) console.log('  ✅ 报告内容渲染出来了')
  else { console.log('  ❌ 报告没渲染出来'); fail++ }
}
const rDoc = await clickAndRender('检查环境')
if (rDoc) {
  if (/检查完|环境/.test(rDoc.text)) console.log('  ✅ 环境体检结果渲染出来了')
  else { console.log('  ❌ 体检结果没渲染'); fail++ }
}

/* ── 私信对象：点「从我的会话里选」应该列出人，点人能选中 ── */
console.log('\n【私信发给谁】')
const rPeople = await clickAndRender('从我的会话里选')
if (rPeople) {
  if (/测试好友/.test(rPeople.text)) console.log('  ✅ 列出会话里的人')
  else { console.log('  ❌ 没列出会话里的人'); fail++ }
  if (/重名/.test(rPeople.text)) console.log('  ✅ 同名的人标了「重名」')
  else { console.log('  ❌ 同名没标出来'); fail++ }
  // ⚠️ 人的名字在**子节点**里（不是按钮自己的 children 文本），要查整棵子树
  const personBtn = rPeople.flat.find((n) => n.tag === 'button' && n.props && n.props['data-dy-person'] !== undefined)
  if (personBtn) {
    try {
      await personBtn.props.onClick()
      await flush()
      const f = walk(await renderNow())
      const txt = f.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
      if (/已选/.test(txt)) console.log('  ✅ 点人能选中（显示"已选"）')
      else { console.log('  ❌ 点人没选中'); fail++ }
    } catch (e) { console.log(`  ❌ 点人抛错：${e?.message ?? e}`); fail++ }
  } else { console.log('  ❌ 找不到可点的人'); fail++ }
}

/* ── 「怎么用？」应该能展开新手流程 ── */
console.log('\n【怎么用？】')
const rGuide = await clickAndRender('怎么用？')
if (rGuide) {
  if (/新手流程/.test(rGuide.text) && /扫码登录/.test(rGuide.text)) console.log('  ✅ 展开了新手流程说明')
  else { console.log('  ❌ 没展开说明'); fail++ }
}

/* ── 登录后要显示账号 ── */
console.log('\n【登录后显示账号】')
if (/测试账号昵称/.test(allText)) console.log('  ✅ 显示了登录的账号昵称')
else { console.log('  ❌ 没显示账号昵称 —— 用户不知道在给谁刷'); fail++ }
if (/9999000011112222/.test(allText)) { console.log('  ❌ 还显示了账号 ID —— 用户说只要昵称就行'); fail++ }
else console.log('  ✅ 只显示昵称，不显示 ID')

/* ── 私信对象：也要能自己写 ── */
console.log('\n【私信对象：自己写】')
const rManual = await clickAndRender('自己写')
if (rManual) {
  const nickInput = rManual.flat.find((n) => n.tag === 'input' && n.props && String(n.props.placeholder || '').includes('示例好友'))
  const idInput = rManual.flat.find((n) => n.tag === 'input' && n.props && String(n.props.placeholder || '').includes('MS4wLjABAAAA'))
  if (nickInput) console.log('  ✅ 有昵称输入框')
  else { console.log('  ❌ 没有昵称输入框'); fail++ }
  if (idInput) console.log('  ✅ 有稳定 ID 输入框（可留空）')
  else { console.log('  ❌ 没有稳定 ID 输入框'); fail++ }
}

/* ── 补回来的功能：每天几条 / 日报多细 / 通知方式 ── */
console.log('\n【每天挑几条 / 日报 / 通知】')
const r10 = await renderNow()
const flatAll = walk(r10)
const txtAll = flatAll.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
for (const [label, re] of [
  ['每天挑几条', /每天挑几条/],
  ['日报详细程度', /日报写多细/],
  ['通知方式', /通知：/],
]) {
  if (re.test(txtAll)) console.log(`  ✅ ${label}`)
  else { console.log(`  ❌ 缺「${label}」`); fail++ }
}
const selects = flatAll.filter((n) => n.tag === 'select')
if (selects.length >= 2) console.log(`  ✅ ${selects.length} 个下拉框`)
else { console.log(`  ❌ 下拉框只有 ${selects.length} 个`); fail++ }

/* ── 人设：能写、能存 ── */
console.log('\n【我的人设】')
const rPersona = await clickAndRender('写人设')
if (rPersona) {
  const ta = rPersona.flat.find((n) => n.tag === 'textarea')
  if (ta) console.log('  ✅ 人设文本框出来了')
  else { console.log('  ❌ 人设文本框没出来'); fail++ }
  if (/默认人设|还没写自己的/.test(rPersona.text)) console.log('  ✅ 说明了当前用的是哪份')
  else { console.log('  ❌ 没说当前用哪份'); fail++ }
}

/* ── 对话记忆 ── */
console.log('\n【对话记忆】')
const rMem = await clickAndRender('看记忆')
if (rMem) {
  if (/私信记忆 2 个人/.test(rMem.text) && /评论区记忆 1 条视频/.test(rMem.text)) {
    console.log('  ✅ 显示了记忆统计')
  } else { console.log('  ❌ 记忆统计没显示'); fail++ }
  if (/清空全部记忆/.test(rMem.text)) console.log('  ✅ 有「清空全部记忆」按钮')
  else { console.log('  ❌ 没有清空按钮'); fail++ }
}

/* ── 消息：评论区 @ 我 + 谁私信我 ── */
console.log('\n【消息（收件箱）】')
const rInbox = await clickAndRender('看看谁找我')
if (rInbox) {
  if (/评论区 @ 我：2 条/.test(rInbox.text)) console.log('  ✅ 显示评论区 @ 的数量')
  else { console.log('  ❌ 没显示 @ 数量'); fail++ }
  if (/出来一下/.test(rInbox.text)) console.log('  ✅ 列出 @ 我的内容')
  else { console.log('  ❌ 没列出 @ 内容'); fail++ }
  if (/我之前在这说过一句/.test(rInbox.text)) console.log('  ✅ 带上了"我在这条视频下说过什么"（记忆）')
  else { console.log('  ❌ 没带"我说过什么"'); fail++ }
  if (/该回了/.test(rInbox.text)) console.log('  ✅ 私信标了「该回了」')
  else { console.log('  ❌ 私信没标该不该回'); fail++ }
  if (/记 11/.test(rInbox.text)) console.log('  ✅ 显示跟这个人记得多少条')
  else { console.log('  ❌ 没显示记忆条数'); fail++ }
}

/* ── 聊天模式（带记忆） ── */
console.log('\n【聊天模式】')
/**
 * ⚠️ 这里不能复用 clickAndRender：它内部用的 `flat` 是**初次渲染**那棵树，
 *    收件箱是后面点出来的，节点在 rInbox.flat 里。
 *    ⚠️ 而且 rInbox.flat 里**也包含**「私信发给谁」那张卡的人（也带 data-dy-person），
 *       点那个只会"选中收件人"，不会打开聊天 ⇒ 用 `data-dy-inbox-dm` 精确区分。
 */
const chatPersonBtn = (rInbox ? rInbox.flat : []).find((n) =>
  n.tag === 'button' && n.props && n.props['data-dy-inbox-dm'] !== undefined)
let rChat = null
if (chatPersonBtn) {
  try {
    await chatPersonBtn.props.onClick()
  } catch (e) { console.log(`  ❌ 点人抛错：${e?.message ?? e}`); fail++ }
  await flush()
  // 连渲染几次，让 openChat 里的 await jpost → setChat 走完
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0))
    hookIdx = 0
    const t = render(React.createElement(Registered, {}))
    await flush()
    const f = walk(t)
    const txt = f.filter((n) => n.tag === '#text').map((n) => n.text).join(' | ')
    if (/跟 .+ 聊/.test(txt)) { rChat = { flat: f, text: txt }; break }
  }
  if (rChat) console.log('  ✅ 点人能打开聊天')
  else { console.log('  ❌ 点了人但聊天界面没出来'); fail++ }
} else { console.log('  ❌ 找不到可点的私信人'); fail++ }
if (rChat) {
  if (/跟 测试好友 聊/.test(rChat.text)) console.log('  ✅ 打开了聊天界面')
  else { console.log('  ❌ 没打开聊天界面'); fail++ }
  if (/记得关于他的：喜欢猫、在杭州/.test(rChat.text)) console.log('  ✅ 显示了记忆里的长期事实')
  else { console.log('  ❌ 没显示记忆事实'); fail++ }
  const bubbles = rChat.flat.filter((n) => n.props && n.props['data-dy-bubble'] !== undefined)
  if (bubbles.length >= 3) console.log(`  ✅ 渲染了 ${bubbles.length} 条消息气泡`)
  else { console.log(`  ❌ 消息气泡只有 ${bubbles.length} 条`); fail++ }
  const mineB = rChat.flat.find((n) => n.props && n.props['data-dy-bubble'] !== undefined && n.props['data-mine'] !== undefined)
  const themB = rChat.flat.find((n) => n.props && n.props['data-dy-bubble'] !== undefined && n.props['data-them'] !== undefined)
  if (mineB && themB) console.log('  ✅ 我的和他的气泡分开了')
  else { console.log('  ❌ 气泡没区分谁发的'); fail++ }
  const input = rChat.flat.find((n) => n.tag === 'input' && n.props && String(n.props.placeholder || '').includes('说点什么'))
  if (input) console.log('  ✅ 有输入框')
  else { console.log('  ❌ 没有输入框'); fail++ }
  if (/分享卡片/.test(rChat.text)) console.log('  ✅ 分享卡片有标记')
  else { console.log('  ❌ 卡片没标记'); fail++ }
}

/* ── 自动发送开关 ── */
console.log('\n【自动发送开关】')
if (/自动发送/.test(allText) && /会自动发|只写报告/.test(allText)) console.log('  ✅ 有自动发送开关卡片')
else { console.log('  ❌ 没有自动发送开关'); fail++ }
// ⭐ 2026-10-22 用户明确要求：默认就是发。所以已登录状态下应该显示"会自动发"
if (/会自动发/.test(allText)) console.log('  ✅ 默认显示"会自动发"')
else { console.log('  ❌ 默认状态不对（应该是"会自动发"）'); fail++ }
if (/只管「插件自己在后台跑的轮次」/.test(allText)) console.log('  ✅ 说清了适用范围（只管后台轮次）')
else { console.log('  ❌ 没说清适用范围'); fail++ }
// 卡片位置：应该在「开始使用」之前（别埋在长面板底部）
{
  const iAuto = allText.indexOf('自动发送')
  const iStart = allText.indexOf('开始使用')
  if (iAuto > 0 && iStart > iAuto) console.log('  ✅ 自动发送卡在「开始使用」之前（不用滚到底才看见）')
  else { console.log('  ❌ 自动发送卡位置太靠后'); fail++ }
}

/* ── 「在评论区 @ 你」（加在自动发送下面） ── */
console.log('\n【在评论区 @ 你】')
if (/在评论区 @ 你/.test(allText)) console.log('  ✅ 有「在评论区 @ 你」开关')
else { console.log('  ❌ 没有「在评论区 @ 你」'); fail++ }
if (/关着：不往评论区发任何东西/.test(allText)) console.log('  ✅ 默认显示"关着"')
else { console.log('  ❌ 默认状态没说'); fail++ }
// 位置：必须在「自动发送」之后、「开始使用」之前
{
  const iSend = allText.indexOf('自动发送')
  const iAtMe = allText.indexOf('在评论区 @ 你')
  const iStart = allText.indexOf('开始使用')
  if (iSend >= 0 && iAtMe > iSend && iStart > iAtMe) console.log('  ✅ 位置正确（自动发送下面、开始使用之前）')
  else { console.log(`  ❌ 位置不对（自动发送@${iSend} 评论区@我@${iAtMe} 开始使用@${iStart}）`); fail++ }
}

/* ── 看日志 ── */
console.log('\n【看日志】')
const rLog = await clickAndRender('看日志')
if (rLog) {
  if (/证据包已备好/.test(rLog.text)) console.log('  ✅ 日志内容显示出来了')
  else { console.log('  ❌ 日志没显示'); fail++ }
  if (/上次跑：/.test(rLog.text)) console.log('  ✅ 显示上次跑的时间')
  else { console.log('  ❌ 没显示上次跑时间'); fail++ }
}

console.log(fail ? `\n渲染检查：${fail} 项失败` : '\n渲染检查：全部通过')
process.exitCode = fail ? 1 : 0
