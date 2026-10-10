/**
 * 补丁：会话枚举改成「**sessionQuery 服务优先，磁盘索引兜底**」。
 *
 * 依据（只读调研，2026-10-10）：
 *   · @deepseek-ai/dsh-session-query 的 listSessions()：全部会话（含历史，newest-first），
 *     但**只给 header**（id/createdAt/cwd/parentSession/origin），名字要再折一次；
 *     readTitleSnapshots(ids)：批量取标题（保序、单条失败隔离）。
 *   · 标题是**事件**（session/title，最后一条胜出）；投影缓存
 *     ~/.dsh/storages/session_projcache/sessions/<id>.json 只是缓存（可能缺失/过期）。
 *   · 磁盘上 subagent 会话用的是**裸 uuid** 目录名（没有 session- 前缀）——
 *     所以"会话区"的默认口径是顶层会话（parentSession 为空），与 GUI 一致。
 *
 * 为什么还要磁盘兜底：sessionQuery 是可选依赖（可能缺席），而"看会话列表"这件事
 * 不能因为一个服务没装就失效。两条路都走，接口里用 source 字段说明数据来自哪。
 *
 * 用法：node tools/apply-sessionquery-patch.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'lib', 'index.js')
let src = fs.readFileSync(FILE, 'utf8')
const applied = []
const failed = []

function replaceOnce(label, from, to) {
  const count = src.split(from).length - 1
  if (count !== 1) { failed.push(`${label}：命中 ${count} 次`); return }
  src = src.replace(from, to)
  applied.push(label)
}

// 1) 权威枚举函数（放在 scanOnce 之前，与 taskSources 同级）
replaceOnce(
  'listSessionsAuthoritative',
  `  /**
   * 多 QQ 自动发现：探一遍候选端口，问出每个 QQ Agent 实例的任务文件与定向。`,
  `  /**
   * 会话清单：**服务优先 + 磁盘兜底**。
   *
   * 为什么这样分层（实测结论）：
   *   · ctx.get('sessionQuery').listSessions() 是权威全集（含历史），但它只给 header；
   *     标题要再用 readTitleSnapshots() 折一次（批量、保序、单条失败隔离）。
   *   · 磁盘上的 projcache（~/.dsh/storages/session_projcache/sessions/<id>.json）
   *     有 title/cwd/lastPromptAt，读起来最省事，但它是**缓存**：可能缺失、可能过期。
   *   · subagent 会话在磁盘上是裸 uuid 目录，且不该给人当投递目标 —— 默认只列顶层会话。
   *
   * 返回值：{ source: 'sessionQuery' | 'disk', sessions: [...] }
   */
  const listSessionsAuthoritative = async () => {
    const diskList = (() => { try { return listStoredSessions() } catch { return [] } })()
    const diskById = new Map(diskList.map((s) => [s.id, s]))
    let svc = null
    try { svc = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null } catch { svc = null }
    if (!svc || typeof svc.listSessions !== 'function') return { source: 'disk', sessions: diskList }
    try {
      const records = await svc.listSessions()
      const tops = (Array.isArray(records) ? records : [])
        .filter((r) => r && r.header && !r.header.parentSession && r.header.origin !== 'subagent')
      const ids = tops.map((r) => String(r.header.id))
      const titles = new Map()
      if (typeof svc.readTitleSnapshots === 'function' && ids.length) {
        try {
          const observed = await svc.readTitleSnapshots(ids)
          for (const item of Array.isArray(observed) ? observed : []) {
            if (item && item.status === 'fulfilled' && item.value) {
              titles.set(String(item.sessionId), String(item.value.title?.title || ''))
            }
          }
        } catch (error) {
          warn(\`取会话标题失败（退化用磁盘缓存里的标题）：\${String((error && error.message) || error)}\`)
        }
      }
      const sessions = tops.map((r) => {
        const id = String(r.header.id)
        const disk = diskById.get(id) || {}
        return {
          id,
          title: titles.has(id) ? titles.get(id) : (disk.title || ''),
          cwd: String(r.header.cwd || disk.cwd || ''),
          createdAt: r.header.createdAt ?? null,
          live: r.live === true,
          // 最近活动仍以磁盘为准（服务只给 createdAt，没有"最后提问时间"）
          lastPromptAt: disk.lastPromptAt ?? null,
          lastActivityAt: disk.lastActivityAt ?? (r.header.createdAt ?? null),
          logBytes: disk.logBytes ?? 0,
        }
      })
      // 服务里没覆盖、但磁盘上有的顶层会话也补上（例如服务刚启动还没扫到）
      for (const s of diskList) {
        if (!sessions.some((x) => x.id === s.id)) sessions.push({ ...s, live: false })
      }
      sessions.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
      return { source: 'sessionQuery', sessions }
    } catch (error) {
      warn(\`sessionQuery 枚举失败，退回磁盘索引：\${String((error && error.message) || error)}\`)
      return { source: 'disk', sessions: diskList }
    }
  }

  /**
   * 多 QQ 自动发现：探一遍候选端口，问出每个 QQ Agent 实例的任务文件与定向。`,
)

// 2) /dev-task/sessions 用权威枚举
replaceOnce(
  'sessions 路由改用权威枚举',
  `      let sessions = filterRecentSessions(listStoredSessions(), days)`,
  `      const enumerated = await listSessionsAuthoritative()
      let sessions = filterRecentSessions(enumerated.sessions, days)`,
)
replaceOnce(
  'sessions 路由回包带 source',
  `      sendJson(res, 200, {
        ok: true,
        revision: REVISION,
        total,
        defaultSession: DEFAULT_SESSION || '',`,
  `      sendJson(res, 200, {
        ok: true,
        revision: REVISION,
        source: enumerated.source,
        total,
        defaultSession: DEFAULT_SESSION || '',`,
)

// 3) 按名字解析时优先用权威清单（标题更准）
replaceOnce(
  'POST /dev-task 名字解析用权威清单',
  `      if (sessionId === '' && sessionName !== '') {
        const resolved = resolveSession(sessionName, { sessions: listStoredSessions() })`,
  `      if (sessionId === '' && sessionName !== '') {
        const named = await listSessionsAuthoritative()
        const resolved = resolveSession(sessionName, { sessions: named.sessions })`,
)
replaceOnce(
  'scan 名字解析用权威清单',
  `      if (!sid && wantedName) {
        const resolved = resolveSession(wantedName, { sessions: listStoredSessions() })`,
  `      if (!wantedName === false && !sid && wantedName) {
        const resolved = resolveSession(wantedName, { sessions: (await listSessionsAuthoritative()).sessions })`,
)
replaceOnce(
  'status 会话计数',
  `        sessionsIndexed: (() => { try { return listStoredSessions().length } catch { return 0 } })(),`,
  `        sessionsIndexed: (() => { try { return listStoredSessions().length } catch { return 0 } })(),
        sessionQuery: (() => { try { return typeof ctx.get === 'function' && Boolean(ctx.get('sessionQuery')) } catch { return false } })(),`,
)

if (failed.length) {
  console.error('❌ 补丁未应用：')
  for (const f of failed) console.error('   · ' + f)
  process.exit(1)
}
fs.copyFileSync(FILE, `${FILE}.bak-sessionquery`)
fs.writeFileSync(FILE, src, 'utf8')
try {
  execFileSync('node', ['--check', FILE])
} catch (error) {
  fs.copyFileSync(`${FILE}.bak-sessionquery`, FILE)
  console.error('❌ 语法失败已回滚：' + String(error.stderr || error))
  process.exit(1)
}
console.log(`✅ 应用 ${applied.length} 处：`)
for (const a of applied) console.log('   · ' + a)
console.log('✅ 语法通过')
