/**
 * lib/channels.mjs —— 记「这条视频我用哪个渠道推过」：私信卡片（dm）还是评论区 @（mention）
 * ============================================================================
 * 2026-10-27 老大要求：
 *   ① **@ 过的视频，私信就不用再分享了**（重复推同一条很烦）；
 *   ② 私信分享过的，评论区 @ 也**可以**，但一般不这样做 —— 只作为一个可选项。
 *
 * 所以：dm 侧是**硬闸**（@ 过了就拦，DOUYIN_FORCE_CHANNEL=1 可覆盖）；
 *       mention 侧只给**提示**（不拦）。
 *
 * 文件：`<HOME>/channel-log.json`，形如
 *   { "7698425317454989160": { "mention": "2026-10-26T16:20:00Z", "dm": "2026-10-26T18:01:00Z" } }
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const dutyHome = () => process.env.DOUYIN_HOME || process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
export const channelLogFile = (home = dutyHome()) => join(home, 'channel-log.json')

export const loadChannels = (home = dutyHome()) => {
  try {
    const p = channelLogFile(home)
    if (!existsSync(p)) return {}
    const o = JSON.parse(readFileSync(p, 'utf8'))
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}

/** 这条视频在哪几个渠道推过：{ dm?: ISO, mention?: ISO } */
export const channelsOf = (aweme, home = dutyHome()) => {
  const all = loadChannels(home)
  return all[String(aweme || '')] || {}
}

/** 记一笔（kind: 'dm' | 'mention'）。同一渠道重复推送只更新时间。 */
export const markChannel = (aweme, kind, home = dutyHome()) => {
  const id = String(aweme || '')
  if (!id || (kind !== 'dm' && kind !== 'mention')) return false
  try {
    const all = loadChannels(home)
    const rec = all[id] || {}
    rec[kind] = new Date().toISOString()
    all[id] = rec
    // 只留最近 800 条，别把文件撑大
    const keys = Object.keys(all)
    if (keys.length > 800) {
      const sorted = keys.sort((a, b) => {
        const ta = Math.max(Date.parse(all[a].dm || 0) || 0, Date.parse(all[a].mention || 0) || 0)
        const tb = Math.max(Date.parse(all[b].dm || 0) || 0, Date.parse(all[b].mention || 0) || 0)
        return ta - tb
      })
      for (const k of sorted.slice(0, keys.length - 800)) delete all[k]
    }
    writeFileSync(channelLogFile(home), JSON.stringify(all, null, 1), 'utf8')
    return true
  } catch { return false }
}
