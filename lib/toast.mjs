/**
 * lib/toast.mjs —— Windows 通知（Toast）通道：真正把消息**弹到用户屏幕上**
 * ============================================================================
 * 为什么要有它：
 *   webhook（企业微信/飞书/钉钉）要用户先申请一个机器人，绝大多数人不会配；
 *   "只写报告"则等于没提醒 —— 报告躺在文件夹里没人知道。
 *   Windows 自带的通知中心是**零配置**的：不装 BurntToast、不连网、不要 token。
 *
 * 实现方式（务实版）：
 *   用 `powershell.exe`（5.1，WinRT 在它这里才稳）调 `Windows.UI.Notifications`，
 *   标题/正文走**临时 JSON 文件**传（命令行里塞中文和引号会被转义坑死）。
 *
 * 🔴 三条纪律：
 *   ① **永不抛异常**：通知发不出去只是"这一轮没提醒到"，不该把宿主或那一轮拖下水；
 *   ② **不联网、不装东西**：纯本地 WinRT 调用；
 *   ③ 正文**截断**：Toast 只显示前几行，长文没意义，完整报告留在 `out/<日期>.md`。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AppUserModelID：桌面程序想弹 Toast 必须有个"身份"。
 * 借 PowerShell 自己的 AUMID —— 通知会以"Windows PowerShell"名义出现，
 * 这是不注册快捷方式时**唯一可靠**的做法（自己造 AUMID 而不注册 = 静默丢弃）。
 */
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const PS_SCRIPT = String.raw`
param([string]$Json, [string]$Aumid)
$ErrorActionPreference = 'Stop'
try {
  $msg = (Get-Content -LiteralPath $Json -Raw -Encoding UTF8) | ConvertFrom-Json
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

  $title = [System.Security.SecurityElement]::Escape([string]$msg.title)
  $body  = [System.Security.SecurityElement]::Escape([string]$msg.body)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')

  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  # 同名 Tag 会覆盖上一条，避免刷屏（Tag 只允许 1-16 位字母数字）
  try { $toast.Tag = 'dyduty'; $toast.Group = 'dyduty' } catch {}
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
  Write-Output 'OK'
} catch {
  Write-Output ('ERR:' + $_.Exception.Message)
}
`

/** 把 toast.ps1 落盘（只写一次）+ 每次调用把内容写进 tmp json */
function ensureScript(dir) {
  mkdirSync(dir, { recursive: true })
  const ps1 = join(dir, 'toast.ps1')
  writeFileSync(ps1, PS_SCRIPT, 'utf8') // PowerShell 5.1 读 BOM-less UTF-8 的 .ps1 也没问题（内容全 ASCII）
  return ps1
}

/**
 * 非 Windows 桌面通知（Linux/macOS）。
 *   - Linux：`notify-send`（libnotify，GNOME/KDE 自带；没有就返回 not_desktop）
 *   - macOS：`osascript` 弹通知
 * 纪律同 Windows：永不抛异常、不联网、正文截断。
 */
function sendToastNix({ title, body, timeoutMs, dryRun }) {
  const payload = {
    title: String(title || '刷抖音').slice(0, 64),
    body: String(body || '').slice(0, 220),
  }
  try {
    if (dryRun) return { ok: true, sent: false, via: process.platform === 'darwin' ? 'osascript' : 'notify-send', body: payload.body }
    if (process.platform === 'darwin') {
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const script = `display notification "${esc(payload.body)}" with title "${esc(payload.title)}"`
      const r = spawnSync('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf8' })
      if (r.error) return { ok: false, sent: false, via: 'osascript', error: String(r.error.message || r.error) }
      if (r.status !== 0) return { ok: false, sent: false, via: 'osascript', error: (String(r.stderr || '').trim() || `osascript exit=${r.status}`).slice(0, 200) }
      return { ok: true, sent: true, via: 'osascript' }
    }
    // Linux / 其它 Unix：优先 notify-send；超时参数各发行版不同，用最通用的形式
    const r = spawnSync('notify-send', [payload.title, payload.body, '--app-name=刷抖音'], { timeout: timeoutMs, encoding: 'utf8' })
    if (r.error && r.error.code === 'ENOENT') {
      return { ok: false, sent: false, skipped: 'not_desktop', error: '没有 notify-send（Linux 桌面装 libnotify 后可用；否则改用 file/webhook 通知）' }
    }
    if (r.error) return { ok: false, sent: false, via: 'notify-send', error: String(r.error.message || r.error) }
    if (r.status !== 0) return { ok: false, sent: false, via: 'notify-send', error: (String(r.stderr || '').trim() || `notify-send exit=${r.status}`).slice(0, 200) }
    return { ok: true, sent: true, via: 'notify-send' }
  } catch (e) {
    return { ok: false, sent: false, via: 'nix-toast', error: String(e?.message ?? e) }
  }
}

/**
 * 发一条 Windows 通知。
 * @param {{ title?: string, body?: string, timeoutMs?: number, dryRun?: boolean }} o
 * @returns {{ ok: boolean, sent: boolean, error?: string, via?: string, skipped?: string }}
 *   永不抛异常。
 */
export function sendToast({ title = '刷抖音', body = '', timeoutMs = 20_000, dryRun = false, dir } = {}) {
  // ⭐ 非 Windows：Linux 用 libnotify 的 notify-send，macOS 用 osascript；
  //    都没有就明确返回 not_desktop（调用方按「只写报告」处理，**绝不抛异常**）。
  if (process.platform !== 'win32') {
    return sendToastNix({ title, body, timeoutMs, dryRun })
  }
  // ⭐ 默认落在插件家目录的 toast/（用户要求所有东西在 D 盘；实在没有家目录才退到 TEMP）
  const workDir = dir
    || (process.env.DOUYIN_DUTY_HOME ? join(process.env.DOUYIN_DUTY_HOME, 'toast') : join(process.env.TEMP || process.cwd(), 'dsh-douyin-toast'))
  const jsonFile = join(workDir, `msg-${process.pid}-${Date.now()}.json`)
  try {
    const ps1 = ensureScript(workDir)
    // 正文太长 Toast 也显示不全，先截断（留余量给标题行）
    const payload = {
      title: String(title || '刷抖音').slice(0, 64),
      body: String(body || '').slice(0, 220),
    }
    if (dryRun) return { ok: true, sent: false, via: 'toast', body: payload.body }
    writeFileSync(jsonFile, JSON.stringify(payload), 'utf8')

    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Json', jsonFile, '-Aumid', AUMID],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
    )
    const out = String(r.stdout || '') + String(r.stderr || '')
    if (r.error) return { ok: false, sent: false, via: 'toast', error: String(r.error.message || r.error) }
    if (r.status !== 0 || !/OK/.test(out)) {
      return { ok: false, sent: false, via: 'toast', error: (out.trim() || `powershell exit=${r.status}`).slice(0, 300) }
    }
    return { ok: true, sent: true, via: 'toast' }
  } catch (e) {
    return { ok: false, sent: false, via: 'toast', error: String(e?.message ?? e) }
  } finally {
    try { rmSync(jsonFile, { force: true }) } catch { /* 删不掉就算了 */ }
  }
}

/**
 * 报告 → Toast 两三行（**别**把 1200 字塞进通知里，人不会读）。
 * @returns {{ title: string, body: string, picked: number }}
 */
export function toastSummary(reportText, { maxItems = 2, day = '' } = {}) {
  const src = String(reportText ?? '')
  const pickedMatch = src.match(/kept\s*=\s*(\d+)/i) || src.match(/挑到\s*(\d+)\s*条/)
  const ids = [...src.matchAll(/^#{2,3}[ \t]*(\d{15,25})[ \t]*$/gm)].map((m) => m[1])
  const picked = ids.length || (pickedMatch ? Number(pickedMatch[1]) : 0)

  /**
   * ⭐ 从报告里抠出「每条推荐」的标题 / 作者 / 一句话。
   *
   * 🔴 2026-10-22 修的真 bug：以前只认**旧格式**（`- **文案摘要**：xxx`），
   *    但 `duty.md` 现在让模型写成：
   *        ### 7676464210544570726
   *        **《烟火里的江西》家常美食「香辣鸡爪」** · @烟火里的江西 · 39.6 秒 · 约 62 天前
   *        ...
   *        **一句话**：一个能照着做的鸡爪方子…
   *    ⇒ 解析不到 ⇒ 通知正文变成"（第 1 条）（第 2 条）"，等于没内容。
   *    现在**两种格式都认**，优先新格式。
   */
  const norm = (s) => String(s || '')
    .replace(/【[^】]*】/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // ── 新格式：按 `### <19位ID>` 切块，每块取第一条加粗行当标题、@后面的当作者、`**一句话**：`当评语
  const blocks = []
  {
    const re = /^#{2,3}[ \t]*(\d{15,25})[ \t]*$/gm
    const marks = [...src.matchAll(re)].map((m) => ({ id: m[1], at: m.index, end: m.index + m[0].length }))
    for (let i = 0; i < marks.length; i++) {
      const body = src.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : src.length)
      // 标题：块里第一个 `**...**` 开头但不是「一句话」的行
      let title = ''
      let author = ''
      let one = ''
      for (const line of body.split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        if (!title) {
          const m = /^\*\*(.+?)\*\*(.*)$/.exec(t)
          if (m && !/^一句话/.test(m[1]) && !/^为什么/.test(m[1]) && !/^注意/.test(m[1])) {
            title = m[1]
            // 同一行后面常有 ` · @作者 · 39.6 秒 · ...`
            const a = /@([^\s·|]+)/.exec(m[2] || '')
            if (a) author = a[1]
          }
        }
        if (!one) {
          const m = /^\*\*一句话\*\*[：:]\s*(.+)$/.exec(t) || /^-\s*\*\*值不值得点开\*\*[：:]\s*(.+)$/.exec(t)
          if (m) one = m[1]
        }
        if (title && author && one) break
      }
      blocks.push({ id: marks[i].id, title, author, one })
    }
  }

  // ── 旧格式兜底（`- **文案摘要**：` 那套）
  const oldTitles = [...src.matchAll(/^-\s*\*\*文案摘要\*\*[：:]\s*(.+)$/gm)].map((m) => m[1].trim())
  const oldAuthors = [...src.matchAll(/^-\s*\*\*作者\*\*[：:]\s*(.+)$/gm)].map((m) => m[1].trim())
  const oldJian = [...src.matchAll(/^-\s*\*\*值不值得点开\*\*[：:]\s*(.+)$/gm)].map((m) => m[1].trim())

  const items = blocks.length
    ? blocks.map((b, i) => ({
      title: b.title || oldTitles[i] || '',
      author: b.author || oldAuthors[i] || '',
      one: b.one || oldJian[i] || '',
    }))
    : oldTitles.map((t, i) => ({ title: t, author: oldAuthors[i] || '', one: oldJian[i] || '' }))

  const lines = []
  const n = Math.min(maxItems, items.length || ids.length)
  for (let i = 0; i < n; i++) {
    const it = items[i] || {}
    const t = norm(it.title).slice(0, 40)
    const a = norm(it.author).slice(0, 12)
    const v = norm(it.one).slice(0, 26)
    const bits = [t || `第 ${i + 1} 条`]
    if (a) bits.push('@' + a)
    if (v) bits.push(v)
    lines.push(`· ${bits.join(' ｜ ')}`)
  }
  if (ids.length > n) lines.push(`… 还有 ${ids.length - n} 条，见报告`)

  const title = `刷抖音${day ? ` · ${day}` : ''}｜挑到 ${picked} 条`
  const body = lines.length ? lines.join('\n') : '这一轮没有挑到值得看的视频（详情见报告文件）'
  return { title, body, picked }
}
