/**
 * 列出 DSH 的会话区（名字 ↔ session-id ↔ 工作目录 ↔ 最近活动 ↔ 是否活着），
 * 并按名字/前缀解析成 id —— 因为 **DSH 界面不显示 session-id**，
 * 而向会话注入消息（POST /dev-task）必须用 id。
 *
 * 用法：
 *   node tools/list-sessions.mjs                 # 最近 30 天，最多 20 条
 *   node tools/list-sessions.mjs --days 7 --limit 50
 *   node tools/list-sessions.mjs --q "QQ Agent"  # 按 id/名字/目录过滤
 *   node tools/list-sessions.mjs --resolve "Coding回传"   # 解析成 id（重名会报歧义）
 *   node tools/list-sessions.mjs --json          # 机器可读
 */

import {
  listStoredSessions,
  filterRecentSessions,
  resolveSession,
} from '../lib/sessions.js'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const days = Number(arg('days', '30')) || 0
const limit = Number(arg('limit', '20')) || 20
const q = arg('q', '').toLowerCase()
const resolveTarget = arg('resolve', '')

let sessions = filterRecentSessions(listStoredSessions(), days)
if (q) {
  sessions = sessions.filter((s) => s.id.toLowerCase().includes(q)
    || String(s.title || '').toLowerCase().includes(q)
    || String(s.cwd || '').toLowerCase().includes(q))
}

if (has('json')) {
  console.log(JSON.stringify({ total: sessions.length, sessions: sessions.slice(0, limit) }, null, 2))
  process.exit(0)
}

if (resolveTarget) {
  const r = resolveSession(resolveTarget, { sessions: listStoredSessions() })
  if (r.ok) {
    console.log(`✅ ${resolveTarget} → ${r.id}（策略 ${r.strategy}｜名字「${r.session?.title || '(未命名)'}」｜${r.session?.cwd || ''}）`)
    process.exit(0)
  }
  console.error(`❌ ${r.code}：${r.error}`)
  for (const c of r.candidates || []) console.error(`   · ${c.id}  「${c.title || '(未命名)'}」  ${c.cwd}`)
  process.exit(1)
}

console.log(`共 ${sessions.length} 个会话${q ? `（过滤：${q}）` : ''}，显示前 ${Math.min(limit, sessions.length)} 个：\n`)
for (const s of sessions.slice(0, limit)) {
  const when = s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString('zh-CN', { hour12: false }) : '—'
  const kb = Math.round((s.logBytes || 0) / 1024)
  console.log(`${s.id}`)
  console.log(`    名字：${s.title || '(未命名)'}   工作目录：${s.cwd || '—'}`)
  console.log(`    最近：${when}   日志：${kb} KB\n`)
}
console.log('提示：注入消息要用 **id**；名字只是显示用、可空且可重名（同名会报 AMBIGUOUS_TITLE）。')
