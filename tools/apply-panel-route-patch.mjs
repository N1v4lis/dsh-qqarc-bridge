/**
 * 补丁：加一条 HTML 面板路由 GET /dev-task/panel。
 *
 * 为什么先做这个（而不是直接做客户端半边）：
 *   · DSH 的聊天区上方确实有座位（conversation.input.dock，session 作用域，组件 props 里带 sessionId），
 *     但已装的两个先例（dsh-memory-evolve / dsh-theme-tarkov）的 lib/client.js **都是打包产物** ——
 *     客户端半边需要构建步骤，且任何客户端改动都必须重启 DSH 才生效。
 *   · 而"看会话 id / 指定回传目标"这件事，用一条纯 HTML 路由就能立刻给人用：
 *     浏览器打开 http://127.0.0.1:19387/dev-task/panel 即可 —— 零构建、零框架、零风险。
 *   · 客户端半边做好后，直接把这个面板的内容嵌进座位即可（同一份数据来源）。
 *
 * 用法：node tools/apply-panel-route-patch.mjs
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

replaceOnce(
  'panel 路由',
  "  ctx.effect(() => ctx.webServer.register(route), `${name}: ${route.path}`)",
  `  // ── (J) GET /dev-task/panel：给人用的最小面板（浏览器直接打开）────────────
  // 纯 HTML + 表单，没有前端框架、没有构建步骤。解决的就是"DSH 界面不显示 session-id"
  // 这件事：列出会话（id / 名字 / 工作目录 / 是否活着），一键把某个会话设为回传目标。
  const panelRoute = {
    kind: 'exact',
    path: '/dev-task/panel',
    handler: async (req, res) => {
      const fence = hostFence(req)
      if (fence !== null) {
        sendJson(res, fence, { ok: false, code: fence === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' })
        return
      }
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase()
      const enumerated = await listSessionsAuthoritative()
      let live = []
      try { live = ctx.agents.list().map((a) => String(a.id)) } catch { /* ignore */ }
      const liveSet = new Set(live)
      let sessions = enumerated.sessions
      if (q) {
        sessions = sessions.filter((s) => s.id.toLowerCase().includes(q)
          || String(s.title || '').toLowerCase().includes(q)
          || String(s.cwd || '').toLowerCase().includes(q))
      }
      const current = DEFAULT_SESSION || ''
      const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      const rows = sessions.slice(0, 200).map((s) => \`<tr>
        <td><code>\${esc(s.id)}</code></td>
        <td>\${esc(s.title) || '<span class=dim>(未命名)</span>'}</td>
        <td class=dim>\${esc(s.cwd || '—')}</td>
        <td>\${liveSet.has(s.id) ? '<b class=ok>活着</b>' : '<span class=dim>未打开</span>'}</td>
        <td>\${String(s.id) === current ? '<b class=cur>当前目标</b>' : \`<form method=POST action="/dev-task/scan"><input type=hidden name=sessionId value="\${esc(s.id)}"><button>设为目标</button></form>\`}</td>
      </tr>\`).join('')
      const html = \`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>DSH 回传目标 · 会话区</title>
<style>
 body{font:13px/1.6 system-ui,"Segoe UI",sans-serif;background:#0f1116;color:#e6e6e6;margin:0;padding:20px}
 h1{font-size:16px;margin:0 0 6px}
 .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 14px}
 .card{background:#171a21;border:1px solid #262b36;border-radius:8px;padding:10px 12px;margin-bottom:12px}
 code{background:#0b0d12;padding:1px 5px;border-radius:4px;font-size:12px}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #232833;vertical-align:top}
 th{color:#9aa4b2;font-weight:600;font-size:12px}
 .dim{color:#8b93a1}.ok{color:#3fb950}.cur{color:#d29922}
 button{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
 input[type=text]{background:#0b0d12;border:1px solid #2a3040;color:#e6e6e6;border-radius:6px;padding:5px 8px;min-width:240px}
 .hint{color:#8b93a1;font-size:12px}
</style></head><body>
<h1>DSH 回传目标 · 会话区</h1>
<div class="hint">这份清单来自 <b>\${esc(enumerated.source)}</b>（sessionQuery 服务优先，磁盘投影缓存兜底）。
  会话身份 = <code>session-&lt;uuid&gt;</code>；名字只是显示用，<b>可为空、可重名</b>。</div>
<div class="card">
  <div>当前回传目标：\${current ? \`<code>\${esc(current)}</code>\` : '<span class=dim>(还没绑定)</span>'}
    \${liveSet.has(current) ? '<b class=ok>（会话活着，可直接投递）</b>' : '<span class=dim>（该会话当前没打开，投递要等它被打开）</span>'}</div>
  <div class="hint" style="margin-top:6px">握手文件：<code>\${esc(identityFiles()[0] || '')}</code></div>
</div>
<div class="bar">
  <form method=GET action="/dev-task/panel"><input type=text name=q placeholder="过滤：会话名 / id / 工作目录" value="\${esc(q)}"><button>过滤</button></form>
  <span class="hint">共 \${sessions.length} 个会话（显示前 200）· 活着 \${live.length} 个</span>
  <a href="/dev-task/status" style="color:#6ea8fe">/dev-task/status</a>
  <a href="/dev-task/sessions" style="color:#6ea8fe">/dev-task/sessions</a>
  <a href="/dev-task/qq" style="color:#6ea8fe">/dev-task/qq</a>
</div>
<table><tr><th>会话 ID</th><th>名字</th><th>工作目录</th><th>状态</th><th>操作</th></tr>\${rows}</table>
</body></html>\`
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch { /* 连接已断 */ }
    },
  }

  ctx.effect(() => ctx.webServer.register(route), \`\${name}: \${route.path}\`)
  ctx.effect(() => ctx.webServer.register(panelRoute), \`\${name}: \${panelRoute.path}\`)`,
)

replaceOnce('REVISION', "const REVISION = 'v6-multiqq-sessions'", "const REVISION = 'v7-session-panel'")

if (failed.length) {
  console.error('❌ 补丁未应用：')
  for (const f of failed) console.error('   · ' + f)
  process.exit(1)
}
fs.copyFileSync(FILE, path.join(ROOT, '_backup', `index.js.bak-panel-${Date.now()}`))
fs.writeFileSync(FILE, src, 'utf8')
try {
  execFileSync('node', ['--check', FILE])
} catch (error) {
  console.error('❌ 语法失败（未写入）：' + String(error.stderr || error))
  process.exit(1)
}
console.log(`✅ 应用 ${applied.length} 处：`)
for (const a of applied) console.log('   · ' + a)
console.log('✅ 语法通过')
