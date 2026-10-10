/**
 * 客户端半边：在**聊天输入框上方**挂一条「回传目标」栏。
 *
 * ── 形态：CommonJS 脚本（⚠️ 这里绝对不能出现 export / import）─────────────
 * 踩过的坑（2026-10-10，真实事故）：写成 ESM（`export function apply`）时，
 * 客户端加载器把它当**普通脚本**执行，控制台直接报
 *
 *     dsh-dev-task-bridge/client.js:NNN Uncaught SyntaxError: Unexpected token 'export'
 *
 * 后果不是"栏位不显示"，而是 **web boot: 1 entry did not activate** —— 整个界面起不来 ✗。
 * 这也解释了两个已装先例（dsh-memory-evolve / dsh-theme-tarkov）为什么发布的都是
 * 打包产物：加载器给的是 CommonJS 环境（`module` / `exports` / `require`），不是 ESM。
 *
 * 所以本文件：
 *   · 不写任何 `export` / `import`，结尾用 `exports.xxx = …`（并对三种宿主形态做兜底）；
 *   · 不 require 任何东西（连 React 都不需要，纯 DOM 注入）；
 *   · 任何异常都吞掉 —— **客户端半边绝不允许影响 boot 与宿主半边**。
 *
 * 它显示/操作的数据全部来自宿主插件注册的 HTTP 路由（同源 fetch，走 hostFence 回环校验）：
 *   GET  /dev-task/status → 当前回传目标   POST /dev-task/scan → 把本会话设为目标
 *   GET  /dev-task/panel  → 完整会话区面板
 */

const BAR_ID = 'dev-task-bridge-bar'
const STYLE_ID = 'dev-task-bridge-bar-style'
const POLL_MS = 1500

/** 候选锚点：插在它**上面**（都是"输入框所在块"的特征，按可靠性排序） */
const ANCHOR_SELECTORS = [
  '[class*="_composerCard"]',
  '[class*="_composer"]',
  '[class*="_composerBar"]',
  '[class*="_inputDock"]',
]

const CSS = `
#${BAR_ID}{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  font:12px/1.5 system-ui,"Segoe UI",sans-serif;color:#9aa4b2;
  padding:5px 10px;margin:0 0 6px;border:1px solid rgba(127,127,127,.22);border-radius:8px;
  background:rgba(127,127,127,.06)}
#${BAR_ID} code{background:rgba(127,127,127,.16);padding:1px 5px;border-radius:4px;font-size:11px}
#${BAR_ID} button{font:inherit;color:#fff;background:#2563eb;border:0;border-radius:6px;
  padding:2px 8px;cursor:pointer}
#${BAR_ID} button.ghost{background:transparent;color:#6ea8fe;border:1px solid rgba(110,168,254,.5)}
#${BAR_ID} .ok{color:#3fb950}
#${BAR_ID} .warn{color:#d29922}
#${BAR_ID} a{color:#6ea8fe;text-decoration:none}
`

function el(tag, attrs, text) {
  const node = document.createElement(tag)
  const a = attrs || {}
  for (const k of Object.keys(a)) {
    if (k === 'class') node.className = a[k]
    else if (k === 'style') node.setAttribute('style', a[k])
    else node.setAttribute(k, a[k])
  }
  if (text) node.textContent = text
  return node
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(6000),
    })
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

/** 当前会话 id：先看数据属性，找不到就留空（**绝不猜一个 id 出来**） */
function sessionIdFromDom() {
  try {
    const node = document.querySelector('[data-session-id]')
    const attr = node && node.getAttribute('data-session-id')
    if (attr) return String(attr)
  } catch { /* 忽略 */ }
  return ''
}

function apply(ctx) {
  let sessionId = sessionIdFromDom()
  let target = ''
  let targetLive = false
  let total = 0
  let timer = null
  let observer = null
  let bar = null

  const render = () => {
    if (!bar) return
    bar.textContent = ''
    bar.appendChild(el('span', {}, 'DSH 回传目标'))
    bar.appendChild(el('code', {}, sessionId || '(未知本会话)'))
    if (sessionId) {
      const copy = el('button', { class: 'ghost', type: 'button' }, '复制')
      copy.addEventListener('click', () => {
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(sessionId)
          copy.textContent = '已复制'
          setTimeout(() => { copy.textContent = '复制' }, 1200)
        } catch { /* 忽略 */ }
      })
      bar.appendChild(copy)
    }
    bar.appendChild(el('span', {}, '→ 当前目标：'))
    bar.appendChild(el('code', { class: target ? '' : 'warn' }, target || '(未绑定)'))
    bar.appendChild(el('span', { class: targetLive ? 'ok' : 'warn' }, targetLive ? '活着' : '未打开'))

    const setSelf = el('button', { type: 'button' }, '把本会话设为目标')
    setSelf.addEventListener('click', async () => {
      if (!sessionId) { setSelf.textContent = '拿不到本会话 id'; return }
      setSelf.disabled = true
      const r = await postJson('/dev-task/scan', { sessionId })
      setSelf.disabled = false
      setSelf.textContent = r && r.ok ? '已设为目标 ✓' : '设置失败'
      void refresh()
    })
    bar.appendChild(setSelf)
    bar.appendChild(el('a', { href: '/dev-task/panel', target: '_blank', rel: 'noreferrer' },
      '会话区面板（' + total + '）'))
  }

  const refresh = async () => {
    const st = await getJson('/dev-task/status')
    if (st && typeof st === 'object') {
      target = String(st.defaultSession || '')
      total = Number(st.sessionsIndexed || 0)
      const agents = Array.isArray(st.agents) ? st.agents.map(String) : []
      targetLive = agents.indexOf(target) >= 0
      if (!sessionId) sessionId = sessionIdFromDom()
    }
    render()
  }

  const mount = () => {
    try {
      if (bar && document.body && document.body.contains(bar)) return true
      const host = document.body || document.documentElement
      if (!host) return false
      if (!document.getElementById(STYLE_ID)) {
        const style = el('style', { id: STYLE_ID }, '')
        style.textContent = CSS
        ;(document.head || document.documentElement).appendChild(style)
      }
      let anchor = null
      for (const sel of ANCHOR_SELECTORS) {
        try {
          const found = document.querySelector(sel)
          if (found && found.parentNode) { anchor = found; break }
        } catch { /* 选择器不支持就跳过 */ }
      }
      bar = el('div', { id: BAR_ID }, '')
      render()
      if (anchor) anchor.parentNode.insertBefore(bar, anchor)
      else host.appendChild(bar)   // 找不到输入框区域时退化成贴底浮条（至少能用）
      return true
    } catch (error) {
      try { console.warn('[dev-task-bridge] 栏位挂载失败：', error) } catch { /* 忽略 */ }
      return false
    }
  }

  const tick = () => {
    try {
      mount()
      void refresh()
    } catch { /* 忽略：客户端半边永远不能抛到外面 */ }
  }

  tick()
  timer = window.setInterval(tick, POLL_MS)
  try {
    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(() => { try { mount() } catch { /* 忽略 */ } })
      observer.observe(document.body, { childList: true, subtree: true })
    }
  } catch { /* 忽略 */ }

  const dispose = () => {
    try { if (timer) window.clearInterval(timer) } catch { /* 忽略 */ }
    try { if (observer) observer.disconnect() } catch { /* 忽略 */ }
    try { if (bar && bar.parentNode) bar.parentNode.removeChild(bar) } catch { /* 忽略 */ }
    try {
      const st = document.getElementById(STYLE_ID)
      if (st && st.parentNode) st.parentNode.removeChild(st)
    } catch { /* 忽略 */ }
    bar = null
  }

  if (ctx && typeof ctx.effect === 'function') ctx.effect(dispose, 'dev-task-bridge: 回传目标栏')
  else window.addEventListener('beforeunload', dispose, { once: true })
}

// ── 导出（CommonJS 形态；三种宿主形态都兜底，任何一种都不会抛）─────────────────
const __exports = (typeof exports === 'object' && exports)
  || (typeof module === 'object' && module && module.exports)
  || (globalThis.__dshDevTaskBridgeClient = globalThis.__dshDevTaskBridgeClient || {})

__exports.inject = ['slots']
__exports.apply = apply
