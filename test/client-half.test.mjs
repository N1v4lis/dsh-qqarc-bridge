/**
 * 契约测试：客户端半边（lib/client.js）与 package.json 的声明。
 *
 * 背景（2026-10-10 真实事故）：客户端半边曾写成 ESM（`export function apply`），
 * 客户端加载器把它当**普通脚本**执行 → 控制台 `Uncaught SyntaxError: Unexpected token 'export'`
 * → `web boot: 1 entry did not activate` → **整个界面起不来**。
 * 教训：加载器给的是 CommonJS 环境（`module` / `exports` / `require`），不是 ESM ——
 * 这也是两个已装先例（dsh-memory-evolve / dsh-theme-tarkov）都发布打包产物的原因。
 *
 * 所以下面两条断言就是"事故复现测试"，把这个形态钉死。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const clientUrl = new URL('../lib/client.js', import.meta.url)
const clientPath = path.resolve(new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgUrl = new URL('../package.json', import.meta.url)

/** 剥掉注释：注释里作为"反例"出现的 export/require 文字不该被判红 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('契约：客户端半边必须是 CommonJS 形态（不得出现 export / import）', () => {
  const raw = fs.readFileSync(clientUrl, 'utf8')
  const src = codeOnly(raw)
  assert.deepEqual(src.match(/^\s*export\s.+$/gm) || [], [], '客户端半边不能有 export —— 加载器按普通脚本执行它')
  assert.deepEqual(src.match(/^\s*import\s.+$/gm) || [], [], '客户端半边不能有 import')
  assert.ok(/-__exports\.apply\s*=/.test(src) || /__exports\.apply\s*=/.test(src), '必须以 CommonJS 方式导出 apply')
  assert.ok(/__exports\.inject\s*=/.test(src), '必须以 CommonJS 方式导出 inject')
  assert.ok(/CommonJS/.test(raw), '注释里要写清形态约束（CommonJS，不是 ESM）与那次 boot 事故')
  assert.ok(raw.includes('module') && raw.includes('exports'), '要对宿主注入的 module/exports 做兜底')
})

test('契约：客户端半边能被当作 CommonJS 脚本加载（事故复现测试）', () => {
  // 本包是 "type": "module"，所以 .js 走 ESM 解析 —— 要模拟加载器那种 CJS 环境，
  // 必须复制成 .cjs 再 require。ESM 写法会在这里直接抛语法错误。
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-')), 'client.cjs')
  fs.copyFileSync(clientPath, tmp)
  const require_ = createRequire(import.meta.url)
  const mod = require_(tmp)
  assert.equal(typeof mod.apply, 'function', 'apply 必须可调用')
  assert.deepEqual(mod.inject, ['slots'])
})

test('契约：客户端半边对 DOM 的写法是防御式的', () => {
  const src = fs.readFileSync(clientUrl, 'utf8')
  assert.ok(/ANCHOR_SELECTORS/.test(src), '锚点必须走"候选选择器列表"，不能写死一个')
  assert.ok(/MutationObserver/.test(src) && /setInterval/.test(src), '要能等首屏 DOM 稳定后再挂')
  assert.ok(/catch/.test(src), '任何异常都要吞掉：客户端半边不能影响 boot 与宿主半边')
  assert.ok(/dispose/.test(src) && /ctx\.effect/.test(src), '要绑生命周期并自清')
  assert.ok(!/\brequire\s*\(/.test(codeOnly(src)), '不 require 任何东西（连 React 都不需要）')
})

test('契约：package.json 声明了客户端半边且指向 lib/client.js', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('slots'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch 也要在（宿主半边靠它 insert）')
  assert.equal(pkg.version, '1.0.0')
  assert.ok(!pkg.private, '发布的包不能是 private')
})

test('契约：宿主半边的 7 条路由与工具都在源码里', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const p of ['/dev-task', '/dev-task/status', '/dev-task/metrics', '/dev-task/sessions', '/dev-task/qq', '/dev-task/scan', '/dev-task/panel']) {
    assert.ok(src.includes(`path: '${p}'`), `缺少路由 ${p}`)
  }
  assert.ok(src.includes("name: 'dev_task_result'"), '缺少 dev_task_result 工具')
})
