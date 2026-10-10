/**
 * 给插件加"客户端自报"通道 —— 让"控件为什么没出现"从猜变成看。
 *
 * 宿主：POST/GET /dev-task/client-report（并在 /dev-task/status 里带一份）
 * 客户端：apply 时、注册成功/失败时、组件渲染时各报一次
 *
 * 用法：node tools/add-client-report.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = path.join(ROOT, 'lib', 'index.js')
const CLIENT = path.join(ROOT, 'lib', 'client.js')
const out = []
const fail = []

function patch(file, label, from, to) {
  let s = fs.readFileSync(file, 'utf8')
  const n = s.split(from).length - 1
  if (n !== 1) { fail.push(`${label}：锚点命中 ${n} 次`); return }
  fs.writeFileSync(file, s.replace(from, to), 'utf8')
  out.push(`✅ ${label}`)
}

// ── 宿主：新路由 + status 里带报告 ─────────────────────────────────────────
patch(
  HOST, '宿主：client-report 路由',
  "  // ── (J) GET /dev-task/panel：给人用的最小面板（浏览器直接打开）────────────",
  `  // ── (K) 客户端半边自报：POST 上报 / GET 读取 ─────────────────────────────
  // 为什么需要：客户端控件跑在渲染进程里，DSH 又不给开发者工具 ——
  // "控件没出现"只能靠它自己说清卡在哪一步（模块加载了没 / 座位注册了没 / 组件渲染了没）。
  let clientReport = null
  const clientReportRoute = {
    kind: 'exact',
    path: '/dev-task/client-report',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, revision: REVISION, report: clientReport })
        return
      }
      let body = {}
      try { body = await readJsonBody(req) } catch { /* 空体也接受 */ }
      const history = Array.isArray(clientReport?.history) ? clientReport.history : []
      const entry = { ...(body && typeof body === 'object' ? body : {}), at: Date.now() }
      clientReport = {
        ...entry,
        history: [...history, entry].slice(-20),
      }
      log(\`[client] 自报：\${JSON.stringify(entry).slice(0, 260)}\`)
      sendJson(res, 200, { ok: true })
    },
  }

  // ── (J) GET /dev-task/panel：给人用的最小面板（浏览器直接打开）────────────`,
)

patch(
  HOST, '宿主：注册 client-report 路由',
  "  ctx.effect(() => ctx.webServer.register(panelRoute), `${name}: ${panelRoute.path}`)",
  `  ctx.effect(() => ctx.webServer.register(panelRoute), \`\${name}: \${panelRoute.path}\`)
  ctx.effect(() => ctx.webServer.register(clientReportRoute), \`\${name}: \${clientReportRoute.path}\`)`,
)

patch(
  HOST, '宿主：status 里带客户端报告',
  `        qqTargets: QQ_TARGETS,`,
  `        qqTargets: QQ_TARGETS,
        clientReport: clientReport ? { at: clientReport.at, event: clientReport.event, registered: clientReport.registered, rendered: clientReport.rendered, error: clientReport.error } : null,`,
)

// ── 客户端：各处上报 ───────────────────────────────────────────────────────
patch(
  CLIENT, '客户端：report() 工具',
  "    function ensureStyle() {",
  `    /** 自报：把"我走到哪一步了"告诉宿主（失败静默，绝不影响渲染） */
    function report(payload) {
      try {
        fetch('/dev-task/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ source: 'client', id: 'dsh-dev-task-bridge' }, payload || {})),
        }).catch(function () {})
      } catch (e) { /* 忽略 */ }
    }

    function ensureStyle() {`,
)

patch(
  CLIENT, '客户端：apply 上报注册结果',
  `    function apply(ctx) {
      var dispose = null
      try {
        var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : (ctx && ctx.slots)
        if (slots && typeof slots.register === 'function') {
          var entry = { name: 'conversation.session.header.actions', id: 'dev-task-bridge-target', order: 5 }
          var register = function () { return slots.register(entry, makeComponent()) }
          dispose = typeof slots.inject === 'function'
            ? slots.inject('conversation.session.header.actions', register)
            : register()
        }
      } catch (error) {
        try {
          console.warn('[dev-task-bridge] 座位注册失败（控件不显示；功能仍可走 /dev-task/panel）：', error)
        } catch (e) { /* 忽略 */ }
      }`,
  `    function apply(ctx) {
      var dispose = null
      var registered = false
      var detail = ''
      try {
        var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : (ctx && ctx.slots)
        if (slots && typeof slots.register === 'function') {
          var entry = { name: 'conversation.session.header.actions', id: 'dev-task-bridge-target', order: 5 }
          var register = function () { return slots.register(entry, makeComponent()) }
          dispose = typeof slots.inject === 'function'
            ? slots.inject('conversation.session.header.actions', register)
            : register()
          registered = true
          detail = 'registered via ' + (typeof slots.inject === 'function' ? 'inject+register' : 'register')
        } else {
          detail = 'ctx.get("slots") 拿不到 slots 服务'
        }
      } catch (error) {
        detail = 'register 抛错：' + String((error && error.message) || error)
        try { console.warn('[dev-task-bridge] 座位注册失败（控件不显示；功能仍可走 /dev-task/panel）：', error) } catch (e) { /* 忽略 */ }
      }
      report({ event: 'apply', registered: registered, detail: detail, hasCtx: !!ctx })`,
)

patch(
  CLIENT, '客户端：组件渲染时上报一次',
  `      return function (props) {
        try {
          return makeWidget(React, props || {})
        } catch (error) {
          try { console.warn('[dev-task-bridge] 回传目标控件渲染失败：', error) } catch (e) { /* 忽略 */ }
          return null
        }
      }`,
  `      var reported = false
      return function (props) {
        try {
          if (!reported) {
            reported = true
            report({ event: 'render', rendered: true, sessionId: props && props.sessionId ? String(props.sessionId) : '' })
          }
          return makeWidget(React, props || {})
        } catch (error) {
          report({ event: 'render-error', error: String((error && error.message) || error) })
          try { console.warn('[dev-task-bridge] 回传目标控件渲染失败：', error) } catch (e) { /* 忽略 */ }
          return null
        }
      }`,
)

patch(
  CLIENT, '客户端：拿不到 React 也上报',
  `      if (!React || typeof React.createElement !== 'function') {
        return function () { return null }
      }`,
  `      if (!React || typeof React.createElement !== 'function') {
        report({ event: 'no-react', detail: 'require("react") 不可用，控件无法渲染' })
        return function () { return null }
      }`,
)

if (fail.length) {
  console.error('❌ 未应用：')
  for (const f of fail) console.error('   · ' + f)
  process.exit(1)
}
const r = spawnSync('node', ['--test', 'test/sessions.test.mjs', 'test/client-half.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
out.push((r.stdout || '').split(/\r?\n/).filter((l) => /^ℹ (tests|pass|fail)|^✖ /.test(l)).join('\n'))
console.log(out.join('\n'))
process.exit(r.status === 0 ? 0 : 1)
