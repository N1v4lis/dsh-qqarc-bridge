/** 修掉换座位后过期的那条断言（DOM 兜底已删除），并把座位/React 约束写进去。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST = path.join(ROOT, 'test', 'client-half.test.mjs')
let t = fs.readFileSync(TEST, 'utf8')

const startMarker = "test('契约：客户端半边对 DOM 的写法是防御式的'"
const i = t.indexOf(startMarker)
if (i < 0) {
  console.log('⚠️ 没找到那条测试，请人工核对')
} else {
  // 找到该 test( ... }) 的结尾
  const end = t.indexOf('\n})\n', i)
  if (end < 0) { console.log('⚠️ 找不到测试结尾'); process.exit(1) }
  const replacement = [
    "test('契约：控件挂在会话头部座位，且渲染路径是防御式的', () => {",
    "  const src = fs.readFileSync(clientUrl, 'utf8')",
    "  // 座位：与 dsh-memory-evolve 的「复制会话 id」同一个（其 lib/client.js:18235）",
    "  assert.ok(/conversation\\.session\\.header\\.actions/.test(src), '要注册到会话头部动作区')",
    "  assert.ok(/require\\('react'\\)/.test(src), '用 React 渲染，props.sessionId 才能随会话切换更新')",
    "  assert.ok(/catch/.test(src), '任何异常都要吞掉：客户端半边不能影响 boot')",
    "  assert.ok(/ctx\\.effect/.test(src), '要绑生命周期并自清')",
    "  // 反面约束：不允许再\"自己插 DOM\"（那会与座位渲染重复、且切会话不跟手）",
    "  assert.ok(!/ANCHOR_SELECTORS/.test(src), '不应再有 DOM 兜底注入的选择器表')",
    "})",
  ].join('\n')
  t = t.slice(0, i) + replacement + t.slice(end + 3)
  fs.writeFileSync(TEST, t, 'utf8')
  console.log('✅ 断言已更新（座位 + React + 禁止 DOM 兜底）')
}

const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
console.log((r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)|^✖ /.test(l)).join('\n'))
process.exit(r.status === 0 ? 0 : 1)
