/**
 * 提升「回传目标」控件的对比度：改用 DSH 官方主题令牌（带兜底色）。
 *
 * 令牌来自 client 端 Theme 服务（cordis_inspect_query → Theme.listTokens）：
 *   --dsw-alias-label-primary / -secondary   文本
 *   --dsw-alias-bg-layer-1 / -2              抬升面
 *   --dsw-alias-border-l1 / -l2              边框
 *   --dsw-alias-brand-primary                主色
 *   --dsw-alias-state-success-primary / -warn-primary / -idle-primary
 * 全部要求"明暗两套"，所以用 var(--token, 兜底色) 写，缺令牌时也不会掉回低对比度。
 *
 * 用法：node tools/boost-widget-contrast.mjs
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
fs.copyFileSync(CLIENT, path.join(ROOT, '_backup', `client.js.bak-contrast-${Date.now()}`))

const start = s.indexOf("    var CSS = ''")
const endMarker = "+ '.dtb-wrap .ok{color:#3fb950}.dtb-wrap .warn{color:#d29922}'"
const end = s.indexOf(endMarker)
if (start < 0 || end < 0) {
  console.error('❌ 找不到 CSS 块（start=' + start + ', end=' + end + '）')
  process.exit(1)
}

const newCss = [
  "    // 颜色全部走 DSH 官方主题令牌（各带兜底色）——令牌要求明暗两套，",
  "    // 所以浅色/深色主题下对比度都够；之前写死 #e6e6e6 + 半透明灰，浅色主题下几乎看不见。",
  "    var T = {",
  "      label: 'var(--dsw-alias-label-primary, #1f2328)',",
  "      label2: 'var(--dsw-alias-label-secondary, #5b6470)',",
  "      layer1: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.10))',",
  "      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.20))',",
  "      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.45))',",
  "      brand: 'var(--dsw-alias-brand-primary, #2563eb)',",
  "      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',",
  "      warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',",
  "      idle: 'var(--dsw-alias-state-idle-primary, #6b7280)',",
  "    }",
  "    var CSS = ''",
  "      + '.dtb-wrap{display:flex;align-items:center;gap:6px;font:12px/1.4 system-ui,\"Segoe UI\",sans-serif;white-space:nowrap;'",
  "      + 'color:' + T.label2 + ';border:1px solid ' + T.border + ';border-radius:8px;padding:2px 6px;background:' + T.layer1 + '}'",
  "      + '.dtb-wrap code{background:' + T.layer2 + ';color:' + T.label + ';padding:1px 5px;border-radius:4px;'",
  "      + 'font-size:11px;font-weight:600;border:1px solid ' + T.border + '}'",
  "      + '.dtb-wrap button{font:inherit;font-weight:600;color:' + T.label + ';background:' + T.layer2 + ';'",
  "      + 'border:1px solid ' + T.border + ';border-radius:6px;padding:2px 8px;cursor:pointer}'",
  "      + '.dtb-wrap button:hover{background:' + T.layer1 + ';border-color:' + T.label2 + '}'",
  "      + '.dtb-wrap button.primary{background:' + T.brand + ';border-color:' + T.brand + ';color:#fff}'",
  "      + '.dtb-wrap button:disabled{opacity:.6;cursor:default}'",
  "      + '.dtb-wrap a{color:' + T.brand + ';font-weight:600;text-decoration:none}'",
  "      + '.dtb-wrap a:hover{text-decoration:underline}'",
  "      + '.dtb-wrap .ok{color:' + T.ok + ';font-weight:600}'",
  "      + '.dtb-wrap .warn{color:' + T.warn + ';font-weight:600}'",
  "      + '.dtb-wrap .idle{color:' + T.idle + '}'",
].join('\n')

s = s.slice(0, start) + newCss + s.slice(end + endMarker.length)
fs.writeFileSync(CLIENT, s, 'utf8')
out.push('✅ CSS 已改为官方主题令牌（并加粗、加边框、加悬停）')

// 状态文字也用一个更明确的类名
if (s.includes("className: live ? 'ok' : 'warn'")) out.push('（状态类名沿用 ok / warn）')

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
pkg.version = '1.0.6'
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
out.push('✅ 版本 → 1.0.6')

let cl = fs.readFileSync(CHANGELOG, 'utf8')
if (!cl.includes('## [1.0.6]')) {
  cl = cl.replace('# Changelog\n', [
    '# Changelog',
    '',
    '## [1.0.6] — 2026-10-10',
    '',
    '### 修复（可见性）',
    '',
    '- 控件配色改用 DSH **官方主题令牌**（`--dsw-alias-label-primary/-secondary`、`--dsw-alias-bg-layer-1/-2`、',
    '  `--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-state-success/-warn-primary`），',
    '  每个都带兜底色：令牌缺失也不会掉回低对比度。',
    '  此前写死 `#e6e6e6` 文字 + 半透明灰底，在浅色主题下按钮文字几乎看不见。',
    '- 按钮/代码块加粗（`font-weight:600`）、加边框、加悬停态；主按钮用品牌色。',
    '',
  ].join('\n'))
  fs.writeFileSync(CHANGELOG, cl, 'utf8')
  out.push('✅ CHANGELOG 已记录 1.0.6')
}

const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
out.push((r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)|^✖ /.test(l)).join('\n'))
console.log(out.join('\n'))
process.exit(r.status === 0 ? 0 : 1)
