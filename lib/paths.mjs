/**
 * lib/paths.mjs —— 插件里**唯一**的路径来源
 * ============================================================================
 * 为什么要有这个文件：
 *   2026-10-22 之前，`tools/` 下 5 个 Python + 12 个 Node 脚本各自写死了
 *   `D:\DeepSeek\dsh-data\douyin-duty` 和 `C:\Program Files\Google\Chrome`。
 *   那是"某台机器上的脚本"，不是插件 —— 换台设备全挂，而且是**静默**挂
 *   （fallback 到别人的 D 盘，报一个莫名其妙的 ENOENT）。
 *
 * 规矩（写死，别再破）：
 *   ① 家目录只认 `DOUYIN_HOME`（宿主 `index.js` 从 `stateDirOf(ctx)` 注入）。
 *      没有就报错退出 —— **绝不**回落到任何写死的盘符。
 *   ② 插件包目录从本文件位置推出来，不写死。
 *   ③ 端口等运行时状态写 `$DOUYIN_HOME/runtime.json`，别的脚本读它，别各自写死。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（lib/ 的上一层） */
export const pluginDir = () => resolve(HERE, '..')

/**
 * 插件家目录 —— **唯一入口**。
 * 顺序：DOUYIN_HOME → DSH_HOME/douyin-duty → ~/.dsh/douyin-duty
 * 全都没有就抛错（不要猜，猜出来的路径一定是错的）。
 */
export function homeDir({ create = true } = {}) {
  const fromEnv = String(process.env.DOUYIN_HOME || '').trim()
  let dir = fromEnv
  if (!dir) {
    const dshHome = String(process.env.DSH_HOME || '').trim()
    dir = join(dshHome || join(homedir(), '.dsh'), 'douyin-duty')
  }
  if (!dir) throw new Error('拿不到插件家目录：请设置环境变量 DOUYIN_HOME')
  dir = resolve(dir)
  if (create) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * ⭐ 2026-10-26：**两套浏览器并存**。
 *
 * 问题：刷视频那一轮（可能跑十几分钟）会一直占着浏览器，私信回话只能排在它后面 ——
 *       使用者反馈「刷视频时回消息很慢」就是这个。
 * 解法：回话单独用一份 profile（`chrome-chat`，从主 profile 克隆登录态）+ 独立端口，
 *       两边互不干扰，真正做到"边刷边回"。
 * 开关：子进程环境变量 `DOUYIN_PROFILE_KIND=chat` / `DOUYIN_RUNTIME_KIND=chat`。
 */
export const profileDir = () => join(homeDir(), String(process.env.DOUYIN_PROFILE_KIND || '').trim() === 'chat' ? 'chrome-chat' : 'chrome-profile')
export const runtimeFile = () => join(homeDir(), String(process.env.DOUYIN_RUNTIME_KIND || '').trim() === 'chat' ? 'runtime-chat.json' : 'runtime.json')
export const configFile = () => join(homeDir(), 'config.json')
export const outDir = () => { const d = join(homeDir(), 'out'); mkdirSync(d, { recursive: true }); return d }
export const cookieFile = () => join(homeDir(), 'douyin_cookie.txt')

/** 读运行时状态（端口等）。读不到给空对象，不抛。 */
export function readRuntime() {
  try { return JSON.parse(readFileSync(runtimeFile(), 'utf8')) || {} } catch { return {} }
}

/** 合并写运行时状态。 */
export function writeRuntime(patch) {
  const next = { ...readRuntime(), ...(patch || {}) }
  try { writeFileSync(runtimeFile(), JSON.stringify(next, null, 2), 'utf8') } catch { /* 写不进去不致命 */ }
  return next
}

/** 有没有登录态（Cookie 文件存在且非空） */
export function hasCookie() {
  const f = cookieFile()
  try { return existsSync(f) && readFileSync(f, 'utf8').trim().length > 0 } catch { return false }
}
