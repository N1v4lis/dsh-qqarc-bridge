/**
 * 恢复被「禁用第三方插件」清掉的 profile 配置。
 *
 * 背景：dsh-dev-task-bridge 的客户端半边曾因 ESM 语法让 web boot 挂掉，
 * 用户在启动失败对话框里点了"禁用第三方插件、备份 profile patch 并重启" ——
 * 该动作把 profile 的 cordis.patch.yml 换成了最小版本、并清空了 dsh.profile.bundles。
 * 现在插件已修好（客户端半边改为 CommonJS，见 lib/client.js 文件头），把两者恢复回去。
 *
 * 安全措施：
 *   · 先备份当前两份文件（.bak-restore-<时间戳>）；
 *   · bundles 用"插入缺失项"的方式恢复，不动已有顺序；
 *   · cordis.patch.yml 只在"备份比当前大"（= 当前是被清过的版本）时才覆盖；
 *   · --dry-run 只打印计划。
 *
 * 用法：node tools/restore-profile-plugins.mjs [--dry-run]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DRY = process.argv.includes('--dry-run')
const PROF = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const STAMP = Date.now()

/** 禁用前应有的 bundle 顺序（取自 profile 的 10-04 备份，与禁用前实测一致） */
const WANT_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  'dsh-whale-widget',
  'dsh-dev-task-bridge',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-schedule-bundle',
  'dsh-better-display',
  'dsh-resume',
  'dsh-theme-tarkov',
  '@modusensus/dsh-mneme',
  'dsh-memory-evolve',
  'dsh-better-sidebar',
]

const out = []
out.push(`profile: ${PROF}`)

// ── 1) package.json 的 dsh.profile.bundles ────────────────────────────────
const pkgFile = path.join(PROF, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
const before = Array.isArray(pkg.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : []
const missing = WANT_BUNDLES.filter((b) => !before.includes(b))
out.push(`bundles 现在 ${before.length} 个：${before.join(', ') || '(空)'}`)
out.push(`需要补回 ${missing.length} 个：${missing.join(', ') || '(无需补)'}`)
if (missing.length) {
  // 按 WANT_BUNDLES 的顺序重排（缺的补进去，多出来的保留在末尾，避免误删用户加的东西）
  const extra = before.filter((b) => !WANT_BUNDLES.includes(b))
  const next = [...WANT_BUNDLES, ...extra]
  out.push(`bundles 将变为 ${next.length} 个`)
  if (!DRY) {
    fs.copyFileSync(pkgFile, `${pkgFile}.bak-restore-${STAMP}`)
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = next
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    out.push(`✅ 已写入（备份 package.json.bak-restore-${STAMP}）`)
  }
}

// ── 2) cordis.patch.yml：只在备份更大时恢复 ───────────────────────────────
const patchFile = path.join(PROF, 'cordis.patch.yml')
let newestBak = null
try {
  const baks = fs.readdirSync(PROF)
    .filter((f) => f.startsWith('cordis.patch.yml.bak-'))
    .map((f) => ({ f, size: fs.statSync(path.join(PROF, f)).size, mtime: fs.statSync(path.join(PROF, f)).mtimeMs }))
    .sort((a, b) => b.size - a.size)
  newestBak = baks[0] || null
} catch { /* 目录读不到就跳过 */ }
if (newestBak) {
  const cur = fs.existsSync(patchFile) ? fs.statSync(patchFile).size : 0
  out.push(`cordis.patch.yml 当前 ${cur}B，最大备份 ${newestBak.f} ${newestBak.size}B`)
  if (newestBak.size > cur) {
    if (!DRY) {
      if (cur) fs.copyFileSync(patchFile, `${patchFile}.bak-restore-${STAMP}`)
      fs.copyFileSync(path.join(PROF, newestBak.f), patchFile)
      out.push(`✅ 已用备份恢复（当前版本备份为 cordis.patch.yml.bak-restore-${STAMP}）`)
    } else out.push('（dry-run：将用该备份恢复）')
  } else out.push('（当前不比备份小，保持不动）')
} else out.push('⚠️ 没找到 cordis.patch.yml 的备份')

console.log(out.join('\n'))
console.log(DRY ? '\n—— dry-run：未改动任何文件 ——' : '\n完成。请重启 DSH 使配置生效。')
