/**
 * 追加补丁：多 QQ「自动发现」。
 *
 * 依据（读 QQ 侧 dev-coding 插件源码得到的事实）：
 *   · 它监听 8765 + portOffset()（每个账号 +100）
 *   · GET /dev/status 会回报 tasksFile / targetSessionId / wsConnected / keywords / reports
 * 所以 DSH 侧不必要求用户手填端口：探一遍 8765 + k*100（k=0..3）就能把
 * "本机有几个 QQ Agent 实例、各自任务文件在哪、各自定向到哪个会话"全问出来。
 *
 * 用法：node tools/apply-qq-discovery-patch.mjs
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

// 1) 发现函数（插在 taskSources 之前）
replaceOnce(
  'discoverQqInstances',
  `  /**
   * 收集"待投递任务"——**多 QQ：每个账号一份任务文件**。`,
  `  /**
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
        const r = await fetch(\`http://127.0.0.1:\${port}/dev/status\`, { signal: AbortSignal.timeout(1200) })
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
   * 收集"待投递任务"——**多 QQ：每个账号一份任务文件**。`,
)

// 2) taskSources 用同步的已知路径 + 发现到的 tasksFile（发现结果来自缓存，不阻塞扫描）
replaceOnce(
  'taskSources 合并发现结果',
  `    for (const entry of files) {
      if (!entry.exists) continue
      let tasks = {}
      try {
        tasks = readTasksFile(entry.path).tasks
      } catch { continue }`,
  `    // 发现到的实例：把它们的 tasksFile 也纳入（它们可能不在注册表推断的路径上）
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
      } catch { continue }`,
)

// 3) /dev-task/qq 用发现函数（带 force，诊断时要实时）
replaceOnce(
  'qq 路由改用发现',
  `      const targets = QQ_TARGETS.length ? QQ_TARGETS : [{ uin: '', port: DEFAULT_NOTIFY_PORT }]
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
      }`,
  `      const discovered = await discoverQqInstances(true)
      const probes = []
      for (let i = 0; i < 4; i += 1) {
        const port = BASE_QQ_PORT + i * 100
        const hit = discovered.find((d) => d.port === port)
        const declared = QQ_TARGETS.find((t) => Number(t.port) === port)
        probes.push(hit
          ? { ...hit, ok: true, declared: Boolean(declared), accountHint: declared?.uin || hit.uin || '' }
          : { port, uin: declared?.uin || '', ok: false, note: '端口没人监听（这个 QQ 号没开，或插件未启用）' })
      }`,
)

// 4) 扫描里顺手刷新一次发现（不阻塞：fire-and-forget）
replaceOnce(
  'scanOnce 触发发现',
  `  const scanOnce = (reason) => {
    ensureBinding(\`scan:\${reason}\`)`,
  `  const scanOnce = (reason) => {
    ensureBinding(\`scan:\${reason}\`)
    // 后台刷新一次"本机有哪些 QQ 实例"（缓存 60 秒，失败静默）——扫描本身不 await 它
    discoverQqInstances().catch(() => {})`,
)

if (failed.length) {
  console.error('❌ 补丁未应用：')
  for (const f of failed) console.error('   · ' + f)
  process.exit(1)
}
fs.copyFileSync(FILE, `${FILE}.bak-discovery`)
fs.writeFileSync(FILE, src, 'utf8')
try {
  execFileSync('node', ['--check', FILE])
} catch (error) {
  fs.copyFileSync(`${FILE}.bak-discovery`, FILE)
  console.error('❌ 语法失败已回滚：' + String(error.stderr || error))
  process.exit(1)
}
console.log(`✅ 应用 ${applied.length} 处：`)
for (const a of applied) console.log('   · ' + a)
console.log('✅ 语法通过')
