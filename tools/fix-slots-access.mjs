/**
 * 一击修复：slots 服务要从**属性**上取（ctx.slots），不是 ctx.get('slots')。
 *
 * 证据（客户端自报，2026-10-10）：
 *   { event: "apply", registered: false, detail: "ctx.get(\"slots\") 拿不到 slots 服务", hasCtx: true }
 * 先例 dsh-memory-evolve 用的就是属性访问：lib/client.js:18220 `ctx.slots.inject("…", …)`。
 * 我上一版写成 `ctx.get('slots')`，它返回 undefined，于是永远走不到注册那一步。
 *
 * 用法：node tools/fix-slots-access.mjs
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
fs.copyFileSync(CLIENT, path.join(ROOT, '_backup', `client.js.bak-slots-${Date.now()}`))

const from = '        var slots = ctx && typeof ctx.get === \'function\' ? ctx.get(\'slots\') : (ctx && ctx.slots)'
const to = [
  '        // ⚠️ slots 要**先从属性上取**：先例 dsh-memory-evolve 用的就是 ctx.slots.inject(...)，',
  '        //    上一版写 ctx.get(\'slots\') 拿到的是 undefined（自报里就是这么暴露出来的）。',
  '        var slots = (ctx && ctx.slots)',
  '          || (ctx && typeof ctx.get === \'function\' ? ctx.get(\'slots\') : null)',
].join('\n')

if (!s.includes(from)) {
  out.push('⚠️ 锚点未匹配，请人工核对 lib/client.js 里的 slots 取值那一行')
} else {
  s = s.replace(from, to)
  fs.writeFileSync(CLIENT, s, 'utf8')
  out.push('✅ 已改为 ctx.slots 优先、ctx.get(\'slots\') 兜底')
}

// 版本 1.0.4
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
pkg.version = '1.0.4'
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
out.push('✅ 版本 → 1.0.4')

let cl = fs.readFileSync(CHANGELOG, 'utf8')
if (!cl.includes('## [1.0.4]')) {
  cl = cl.replace('# Changelog\n', [
    '# Changelog',
    '',
    '## [1.0.4] — 2026-10-10',
    '',
    '### 修复',
    '',
    '- **控件不出现的真正原因：取 slots 的方式错了。** 客户端自报给了决定性证据：',
    '  `{ event: "apply", registered: false, detail: "ctx.get(\\"slots\\") 拿不到 slots 服务", hasCtx: true }`',
    '  —— 模块加载了、apply 也执行了，只是 `ctx.get(\'slots\')` 返回 undefined。',
    '  先例 dsh-memory-evolve 用的是**属性访问** `ctx.slots.inject(…)`（其 lib/client.js:18220）。',
    '  现改为 `ctx.slots` 优先、`ctx.get(\'slots\')` 兜底。',
    '- 自报通道保留（`/dev-task/client-report`）：以后这类问题一条命令就能定位。',
    '',
  ].join('\n'))
  fs.writeFileSync(CHANGELOG, cl, 'utf8')
  out.push('✅ CHANGELOG 已记录 1.0.4')
}

const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
out.push((r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)|^✖ /.test(l)).join('\n'))
console.log(out.join('\n'))
process.exit(r.status === 0 ? 0 : 1)
