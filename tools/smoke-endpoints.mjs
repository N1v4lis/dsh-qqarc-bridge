/**
 * 离线冒烟：伪造一个 Cordis ctx，把插件的路由注册出来，然后直接打这几个接口。
 *
 * 为什么需要：插件跑在 DSH 进程里，改完代码要重启 DSH 才生效 —— 而重启会掐掉
 * 正在对话的会话。这个冒烟台让"改完立刻验证"成为可能：
 *   · apply() 真的被调用（真依赖 @deepseek-ai/dsh-* 会用 profile 的 node_modules 解析）
 *   · 三个接口真的被注册，并且用假 req/res 真的跑一遍
 *   · 会打印真实会话区（来自 ~/.dsh）与多 QQ 诊断结果
 *
 * 用法：node tools/smoke-endpoints.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 收集一个假 ctx 上的注册结果。 */
function makeCtx() {
  const routes = new Map()
  const registeredTools = []
  const logs = []
  const cleanups = []
  return {
    routes,
    registeredTools,
    logs,
    cleanups,
    logger: {
      info: (m) => logs.push(`INFO ${m}`),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    agents: {
      list: () => [],
      roots: () => [],
      get: () => undefined,
    },
    tools: { register: (tool) => { registeredTools.push(tool); return () => {} } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return () => {} },
    on: () => () => {},
  }
}

/** 造一个假的 res，把响应体收集下来。 */
function makeRes() {
  const chunks = []
  let status = 0
  return {
    get status() { return status },
    body: () => chunks.join(''),
    writeHead(code) { status = code },
    end(text) { if (text !== undefined) chunks.push(String(text)) },
    setHeader() {},
  }
}

function makeReq(url, method = 'GET', body = null, headers = {}) {
  const listeners = {}
  return {
    url,
    method,
    headers: { host: '127.0.0.1:19387', ...headers },
    on(event, fn) { (listeners[event] ||= []).push(fn); return this },
    destroy() {},
    // 让 readJsonBody 能读到 body
    __emit() {
      const data = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      for (const fn of listeners.data || []) fn(Buffer.concat(data))
      for (const fn of listeners.end || []) fn()
    },
  }
}

async function callRoute(route, { url, method = 'GET', body = null }) {
  const req = makeReq(url, method, body)
  const res = makeRes()
  const promise = route.handler(req, res)
  if (body !== null) req.__emit()
  await promise
  // setImmediate 里排的活（注入一般在这里）不影响 HTTP 响应，这里等一小会儿
  await new Promise((r) => setTimeout(r, 60))
  let parsed = null
  try { parsed = JSON.parse(res.body()) } catch { /* 非 JSON */ }
  return { status: res.status, json: parsed, raw: res.body() }
}

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href).catch((error) => {
  console.error('❌ 导入插件失败：' + (error?.stack || error))
  process.exit(1)
})

const ctx = makeCtx()
try {
  await mod.apply(ctx, {})
} catch (error) {
  console.error('❌ apply() 失败：' + (error?.stack || error))
  process.exit(1)
}

console.log('=== 已注册路由 ===')
for (const p of ctx.routes.keys()) console.log('  ' + p)
console.log('=== 已注册工具 ===')
for (const t of ctx.registeredTools) console.log('  ' + t.name)

let failures = 0
const expect = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures += 1
}

console.log('\n=== GET /dev-task/status ===')
const status = await callRoute(ctx.routes.get('/dev-task/status'), { url: '/dev-task/status' })
expect('status 200', status.status === 200, `revision=${status.json?.revision}`)
expect('revision 已升级到 v6', String(status.json?.revision || '').startsWith('v6'), status.json?.revision)
expect('带 qqTargets', Array.isArray(status.json?.qqTargets), JSON.stringify(status.json?.qqTargets))
expect('带 sessionsIndexed', Number(status.json?.sessionsIndexed) > 0, String(status.json?.sessionsIndexed))

console.log('\n=== GET /dev-task/sessions（真实会话区）===')
const sessions = await callRoute(ctx.routes.get('/dev-task/sessions'), { url: '/dev-task/sessions?limit=5&days=30' })
expect('sessions 200', sessions.status === 200)
expect('枚举到会话', Number(sessions.json?.total) > 0, `total=${sessions.json?.total}`)
for (const s of (sessions.json?.sessions || []).slice(0, 5)) {
  console.log(`   · ${s.id.slice(0, 22)}…  名字=${s.title || '(未命名)'}  cwd=${s.cwd}  live=${s.live}`)
}
const filtered = await callRoute(ctx.routes.get('/dev-task/sessions'), { url: '/dev-task/sessions?q=' + encodeURIComponent('QQ Agent') })
expect('?q= 过滤生效', Number(filtered.json?.total) > 0 && Number(filtered.json?.total) <= Number(sessions.json?.total), `命中 ${filtered.json?.total}`)

console.log('\n=== GET /dev-task/qq（多 QQ 诊断）===')
const qq = await callRoute(ctx.routes.get('/dev-task/qq'), { url: '/dev-task/qq' })
expect('qq 200', qq.status === 200)
expect('列出任务文件', Array.isArray(qq.json?.taskFiles) && qq.json.taskFiles.length > 0, `${qq.json?.taskFiles?.length} 份`)
for (const f of qq.json?.taskFiles || []) console.log(`   · ${f.kind}  uin=${f.uin || '-'}  port=${f.port || '-'}  exists=${f.exists}`)
for (const p of qq.json?.probes || []) console.log(`   · probe port=${p.port} uin=${p.uin || '-'} ok=${p.ok} ws=${p.wsConnected ?? '-'} targetSession=${p.targetSessionId ?? '-'}`)

console.log('\n=== POST /dev-task/scan 按名字改指向（歧义必须被挡住）===')
const ambiguous = await callRoute(ctx.routes.get('/dev-task/scan'), {
  url: '/dev-task/scan', method: 'POST', body: { sessionName: '连通性测试' },
})
expect('重名 → 409 AMBIGUOUS_TITLE', ambiguous.status === 409 && ambiguous.json?.code === 'AMBIGUOUS_TITLE', JSON.stringify(ambiguous.json?.candidates?.length))
const notFound = await callRoute(ctx.routes.get('/dev-task/scan'), {
  url: '/dev-task/scan', method: 'POST', body: { sessionName: '这个会话不存在' },
})
expect('不存在 → 409 NOT_FOUND', notFound.status === 409 && notFound.json?.code === 'NOT_FOUND')

// 用真实存在的会话名试一次（取第一个有名字的）
const named = (sessions.json?.sessions || []).find((s) => s.title)
if (named) {
  const ok = await callRoute(ctx.routes.get('/dev-task/scan'), {
    url: '/dev-task/scan', method: 'POST', body: { sessionName: named.title },
  })
  const code = ok.json?.code || ''
  const unique = ok.status === 200 || code === 'AMBIGUOUS_TITLE'   // 用真实库，重名是常态
  expect(`按名字改指向（${named.title}）不崩且有明确结果`, unique, `HTTP ${ok.status} ${code || 'ok'} resolved=${JSON.stringify(ok.json?.resolved)}`)
}

console.log('\n=== POST /dev-task 参数校验 ===')
const bad = await callRoute(ctx.routes.get('/dev-task'), { url: '/dev-task', method: 'POST', body: { text: 'hi' } })
expect('缺目标 → 400 MISSING_FIELD', bad.status === 400 && bad.json?.code === 'MISSING_FIELD')
const noAgent = await callRoute(ctx.routes.get('/dev-task'), {
  url: '/dev-task', method: 'POST', body: { sessionId: 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', text: 'hi' },
})
expect('没有活会话 → 404 NO_LIVE_AGENT', noAgent.status === 404 && noAgent.json?.code === 'NO_LIVE_AGENT')

console.log('\n=== 日志（apply 期间）===')
for (const l of ctx.logs.slice(-8)) console.log('  ' + l)

// 卸载清理不应该删掉握手文件（契约）
for (const fn of ctx.cleanups) { try { fn() } catch { /* ignore */ } }
console.log(`\n${failures === 0 ? '✅ 全部冒烟断言通过' : `❌ 有 ${failures} 条断言失败`}`)
process.exit(failures === 0 ? 0 : 1)
