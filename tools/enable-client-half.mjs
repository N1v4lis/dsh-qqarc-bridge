/**
 * 启用客户端半边（ModuleLoader 形态）+ 把"加载契约"固化成测试。
 *
 * 依据：dsh-memory-evolve/lib/client.js 第一行
 *   window.__ModuleLoader__.load({ id: "dsh-memory-evolve", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports; … return module.exports; } });
 * 我们的 lib/client.js 已按同一形态重写。
 *
 * 用法：node tools/enable-client-half.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'package.json')
const TEST = path.join(ROOT, 'test', 'client-half.test.mjs')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const out = []

// ── 1) package.json：重新声明客户端半边 ────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
fs.copyFileSync(PKG, path.join(ROOT, '_backup', `package.json.bak-enableclient-${Date.now()}`))
pkg.exports = pkg.exports || {}
pkg.exports['./client'] = './lib/client.js'
pkg.dsh = pkg.dsh || {}
pkg.dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] }
pkg.version = '1.0.2'
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
out.push('✅ package.json：已恢复 exports["./client"] 与 dsh.client（platform=web，inject=模块名），版本 1.0.2')

// ── 2) CHANGELOG ──────────────────────────────────────────────────────────
let cl = fs.readFileSync(CHANGELOG, 'utf8')
if (!cl.includes('## [1.0.2]')) {
  cl = cl.replace('# Changelog\n', [
    '# Changelog',
    '',
    '## [1.0.2] — 2026-10-10',
    '',
    '### 修复',
    '',
    '- **客户端半边按正确形态重写并重新启用**。逆向 `dsh-memory-evolve/lib/client.js` 得到契约：',
    '  客户端入口是一段脚本，必须调用 `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })`，',
    '  所有代码待在 factory 内（这样重复求值才有独立作用域）。',
    '  三次事故的证据链：`export` → 语法错误；顶层 `const` → 重复声明；自己包 IIFE 但不调 `__ModuleLoader__` → `import failed`。',
    '- 栏位注册到座位 `conversation.input.dock`（输入框上方），组件从 props 取 `sessionId`；',
    '  拿不到座位/React 时自动退回 DOM 注入，两条路都失败也只是栏位不出现（不影响 boot）。',
    '- 测试新增"加载契约"：伪造 `window.__ModuleLoader__` 真加载一次，断言 `id` 正确、`factory` 返回 `apply`/`inject`、',
    '  且**连续求值两次不抛错**。',
    '',
  ].join('\n'))
  fs.writeFileSync(CHANGELOG, cl, 'utf8')
  out.push('✅ CHANGELOG 已记录 1.0.2')
}

// ── 3) 测试：加载契约 + DOM 防御（整体重写，旧的"停用"断言已过时）────────────
fs.writeFileSync(TEST, `/**
 * 客户端半边契约测试。
 *
 * 三次真实 boot 事故（2026-10-10）换来的三条硬约束，全部固化成断言：
 *   ① 入口必须是调用 window.__ModuleLoader__.load 的**脚本**（写 export → Unexpected token 'export'）
 *   ② 所有代码必须在 factory 内（顶层 const → Identifier 'x' has already been declared）
 *   ③ 必须真的调用 __ModuleLoader__.load（自己包 IIFE → import failed）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const clientUrl = new URL('../lib/client.js', import.meta.url)
const clientPath = fileURLToPath(clientUrl)
const pkgUrl = new URL('../package.json', import.meta.url)

/** 剥注释后再做形态检查（注释里作为反例出现的 export/import 不该判红） */
function codeOnly(src) {
  return src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/^\\s*\\/\\/.*$/gm, '')
}

/** 在 vm 里伪造 ModuleLoader，真加载一次客户端入口 */
function loadInSandbox(src) {
  const loaded = []
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.reject(new Error('no network in test')),
    AbortSignal: { timeout: () => undefined },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.__ModuleLoader__ = {
    load: (def) => { loaded.push(def) },
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  return loaded
}

test('契约：入口是调用 __ModuleLoader__.load 的脚本（不是 ESM、不是裸 CJS）', () => {
  const raw = fs.readFileSync(clientUrl, 'utf8')
  const src = codeOnly(raw)
  assert.deepEqual(src.match(/^\\s*export\\s.+$/gm) || [], [], '不能有 export（加载器按脚本执行）')
  assert.deepEqual(src.match(/^\\s*import\\s.+$/gm) || [], [], '不能有 import')
  assert.ok(/window\\.__ModuleLoader__\\.load\\(/.test(src), '必须调用 window.__ModuleLoader__.load')
  assert.ok(/factory:\\s*\\(require\\)\\s*=>/.test(src), '必须给出 factory(require)')
  assert.ok(/return module\\.exports/.test(src), 'factory 必须 return module.exports')
})

test('契约：在伪造的 __ModuleLoader__ 下真加载，且连续求值两次不抛错', () => {
  const src = fs.readFileSync(clientPath, 'utf8')
  const first = loadInSandbox(src)
  assert.equal(first.length, 1, '必须注册恰好一个模块')
  assert.equal(first[0].id, 'dsh-dev-task-bridge', 'id 必须是包名')

  const mod = first[0].factory((name) => { throw new Error('测试环境没有 ' + name) })
  assert.equal(typeof mod.apply, 'function', 'factory 必须返回 apply')
  assert.ok(Array.isArray(mod.inject), 'factory 必须返回 inject')

  // 同一 context 里第二次求值：旧写法（顶层声明）在这里必炸
  const second = loadInSandbox(src)
  assert.equal(second.length, 1, '重复求值也要能成功注册')
})

test('契约：客户端半边对 DOM 的写法是防御式的', () => {
  const src = fs.readFileSync(clientUrl, 'utf8')
  assert.ok(/conversation\\.input\\.dock/.test(src), '要注册到输入框上方的座位')
  assert.ok(/ANCHOR_SELECTORS/.test(src), '要有 DOM 兜底锚点（候选列表，不写死一个）')
  assert.ok(/catch/.test(src), '任何异常都要吞掉：客户端半边不能影响 boot')
  assert.ok(/ctx\\.effect/.test(src), '要绑生命周期并自清')
})

test('契约：package.json 声明了客户端半边', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.deepEqual(pkg.dsh?.client?.inject, ['@deepseek-ai/dsh-client-runtime'], '这个字段写模块名，与先例一致')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch 也要在（宿主半边靠它 insert）')
  assert.match(String(pkg.version), /^1\\.0\\.\\d+$/)
  assert.ok(!pkg.private, '发布的包不能是 private')
})

test('契约：宿主半边的 7 条路由与工具都在源码里', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const p of ['/dev-task', '/dev-task/status', '/dev-task/metrics', '/dev-task/sessions', '/dev-task/qq', '/dev-task/scan', '/dev-task/panel']) {
    assert.ok(src.includes(\`path: '\${p}'\`), \`缺少路由 \${p}\`)
  }
  assert.ok(src.includes("name: 'dev_task_result'"), '缺少 dev_task_result 工具')
})
`, 'utf8')
out.push('✅ 测试已重写：加载契约（伪造 ModuleLoader + 连续求值两次）+ DOM 防御 + 包声明')

console.log(out.join('\n'))
