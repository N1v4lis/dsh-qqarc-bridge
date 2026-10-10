/**
 * 停用客户端半边（保界面可用）。
 *
 * 背景：客户端半边连续两次让 web boot 起不来 ——
 *   ① ESM 形态 → Uncaught SyntaxError: Unexpected token 'export'
 *   ② 顶层 const → Identifier 'BAR_ID' has already been declared（加载器会在同一作用域重新求值）
 *   改成 IIFE + CJS 后语法错误消失（新日志里已无 renderer 语法报错），但加载器**仍然**
 *   判定 `dsh-dev-task-bridge: import failed`，而且它不打印更细的原因。
 *   两个已装先例（dsh-memory-evolve / dsh-theme-tarkov）发布的都是**预构建产物**（esbuild 打的包），
 *   推测本机加载器要的就是那种形态 —— 在搞清楚之前，不该再让用户的界面承担风险。
 *
 * 本脚本：从 package.json 移除 dsh.client 与 exports['./client']（lib/client.js 保留在仓库里，
 * 不删代码），版本升到 1.0.1 并在 CHANGELOG 记录。
 *
 * 用法：node tools/disable-client-half.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'package.json')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const out = []

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
fs.copyFileSync(PKG, path.join(ROOT, '_backup', `package.json.bak-disableclient-${Date.now()}`))

if (pkg.dsh && pkg.dsh.client) {
  delete pkg.dsh.client
  out.push('✅ 已从 package.json 移除 dsh.client（宿主半边不受影响）')
} else out.push('（dsh.client 已不存在）')

if (pkg.exports && pkg.exports['./client']) {
  delete pkg.exports['./client']
  out.push('✅ 已移除 exports["./client"]（lib/client.js 文件保留在仓库里，只是不再被加载）')
} else out.push('（exports["./client"] 已不存在）')

pkg.version = '1.0.1'
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
out.push('✅ 版本 → 1.0.1')

// CHANGELOG
let cl = fs.readFileSync(CHANGELOG, 'utf8')
if (!cl.includes('## [1.0.1]')) {
  const entry = [
    '## [1.0.1] — 2026-10-10',
    '',
    '### 修复（界面可用性优先）',
    '',
    '- **停用客户端半边**（`dsh.client` / `exports["./client"]` 从 package.json 移除）。',
    '  它连续两次让 DSH 的 web boot 失败：',
    '  1. ESM 形态 → `Uncaught SyntaxError: Unexpected token \'export\'`（加载器按普通脚本执行它）；',
    '  2. 顶层 `const` → `Identifier \'BAR_ID\' has already been declared`（加载器会在同一作用域重新求值）；',
    '  改成 IIFE + CommonJS 后语法错误消失，但加载器**仍然**报 `import failed`（不打印更细的原因）。',
    '  两个已装先例发布的都是**预构建产物**，推测加载器要的就是那种形态 —— 搞清楚之前不再动用户界面。',
    '- 宿主半边（7 条路由 + `dev_task_result` 工具 + 多 QQ 路由 + 会话区索引）不受影响，功能照旧；',
    '  会话区依然可以通过 `GET /dev-task/sessions`、`GET /dev-task/panel` 与 `npm run sessions` 使用。',
    '',
    '### 保留',
    '',
    '- `lib/client.js`（IIFE 形态）与 `tools/fix-client-iife.mjs`、`test/client-half.test.mjs` 都留在仓库里，',
    '  等改成预构建产物后再启用。',
    '',
  ].join('\n')
  cl = cl.replace('# Changelog\n', '# Changelog\n\n' + entry)
  fs.writeFileSync(CHANGELOG, cl, 'utf8')
  out.push('✅ CHANGELOG 已记录 1.0.1')
}

// 契约测试同步：不再要求 dsh.client
const TEST = path.join(ROOT, 'test', 'client-half.test.mjs')
let t = fs.readFileSync(TEST, 'utf8')
if (t.includes("assert.equal(pkg.dsh?.client?.platform, 'web')")) {
  t = t.replace(/test\('契约：package\.json 声明了客户端半边且指向 lib\/client\.js'[\s\S]*?\n\}\)\n/, [
    "test('契约：客户端半边当前处于停用状态（界面可用性优先）', () => {",
    "  const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'))",
    "  // 2026-10-10：连续两次 boot 事故后停用；重新启用前必须先搞清加载器要的形态（见 CHANGELOG 1.0.1）",
    "  assert.equal(pkg.dsh?.client, undefined, 'dsh.client 应为空（停用中）')",
    "  assert.equal(pkg.exports?.['./client'], undefined, 'exports[\"./client\"] 应为空（停用中）')",
    "  assert.ok(fs.existsSync(clientPath), 'lib/client.js 仍应保留在仓库里')",
    "  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch 仍要在（宿主半边靠它 insert）')",
    "  assert.equal(pkg.version, '1.0.1')",
    "  assert.ok(!pkg.private, '发布的包不能是 private')",
    "})",
    '',
  ].join('\n'))
  fs.writeFileSync(TEST, t, 'utf8')
  out.push('✅ 契约测试已改为"客户端半边处于停用状态"')
}

console.log(out.join('\n'))
