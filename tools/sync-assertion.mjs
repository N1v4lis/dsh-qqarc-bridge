/** 同步那条过期的契约断言（dsh.client.inject 现在写模块名，不再是 'slots'），并跑测试。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST = path.join(ROOT, 'test', 'client-half.test.mjs')
let t = fs.readFileSync(TEST, 'utf8')
const before = t

const oldLine = "assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('slots'))"
const newLine = "assert.deepEqual(pkg.dsh?.client?.inject, ['@deepseek-ai/dsh-client-runtime'], 'dsh.client.inject 写模块名（与先例一致），不是服务名')"
if (t.includes(oldLine)) {
  t = t.replace(oldLine, newLine)
  fs.writeFileSync(TEST, t, 'utf8')
  console.log('✅ 断言已同步为模块名')
} else {
  console.log(t.includes('@deepseek-ai/dsh-client-runtime') ? '（断言已是模块名）' : '⚠️ 没找到该断言，请人工核对')
}

const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
const summary = (r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)/.test(l))
console.log(summary.join('\n'))
process.exit(r.status === 0 ? 0 : 1)
