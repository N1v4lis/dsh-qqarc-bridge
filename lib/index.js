/**
 * dsh-dev-task-bridge —— DSH（Host 侧）桥接插件
 *
 * ── 它在整条链路里的位置 ──────────────────────────────────────────────────
 *   QQ 群里管理员发「开发 xxxx」
 *     → QQ Agent 插件 dev-coding 把需求写进共享任务文件，并 POST 到这里
 *     → 本插件把需求作为一条**真实用户消息**注入指定会话（agent.followup）
 *     → 该会话里的 Agent 真的动手做事（这一步就是"Chat Coding 回传"）
 *     → 做完调用 dev_task_result 工具把结论回传
 *     → 本插件 POST 给 QQ Agent 的本地接口，QQ 侧渲染成长图发回原群
 *
 * ── 两个关键设计（都有踩坑背景）────────────────────────────────────────────
 * 1) **只有 QQ 侧写任务文件，本插件一律通过 HTTP 回传。**
 *    两边都去改同一个 tasks.json 会互相覆盖（读—改—写不是原子的，跨进程必然丢数据）。
 *    所以约定：QQ 侧是任务文件的唯一写者，本插件只负责把结果 POST 回 /dev/notify。
 *    万一 QQ 侧没在跑，本插件会退化成"直接改任务文件"，并在日志里说清楚。
 *
 * 2) **必须用 agent.followup()，不是 agent.inject()。**
 *    inject() 只塞上下文、**不唤醒**驱动；followup() 会入 next-turn 队列并唤醒，
 *    会话 idle 时也会立刻开新一轮（源码 dsh-agent-loop：`followup -> send(...,true)
 *    -> wakeDriver()`，其注释明确写 "A wake sent while idle always opens its turn
 *    boundary"）。用错的话表现为"消息进去了但机器人不动"，极难排查。
 *
 * ── 形态说明 ──────────────────────────────────────────────────────────────
 * Cordis 函数插件：模块导出即清单（没有 plugin.json）。`inject` 列出的服务必须先就绪
 * 才会调用 apply()，因此 webServer / agents / tools 三个都能直接当属性用。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import {
  BASE_QQ_PORT,
  listStoredSessions,
  filterRecentSessions,
  resolveSession,
  parseQqTargets,
  listTaskFiles,
  readTasksFile,
  notifyTargetFor,
} from './sessions.js'

/**
 * 解析 @deepseek-ai/* 包的位置。
 *
 * ⚠️ 这两个包**不能**直接用裸说明符 import：本插件是通过 `link:` 装进 profile 的
 * （desktop profile 只能这么装），node_modules 里那条是 **junction**，而 Node 解析
 * 说明符时用的是**真实路径**（E:\QQ Agent Dev\dsh-dev-task-bridge\lib\），于是不会去
 * profile 的 node_modules 里找，直接 ERR_MODULE_NOT_FOUND —— 表现为"装上了但
 * failed to import"，还不会说清是哪个包。
 *
 * 这里用 createRequire 锚在 profile 的 node_modules 上显式解析；全都失败才退回
 * 裸说明符（插件被直接复制进 node_modules 时那条路是通的）。
 */
function resolveDshModule(spec) {
  const anchors = [
    process.env.DSH_PROFILE_DIR
      ? path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'noop.cjs')
      : '',
    process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'noop.cjs')
      : '',
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'noop.cjs'),
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', 'noop.cjs'),
    // 兜底：Electron 主进程的 cwd 就在 DSH 安装目录里，从那儿往上能走到自带的
    // node_modules（不依赖任何环境变量，是最后一道保险）
    path.join(process.cwd(), 'noop.cjs'),
  ].filter(Boolean)
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(spec)
    } catch { /* 换下一个锚点 */ }
  }
  return spec
}

/**
 * 加载失败时把原因写进一个文件。
 * 为什么：DSH 的加载器只会打印一句 "failed to import"，具体是哪个包、什么原因
 * 一概不说。落盘一份，排查成本从"猜"变成"读"。
 * （注意：它救不了"顶层 await"那类错误 —— 那种错误根本没机会执行到这里。）
 */
function annotate(error, spec) {
  const message = `[dev-task-bridge] 加载 ${spec} 失败：${String((error && error.stack) || error)}`
  try {
    const dir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'dev-task-bridge.error.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* 落盘失败也不能掩盖原始错误 */ }
  const wrapped = new Error(message)
  wrapped.cause = error
  return wrapped
}

/**
 * 动态装载依赖，并把依赖它们的函数挂到 bridge 上。只跑一次。
 */
async function init() {
  const [toolsModule, llmModule] = await Promise.all([
    import(pathToFileURL(resolveDshModule('@deepseek-ai/dsh-tools')).href)
      .catch((error) => { throw annotate(error, '@deepseek-ai/dsh-tools') }),
    import(pathToFileURL(resolveDshModule('@deepseek-ai/dsh-llm')).href)
      .catch((error) => { throw annotate(error, '@deepseek-ai/dsh-llm') }),
  ])
  const defineTool = toolsModule.defineTool || toolsModule.default?.defineTool
  const createUserMessage = llmModule.createUserMessage || llmModule.default?.createUserMessage
  if (typeof defineTool !== 'function' || typeof createUserMessage !== 'function') {
    throw new Error(
      '[dev-task-bridge] 无法从 @deepseek-ai/dsh-tools / dsh-llm 取到 defineTool / createUserMessage，'
      + '插件无法工作（请检查 profile 的 node_modules 是否完整）'
    )
  }

  /**
   * 把一段文本作为**真实用户消息**送进某个会话。
   * 用 followup()：入 next-turn 队列并唤醒驱动 —— 会话空闲时也会立刻开新一轮。
   */
  bridge.deliverToSession = (ctx, sessionId, text) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return { ok: false, code: 'NO_LIVE_AGENT' }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      // ⚠️ source.kind 只能用**生产者自有**的 kind（会话格式 v4 硬校验）。
      //    写成 kind:'plugin' 会在写会话日志那一刻抛：
      //      SessionFormatError: format v4 message requires a producer-owned source kind
      //    后果不是"这条消息没发出去"，而是**整个会话从此跑不动**
      //    （每一轮都在追加日志时失败，界面只显示"本轮运行失败"，实测踩过，
      //      旧会话 session-979c444f 就是这么废掉的）。
      //    我们注入的本来就是一条"用户消息"，所以用 'user'。
      //    合法 kind 见 @deepseek-ai/dsh-llm 的 MessageSourceMap：
      //    user / model / tool / system-prompt / agent-message / goal / schedule …
      source: { kind: 'user' },
    })
    agent.followup(message)
    return { ok: true, messageId: message.id, agentStatus: agent.status }
  }

  // 工具对象也在 init 之后才能构造（defineTool 在这里才有）
  bridge.defineTool = defineTool
  return bridge
}

/** 同一进程内只初始化一次；失败不缓存（下次 apply 还能重试）。 */
function ready() {
  if (!readyPromise) {
    readyPromise = init().catch((error) => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

/**
 * ⚠️ 这个文件里**绝对不能出现顶层 await**。
 *
 * 实测教训：DSH 的加载器加载 entry 时，遇到含顶层 await 的 ESM 图会抛
 *   ERR_REQUIRE_ASYNC_MODULE: require() cannot be used on an ESM graph with
 *   top-level await. Use import() instead.
 * 而这个错误**发生在模块体执行之前**，所以文件里任何 try/catch、任何日志、
 * 任何"落盘错误原因"的兜底都来不及跑 —— 界面上只看到一句 "failed to import"，
 * 完全不知道是哪里出的问题（我为此白排查了两轮）。
 *
 * 所以依赖改为在 init() 里动态 import，init 的 Promise 由 apply() 等待。
 */

export const name = 'dev-task-bridge'

export const inject = ['webServer', 'agents', 'tools']

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const MAX_BODY_BYTES = 256 * 1024

/** QQ Agent 侧 dev-coding 插件的本地接口（两个插件必须一致）。 */
const DEFAULT_QQ_PORT = 8765
/** 默认注入口：QQ 侧把结果 POST 到这里。 */
const DEFAULT_NOTIFY_PORT = Number(process.env.DEV_TASK_QQ_PORT || DEFAULT_QQ_PORT)
/**
 * 多 QQ 回传目标。
 *   DEV_TASK_QQ_TARGETS=158732453:8765,487271667:8865   （推荐：带账号，结果按来源账号回传）
 *   DEV_TASK_QQ_TARGETS=8765,8865                        （只给端口）
 * 未配置时退回单端口 DEV_TASK_QQ_PORT / 8765。
 */
const QQ_TARGETS = parseQqTargets(process.env.DEV_TASK_QQ_TARGETS || process.env.DEV_TASK_QQ_PORT || DEFAULT_QQ_PORT)
/** 共享任务文件（留空则按 QQ Agent 默认数据目录推）。 */
const DEFAULT_TASKS_FILE = process.env.DEV_TASK_TASKS_FILE || ''
/** 目标会话：可由环境变量预置，也会在第一次投递时自动记下。 */
let DEFAULT_SESSION = String(process.env.DEV_TASK_SESSION || '')
/** 轮询共享任务文件的间隔。 */
const POLL_MS = Number(process.env.DEV_TASK_POLL_MS || 4000)
/**
 * 代码修订号：只用于"这次加载的到底是哪一版代码"。
 * 热重载（HMR）是异步的，改完文件没法从进程外确认它有没有生效 —— 把这个值放进
 * /dev-task/status，curl 一下就知道（值没变 = 还在跑旧模块 = 需要重启 DSH）。
 *
 * ⚠️ 改这个文件的**行为**时记得一起改这里。踩过的坑：加了新功能却没改这个字符串，
 *    重启助手看 status 里还是老值，判定"已经是新代码"直接退出 —— 于是新代码一直没生效，
 *    表现是"明明改了代码，长图上却没有新字段"。（助手现在还会比对文件修改时间，
 *    双保险，见 _devcoding/restart-dsh.ps1。）
 */
const REVISION = 'v6-multiqq-sessions'

/** init() 装好之后才有的东西（defineTool / createUserMessage / 依赖它们的函数）。 */
const bridge = {}
/** 只执行一次的初始化 Promise；apply() 会 await 它。 */
let readyPromise = null

/**
 * 已排队、等待注入的请求：requestId -> { sessionId, text, taskId, reply }
 * HTTP 处理器只入队立即返回（不 await 注入本身），避免长操作卡住请求。
 */
const pending = new Map()

/**
 * 本插件经手过的任务：taskId -> 状态。
 * 用来在没有显式调用 dev_task_result 时，于本轮结束时兜底回传最后一条助手消息。
 */
const knownTasks = new Map()

// ───────────────────────────────────────────────────────────── 小工具

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/**
 * 轻量信任栅栏：只放行回环 Host、同源 Origin、非 cross-site 的浏览器请求。
 * 这个路由是给本机脚本用的（不带 cookie），所以**不套 host 的 cookie 鉴权**，
 * 但也不能变成"任何网页都能通过浏览器 POST 进来"。
 */
function hostFence(req) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl
    try {
      hostUrl = new URL('http://' + String(headers.host || ''))
    } catch {
      return 403
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = headers.origin
    if (origin) {
      let originUrl
      try {
        originUrl = new URL(origin)
      } catch {
        return 403
      }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }
    // 可选共享密钥：设置了就必须带（本机脚本之间的一道暗号）
    const token = String(process.env.DEV_TASK_TOKEN || '')
    if (token && String(headers['x-dev-task-token'] || '') !== token) return 401
    return null
  } catch {
    return 403
  }
}

function sendJson(res, status, payload) {
  try {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  } catch { /* 连接已断 */ }
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`))
        try { req.destroy() } catch { /* 已断 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${String((error && error.message) || error)}`))
      }
    })
  })
}

function textOfMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 取会话里最后一条助手消息的纯文本（兜底回传用）。 */
function lastAssistantText(session) {
  try {
    if (session && typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages()
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]
        if (m && m.role === 'assistant') {
          const text = textOfMessage(m)
          if (text) return text
        }
      }
    }
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev && ev.type === 'assistant/message') {
          const text = textOfMessage(ev.message)
          if (text) return text
        }
      }
    }
  } catch { /* 取不到就走"无正文"路径 */ }
  return ''
}

/** QQ Agent 家目录（多账号的 accounts/<uin>/… 都挂在它下面）。 */
function qqAgentHome() {
  return process.env.QQ_AGENT_HOME || 'E:\\QQ Agent'
}

function tasksFilePath() {
  if (DEFAULT_TASKS_FILE) return DEFAULT_TASKS_FILE
  // 与 QQ Agent 插件 dev-coding 的默认位置一致（数据目录可由环境变量改写）
  const home = process.env.QQ_AGENT_HOME || 'E:\\QQ Agent'
  return path.join(home, 'data', 'dev-coding', 'tasks.json')
}

/** DSH 侧写给 QQ 侧的握手文件：告诉它"我在哪、目标会话是谁"。 */
/**
 * 挑一个默认注入目标。
 *
 * 为什么要挑：DSH 侧的消息注入必须指明 sessionId，而 QQ 侧无从知道。用户要的是
 * "回传到**本对话**"，所以这里按"用户正在用的那个会话"来挑：
 *   1. 环境变量 DEV_TASK_SESSION 明确指定 → 用它（没绑成功时也能人工救急）
 *   2. 只取**顶层**会话（roots()，排除 subagent 子会话），取最后注册的那个
 *      —— 注册顺序里最后出现的，就是最近被打开的会话，也就是用户在看的那个
 * 单一会话使用时这就是那个会话；多开时如果送回错了人，改 QQ Agent 插件设置里的
 * 「目标会话 ID」即可精确指定。
 */
function pickDefaultSession(ctx) {
  try {
    if (DEFAULT_SESSION && ctx.agents.get(DEFAULT_SESSION) !== undefined) return DEFAULT_SESSION
  } catch { /* 继续往下挑 */ }
  // 上一版记下的目标会话优先：这样"人工改指向"能跨重启保留下来。
  // 不加这一步的症状是：改好指向、重启 DSH，它又按 roots() 顺序挑回旧会话 ——
  // 用户看到的就是"我改过了，它还是往废掉的会话里投"。
  try {
    const remembered = readIdentitySession()
    if (remembered && ctx.agents.get(remembered) !== undefined) {
      DEFAULT_SESSION = remembered
      return DEFAULT_SESSION
    }
  } catch { /* 继续往下挑 */ }
  try {
    const roots = typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : ctx.agents.list()
    const candidate = roots.length ? roots[roots.length - 1] : undefined
    const id = candidate ? String(candidate.id || '') : ''
    if (id) DEFAULT_SESSION = id
    return DEFAULT_SESSION
  } catch {
    return DEFAULT_SESSION
  }
}

/**
 * 握手文件位置。原则：**QQ 侧能猜到，我们也能写**。
 * 主位置用 os.homedir() 推（不依赖 DSH_HOME 环境变量 —— Electron 里它未必存在），
 * 同时往 DSH_HOME 也写一份（QQ 侧优先读那里），两边任取其一都能对上。
 */
function identityFiles() {
  const list = []
  try {
    list.push(path.join(os.homedir(), '.dsh', 'dev-task-bridge.json'))
  } catch { /* 拿不到家目录就跳过 */ }
  const home = process.env.DSH_HOME || ''
  if (home) list.push(path.join(home, 'dev-task-bridge.json'))
  return [...new Set(list)]
}

/** 读回握手文件里记着的目标会话（QQ 侧读的是同一个文件）。 */
function readIdentitySession() {
  for (const file of identityFiles()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const sid = typeof data.sessionId === 'string' ? data.sessionId.trim() : ''
      if (sid) return sid
    } catch { /* 换下一个位置 */ }
  }
  return ''
}

function writeIdentity(sessionId, extra = {}) {
  const files = identityFiles()
  if (!files.length) return false
  // 合并写：先把文件里已有的字段读出来，再叠加本次要改的。
  // 直接覆盖会把人工加的标记（pinnedBy / pinnedAt 之类）冲掉 —— 离线套件里有一条
  // "启动时不覆盖人工定向"的断言就是盯这个的（实测被它抓到过）。
  let existing = {}
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') { existing = parsed; break }
    } catch { /* 还没有文件 / 坏了就当空的 */ }
  }
  const payload = {
    ...existing,
    sessionId: sessionId || existing.sessionId || '',
    notifyPort: DEFAULT_NOTIFY_PORT,
    tasksFile: tasksFilePath(),
    token: String(process.env.DEV_TASK_TOKEN || ''),
    updatedAt: Date.now(),
    ...extra,
  }
  let wrote = false
  for (const file of files) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8')
      fs.renameSync(tmp, file)
      wrote = true
    } catch { /* 换下一个位置 */ }
  }
  return wrote
}

/** 兜底：QQ 侧接口不可用时，直接把结果写进共享任务文件。 */
function writeResultToTasksFile(taskId, payload, fileHint) {
  // 多 QQ：必须写回**任务来源的那份** tasks.json（每个账号一份），
  // 否则主号的任务会被写进 bot 号的文件里 —— 表现是"结果回来了但发给了另一个号"。
  const file = fileHint || tasksFilePath()
  if (!file) return false
  try {
    if (!fs.existsSync(file)) return false
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rec = data && data.tasks ? data.tasks[taskId] : null
    if (!rec) return false
    const status = payload.ok === false ? 'failed' : 'done'
    data.tasks[taskId] = {
      ...rec,
      status,
      ok: status === 'done',
      markdown: String(payload.markdown || rec.markdown || ''),
      title: String(payload.title || rec.title || ''),
      files: payload.files == null ? rec.files : Number(payload.files) || 0,
      reason: String(payload.reason || rec.reason || ''),
      finishedAt: Date.now(),
      // 长图右上角要用的两项（QQ 侧补发时也得有）
      durationMs: payload.durationMs == null ? rec.durationMs : Number(payload.durationMs) || 0,
      usage: payload.usage == null ? rec.usage : payload.usage,
    }
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 把结果推给 QQ Agent；失败返回 { ok:false }，由调用方决定怎么兜底。 */
async function pushResult(payload, signal, portHint) {
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
      const response = await fetch(`http://127.0.0.1:${port}/dev/notify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, notifyPort: port }),
        signal,
      })
      tried.push({ port, status: response.status })
      if (response.ok) return { ok: true, status: response.status, via: 'http', port, tried }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = String((error && error.message) || error)
      tried.push({ port, status: 0 })
    }
  }
  return { ok: false, status: 0, via: 'http', error: lastError, tried }
}

// ───────────────────────────────────────────────────────────── 注入
// deliverToSession 的真实实现在 init() 里（依赖 createUserMessage），挂到 bridge 上。
// 这里只做一层转发，好处是插件在被禁用/未就绪时能给出明确错误而不是 undefined 崩溃。

function deliverToSession(ctx, sessionId, text) {
  if (typeof bridge.deliverToSession !== 'function') {
    return { ok: false, code: 'NOT_READY' }
  }
  return bridge.deliverToSession(ctx, sessionId, text)
}

// ───────────────────────────────────────────────────────────── 工具

/**
 * 取一个 agent 身上的 session。
 *
 * 为什么写成这样（实测踩过）：早先写成
 *   `const candidates = [agent.session, agent.state?.session, agent.ctx?.session]`
 * —— 只要其中**任意一个取值抛异常**，整条式子就炸了；被外层 catch 吞掉后
 * `hasSession` 变成 false，长图上 token 永远是 "—"，而外面完全看不出原因
 * （实测自检路由里就是 hasAgent=true / hasSession=false，还看不出是哪一项坏的）。
 * 现在每个候选各自 try/catch，一个坏了不影响别的；探测结果会进自检路由。
 */
function sessionOf(agent, probe = null) {
  if (!agent) return null
  const paths = [
    ['session', () => agent.session],
    ['state.session', () => agent.state?.session],
    ['ctx.session', () => agent.ctx?.session],
    ['core.session', () => agent.core?.session],
  ]
  let fallback = null
  for (const [label, read] of paths) {
    let value = null
    try {
      value = read()
    } catch (error) {
      if (probe) probe.push(`${label}: 抛错 ${String((error && error.message) || error)}`)
      continue
    }
    if (!value) { if (probe) probe.push(`${label}: 空`); continue }
    const hasSnapshot = typeof value.snapshotEvents === 'function'
    if (probe) {
      probe.push(`${label}: ${value.constructor?.name || typeof value}`
        + `${hasSnapshot ? '（有 snapshotEvents）' : '（没有 snapshotEvents）'}`)
    }
    if (hasSnapshot) return value
    if (!fallback) fallback = value
  }
  return fallback
}

/**
 * 统计某个会话"从某个时刻到现在"的 token 用量。
 *
 * DSH 把每一步的用量记在会话事件上（`assistant/message` 的 `data.usage`：
 * `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`）。
 * 所以按"注入时刻"筛一遍再求和，就是**这次开发花了多少 token**。
 * 这里对取值路径做了兜底（data.usage / usage / data.message.usage），
 * 免得某个版本挪了字段就静默变成 "—"。
 *
 * @param session - agent 的 session（有 snapshotEvents() 就能读）
 * @param sinceMs - 只统计这个时间之后的事件（任务的注入时刻）
 */
function usageSince(session, sinceMs) {
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, steps: 0,
  }
  const stats = { events: 0, assistantEvents: 0, usageEvents: 0 }
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    stats.events = Array.isArray(events) ? events.length : 0
    for (const event of events || []) {
      if (!event || event.type !== 'assistant/message') continue
      stats.assistantEvents += 1
      if (sinceMs && Number(event.time) < sinceMs) continue
      const u = event.data?.usage || event.usage || event.data?.message?.usage
      if (!u) continue
      stats.usageEvents += 1
      usage.steps += 1
      usage.inputTokens += Number(u.inputTokens) || 0
      usage.outputTokens += Number(u.outputTokens) || 0
      usage.cacheReadTokens += Number(u.cacheReadTokens) || 0
      usage.cacheWriteTokens += Number(u.cacheWriteTokens) || 0
      usage.totalTokens += Number(u.totalTokens) || 0
    }
  } catch { /* 读不到事件就不带用量，长图上显示 — */ }
  usage.debug = stats
  return usage
}

/**
 * 汇总一条任务的指标：token 用量 + 开发时长（注入 → 完成）。
 * 报告长图右上角那两行就是它：没有就让 QQ 侧显示 "—"，绝不编数字。
 */
function collectMetrics(ctx, taskId, finishedAt, options = {}) {
  const info = knownTasks.get(taskId) || {}
  const startedAt = Number(info.startedAt) || 0
  let agent = null
  let session = null
  const probe = []
  try {
    agent = ctx.agents.get(info.sessionId) || null
    session = sessionOf(agent, probe)
  } catch (error) {
    probe.push(`取 agent 抛错：${String((error && error.message) || error)}`)
  }
  const usage = session ? usageSince(session, startedAt) : null
  const out = {
    startedAt: startedAt || null,
    finishedAt,
    durationMs: startedAt ? Math.max(0, finishedAt - startedAt) : null,
    // steps === 0 说明这一步还没记用量（或会话读不到）→ 不要给个全 0 的假数据
    usage: usage && usage.steps > 0 ? usage : null,
  }
  // 自检信息只在 debug 时要（/dev-task/metrics 用）：外面看这几个字段就知道"为什么没取到"
  if (options.debug) {
    out._debug = {
      taskId,
      sessionId: info.sessionId || '',
      hasAgent: Boolean(agent),
      hasSession: Boolean(session),
      sessionProbe: probe,
      agentKeys: agent ? Object.keys(agent).slice(0, 30) : [],
      events: usage?.debug?.events ?? null,
      assistantEvents: usage?.debug?.assistantEvents ?? null,
      usageEvents: usage?.debug?.usageEvents ?? null,
      rawUsage: usage ? { ...usage } : null,
    }
  }
  return out
}

/**
 * 构造 dev_task_result 工具。放在函数里（而不是模块顶层 const）有两个原因：
 *   1. defineTool 要等 init() 动态 import 之后才有；
 *   2. 模块顶层不能有 await —— 见文件头关于 ERR_REQUIRE_ASYNC_MODULE 的说明。
 *
 * ctx 由 apply() 传进来（工具执行时要靠它去会话里取 token 用量与时长）。
 */
function buildResultTool(defineTool, ctx) {
  return defineTool({
    name: 'dev_task_result',
    description:
      '把一个开发任务的最终结果回传给本机 QQ Agent（它会渲染成长图发回 QQ 群）。'
      + '任务做完时调用一次；markdown 写成能直接给人看的结论'
      + '（做了什么、改了哪些文件、结论），不要写聊天过程。',
    parameters: {
      taskId: { type: 'string', required: true, description: 'dev-task 提示里给出的任务编号（taskId）。' },
      markdown: { type: 'string', required: true, description: '结果正文，Markdown 格式。' },
      ok: { type: 'boolean', required: true, description: '任务是否成功完成。' },
      title: { type: 'string', description: '一句话标题，显示在结果图顶部。' },
      files: { type: 'integer', description: '改动/新增的文件数量，用于结果图上的统计。' },
      reason: { type: 'string', description: '失败时的原因（ok=false 时填）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          status: { type: 'integer', required: true },
          taskId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `任务 ${value.taskId} 的结果已回传给 QQ Agent（HTTP ${value.status}）。`
          : `任务 ${value.taskId} 的结果**没能**回传（HTTP ${value.status}）：QQ Agent 可能没在运行。`,
      }],
    },
    async execute(args, exec) {
      const finishedAt = Date.now()
      const payload = {
        taskId: String(args.taskId),
        status: args.ok === false ? 'failed' : 'done',
        ok: args.ok !== false,
        markdown: String(args.markdown || ''),
        title: args.title == null ? '' : String(args.title),
        files: args.files == null ? null : Number(args.files) || 0,
        reason: args.reason == null ? '' : String(args.reason),
        finishedAt,
        from: name,
        // 长图右上角要的"本次开发 token 消耗 / 开发时长"
        ...collectMetrics(ctx, String(args.taskId), finishedAt),
      }
      const known = knownTasks.get(payload.taskId) || {}
      const pushed = await pushResult(payload, exec && exec.signal, known.notifyPort)
      if (pushed.ok) {
        knownTasks.set(payload.taskId, { ...(knownTasks.get(payload.taskId) || {}), delivered: true })
        bridge.log?.(`任务 ${payload.taskId} 的结果已回传（HTTP ${pushed.status}）`)
        return { delivered: true, status: pushed.status, taskId: payload.taskId }
      }
      // QQ 侧没在跑：退化成直接改共享任务文件（QQ 侧下次轮询/重启即可发现）
      const wrote = writeResultToTasksFile(payload.taskId, payload, known.sourceFile)
      if (wrote) {
        knownTasks.set(payload.taskId, { ...(knownTasks.get(payload.taskId) || {}), delivered: true })
        bridge.warn?.(`回传接口不通（${pushed.error || pushed.status}），已直接写入任务文件：${payload.taskId}`)
        return { delivered: true, status: 0, taskId: payload.taskId }
      }
      bridge.warn?.(`回传失败：${payload.taskId} —— ${pushed.error || `HTTP ${pushed.status}`}`)
      return { delivered: false, status: pushed.status || 0, taskId: payload.taskId }
    },
  })
}

// ───────────────────────────────────────────────────────────── 插件

/** 插件的 apply：Cordis 在 inject 的服务就绪后调用它。 */
export async function apply(ctx, config) {
  void config
  const log = (msg) => { try { ctx.logger?.info?.(`[${name}] ${msg}`) } catch { /* 无 logger */ } }
  const warn = (msg) => { try { ctx.logger?.warn?.(`[${name}] ${msg}`) } catch { /* 无 logger */ } }

  // 先装依赖（动态 import，避免顶层 await —— 见文件头注释）
  try {
    await ready()
  } catch (error) {
    warn(`初始化失败，插件未启用：${String((error && error.message) || error)}`)
    throw error
  }
  bridge.log = log
  bridge.warn = warn

  // ── (A) POST /dev-task：QQ 侧投递需求 ──────────────────────────────────
  const route = {
    kind: 'exact',
    path: '/dev-task',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: String((error && error.message) || error) })
        return
      }
      let sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const sessionName = typeof body.sessionName === 'string' ? body.sessionName.trim() : ''
      const text = typeof body.text === 'string' ? body.text : ''
      // 允许用**会话名**投递（用户看不到完整 id）：先解析成 id，重名则明确报歧义
      if (sessionId === '' && sessionName !== '') {
        const named = await listSessionsAuthoritative()
        const resolved = resolveSession(sessionName, { sessions: named.sessions })
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
      }
      const requestId = typeof body.requestId === 'string' && body.requestId ? body.requestId : `req-${Date.now()}`
      const taskId = typeof body.taskId === 'string' ? body.taskId : ''

      // 先确认目标会话活着再收下，免得入队后才发现没人接
      if (ctx.agents.get(sessionId) === undefined) {
        sendJson(res, 404, {
          ok: false,
          code: 'NO_LIVE_AGENT',
          error: `会话 ${sessionId} 当前没有存活的 Agent（要在 DSH 里打开着这个会话）`,
        })
        return
      }

      // 立刻回执，注入放到下一个事件循环：不把长活压在 HTTP 请求上
      sendJson(res, 202, { ok: true, requestId, taskId, queued: true })
      setImmediate(() => {
        try {
          const result = deliverToSession(ctx, sessionId, text)
          if (!result.ok) {
            warn(`注入失败（${result.code}）：session=${sessionId}`)
            return
          }
          if (taskId) {
            knownTasks.set(taskId, {
              sessionId,
              startedAt: Date.now(),
              delivered: false,
              accountUin: typeof body.accountUin === 'string' ? body.accountUin : '',
              notifyPort: Number(body.notifyPort) || DEFAULT_NOTIFY_PORT,
            })
            log(`已把任务 ${taskId} 注入会话 ${sessionId}（消息 ${result.messageId}，agent=${result.agentStatus}）`)
          } else {
            log(`已把一条消息注入会话 ${sessionId}（消息 ${result.messageId}）`)
          }
        } catch (error) {
          warn(`注入会话 ${sessionId} 时出错：${String((error && error.message) || error)}`)
        }
      })
    },
  }

  // ── (B) GET /dev-task/status：自检用 ──────────────────────────────────
  const statusRoute = {
    kind: 'exact',
    path: '/dev-task/status',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      let agents = []
      try {
        agents = ctx.agents.list().map((a) => String(a.id))
      } catch { /* 拿不到就算了 */ }
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        revision: REVISION,
        defaultSession: DEFAULT_SESSION || pickDefaultSession(ctx),
        injectSourceKind: 'user',
        notifyPort: DEFAULT_NOTIFY_PORT,
        qqTargets: QQ_TARGETS,
        sessionsIndexed: (() => { try { return listStoredSessions().length } catch { return 0 } })(),
        sessionQuery: (() => { try { return typeof ctx.get === 'function' && Boolean(ctx.get('sessionQuery')) } catch { return false } })(),
        agents,
        tasks: [...knownTasks.entries()].map(([taskId, v]) => ({ taskId, ...v })),
        pending: pending.size,
        time: Date.now(),
      })
    },
  }

  // ── (B2) GET /dev-task/metrics?taskId=…：查"这张长图右上角的数字为什么是 —" ──
  // 长图上的 token / 时长如果显示不出来，从外面没法判断是"没取到会话"、
  // "会话里没有用量事件"还是"字段名不对"。这条路由把取值过程摊开给人看。
  const metricsRoute = {
    kind: 'exact',
    path: '/dev-task/metrics',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
      let taskId = url.searchParams.get('taskId') || ''
      if (!taskId) {
        // 不给就取最近一条已知任务
        const entries = [...knownTasks.entries()]
        taskId = entries.length ? entries[entries.length - 1][0] : ''
      }
      sendJson(res, 200, {
        ok: true,
        revision: REVISION,
        metrics: taskId ? collectMetrics(ctx, taskId, Date.now(), { debug: true }) : null,
        knownTasks: [...knownTasks.keys()],
        time: Date.now(),
      })
    },
  }

  // ── (C) dev_task_result 工具：本轮的显式回传口 ────────────────────────
  // 工具在 init() 里拿到 defineTool，但要用 ctx 去会话里取 token 用量/时长，所以在这里构造。
  const tool = bridge.defineTool ? buildResultTool(bridge.defineTool, ctx) : null
  if (!tool) warn('dev_task_result 工具没能构造出来，本次不注册（回传还有轮次结束兜底）')

  // ── (D) 兜底：这一轮结束了但任务还没回传 → 用最后一条助手消息顶上 ──────
  // 为什么需要：模型可能忘了调工具、或者被中途打断。不兜底的话，QQ 群里
  // 就只能一直等到超时，白白浪费一次已经做完的活。
  const onTurnStopping = (payload) => {
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      const sessionId = session ? String(session.id) : ''
      if (!sessionId) return
      for (const [taskId, info] of knownTasks.entries()) {
        if (info.delivered) continue
        if (String(info.sessionId) !== sessionId) continue
        // 只补"这一轮开始之后才注入"的任务，避免把上一位 agent 的旧任务也算进来
        if (Date.now() - Number(info.startedAt || 0) < 2000) continue
        const text = lastAssistantText(session)
        const fallbackFinishedAt = Date.now()
        const payloadOut = {
          taskId,
          status: text ? 'done' : 'failed',
          ok: Boolean(text),
          markdown: text || '',
          title: '',
          files: null,
          reason: text ? '' : '这一轮结束时没有拿到可回传的正文',
          finishedAt: fallbackFinishedAt,
          from: `${name}(fallback)`,
          ...collectMetrics(ctx, taskId, fallbackFinishedAt),
        }
        knownTasks.set(taskId, { ...info, delivered: true })
        pushResult(payloadOut, undefined, info.notifyPort)
          .then((r) => {
            if (r.ok) log(`任务 ${taskId} 未调用回传工具，已用本轮最终回复兜底回传（HTTP ${r.status}）`)
            else if (writeResultToTasksFile(taskId, payloadOut, info.sourceFile)) warn(`任务 ${taskId} 兜底回传走了任务文件`)
            else warn(`任务 ${taskId} 兜底回传失败：${r.error || r.status}`)
          })
          .catch(() => { /* 已记录 */ })
      }
    } catch (error) {
      warn(`轮次结束兜底处理出错：${String((error && error.message) || error)}`)
    }
  }

  // ── (H) GET /dev-task/sessions：把 DSH 的"会话区"摊开给人看 ────────────
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
      const enumerated = await listSessionsAuthoritative()
      let sessions = filterRecentSessions(enumerated.sessions, days)
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
        source: enumerated.source,
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
      const discovered = await discoverQqInstances(true)
      const probes = []
      for (let i = 0; i < 4; i += 1) {
        const port = BASE_QQ_PORT + i * 100
        const hit = discovered.find((d) => d.port === port)
        const declared = QQ_TARGETS.find((t) => Number(t.port) === port)
        probes.push(hit
          ? { ...hit, ok: true, declared: Boolean(declared), accountHint: declared?.uin || hit.uin || '' }
          : { port, uin: declared?.uin || '', ok: false, note: '端口没人监听（这个 QQ 号没开，或插件未启用）' })
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

  ctx.effect(() => ctx.webServer.register(route), `${name}: ${route.path}`)
  ctx.effect(() => ctx.webServer.register(sessionsRoute), `${name}: ${sessionsRoute.path}`)
  ctx.effect(() => ctx.webServer.register(qqRoute), `${name}: ${qqRoute.path}`)
  ctx.effect(() => ctx.webServer.register(statusRoute), `${name}: ${statusRoute.path}`)
  ctx.effect(() => ctx.webServer.register(metricsRoute), `${name}: ${metricsRoute.path}`)
  ctx.effect(() => ctx.tools.register(tool), `${name}: dev_task_result`)
  ctx.effect(() => ctx.on('agent/turn-stopping', onTurnStopping), `${name}: turn-stopping fallback`)

  // ── (E) 主动扫描共享任务文件 ─────────────────────────────────────────
  // 为什么还要轮询：HTTP 通知只是"加速口"，它依赖 QQ Agent 那边正跑着、端口对得上。
  // 任务文件才是唯一真相来源；DSH 自己扫一遍，任何一侧先起后起都不会丢单。
  const handled = new Set()
  const instructionFor = (rec) => {
    if (typeof rec.instruction === 'string' && rec.instruction.trim()) return rec.instruction
    // 兜底拼一条（正常情况下 QQ 侧已经把 instruction 写好了）
    return [
      `【开发任务 #${rec.seq ?? '?'}】`,
      `来自：${rec.fromName || rec.from || 'QQ'}`,
      `会话：${rec.chatLabel || `${rec.kind}:${rec.chatId}`}`,
      `回传编号：taskId=${rec.taskId}｜sessionId=${rec.sessionIdHint || ''}`,
      '',
      '请按下面这条需求动手做事：',
      String(rec.task || ''),
      '',
      `做完后调用 dev_task_result 工具回传结果（taskId=${rec.taskId}）。`,
    ].join('\n')
  }

  /**
   * 保证"目标会话"这一绑定**长期有效**（用户要的"永久绑定到本会话"）。
   *
   * 绑定优先顺序：
   *   ① 握手文件里钉住的会话只要还活着 → 一直用它（**这就是永久绑定**：不会因为
   *      重启后被别的会话抢走，也不会因为"最后打开的是另一个会话"而漂移）；
   *   ② 钉住的会话真的没了（被删/被关）→ 退回 pickDefaultSession（记忆 → 最新 root），
   *      并把新目标**写回文件**，免得每次扫描都重新猜。
   *
   * 之前两个让它丢绑定的坑，这里一并兜住：
   *   · 旧代码在卸载时会**删掉**握手文件（见下面的 unload），DSH 一重启就无记录可依；
   *   · 启动瞬间 GUI 还没把会话挂上来，pickDefaultSession 返回空，而旧代码照样把
   *     空值写回文件 —— 记录被冲成空的之后，后面每次启动都从"没有记录"开始。
   */
  const ensureBinding = (reason) => {
    const alive = (id) => {
      if (!id) return false
      try { return ctx.agents.get(id) !== undefined } catch { return false }
    }
    const remembered = readIdentitySession()
    if (alive(remembered)) {
      if (DEFAULT_SESSION !== remembered) {
        DEFAULT_SESSION = remembered
        log(`按握手文件重新钉住目标会话：${remembered}（原因：${reason}）`)
      }
      return remembered
    }
    const picked = String(pickDefaultSession(ctx) || '').trim()
    if (picked && picked !== remembered) {
      writeIdentity(picked, { bridgeReady: true, pickedAt: Date.now(), healedAt: Date.now() })
      log(`自动补绑目标会话：${picked}（原因：${reason}；原记录 ${remembered || '无'}）`)
    }
    return picked
  }

  /**
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
          warn(`取会话标题失败（退化用磁盘缓存里的标题）：${String((error && error.message) || error)}`)
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
      warn(`sessionQuery 枚举失败，退回磁盘索引：${String((error && error.message) || error)}`)
      return { source: 'disk', sessions: diskList }
    }
  }

  /**
   * 多 QQ 自动发现：探一遍候选端口，问出每个 QQ Agent 实例的任务文件与定向。
   *
   * 为什么要探而不是只读环境变量：用户装多个 QQ 号时不该被要求记住
   * "第二个号是 8865" 这种约定；能自动问出来就别让人配。
   * 环境变量 DEV_TASK_QQ_TARGETS 仍然优先（它额外带账号号，能保证"结果回到提问的那个号"）。
   * 结果缓存 60 秒 —— 扫描每 4 秒跑一次，不能每次都去探。
   */
  let qqDiscovery = { at: 0, list: [] }
  const discoverQqInstances = async (force = false) => {
    if (!force && Date.now() - qqDiscovery.at < 60_000 && qqDiscovery.list.length) return qqDiscovery.list
    const ports = []
    for (const t of QQ_TARGETS) ports.push({ port: Number(t.port), uin: String(t.uin || '') })
    for (let i = 0; i < 4; i += 1) {
      const port = BASE_QQ_PORT + i * 100
      if (!ports.some((p) => p.port === port)) ports.push({ port, uin: '' })
    }
    const list = []
    for (const { port, uin } of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/dev/status`, { signal: AbortSignal.timeout(1200) })
        if (!r.ok) continue
        const body = await r.json().catch(() => null)
        if (!body || body.plugin !== 'dev-coding') continue
        list.push({
          port,
          uin,
          tasksFile: typeof body.tasksFile === 'string' ? body.tasksFile : '',
          targetSessionId: typeof body.targetSessionId === 'string' ? body.targetSessionId : '',
          wsConnected: body.wsConnected === true,
          keywords: Array.isArray(body.keywords) ? body.keywords : [],
          reports: typeof body.reports === 'string' ? body.reports : '',
        })
      } catch { /* 端口没人监听 = 这个号没开，正常 */ }
    }
    qqDiscovery = { at: Date.now(), list }
    return list
  }

  /**
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
      warn(`枚举任务文件失败：${String((error && error.message) || error)}`)
      return out
    }
    // 发现到的实例：把它们的 tasksFile 也纳入（它们可能不在注册表推断的路径上）
    const known = new Set(files.map((f) => f.path))
    for (const inst of qqDiscovery.list) {
      if (!inst.tasksFile || known.has(inst.tasksFile)) continue
      known.add(inst.tasksFile)
      files.push({ path: inst.tasksFile, uin: inst.uin || '', port: inst.port, kind: 'discovered', exists: fs.existsSync(inst.tasksFile) })
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
    ensureBinding(`scan:${reason}`)
    // 后台刷新一次"本机有哪些 QQ 实例"（缓存 60 秒，失败静默）——扫描本身不 await 它
    discoverQqInstances().catch(() => {})
    let injected = 0
    for (const source of taskSources()) {
      const { taskId, rec } = source
      if (handled.has(taskId)) continue
      // 太老的任务不补投（可能是几天前的残留，投进去只会让人困惑）
      if (Date.now() - (Number(rec.createdAt) || 0) > 2 * 60 * 60 * 1000) { handled.add(taskId); continue }

      // 目标会话：优先用任务里写死的 sessionIdHint（QQ 侧投递那一刻的定向），
      // 但那个会话**必须还活着**才是有效定向 —— 否则（用户把旧会话关掉/换会话了）
      // 任务会一直卡在"等会话打开"里，群里只能等到超时。这时候退回默认目标会话，
      // 至少让它落在一个活着的对话里；真投错了也好过没人接。
      let sessionId = typeof rec.sessionIdHint === 'string' ? rec.sessionIdHint.trim() : ''
      if (sessionId) {
        const hintLive = (() => {
          try { return ctx.agents.get(sessionId) !== undefined } catch { return false }
        })()
        if (!hintLive) {
          warn(`任务 ${taskId} 定向的会话 ${sessionId} 当前不在（被关掉或已废弃），改投默认目标会话`)
          sessionId = ''
        }
      }
      if (!sessionId) sessionId = String(pickDefaultSession(ctx) || '').trim()
      if (!sessionId) {
        warn(`任务 ${taskId} 等着处理，但本插件还不知道目标会话：`
          + '请把「目标会话 ID」在 QQ Agent 插件设置里填上，或先在 DSH 里产生一次任务让本插件记下会话')
        continue
      }
      let delivered
      try {
        delivered = deliverToSession(ctx, sessionId, instructionFor(rec))
      } catch (error) {
        warn(`注入任务 ${taskId} 抛错：${String((error && error.message) || error)}`)
        continue
      }
      if (!delivered.ok) {
        // 目标会话当前没有存活 Agent：不要标记 handled，等它在 DSH 里被打开后再投
        if (reason !== 'silent') warn(`任务 ${taskId} 暂时投不进去（${delivered.code}），等会话打开后重试`)
        continue
      }
      handled.add(taskId)
      knownTasks.set(taskId, {
        sessionId,
        startedAt: Date.now(),
        delivered: false,
        accountUin: source.uin,
        notifyPort: source.port,
        sourceFile: source.file,
      })
      // 记下目标会话，供 QQ 侧下一次使用（它读这个文件就知道该发给谁）
      writeIdentity(sessionId, { lastTaskId: taskId })
      injected += 1
      log(`已注入任务 ${taskId} → 会话 ${sessionId}（消息 ${delivered.messageId}）`)
    }
    return injected
  }

  // 先挑好默认注入目标，并把结果写进握手文件（QQ 侧读它就知道该往哪送）。
  //
  // ⚠️ 别无条件覆盖：握手文件是"人工定向"的唯一落点。刚启动这会儿 GUI 可能还没把
  //    任何会话挂上来（agents 空），甚至只有旧会话活着，一次"瞎猜"就会把用户手工
  //    改好的指向冲掉 —— 实测被冲过两次。所以：只有**没有记录**、或**环境变量
  //    DEV_TASK_SESSION 明确指定了别的会话**时才改写；其余一律保留记录。
  //    记录指向的会话若真的没了，投递时会自动退回默认目标（scanOnce 里那段处理），
  //    不会把任务卡死。
  const picked = pickDefaultSession(ctx)
  const remembered = readIdentitySession()
  const envSession = String(process.env.DEV_TASK_SESSION || '').trim()
  // 环境变量只在**没有记录**时兜底（bootstrap），不当强制覆盖：
  // 记录（握手文件）= 权威，因为"永久绑定"要允许人工改指向；
  // 环境变量的价值在于：v4 那版代码会在退出时删掉握手文件，那一刻起记录就没了 ——
  // 下一次启动靠这个环境变量把会话直接恢复出来。
  const explicitOverride = envSession !== '' && !remembered && picked === envSession
  if (explicitOverride) {
    writeIdentity(picked, { bridgeReady: true, pickedAt: Date.now(), pinnedBy: 'env' })
  } else if (remembered) {
    // 有记录就**原样保留，连文件都不碰** —— 这是"永久绑定"赖以生效的地方，
    // 也是离线套件里那条"启动时不覆盖人工定向"断言守的契约。
    // 活跃信号不靠这个文件：启动时另有一次 handshake POST /dev/notify（见下）。
    log(`保留握手文件里已有的目标会话：${remembered}（本次自动挑到 ${picked || '无'}，不覆盖）`)
  } else if (picked) {
    writeIdentity(picked, { bridgeReady: true, pickedAt: Date.now() })
  } else {
    // ⚠️ 千万别写空：写空等于把记录冲掉，之后每次启动都从"没有记录"开始（实测踩过）。
    warn('暂时没有可用会话（DSH 里还没有打开的会话）；不写空值，等有会话后自动补上')
  }
  if (picked) log(`默认注入目标会话：${picked}`)
  else warn('暂时没有可用会话（DSH 里还没有打开的会话）；等有会话后会自动补上')

  // QQ 侧启动完成会回调 /dev/notify，我们在那里立刻扫一次；这里再兜一个定时器。
  const scanTimer = setInterval(() => {
    try { scanOnce('silent') } catch { /* 单次失败不影响下一轮 */ }
  }, POLL_MS)
  scanTimer.unref?.()
  ctx.effect(() => () => { clearInterval(scanTimer) }, `${name}: scan timer`)

  // 启动后扫两次：一次立刻（可能已经有排队任务），一次稍后（等 QQ 侧就绪）
  setTimeout(() => { try { scanOnce('startup') } catch { /* 忽略 */ } }, 1500).unref?.()
  setTimeout(() => { try { scanOnce('startup') } catch { /* 忽略 */ } }, 8000).unref?.()

  // ── (F) 握手：告诉 QQ Agent "我在这儿"（它可能比我们晚起） ──────────────
  const handshake = (attempt) => {
    const body = JSON.stringify({ event: 'bridge-ready', sessionId: DEFAULT_SESSION, targets: QQ_TARGETS, at: Date.now() })
    const headers = { 'Content-Type': 'application/json' }
    const token = String(process.env.DEV_TASK_TOKEN || '')
    if (token) headers['x-dev-task-token'] = token
    fetch(`http://127.0.0.1:${DEFAULT_NOTIFY_PORT}/dev/notify`, { method: 'POST', headers, body })
      .then((r) => { if (r.ok) log(`已通知 QQ Agent 侧桥接就绪（HTTP ${r.status}）`) })
      .catch(() => {
        if (attempt < 3) setTimeout(() => handshake(attempt + 1), 4000 * (attempt + 1)).unref?.()
      })
  }
  setTimeout(() => handshake(1), 3000).unref?.()

  // ── (G) 让外部（QQ 侧）能立刻催一次扫描 ────────────────────────────────
  const pokeRoute = {
    kind: 'exact',
    path: '/dev-task/scan',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
        return
      }
      let body = {}
      try { body = await readJsonBody(req) } catch { body = {} }
      let sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const wantedName = typeof body.sessionName === 'string' ? body.sessionName.trim() : ''
      let resolvedInfo = null
      // 允许按**会话名**改指向（名字可空可重名 → 命中多个直接报歧义，不瞎挑）
      if (!sid && wantedName) {
        const resolved = resolveSession(wantedName, { sessions: (await listSessionsAuthoritative()).sessions })
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
        log(`目标会话已更新为 ${sid}${resolvedInfo ? `（按名字解析，策略 ${resolvedInfo.strategy}）` : ''}`)
      }
      const injected = scanOnce('poked')
      sendJson(res, 200, {
        ok: true,
        injected,
        resolved: resolvedInfo,
        sessionId: pickDefaultSession(ctx),
        agents: (() => { try { return ctx.agents.list().map((a) => String(a.id)) } catch { return [] } })(),
        time: Date.now(),
      })
    },
  }
  ctx.effect(() => ctx.webServer.register(pokeRoute), `${name}: ${pokeRoute.path}`)

  // 卸载时**不要删**握手文件：删了等于丢掉"永久绑定"。
  // 旧实现是 rmSync 掉整个文件，理由是"留着它会让 QQ 侧以为桥接还在"——现在改成
  // 保留定向 + 打一个 bridgeReady:false / stoppedAt，QQ 侧既知道桥接下线了，
  // 又能在 DSH 重启后把任务投回同一个会话。
  ctx.effect(() => () => {
    const remembered = readIdentitySession()
    if (remembered) {
      writeIdentity(remembered, { bridgeReady: false, stoppedAt: Date.now() })
      return
    }
    for (const file of identityFiles()) {
      try { fs.rmSync(file, { force: true }) } catch { /* 删不掉就算了 */ }
    }
  }, `${name}: identity cleanup`)

  log(`桥接已就绪：POST /dev-task → 注入会话；结果回传端口 ${DEFAULT_NOTIFY_PORT}；`
    + `任务文件 ${tasksFilePath()}；工具 dev_task_result 已注册`)
}

/** 便于排查时手工调用（也让本模块的纯函数与状态可被测试）。 */
export {
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
}
