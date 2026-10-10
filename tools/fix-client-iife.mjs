/**
 * 紧急修复：把客户端半边包进 IIFE（消除"重复声明"导致的 boot 失败），并修正 dsh.client.inject。
 *
 * 证据（crash-2026-10-10T12-58-03-437Z-web-boot.log）：
 *   dsh-dev-task-bridge/client.js:1 Uncaught SyntaxError: Identifier 'BAR_ID' has already been declared
 *   → web boot: 1 entry did not activate
 * 原因：加载器会在**同一作用域内重新求值**客户端模块，文件顶层的 const 第二次就撞车。
 * 先例 dsh-theme-tarkov 的形态正是「整个文件体包在 (function(){ var exports = module.exports; … return module.exports })()」。
 *
 * 用法：node tools/fix-client-iife.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'lib', 'client.js')
const PKG = path.join(ROOT, 'package.json')
const TEST = path.join(ROOT, 'test', 'client-half.test.mjs')
const out = []

// ── 1) client.js：包进 IIFE ────────────────────────────────────────────────
let src = fs.readFileSync(FILE, 'utf8')
fs.copyFileSync(FILE, path.join(ROOT, '_backup', `client.js.bak-iife-${Date.now()}`))

if (src.includes('var __host =')) {
  out.push('（client.js 已是 IIFE 形态）')
} else {
  const header = [
    "(function () {",
    "  'use strict'",
    '  // 宿主形态兜底：加载器会注入 module/exports；万一没有（普通脚本环境）就落到 globalThis',
    '  var __host = (typeof module === \'object\' && module && module.exports)',
    '    ? module.exports',
    '    : (globalThis.__dshDevTaskBridgeClient = globalThis.__dshDevTaskBridgeClient || {})',
    '',
  ].join('\n')

  const anchor = "const BAR_ID = 'dev-task-bridge-bar'"
  if (!src.includes(anchor)) { console.error('❌ 找不到 BAR_ID 锚点'); process.exit(1) }
  src = src.replace(anchor, header + anchor)

  // 结尾：原来的三形态 __exports 段 换成 IIFE 的返回
  const tailFrom = src.indexOf('const __exports =')
  if (tailFrom < 0) { console.error('❌ 找不到 __exports 段'); process.exit(1) }
  src = src.slice(0, tailFrom) + [
    '  // 运行时服务依赖：本栏位纯 DOM，不需要任何服务',
    '  __host.inject = []',
    '  __host.apply = apply',
    '  return __host',
    '})()',
    '',
  ].join('\n')

  fs.writeFileSync(FILE, src, 'utf8')
  out.push('✅ client.js 已包进 IIFE（顶层再无声明 → 重新求值不会重复声明）')
}

// 语法检查（按 CJS 脚本）
{
  const probe = path.join(ROOT, '_backup', 'client-probe.cjs')
  fs.writeFileSync(probe, fs.readFileSync(FILE, 'utf8'), 'utf8')
  const r = spawnSync('node', ['-e', `const m=require(${JSON.stringify(probe)});console.log('  apply=' + typeof m.apply + ' inject=' + JSON.stringify(m.inject))`], { encoding: 'utf8' })
  out.push(r.status === 0 ? '✅ .cjs 加载通过：' + r.stdout.trim() : '❌ .cjs 加载失败：' + (r.stderr || '').slice(0, 300))
  if (r.status !== 0) process.exit(1)
}

// ── 2) package.json：dsh.client.inject 要写**模块名**（先例都是 dsh-client-runtime）──
{
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
  const cur = JSON.stringify(pkg.dsh?.client?.inject)
  if (cur !== '["@deepseek-ai/dsh-client-runtime"]') {
    fs.copyFileSync(PKG, path.join(ROOT, '_backup', `package.json.bak-clientinject-${Date.now()}`))
    pkg.dsh.client.inject = ['@deepseek-ai/dsh-client-runtime']
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    out.push(`✅ dsh.client.inject: ${cur} → ["@deepseek-ai/dsh-client-runtime"]（与两个先例一致）`)
  } else out.push('（dsh.client.inject 已正确）')
}

// ── 3) 测试断言同步（__exports → __host；inject 由 ['slots'] 变 []）────────
{
  let t = fs.readFileSync(TEST, 'utf8')
  const before = t
  t = t.replace("assert.ok(/-__exports\\.apply\\s*=/.test(src) || /__exports\\.apply\\s*=/.test(src), '必须以 CommonJS 方式导出 apply')",
    "assert.ok(/__host\\.apply\\s*=/.test(src), '必须以 CommonJS 方式导出 apply')")
  t = t.replace("assert.ok(/__exports\\.inject\\s*=/.test(src), '必须以 CommonJS 方式导出 inject')",
    "assert.ok(/__host\\.inject\\s*=/.test(src), '必须以 CommonJS 方式导出 inject')")
  t = t.replace("assert.deepEqual(mod.inject, ['slots'])", "assert.deepEqual(mod.inject, [])")
  t = t.replace("assert.ok(raw.includes('module') && raw.includes('exports'), '要对宿主注入的 module/exports 做兜底')",
    "assert.ok(/^\\(function \\(\\) \\{/m.test(raw), '整个文件必须包在 IIFE 里（顶层声明会在重复求值时撞车）')")
  if (t !== before) { fs.writeFileSync(TEST, t, 'utf8'); out.push('✅ 测试断言已同步（__host / inject [] / IIFE）') }
  else out.push('（测试断言无需改动）')
}

console.log(out.join('\n'))
