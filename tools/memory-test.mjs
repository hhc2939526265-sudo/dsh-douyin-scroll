/**
 * tools/memory-test.mjs —— 记忆功能自测（不联网、不碰浏览器）
 * ============================================================================
 * 验证：合并去重、上限、上下文摘要、事实、评论区记忆、清空。
 * selfcheck 会调它；改了 lib/memory.mjs 之后也手动跑一下。
 *
 * 跑法：node tools/memory-test.mjs
 * ============================================================================
 */
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeDmMemory, loadDmMemory, noteSent, addFacts, dmContext,
  noteMyComment, loadCommentMemory, markSeen,
  memoryStats, forgetDm, forgetAll,
} from '../lib/memory.mjs'

let pass = 0
let fail = 0
const ok = (m) => { pass++; console.log(`  ✅ ${m}`) }
const bad = (m) => { fail++; console.log(`  ❌ ${m}`) }

const home = mkdtempSync(join(tmpdir(), 'dy-mem-'))
const SEC = 'MS4wLjABAAAA_TESTUSER'

try {
  /* ── 1. 空记忆 ── */
  if (loadDmMemory(home, SEC) === null) ok('没有记录时返回 null（不编造）')
  else bad('没记录却返回了东西')

  /* ── 2. 第一次读会话 ── */
  const m1 = mergeDmMemory(home, SEC, '示例好友', [
    { from: 'them', text: '在吗' },
    { from: 'me', text: '在' },
    { from: 'them', text: '帮我看看这个视频' },
  ])
  if (m1 && m1.total === 3 && m1.added === 3) ok('第一次读会话：3 条全进记忆')
  else bad(`第一次读会话条数不对：${JSON.stringify(m1 && { total: m1.total, added: m1.added })}`)
  if (m1.who.nick === '示例好友') ok('记住了昵称')
  else bad('昵称没记住')

  /* ── 3. 再读一次同样的（去重）── */
  const m2 = mergeDmMemory(home, SEC, '示例好友', [
    { from: 'them', text: '在吗' },
    { from: 'me', text: '在' },
    { from: 'them', text: '帮我看看这个视频' },
    { from: 'them', text: '这个猫好好笑' },
  ])
  if (m2.total === 4 && m2.added === 1) ok('重复读同一段不会重复记（只加了新的 1 条）')
  else bad(`去重失败：total=${m2.total} added=${m2.added}`)

  /* ── 4. 上下文摘要 ── */
  const ctx = dmContext(home, SEC, { recent: 2 })
  if (ctx && ctx.recent.length === 2 && ctx.total_remembered === 4) ok('上下文只给最近 2 条，不把全部塞进去')
  else bad(`上下文摘要不对：${JSON.stringify(ctx && { recent: ctx.recent.length, total: ctx.total_remembered })}`)
  if (ctx.who.nick === '示例好友') ok('上下文带昵称')
  else bad('上下文没带昵称')

  /* ── 5. 记自己发出去的 ── */
  noteSent(home, SEC, '示例好友', '哈哈哈哈确实', 'text')
  const m3 = loadDmMemory(home, SEC)
  if (m3.messages[m3.messages.length - 1].from === 'me') ok('自己发的也进记忆（from=me）')
  else bad('自己发的没进记忆')

  /* ── 6. 卡片标记 ── */
  noteSent(home, SEC, '示例好友', '[分享视频] 猫咪合集', 'card')
  const m4 = loadDmMemory(home, SEC)
  const card = m4.messages[m4.messages.length - 1]
  if (card.kind === 'card') ok('分享卡片记成 kind=card（不是普通文字）')
  else bad(`卡片类型不对：${card.kind}`)

  /* ── 6b. 普通文字消息不能被误判成卡片 ──
   * 🔴 2026-10-22 实测 bug：抖音的 aweType 在普通文字消息上也有值（700），
   *    只有分享卡片是 800。老逻辑 `m.awe ? 'card' : 'text'` 会把**所有消息**标成卡片。 */
  mergeDmMemory(home, SEC, '示例好友', [
    { from: 'them', text: '普通文字消息', awe: 700 },
    { from: 'them', text: '真的卡片', awe: 800 },
  ])
  const m4b = loadDmMemory(home, SEC)
  const plain = m4b.messages.find((m) => m.text === '普通文字消息')
  const realCard = m4b.messages.find((m) => m.text === '真的卡片')
  if (plain && plain.kind === 'text') ok('awe=700 的普通消息判成 text（不被误判成卡片）')
  else bad(`普通消息被误判：${plain && plain.kind}`)
  if (realCard && realCard.kind === 'card') ok('awe=800 才判成 card')
  else bad(`卡片判错了：${realCard && realCard.kind}`)

  /* ── 7. 长期事实 ── */
  addFacts(home, SEC, ['在杭州', '养了只橘猫'])
  addFacts(home, SEC, ['在杭州'])   // 重复的不该再加
  const m5 = loadDmMemory(home, SEC)
  if (m5.facts.length === 2 && m5.facts.includes('在杭州') && m5.facts.includes('养了只橘猫')) ok('长期事实去重正确（2 条）')
  else bad(`事实不对：${JSON.stringify(m5.facts)}`)

  /* ── 8. 上限：不能无限长 ── */
  const many = []
  for (let i = 0; i < 120; i++) many.push({ from: 'them', text: '第' + i + '条消息' })
  mergeDmMemory(home, SEC, '示例好友', many)
  const m6 = loadDmMemory(home, SEC)
  if (m6.messages.length <= 80) ok(`记忆有上限（120 条塞进去，只留 ${m6.messages.length} 条 ≤ 80）`)
  else bad(`记忆没上限：${m6.messages.length} 条`)
  if (m6.messages[m6.messages.length - 1].text === '第119条消息') ok('留下的是最新的（不是最旧的）')
  else bad('截断方向错了 —— 留下了旧消息')

  /* ── 9. 超长文本要截断 ── */
  mergeDmMemory(home, SEC, '示例好友', [{ from: 'them', text: 'x'.repeat(500) }])
  const m7 = loadDmMemory(home, SEC)
  if (m7.messages[m7.messages.length - 1].text.length <= 200) ok('单条文本超长会截断（≤200 字）')
  else bad('超长文本没截断')

  /* ── 10. 评论区记忆 ── */
  noteMyComment(home, '7401234567890123401', { cid: '111', text: '@某人 来看看', mention: '某人' })
  const cm = loadCommentMemory(home, '7401234567890123401')
  if (cm && cm.mine.length === 1 && cm.mine[0].mention === '某人') ok('评论区记忆记下了"我发的评论 + @ 了谁"')
  else bad('评论区记忆不对')
  markSeen(home, '7401234567890123401', ['111', '222'])
  const cm2 = loadCommentMemory(home, '7401234567890123401')
  if (cm2.seen.includes('111') && cm2.seen.includes('222')) ok('标记"处理过"能记住（避免重复回）')
  else bad('seen 标记没存上')

  /* ── 11. 统计 ── */
  const st = memoryStats(home)
  if (st.dm >= 1 && st.comment >= 1 && st.bytes > 0) ok(`统计正确（私信 ${st.dm} / 评论 ${st.comment} / ${st.bytes} 字节）`)
  else bad(`统计不对：${JSON.stringify(st)}`)

  /* ── 12. 忘掉一个人 ── */
  forgetDm(home, SEC)
  if (loadDmMemory(home, SEC) === null) ok('忘掉某人后记忆真的没了')
  else bad('忘掉某人失败')
  if (loadCommentMemory(home, '7401234567890123401') !== null) ok('忘掉私信不影响评论区记忆（分开的）')
  else bad('忘掉一个人却把评论区也删了')

  /* ── 13. 清空全部 ── */
  const r = forgetAll(home)
  const files = readdirSync(join(home, 'memory')).filter((f) => f.endsWith('.json'))
  if (files.length === 0) ok(`清空全部（删了 ${r.removed} 个文件）`)
  else bad(`清空后还剩 ${files.length} 个文件`)

  /* ── 14. 坏文件不能让它崩 ── */
  writeFileSync(join(home, 'memory', 'dm-broken.json'), '{ 这不是 JSON', 'utf8')
  const broken = loadDmMemory(home, 'broken')
  if (broken === null) ok('记忆文件坏了返回 null，不崩')
  else bad('坏文件居然读出来了')
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
