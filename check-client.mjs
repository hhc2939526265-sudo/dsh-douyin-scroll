#!/usr/bin/env node
/**
 * check-client.mjs —— 体检：DSH 能不能认出这个插件的 client 面板
 * 用法：node check-client.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const PROF = process.env.DSH_PROFILE_DIR || 'D:\\DeepSeek\\dsh-data\\profiles\\desktop'
const PKG = 'dsh-douyin-scroll'

const ok = (m) => console.log('✅ ' + m)
const bad = (m, fix) => { console.log('❌ ' + m); if (fix) console.log('     → ' + fix) }

console.log('=== 1. 包能不能被解析 ===')
let pkgJson = ''
try {
  const req = createRequire(join(PROF, 'package.json'))
  pkgJson = req.resolve(PKG + '/package.json')
  ok('解析到 ' + pkgJson)
} catch (e) {
  bad('解析不到 ' + PKG, 'dsh plugin --profile desktop add link:<绝对路径>')
  process.exit(1)
}

console.log('\n=== 2. 是真实目录还是软链 ===')
let real = true
try {
  const st = statSync(join(PROF, 'node_modules', PKG))
  // statSync 会跟随软链；用 lstat 判断
  const { lstatSync } = await import('node:fs')
  const ls = lstatSync(join(PROF, 'node_modules', PKG))
  real = !ls.isSymbolicLink()
  if (real) ok('真实目录（DSH 能正确定位包根）')
  else bad('是软链/Junction —— DSH 的 locatePkgJson 会解析到别处，面板加载不出来',
    '删掉软链，改成真实目录拷贝：rmdir 链接 && Copy-Item 源目录 目标 -Recurse')
} catch (e) { console.log('（跳过）', e.message) }

console.log('\n=== 3. package.json 声明 ===')
const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
const decl = pkg.dsh?.client
if (!decl) bad('没有 dsh.client 声明', 'package.json 里加 dsh.client.platform = "web"')
else {
  if (decl.platform === 'web') ok('dsh.client.platform = web')
  else bad('platform = ' + decl.platform + '，必须是 web')
}

console.log('\n=== 4. client 入口文件 ===')
const rel = typeof pkg.exports?.['./client'] === 'string'
  ? pkg.exports['./client']
  : pkg.exports?.['./client']?.default
if (!rel) bad('exports 里没有 "./client"', '加 "./client": "./client.js"')
else {
  const p = join(dirname(pkgJson), rel)
  if (!existsSync(p)) bad('文件不存在：' + p, '重新拷贝插件目录')
  else {
    const src = readFileSync(p, 'utf8')
    ok('文件在：' + p + '（' + statSync(p).size + ' 字节）')
    if (!/__ModuleLoader__/.test(src)) bad('里面没有 __ModuleLoader__.load —— 不会被当成 client bundle')
    else ok('有 __ModuleLoader__.load')
    // 语法检查
    try { new Function(src); ok('语法能过') }
    catch (e) { bad('语法错误：' + e.message) }
  }
}

console.log('\n=== 5. profile 里有没有启用 ===')
const patch = join(PROF, 'cordis.patch.yml')
if (existsSync(patch)) {
  const y = readFileSync(patch, 'utf8')
  if (/id:\s*douyin-scroll/.test(y) && /name:\s*dsh-douyin-scroll/.test(y)) ok('cordis.patch.yml 里有 douyin-scroll 条目')
  else bad('profile 的 patch 里没有这个插件', 'dsh plugin --profile desktop add link:<路径>')
  if (/enabled:\s*true/.test(y)) ok('看起来是启用的')
} else bad('找不到 cordis.patch.yml')

console.log('\n=== 6. bundle 列表 ===')
try {
  const pp = JSON.parse(readFileSync(join(PROF, 'package.json'), 'utf8'))
  const list = pp.dsh?.profile?.bundles || []
  if (list.includes(PKG)) ok('bundles 里有 ' + PKG)
  else bad('bundles 里没有 ' + PKG, JSON.stringify(list))
} catch (e) { console.log('（跳过）', e.message) }
