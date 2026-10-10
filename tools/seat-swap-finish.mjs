/** 换座位后的收尾：同步测试断言、升版本 1.0.3、写 CHANGELOG、跑测试。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST = path.join(ROOT, 'test', 'client-half.test.mjs')
const PKG = path.join(ROOT, 'package.json')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const out = []

// 1) 测试断言：座位换了
let t = fs.readFileSync(TEST, 'utf8')
if (t.includes("conversation\\.input\\.dock")) {
  t = t.replace(/\/conversation\\\\\.input\\\\\.dock\/\.test\(src\), '要注册到输入框上方的座位'\)/,
    "/conversation\\\\.session\\\\.header\\\\.actions/.test(src), '要注册到会话头部动作区（与 dsh-memory-evolve 的复制 id 同座位）')")
  fs.writeFileSync(TEST, t, 'utf8')
  out.push('✅ 测试断言已改为 conversation.session.header.actions')
} else out.push('（测试断言无需改动）')

// 2) 版本 1.0.3
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
pkg.version = '1.0.3'
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
out.push('✅ 版本 → 1.0.3')

// 3) CHANGELOG
let cl = fs.readFileSync(CHANGELOG, 'utf8')
if (!cl.includes('## [1.0.3]')) {
  cl = cl.replace('# Changelog\n', [
    '# Changelog',
    '',
    '## [1.0.3] — 2026-10-10',
    '',
    '### 变更（按用户要求换位置 + 修切会话不跟手）',
    '',
    '- **座位换到 `conversation.session.header.actions`**（会话头部右侧那一排，与 dsh-memory-evolve 的',
    '  「复制会话 id」按钮同一个座位）—— 1.0.2 放在输入框上方，位置不对。',
    '- **改为 React 渲染**：控件由座位交给 React，`props.sessionId` 随会话切换变化 → 自动跟着更新；',
    '  之前用"自己插 DOM + 单例节点"，导致 id 停在首次捕获的会话（切换不跟手）。',
    '- **删除 DOM 兜底注入**：它会和座位渲染重复；现在座位失败就只是控件不显示，功能仍可走 `/dev-task/panel`。',
    '- 控件内容：本会话 id（截断显示、悬停看全文、一键复制）+ 当前回传目标与是否活着 + 「设为目标」+ 会话区入口。',
    '',
  ].join('\n'))
  fs.writeFileSync(CHANGELOG, cl, 'utf8')
  out.push('✅ CHANGELOG 已记录 1.0.3')
}

// 4) 跑测试
const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
out.push((r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)|^✖ /.test(l)).join('\n'))
console.log(out.join('\n'))
process.exit(r.status === 0 ? 0 : 1)
