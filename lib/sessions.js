/**
 * sessions.js —— DSH「会话区」索引与选择（纯函数，可脱离 DSH 单测）
 *
 * ── 本机实测结论（2026-10-10，DSH Desktop 0.2.0-rc.2）──────────────────────
 *
 * 1) 会话日志（会话区的本体）
 *      ~/.dsh/sessions/<项目目录编码>/session-<uuid>/session.v4.jsonl.zstd
 *    每个会话一个目录，日志是 **zstd 分帧** 的 JSONL；目录名里的
 *    `session-<uuid>` 就是会话的**唯一身份**。名字/标题**不在**这里 ——
 *    所以「改名字不会改身份」是结构上成立的，不是约定。
 *
 * 2) 会话标题与元数据（投影缓存）
 *      ~/.dsh/storages/session_projcache/sessions/session-<uuid>.json
 *      record.identity.cwd                             → 会话的工作目录（权威值）
 *      record.rows.title.val                           → GUI 里显示的名字（**可为 null**）
 *      record.rows.sessionListMetadata.val.lastPromptAt → 最近一次提问时间
 *
 * 3) 名字**不能当主键**（实测证据）
 *      `--E-Deepseek~0020Harness--` 下两个不同会话的 title 都叫「连通性测试」。
 *    标题是从首条消息自动生成的，重名是常态；未命名的会话 title 为 null。
 *    → 选择目标会话的主力永远是 id；名字只做"给人用的入口"，命中多个必须报歧义。
 *
 * 4) 多 QQ（QQ Agent 多账号）在磁盘上的形态
 *      旧：<QQ_AGENT_HOME>/data/dev-coding/tasks.json
 *      多账号：<QQ_AGENT_HOME>/accounts/<uin>/plugins/dev-coding/tasks.json
 *    每个账号的插件实例端口 = 8765 + (序号-1)*100（QQ Agent 侧 portOffset 的约定），
 *    所以"回传"必须按**来源账号**选端口，而不是永远打 8765。
 *
 * 本文件只做纯计算 + 只读文件访问，不碰 DSH 服务，便于 `node --test` 直接跑。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** QQ Agent 侧 dev-coding 插件的基准端口（与 QQ 侧约定一致）。 */
export const BASE_QQ_PORT = 8765
/** 多账号时每个账号的端口步长（QQ Agent 的 portOffset 约定）。 */
export const QQ_PORT_STEP = 100

/** DSH 家目录（可用 DSH_HOME 覆盖）。 */
export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function sessionsRoot(home = defaultDshHome()) {
  return path.join(home, 'sessions')
}

export function projcacheRoot(home = defaultDshHome()) {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

/**
 * 把 DSH 的项目目录编码还原成路径（**尽力而为**）。
 *
 * 编码规则（实测）：`E:\QQ Agent Dev` → `--E-QQ~0020Agent~0020Dev--`
 *   · 外层 `--…--` 是包裹
 *   · 非字母数字字符换成 `~` + 4 位十六进制（空格 → `~0020`）
 *   · 但**分隔符和字面连字符都会变成 `-`**，所以这是**有损**的：
 *     `E:\DSH-WechatWork` → `--E-DSH-WechatWork--`，与 `E:\DSH\WechatWork` 无法区分。
 *
 * 因此：路径的权威来源是投影缓存里的 `record.identity.cwd`（见 listStoredSessions），
 * 这里的还原只用于"投影缓存缺失时给个能看的近似值"。
 */
export function decodeProjectDir(name) {
  const raw = String(name || '')
  if (!raw.startsWith('--') || !raw.endsWith('--')) return raw
  const body = raw.slice(2, -2)
  const unescaped = body.replace(/~([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
  // 首段是盘符（E → E:），其余 `-` 当目录分隔符
  const withDrive = /^[A-Za-z]$/.test(unescaped[0] || '') ? `${unescaped[0]}:${unescaped.slice(1)}` : unescaped
  return withDrive.replace(/-/g, '\\')
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读取一个会话的投影缓存（标题/工作目录/最近提问时间）。缺文件返回 null。 */
export function readProjection(home, sessionId) {
  const file = path.join(projcacheRoot(home), `${sessionId}.json`)
  const data = readJsonSafe(file)
  if (!data || typeof data !== 'object') return null
  const record = data.record || {}
  const rows = record.rows || {}
  const titleRow = rows.title || {}
  const titleVal = titleRow && typeof titleRow === 'object' && 'val' in titleRow ? titleRow.val : null
  const listMeta = rows.sessionListMetadata || {}
  const listVal = listMeta && typeof listMeta === 'object' && 'val' in listMeta ? listMeta.val : null
  const identity = record.identity || {}
  return {
    sessionId,
    title: typeof titleVal === 'string' && titleVal.trim() !== '' ? titleVal.trim() : '',
    cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
    createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
    lastPromptAt: listVal && typeof listVal.lastPromptAt === 'number' ? listVal.lastPromptAt : null,
  }
}

/**
 * 枚举磁盘上的全部会话（含历史会话）。
 *
 * 返回按「最近活动」倒序：优先 lastPromptAt（投影缓存），其次日志文件的 mtime。
 * live 与否由调用方用 DSH 的 agents 列表补齐（本函数不碰 DSH）。
 */
export function listStoredSessions(options = {}) {
  const home = options.home || defaultDshHome()
  const root = sessionsRoot(home)
  const out = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    } catch {
      continue
    }
    for (const entry of sessions) {
      const dir = path.join(projectDir, entry.name)
      const logPath = path.join(dir, 'session.v4.jsonl.zstd')
      let stat = null
      try {
        stat = fs.statSync(logPath)
      } catch { /* 日志缺失也算一个会话（可能是空会话） */ }
      const projection = readProjection(home, entry.name)
      const lastPromptAt = projection && projection.lastPromptAt ? projection.lastPromptAt : null
      const mtime = stat ? stat.mtimeMs : null
      out.push({
        id: entry.name,
        title: (projection && projection.title) || '',
        cwd: (projection && projection.cwd) || decodeProjectDir(project.name),
        projectDirName: project.name,
        dir,
        logPath,
        logBytes: stat ? stat.size : 0,
        mtime,
        lastPromptAt,
        // 语义信号优先：有"最近提问时间"就用它，没有才退回日志 mtime
        lastActivityAt: lastPromptAt || mtime || null,
      })
    }
  }
  // 排序规则（踩过）：**别用 max(lastPromptAt, mtime) 混排** —— 那样"从没被提问过、
  // 但日志刚被 touch 过"的会话会挤到第一位（实测就是它把真正的最近会话顶下去）。
  // 正确次序：有提问记录的在前（按时间倒序）→ 没有提问记录的按 mtime 倒序垫底。
  out.sort((a, b) => {
    const ap = a.lastPromptAt ? 1 : 0
    const bp = b.lastPromptAt ? 1 : 0
    if (ap !== bp) return bp - ap
    if (ap === 1 && b.lastPromptAt !== a.lastPromptAt) return b.lastPromptAt - a.lastPromptAt
    return (b.mtime || 0) - (a.mtime || 0)
  })
  return out
}

/** 只保留最近 N 天的会话（0/负数 = 不过滤），再按活动时间倒序。 */
export function filterRecentSessions(sessions, days, now = Date.now()) {
  if (!days || days <= 0) return [...sessions]
  const floor = now - days * 24 * 60 * 60 * 1000
  return sessions.filter((s) => (s.lastActivityAt || 0) >= floor)
}

/**
 * 把用户写的"目标"解析成一个确切的会话 id。
 *
 * 支持的写法（按优先级）：
 *   1. 完整 id              `session-1406fdfe-…`
 *   2. id 的任意唯一前缀     `1406fdfe` / `session-1406`
 *   3. 会话名（完全匹配）    `Coding回传`   ← 重名时报歧义，不瞎猜
 *   4. 会话名（子串匹配）    `Coding`
 *
 * 为什么名字排最后：标题是自动生成的、可空、会重名（实测两个会话都叫「连通性测试」）。
 * 命中多个时**必须**返回 ambiguous + 候选列表，让用户改用 id —— 静默挑一个是最坏的行为。
 */
export function resolveSession(selector, options = {}) {
  const sessions = Array.isArray(options.sessions) ? options.sessions : []
  const raw = String(selector == null ? '' : selector).trim()
  if (raw === '') return { ok: false, code: 'EMPTY', error: '目标为空' }

  const exactId = sessions.find((s) => s.id === raw)
  if (exactId) return { ok: true, id: exactId.id, strategy: 'id', session: exactId }

  const needle = raw.startsWith('session-') ? raw : raw
  const idPrefix = sessions.filter((s) => s.id.startsWith(needle) || s.id.replace(/^session-/, '').startsWith(needle))
  if (idPrefix.length === 1) return { ok: true, id: idPrefix[0].id, strategy: 'id-prefix', session: idPrefix[0] }
  if (idPrefix.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_ID', error: `前缀 ${raw} 命中 ${idPrefix.length} 个会话`, candidates: idPrefix }
  }

  const named = sessions.filter((s) => s.title && s.title === raw)
  if (named.length === 1) return { ok: true, id: named[0].id, strategy: 'title', session: named[0] }
  if (named.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_TITLE',
      error: `有 ${named.length} 个会话都叫「${raw}」，请改用 id（会话名可以重复）`,
      candidates: named,
    }
  }

  const partial = sessions.filter((s) => s.title && s.title.includes(raw))
  if (partial.length === 1) return { ok: true, id: partial[0].id, strategy: 'title-partial', session: partial[0] }
  if (partial.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_TITLE',
      error: `「${raw}」匹配到 ${partial.length} 个会话标题，请改用 id`,
      candidates: partial,
    }
  }
  return { ok: false, code: 'NOT_FOUND', error: `找不到会话：${raw}`, candidates: [] }
}

/**
 * 解析多 QQ 回传目标。
 *
 * 支持三种写法（逗号/分号/空白分隔）：
 *   · `8765`                        → [{ uin: '', port: 8765 }]
 *   · `8765,8865`                   → 两个端口，账号未知
 *   · `158732453:8765,487271667:8865` → 带账号（推荐：结果就能按来源账号回传）
 *   · `158732453,487271667`         → 只给账号，端口按 8765 + 序号*100 推
 */
export function parseQqTargets(value) {
  const raw = String(value == null ? '' : value).trim()
  if (raw === '') return []
  const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
  const out = []
  let autoIndex = 0
  for (const part of parts) {
    const m = /^([^:]+):(\d+)$/.exec(part)
    if (m) {
      out.push({ uin: m[1].trim(), port: Number(m[2]) })
      autoIndex += 1
      continue
    }
    if (/^\d{2,6}$/.test(part)) {
      const n = Number(part)
      // 端口号一般 ≥ 1024 且我们约定以 8765 为基准；账号 QQ 号 ≥ 5 位
      if (n >= 1024 && n <= 65535 && String(n).length === 4) {
        out.push({ uin: '', port: n })
        autoIndex += 1
        continue
      }
      out.push({ uin: part, port: BASE_QQ_PORT + autoIndex * QQ_PORT_STEP })
      autoIndex += 1
      continue
    }
    out.push({ uin: part, port: BASE_QQ_PORT + autoIndex * QQ_PORT_STEP })
    autoIndex += 1
  }
  // 去重（同端口只留第一个）
  const seen = new Set()
  return out.filter((t) => {
    const key = String(t.port)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 列出所有可能的任务文件（多 QQ：每个账号一份）。
 *
 * 形态：
 *   <home>/data/dev-coding/tasks.json                          （旧版/主账号）
 *   <home>/accounts/<uin>/plugins/dev-coding/tasks.json         （多账号隔离后）
 * accounts.json 里出现的 uin 都会被列上（文件不存在也算一条，便于诊断）。
 */
export function listTaskFiles(options = {}) {
  const home = options.home || process.env.QQ_AGENT_HOME || 'E:\\QQ Agent'
  const files = []
  files.push({ path: path.join(home, 'data', 'dev-coding', 'tasks.json'), uin: '', kind: 'legacy' })
  const accountsFile = path.join(home, 'accounts.json')
  const registry = readJsonSafe(accountsFile)
  const uins = []
  if (registry && Array.isArray(registry.accounts)) {
    for (const a of registry.accounts) {
      const uin = a && a.uin ? String(a.uin) : ''
      if (uin) uins.push({ uin, port: accountPort(uin, uins.length) })
    }
  }
  for (const { uin, port } of uins) {
    files.push({
      path: path.join(home, 'accounts', uin, 'plugins', 'dev-coding', 'tasks.json'),
      uin,
      port,
      kind: 'account',
    })
  }
  return files.map((f) => ({ ...f, exists: fs.existsSync(f.path) }))
}

/** 账号在注册表里的序号 → 端口（QQ Agent 的 portOffset 约定：+100/账号）。 */
export function accountPort(_uin, index) {
  return BASE_QQ_PORT + Math.max(0, Number(index) || 0) * QQ_PORT_STEP
}

/** 读一份 tasks.json（只读，容错）。 */
export function readTasksFile(file) {
  const data = readJsonSafe(file)
  if (!data || typeof data !== 'object') return { tasks: {}, count: 0 }
  const tasks = data.tasks && typeof data.tasks === 'object' ? data.tasks : {}
  return { tasks, count: Object.keys(tasks).length, raw: data }
}

/**
 * 汇总多份任务文件里"尚未回传"的任务（多 QQ 场景下 DSH 侧要扫全部账号）。
 * 返回的每条都带上它来自哪个账号（用于把结果回传到来源账号）。
 */
export function collectPendingTasks(files) {
  const out = []
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || !file.exists) continue
    const { tasks } = readTasksFile(file.path)
    for (const [taskId, rec] of Object.entries(tasks)) {
      if (!rec || typeof rec !== 'object') continue
      const status = String(rec.status || '')
      if (status !== 'pending' && status !== 'queued') continue
      out.push({ taskId, account: file.uin || '', sourceFile: file.path, record: rec })
    }
  }
  return out
}

/**
 * 根据任务记录推断"结果该回传到哪个端口"。
 * 优先用任务里写死的 notifyPort（QQ 侧多账号必须写它），其次按账号端口，最后兜底基准端口。
 */
export function notifyTargetFor(task, qqTargets = []) {
  const targets = Array.isArray(qqTargets) ? qqTargets : []
  const explicit = task && task.payload && task.payload.notifyPort
  if (explicit) return Number(explicit)
  const uin = String((task && (task.account || task.uin)) || '')
  if (uin) {
    const hit = targets.find((t) => String(t.uin) === uin)
    if (hit) return hit.port
  }
  if (targets.length === 1) return targets[0].port
  return BASE_QQ_PORT
}
