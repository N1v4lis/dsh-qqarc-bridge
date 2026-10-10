/**
 * 一击修复：客户端半边必须 `exports.inject = ['slots']`。
 *
 * 证据（客户端自报，2026-10-10）：
 *   register 抛错：cannot get property "slots" without inject
 * 即客户端 Cordis 对服务访问有"先声明依赖"的门禁 —— 没 inject 就取 ctx.slots 会直接抛。
 * 先例 dsh-theme-tarkov 的客户端半边结尾正是 `exports.inject = ['slots']`。
 * 我上一版把它写成了 []（因为当时没用座位），所以拿不到 slots。
 *
 * 用法：node tools/fix-inject-slots.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'lib', 'client.js')
const PKG = path.join(ROOT, 'package.json')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const out = []

let s = fs.readFileSync(CLIENT, 'utf8')
fs.copyFileSync(CLIENT, path.join(ROOT, '_backup', `client.js.bak-injectslots-${Date.now()}`))

if (s.includes("exports.inject = ['slots']")) {
  out.push('（已经是 slots 依赖）')
} else if (s.includes('exports.inject = []')) {
  s = s.replace('exports.inject = []',
    "// ⚠️ 客户端 Cordis 有"先声明依赖"的门禁：不声明就取 ctx.slots 会抛\n"
    + "    //    `cannot get property \"slots\" without inject`（自报里抓到的原文）。\n"
    + "    //    先例 dsh-theme-tarkov 结尾就是 exports.inject = ['slots']。\n"
    + "    exports.inject = ['slots']")
  fs.writeFileSync(CLIENT, s, 'utf8')
  out.push("✅ exports.inject 改为 ['slots']")
} else {
  out.push('⚠️ 找不到 exports.inject 那一行，请人工核对')
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
pkg.version = '1.0.5'
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
out.push('✅ 版本 → 1.0.5')

let cl = fs.readFileSync(CHANGELOG, 'utf8')
if (!cl.includes('## [1.0.5]')) {
  cl = cl.replace('# Changelog\n', [
    '# Changelog',
    '',
    '## [1.0.5] — 2026-10-10',
    '',
    '### 修复（真正让控件出现的那一行）',
    '',
    '- 客户端半边补回服务声明：**`exports.inject = [\'slots\']`**。',
    '  自报给出的原文是 `register 抛错：cannot get property "slots" without inject` ——',
    '  客户端 Cordis 对服务访问有"先声明依赖"的门禁，没声明就取 `ctx.slots` 会直接抛。',
    '  1.0.4 曾把取值改成属性访问（方向对），但没声明依赖，仍然抛。',
    '  先例 dsh-theme-tarkov 的客户端入口结尾正是这一行。',
    '- 三次取值问题的完整序列：`ctx.get(\'slots\')` 拿不到 → `ctx.slots` 未声明就取会抛 → 声明后可用。',
    '',
  ].join('\n'))
  fs.writeFileSync(CHANGELOG, cl, 'utf8')
  out.push('✅ CHANGELOG 已记录 1.0.5')
}

const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
out.push((r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)|^✖ /.test(l)).join('\n'))
console.log(out.join('\n'))
process.exit(r.status === 0 ? 0 : 1)
