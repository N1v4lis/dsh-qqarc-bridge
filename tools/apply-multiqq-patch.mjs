/**
 * 一次性补丁：给 dsh-dev-task-bridge 接入「会话区索引」与「多 QQ 回传」。
 *
 * 为什么用脚本而不是手工编辑：改动点多（14 处），每处都要求"锚点必须命中"，
 * 命中不了就整体中止并回滚 —— 好过手工漏改一处导致行为不对（这个文件踩过这种坑）。
 *
 * 用法：node tools/apply-multiqq-patch.mjs   （在插件目录内执行；会先备份 lib/index.js）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FILE = path.join(ROOT, 'lib', 'index.js')

let src = fs.readFileSync(FILE, 'utf8')
const applied = []
const failed = []

function replaceOnce(label, from, to) {
  const count = src.split(from).length - 1
  if (count !== 1) {
    failed.push(`${label}：锚点命中 ${count} 次（要求恰好 1 次）`)
    return
  }
  src = src.replace(from, to)
  applied.push(label)
}

// ── 1) 引入会话索引模块 ────────────────────────────────────────────────────
replaceOnce(
  'import sessions.js',
  "import { pathToFileURL } from 'node:url'",
  `import { pathToFileURL } from 'node:url'

import {
  BASE_QQ_PORT,
  listStoredSessions,
  filterRecentSessions,
  resolveSession,
  parseQqTargets,
  listTaskFiles,
  readTasksFile,
  notifyTargetFor,
} from './sessions.js'`,
)

// ── 2) 多 QQ 目标 + QQ Agent 家目录 ────────────────────────────────────────
replaceOnce(
  'QQ_TARGETS',
  "const DEFAULT_NOTIFY_PORT = Number(process.env.DEV_TASK_QQ_PORT || DEFAULT_QQ_PORT)",
  `const DEFAULT_NOTIFY_PORT = Number(process.env.DEV_TASK_QQ_PORT || DEFAULT_QQ_PORT)
/**
 * 多 QQ 回传目标。
 *   DEV_TASK_QQ_TARGETS=158732453:8765,487271667:8865   （推荐：带账号，结果按来源账号回传）
 *   DEV_TASK_QQ_TARGETS=8765,8865                        （只给端口）
 * 未配置时退回单端口 DEV_TASK_QQ_PORT / 8765。
 */
const QQ_TARGETS = parseQqTargets(process.env.DEV_TASK_QQ_TARGETS || process.env.DEV_TASK_QQ_PORT || DEFAULT_QQ_PORT)`,
)

replaceOnce(
  'qqAgentHome',
  "function tasksFilePath() {",
  `/** QQ Agent 家目录（多账号的 accounts/<uin>/… 都挂在它下面）。 */
function qqAgentHome() {
  return process.env.QQ_AGENT_HOME || 'E:\\\\QQ Agent'
}

function tasksFilePath() {`,
)

// ── 3) 修订号 ──────────────────────────────────────────────────────────────
replaceOnce('REVISION', "const REVISION = 'v5-pinned-session'", "const REVISION = 'v6-multiqq-sessions'")

// ── 4) writeResultToTasksFile 支持指定文件 ─────────────────────────────────
replaceOnce(
  'writeResultToTasksFile 签名',
  `function writeResultToTasksFile(taskId, payload) {
  const file = tasksFilePath()
  if (!file) return false`,
  `function writeResultToTasksFile(taskId, payload, fileHint) {
  // 多 QQ：必须写回**任务来源的那份** tasks.json（每个账号一份），
  // 否则主号的任务会被写进 bot 号的文件里 —— 表现是"结果回来了但发给了另一个号"。
  const file = fileHint || tasksFilePath()
  if (!file) return false`,
)

// ── 5) pushResult 支持按账号路由 + 兜底广播 ────────────────────────────────
replaceOnce(
  'pushResult 实现',
  `async function pushResult(payload, signal) {
  const port = DEFAULT_NOTIFY_PORT
  const url = \`http://127.0.0.1:\${port}/dev/notify\`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    return { ok: response.ok, status: response.status, via: 'http' }
  } catch (error) {
    return { ok: false, status: 0, via: 'http', error: String((error && error.message) || error) }
  }
}`,
  `async function pushResult(payload, signal, portHint) {
  // 多 QQ：优先打"来源账号"那一份插件实例的端口，失败再依次试其它已配置端口。
  // 只有一个端口时行为和以前完全一致（不会多打一次）。
  const preferred = Number(portHint || payload?.notifyPort) || DEFAULT_NOTIFY_PORT
  const others = QQ_TARGETS.map((t) => Number(t.port)).filter((p) => p && p !== preferred)
  const ports = [preferred, ...others]
  const tried = []
  let lastError = ''
  for (const port of ports) {
    const token = String(process.env.DEV_TASK_TOKEN || '')
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['x-dev-task-token'] = token
    try {
      const response = await fetch(\`http://127.0.0.1:\${port}/dev/notify\`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, notifyPort: port }),
        signal,
      })
      tried.push({ port, status: response.status })
      if (response.ok) return { ok: true, status: response.status, via: 'http', port, tried }
      lastError = \`HTTP \${response.status}\`
    } catch (error) {
      lastError = String((error && error.message) || error)
      tried.push({ port, status: 0 })
    }
  }
  return { ok: false, status: 0, via: 'http', error: lastError, tried }
}`,
)

// ── 6) 工具回传：带上记下的端口 ────────────────────────────────────────────
replaceOnce(
  'tool pushResult 传端口',
  "      const pushed = await pushResult(payload, exec && exec.signal)",
  `      const known = knownTasks.get(payload.taskId) || {}
      const pushed = await pushResult(payload, exec && exec.signal, known.notifyPort)`,
)
replaceOnce(
  'tool 兜底写文件',
  "      const wrote = writeResultToTasksFile(payload.taskId, payload)",
  "      const wrote = writeResultToTasksFile(payload.taskId, payload, known.sourceFile)",
)

// ── 7) 轮次结束兜底：同样按来源账号回传 ─────────────────────────────────────
replaceOnce(
  'fallback pushResult',
  "        pushResult(payloadOut)",
  "        pushResult(payloadOut, undefined, info.notifyPort)",
)
replaceOnce(
  'fallback 写文件',
  "            else if (writeResultToTasksFile(taskId, payloadOut)) warn(`任务 ${taskId} 兜底回传走了任务文件`)",
  "            else if (writeResultToTasksFile(taskId, payloadOut, info.sourceFile)) warn(`任务 ${taskId} 兜底回传走了任务文件`)",
)

// ── 8) scanOnce：扫多份任务文件（多账号）────────────────────────────────────
replaceOnce(
  'scanOnce 多文件',
  `  const scanOnce = (reason) => {
    ensureBinding(\`scan:\${reason}\`)
    const file = tasksFilePath()
    let data
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return 0   // 文件还没出现 / 正在被写：下一轮再说
    }
    const tasks = data && typeof data.tasks === 'object' ? data.tasks : {}
    let injected = 0
    for (const [taskId, rec] of Object.entries(tasks)) {
      if (!rec || typeof rec !== 'object') continue
      if (String(rec.status || '') !== 'pending') continue
      if (handled.has(taskId)) continue`,
  `  /**
   * 收集"待投递任务"——**多 QQ：每个账号一份任务文件**。
   *   旧位置：<QQ_AGENT_HOME>/data/dev-coding/tasks.json
   *   多账号：<QQ_AGENT_HOME>/accounts/<uin>/plugins/dev-coding/tasks.json
   * 每条都带上来源账号与应回传的端口，这样结果才会回到"提问的那个号"。
   */
  const taskSources = () => {
    const out = []
    let files = []
    try {
      files = listTaskFiles({ home: qqAgentHome() })
    } catch (error) {
      warn(\`枚举任务文件失败：\${String((error && error.message) || error)}\`)
      return out
    }
    for (const entry of files) {
      if (!entry.exists) continue
      let tasks = {}
      try {
        tasks = readTasksFile(entry.path).tasks
      } catch { continue }
      for (const [taskId, rec] of Object.entries(tasks)) {
        if (!rec || typeof rec !== 'object') continue
        if (String(rec.status || '') !== 'pending') continue
        out.push({
          taskId,
          rec,
          uin: entry.uin || '',
          file: entry.path,
          port: notifyTargetFor({ account: entry.uin, payload: { notifyPort: rec.notifyPort } }, QQ_TARGETS),
        })
      }
    }
    return out
  }

  const scanOnce = (reason) => {
    ensureBinding(\`scan:\${reason}\`)
    let injected = 0
    for (const source of taskSources()) {
      const { taskId, rec } = source
      if (handled.has(taskId)) continue`,
)

// ── 9) scanOnce 里记下来源（账号/端口/文件）────────────────────────────────
replaceOnce(
  'scanOnce knownTasks 记录来源',
  `      handled.add(taskId)
      knownTasks.set(taskId, { sessionId, startedAt: Date.now(), delivered: false })`,
  `      handled.add(taskId)
      knownTasks.set(taskId, {
        sessionId,
        startedAt: Date.now(),
        delivered: false,
        accountUin: source.uin,
        notifyPort: source.port,
        sourceFile: source.file,
      })`,
)

// ── 10) POST /dev-task：支持 sessionName / accountUin / notifyPort ─────────
replaceOnce(
  'POST /dev-task 解析目标',
  `      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const text = typeof body.text === 'string' ? body.text : ''
      if (sessionId === '' || text.trim() === '') {
        sendJson(res, 400, {
          ok: false,
          code: 'MISSING_FIELD',
          error: '需要 sessionId（非空字符串）和 text（非空字符串）',
        })
        return
      }`,
  `      let sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const sessionName = typeof body.sessionName === 'string' ? body.sessionName.trim() : ''
      const text = typeof body.text === 'string' ? body.text : ''
      // 允许用**会话名**投递（用户看不到完整 id）：先解析成 id，重名则明确报歧义
      if (sessionId === '' && sessionName !== '') {
        const resolved = resolveSession(sessionName, { sessions: listStoredSessions() })
        if (!resolved.ok) {
          sendJson(res, 409, {
            ok: false,
            code: resolved.code,
            error: resolved.error,
            candidates: (resolved.candidates || []).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd })),
          })
          return
        }
        sessionId = resolved.id
      }
      if (sessionId === '' || text.trim() === '') {
        sendJson(res, 400, {
          ok: false,
          code: 'MISSING_FIELD',
          error: '需要 sessionId 或 sessionName（非空字符串）以及 text（非空字符串）',
        })
        return
      }`,
)
replaceOnce(
  'POST /dev-task knownTasks 记录来源',
  `          if (taskId) {
            knownTasks.set(taskId, { sessionId, startedAt: Date.now(), delivered: false })`,
  `          if (taskId) {
            knownTasks.set(taskId, {
              sessionId,
              startedAt: Date.now(),
              delivered: false,
              accountUin: typeof body.accountUin === 'string' ? body.accountUin : '',
              notifyPort: Number(body.notifyPort) || DEFAULT_NOTIFY_PORT,
            })`,
)

// ── 11) /dev-task/scan：支持按名字改指向 ───────────────────────────────────
replaceOnce(
  'scan 路由按名字',
  `      const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sid) {
        DEFAULT_SESSION = sid
        writeIdentity(sid)
        log(\`目标会话已更新为 \${sid}\`)
      }`,
  `      let sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const wantedName = typeof body.sessionName === 'string' ? body.sessionName.trim() : ''
      let resolvedInfo = null
      // 允许按**会话名**改指向（名字可空可重名 → 命中多个直接报歧义，不瞎挑）
      if (!sid && wantedName) {
        const resolved = resolveSession(wantedName, { sessions: listStoredSessions() })
        if (!resolved.ok) {
          sendJson(res, 409, {
            ok: false,
            code: resolved.code,
            error: resolved.error,
            candidates: (resolved.candidates || []).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd })),
          })
          return
        }
        sid = resolved.id
        resolvedInfo = { strategy: resolved.strategy, title: resolved.session?.title || '' }
      }
      if (sid) {
        DEFAULT_SESSION = sid
        writeIdentity(sid, resolvedInfo ? { pinnedBy: 'sessionName', resolvedBy: resolvedInfo.strategy } : {})
        log(\`目标会话已更新为 \${sid}\${resolvedInfo ? \`（按名字解析，策略 \${resolvedInfo.strategy}）\` : ''}\`)
      }`,
)
replaceOnce(
  'scan 路由回包带解析信息',
  `      sendJson(res, 200, {
        ok: true,
        injected,
        sessionId: pickDefaultSession(ctx),`,
  `      sendJson(res, 200, {
        ok: true,
        injected,
        resolved: resolvedInfo,
        sessionId: pickDefaultSession(ctx),`,
)

// ── 12) 新路由：会话区清单 + 多 QQ 诊断 ────────────────────────────────────
replaceOnce(
  '新路由插入点',
  "  ctx.effect(() => ctx.webServer.register(route), `${name}: ${route.path}`)",
  `  // ── (H) GET /dev-task/sessions：把 DSH 的"会话区"摊开给人看 ────────────
  // 为什么需要它：DSH 界面**不显示** session-id，用户只看到会话名字；而注入必须用 id。
  // 这条路由把"名字 ↔ id ↔ 工作目录 ↔ 最近活动 ↔ 是否活着"一次列全，
  // 支持 ?days=7&limit=50&q=关键词 过滤。名字可空可重名（实测两个会话同名），
  // 所以按名选择命中多个时返回候选而不是猜一个。
  const sessionsRoute = {
    kind: 'exact',
    path: '/dev-task/sessions',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
      const days = Number(url.searchParams.get('days') || 0)
      const limit = Number(url.searchParams.get('limit') || 50)
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
      let live = []
      try {
        live = ctx.agents.list().map((a) => ({ id: String(a.id), status: String(a.status || '') }))
      } catch { /* 拿不到就当没有活会话 */ }
      const liveIds = new Set(live.map((l) => l.id))
      let sessions = filterRecentSessions(listStoredSessions(), days)
      if (q) {
        sessions = sessions.filter((s) => s.id.toLowerCase().includes(q)
          || String(s.title || '').toLowerCase().includes(q)
          || String(s.cwd || '').toLowerCase().includes(q))
      }
      const total = sessions.length
      const shaped = sessions.slice(0, limit).map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        live: liveIds.has(s.id),
        lastPromptAt: s.lastPromptAt,
        lastActivityAt: s.lastActivityAt,
        logBytes: s.logBytes,
      }))
      // 只活在内存里、磁盘上还没有日志的新会话也列出来（第一轮落盘之前）
      for (const l of live) {
        if (!shaped.some((s) => s.id === l.id)) {
          shaped.unshift({ id: l.id, title: '', cwd: '', live: true, status: l.status, lastPromptAt: null, lastActivityAt: null, logBytes: 0 })
        }
      }
      sendJson(res, 200, {
        ok: true,
        revision: REVISION,
        total,
        defaultSession: DEFAULT_SESSION || '',
        liveAgents: live,
        sessions: shaped,
        hint: '会话身份 = id（目录名 session-<uuid>）；名字只是显示用、可空可重名。按名选择命中多个会返回 AMBIGUOUS_TITLE。',
      })
    },
  }

  // ── (I) GET /dev-task/qq：多 QQ（QQ Agent 多账号）连通性诊断 ──────────────
  // 每个账号一份插件实例、端口相差 100（QQ Agent 的 portOffset 约定）。
  // 这条路由把"配置了哪些回传目标、每个是否活着、它认哪个会话"列出来 ——
  // 多账号下"结果发错号"基本都是端口/账号对不上，看一眼就能定位。
  const qqRoute = {
    kind: 'exact',
    path: '/dev-task/qq',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      let taskFiles = []
      try {
        taskFiles = listTaskFiles({ home: qqAgentHome() })
      } catch { /* 家目录不存在就当没有 */ }
      const targets = QQ_TARGETS.length ? QQ_TARGETS : [{ uin: '', port: DEFAULT_NOTIFY_PORT }]
      const probes = []
      for (const t of targets) {
        const started = Date.now()
        try {
          const r = await fetch(\`http://127.0.0.1:\${t.port}/dev/status\`, { signal: AbortSignal.timeout(1500) })
          const body = await r.json().catch(() => null)
          probes.push({
            uin: t.uin,
            port: t.port,
            ok: r.ok,
            httpStatus: r.status,
            ms: Date.now() - started,
            wsConnected: body?.wsConnected,
            targetSessionId: body?.targetSessionId,
            tasks: body?.tasks,
          })
        } catch (error) {
          probes.push({ uin: t.uin, port: t.port, ok: false, ms: Date.now() - started, error: String((error && error.message) || error) })
        }
      }
      sendJson(res, 200, {
        ok: true,
        revision: REVISION,
        configuredTargets: QQ_TARGETS,
        defaultNotifyPort: DEFAULT_NOTIFY_PORT,
        probes,
        taskFiles,
        hint: 'DEV_TASK_QQ_TARGETS=158732453:8765,487271667:8865 —— 带账号时结果按任务来源账号回传。',
      })
    },
  }

  ctx.effect(() => ctx.webServer.register(route), \`\${name}: \${route.path}\`)
  ctx.effect(() => ctx.webServer.register(sessionsRoute), \`\${name}: \${sessionsRoute.path}\`)
  ctx.effect(() => ctx.webServer.register(qqRoute), \`\${name}: \${qqRoute.path}\`)`,
)

// ── 13) status 路由补上多 QQ / 会话索引信息 ────────────────────────────────
replaceOnce(
  'status 路由补字段',
  `        notifyPort: DEFAULT_NOTIFY_PORT,
        agents,`,
  `        notifyPort: DEFAULT_NOTIFY_PORT,
        qqTargets: QQ_TARGETS,
        sessionsIndexed: (() => { try { return listStoredSessions().length } catch { return 0 } })(),
        agents,`,
)

// ── 14) 握手文件带上多 QQ 目标 ─────────────────────────────────────────────
replaceOnce(
  'handshake 带 targets',
  "    const body = JSON.stringify({ event: 'bridge-ready', sessionId: DEFAULT_SESSION, at: Date.now() })",
  "    const body = JSON.stringify({ event: 'bridge-ready', sessionId: DEFAULT_SESSION, targets: QQ_TARGETS, at: Date.now() })",
)

// ── 15) 导出更多纯函数（便于离线测试） ─────────────────────────────────────
replaceOnce(
  '导出清单',
  "export { deliverToSession, lastAssistantText, hostFence, knownTasks, sessionOf, usageSince }",
  `export {
  deliverToSession,
  lastAssistantText,
  hostFence,
  knownTasks,
  sessionOf,
  usageSince,
  // 多 QQ / 会话区：导出给离线测试与外部脚本用（不改变 DSH 侧行为）
  BASE_QQ_PORT,
  QQ_TARGETS,
  listStoredSessions,
  resolveSession,
}`,
)

// ── 结果 ───────────────────────────────────────────────────────────────────
if (failed.length) {
  console.error('❌ 补丁未应用（锚点未命中，文件保持不变）：')
  for (const f of failed) console.error('   · ' + f)
  console.error(`   已成功 ${applied.length} 处，但按"全有或全无"原则不做部分写入。`)
  process.exit(1)
}

fs.copyFileSync(FILE, `${FILE}.bak-multiqq`)
fs.writeFileSync(FILE, src, 'utf8')
try {
  execFileSync('node', ['--check', FILE])
} catch (error) {
  fs.copyFileSync(`${FILE}.bak-multiqq`, FILE)
  console.error('❌ 语法检查失败，已回滚：' + String(error.stderr || error))
  process.exit(1)
}
console.log(`✅ 补丁已应用 ${applied.length} 处：`)
for (const a of applied) console.log('   · ' + a)
console.log('✅ 语法检查通过（备份：lib/index.js.bak-multiqq）')
