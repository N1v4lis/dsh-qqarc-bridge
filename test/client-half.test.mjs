/**
 * 契约测试：客户端半边（lib/client.js）与 package.json 的声明。
 *
 * 为什么值得单独测：客户端半边跑在 DSH 的**客户端加载器**里 ——
 * 已装的两个先例（dsh-memory-evolve / dsh-theme-tarkov）的 lib/client.js 都是
 * **打包产物**（CJS 包装 + require），说明那条路要过构建。
 * 本插件故意走"零依赖 DOM 注入"，好让"改完重启就能用"成立。
 * 这些断言就是把这个决定**钉死**：谁哪天顺手加了 import，测试立刻红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const clientUrl = new URL('../lib/client.js', import.meta.url)
const pkgUrl = new URL('../package.json', import.meta.url)

/** 剥掉注释：注释里出现 require('react') 这类"讲反例"的文字很正常，不该被判红 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('契约：客户端半边零依赖（不得出现 import / require）', () => {
  const raw = fs.readFileSync(clientUrl, 'utf8')
  const src = codeOnly(raw)
  const imports = src.match(/^\s*import\s.+$/gm) || []   // match 无匹配返回 null，不是 []
  assert.deepEqual(imports, [], '客户端半边不能有顶层 import —— 加载器不保证解析外部依赖')
  assert.ok(!/\brequire\s*\(/.test(src), '客户端半边不能有 require')
  assert.ok(/export function apply\s*\(/.test(raw), '必须导出 apply')
  assert.ok(/export const inject\s*=/.test(raw), '必须导出 inject（声明要用的客户端服务）')
  assert.ok(raw.includes('conversation.input.dock'), '注释里要写清座位依据（为什么不用 slots）')
})

test('契约：客户端半边对 DOM 的写法是防御式的', () => {
  const src = fs.readFileSync(clientUrl, 'utf8')
  assert.ok(/ANCHOR_SELECTORS/.test(src), '锚点必须走"候选选择器列表"，不能写死一个')
  assert.ok(/MutationObserver/.test(src) && /setInterval/.test(src), '要能等首屏 DOM 稳定后再挂')
  assert.ok(/catch/.test(src), '任何异常都要吞掉：客户端半边不能影响宿主半边')
  assert.ok(/dispose/.test(src) && /ctx\.effect/.test(src), '要绑生命周期并自清')
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
